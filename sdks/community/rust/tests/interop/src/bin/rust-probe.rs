use ag_ui_client::agent::{AgentError, AgentStateMutation, RunTerminalStatus};
use ag_ui_client::subscriber::{AgentSubscriber, AgentSubscriberParams};
use ag_ui_client::{Agent, HttpAgent};
use ag_ui_core::{event::Event, types::RunAgentInput};
use ag_ui_interop_fixture::{DUMMY_TOKEN, FixtureHost, TestResult, scenarios};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Observation {
    events: Vec<Value>,
    initialized: usize,
    finalized: usize,
    failed: usize,
}
#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Observation>>);

#[async_trait::async_trait]
impl AgentSubscriber for Recorder {
    async fn on_event(
        &self,
        event: &Event,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation<Value>, AgentError> {
        self.0
            .lock()
            .unwrap()
            .events
            .push(serde_json::to_value(event).unwrap());
        Ok(AgentStateMutation::default())
    }
    async fn on_run_initialized(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation<Value>, AgentError> {
        self.0.lock().unwrap().initialized += 1;
        Ok(AgentStateMutation::default())
    }
    async fn on_run_finalized(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation<Value>, AgentError> {
        self.0.lock().unwrap().finalized += 1;
        Ok(AgentStateMutation::default())
    }
    async fn on_run_failed(
        &self,
        _: &AgentError,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation<Value>, AgentError> {
        self.0.lock().unwrap().failed += 1;
        Ok(AgentStateMutation::default())
    }
}

#[tokio::main]
async fn main() -> TestResult<()> {
    let output = std::env::args().nth(1);
    let mut evidence = Vec::new();
    for (name, steps) in scenarios() {
        let mut previous = None;
        for (index, step) in steps.into_iter().enumerate() {
            let mut input: RunAgentInput = serde_json::from_value(step.input.clone())?;
            if step.carry_history {
                // The public complete result is the only source of next-turn history/state.
                let (messages, state) = previous.take().ok_or("missing previous result")?;
                input.messages = messages;
                input.state = state;
                for message in &step.append_messages {
                    input
                        .messages
                        .push(serde_json::from_value(message.clone())?);
                }
            }
            let host = FixtureHost::start(step.clone())?;
            // Both client and server are reconstructed between every turn.
            let diagnostics = Arc::new(Mutex::new(Vec::new()));
            let diagnostic_capture = diagnostics.clone();
            let client = HttpAgent::builder()
                .with_diagnostic_handler(move |diagnostic| {
                    diagnostic_capture
                        .lock()
                        .unwrap()
                        .push(serde_json::to_value(diagnostic).unwrap());
                })
                .with_url_str(&host.url)?
                .with_bearer_token(DUMMY_TOKEN)?
                .with_timeout(10)
                .build()?;
            let recorder = Recorder::default();
            let result = client.run_input(&input, (recorder.clone(),)).await;
            let trace = host.finish()?;
            let result = result?;
            assert_eq!(
                serde_json::to_value(&result.messages)?,
                json!(step.expected_messages),
                "{name}/{index} full history"
            );
            assert_eq!(
                result.new_state, step.expected_state,
                "{name}/{index} state"
            );
            assert!(
                matches!(&result.terminal_status, RunTerminalStatus::Finished {thread_id, run_id}
                if thread_id == &input.thread_id && run_id == &input.run_id),
                "{name}/{index} identity"
            );
            let terminal = step.response.last().expect("terminal event");
            assert_eq!(
                serde_json::to_value(&result.outcome)?,
                terminal.get("outcome").cloned().unwrap_or(Value::Null),
                "{name}/{index} outcome"
            );
            assert_eq!(
                result.result,
                terminal
                    .get("result")
                    .filter(|value| !value.is_null())
                    .cloned(),
                "{name}/{index} output"
            );
            let observed = recorder.0.lock().unwrap();
            assert_eq!(
                (observed.initialized, observed.finalized, observed.failed),
                (1, 1, 0),
                "{name}/{index} lifecycle"
            );
            assert_eq!(
                observed.events, trace.response_events,
                "{name}/{index} public event payloads"
            );
            assert!(
                diagnostics.lock().unwrap().is_empty(),
                "{name}/{index} client diagnostics"
            );
            assert_eq!(
                trace.diagnostics,
                json!([]),
                "{name}/{index} producer diagnostics"
            );
            assert_eq!(trace.response_events[0]["protocolVersion"], "1.0");
            evidence.push(json!({"scenario":name,"step":index,"trace":trace,
                "messages":result.messages,"state":result.new_state,"events":observed.events,
                "callbacks":{"initialized":observed.initialized,"finalized":observed.finalized,"failed":observed.failed}}));
            previous = Some((result.messages, result.new_state));
        }
    }
    let report =
        json!({"client":"Rust public run_input","exchanges":evidence.len(),"evidence":evidence});
    if let Some(path) = output {
        std::fs::write(path, serde_json::to_vec_pretty(&report)?)?;
    }
    println!(
        "Rust interoperability: {} real HTTP exchanges passed",
        report["exchanges"]
    );
    Ok(())
}
