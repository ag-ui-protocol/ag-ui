use ag_ui_client::{
    Agent,
    agent::{AgentError, AgentStateMutation},
    core::{AgentState, event::Event, types::RunAgentInput},
    subscriber::{AgentSubscriber, AgentSubscriberParams},
};
use futures::stream::{self, BoxStream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const SENTINEL: &str = "OPAQUE_STATE_SECRET_DO_NOT_LOG";
struct LogSink(Mutex<Vec<String>>);
static LOGS: LogSink = LogSink(Mutex::new(Vec::new()));
impl log::Log for LogSink {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        self.0.lock().unwrap().push(format!("{}", record.args()));
    }
    fn flush(&self) {}
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
enum Mode {
    #[default]
    Safe,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
struct TypedState {
    mode: Mode,
}
impl AgentState for TypedState {}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
struct FailingSerializer {
    mode: Mode,
    #[serde(skip)]
    fail: bool,
}
impl AgentState for FailingSerializer {}
impl Serialize for FailingSerializer {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.fail {
            return Err(serde::ser::Error::custom(SENTINEL));
        }
        TypedState {
            mode: self.mode.clone(),
        }
        .serialize(serializer)
    }
}

struct PatchAgent;
#[async_trait::async_trait]
impl<S: AgentState> Agent<S> for PatchAgent {
    async fn run(
        &self,
        _: &RunAgentInput<S>,
    ) -> Result<BoxStream<'async_trait, Result<Event<S>, AgentError>>, AgentError> {
        Ok(Box::pin(stream::iter([
            json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
            json!({"type":"STATE_DELTA","delta":[{"op":"replace","path":"/mode","value":SENTINEL}]}),
            json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}),
        ].into_iter().map(|value| Ok(serde_json::from_value(value).unwrap())).collect::<Vec<_>>())))
    }
}

type Observation<S> = Arc<Mutex<(usize, usize, Vec<String>, Option<S>)>>;

struct Observer<S> {
    initialized_state: S,
    observed: Observation<S>,
}
#[async_trait::async_trait]
impl<S: AgentState> AgentSubscriber<S> for Observer<S> {
    async fn on_run_initialized(
        &self,
        _: AgentSubscriberParams<'async_trait, S, Value>,
    ) -> Result<AgentStateMutation<S>, AgentError> {
        Ok(AgentStateMutation {
            state: Some(self.initialized_state.clone()),
            ..Default::default()
        })
    }
    async fn on_run_failed(
        &self,
        error: &AgentError,
        _: AgentSubscriberParams<'async_trait, S, Value>,
    ) -> Result<AgentStateMutation<S>, AgentError> {
        let mut observed = self.observed.lock().unwrap();
        observed.0 += 1;
        observed.2.push(format!("{error} {error:?}"));
        Ok(Default::default())
    }
    async fn on_run_finalized(
        &self,
        params: AgentSubscriberParams<'async_trait, S, Value>,
    ) -> Result<AgentStateMutation<S>, AgentError> {
        let mut observed = self.observed.lock().unwrap();
        observed.1 += 1;
        observed.3 = Some(params.state.clone());
        Ok(Default::default())
    }
}

async fn check_failure<S: AgentState + PartialEq>(initial: S, state: S, expected: &str) {
    let observed = Arc::new(Mutex::new((0, 0, Vec::new(), None)));
    let input = RunAgentInput::new("t", "r", initial, vec![], vec![], vec![], json!({}));
    let error = PatchAgent
        .run_input(
            &input,
            (Observer {
                initialized_state: state.clone(),
                observed: observed.clone(),
            },),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains(expected));
    assert!(!format!("{error} {error:?}").contains(SENTINEL));
    let observed = observed.lock().unwrap();
    assert_eq!((observed.0, observed.1), (1, 1));
    assert!(observed.2.iter().all(|error| !error.contains(SENTINEL)));
    assert_eq!(
        observed.3.as_ref(),
        Some(&state),
        "state is unchanged on failed conversion"
    );
}

#[tokio::test]
async fn state_conversion_errors_are_explicit_atomic_and_never_logged_or_forwarded_raw() {
    log::set_logger(&LOGS).unwrap();
    log::set_max_level(log::LevelFilter::Trace);
    check_failure(
        TypedState::default(),
        TypedState::default(),
        "Patched state cannot be represented",
    )
    .await;
    check_failure(
        FailingSerializer::default(),
        FailingSerializer {
            fail: true,
            ..Default::default()
        },
        "Application state cannot be serialized",
    )
    .await;
    let logs = LOGS.0.lock().unwrap();
    assert_eq!(
        logs.iter()
            .filter(|line| line.contains("Agent error:"))
            .count(),
        2
    );
    assert!(logs.iter().all(|line| !line.contains(SENTINEL)));
}
