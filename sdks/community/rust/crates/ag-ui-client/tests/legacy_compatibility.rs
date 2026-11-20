mod lifecycle_support;
use ag_ui_client::{
    Agent,
    agent::{AgentError, AgentStateMutation},
    core::{
        event::Event,
        processing::{Diagnostic, DiagnosticCategory},
    },
    subscriber::{AgentSubscriber, AgentSubscriberParams},
};
use lifecycle_support::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Capture {
    events: Arc<Mutex<Vec<Value>>>,
    diagnostics: Arc<Mutex<Vec<Diagnostic>>>,
}
#[async_trait::async_trait]
impl AgentSubscriber for Capture {
    async fn on_event(
        &self,
        event: &Event,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.events
            .lock()
            .unwrap()
            .push(serde_json::to_value(event).unwrap());
        Ok(Default::default())
    }
    async fn on_diagnostic(
        &self,
        diagnostic: &Diagnostic,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.diagnostics.lock().unwrap().push(diagnostic.clone());
        Ok(())
    }
}

#[tokio::test]
async fn custom_typed_agent_translates_thinking_before_callbacks_and_history() {
    let script = Script(vec![
        start("requested"),
        json!({"type":"THINKING_START","title":"private-title"}),
        json!({"type":"THINKING_TEXT_MESSAGE_START"}),
        json!({"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"Thinking "}),
        json!({"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"carefully"}),
        json!({"type":"THINKING_TEXT_MESSAGE_END"}),
        json!({"type":"THINKING_END"}),
        finish("requested"),
    ]);
    let mut previous_id = None;
    // The same agent can be reused without leaking a previous run's translation ids.
    for _ in 0..2 {
        let capture = Capture::default();
        let result = script
            .run_input(&input("requested"), (capture.clone(),))
            .await
            .unwrap();
        let history = values(&result.messages);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "reasoning");
        assert_eq!(history[0]["content"], "Thinking carefully");
        if let Some(previous_id) = previous_id {
            assert_ne!(history[0]["id"], previous_id);
        }
        previous_id = Some(history[0]["id"].clone());
        let events = capture.events.lock().unwrap();
        let kinds: Vec<_> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            vec![
                "RUN_STARTED",
                "REASONING_START",
                "REASONING_MESSAGE_START",
                "REASONING_MESSAGE_CONTENT",
                "REASONING_MESSAGE_CONTENT",
                "REASONING_MESSAGE_END",
                "REASONING_END",
                "RUN_FINISHED"
            ]
        );
        assert_eq!(events[1]["messageId"], events[6]["messageId"]);
        for event in &events[2..6] {
            assert_eq!(event["messageId"], history[0]["id"]);
        }
        assert_eq!(events[2]["role"], "reasoning");
        let diagnostics = capture.diagnostics.lock().unwrap();
        assert_eq!(
            diagnostics
                .iter()
                .filter(|d| d.category == DiagnosticCategory::DeprecatedEvent)
                .count(),
            7
        );
        assert!(!format!("{diagnostics:?}").contains("private-title"));
    }
}
