mod lifecycle_support;
use ag_ui_client::{
    Agent, RunTerminalStatus,
    agent::{AgentError, AgentStateMutation},
    core::{
        event::*,
        types::{Message, ToolCall},
    },
    subscriber::{AgentSubscriber, AgentSubscriberParams},
};
use lifecycle_support::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct StopTerminal {
    generic: bool,
    error: bool,
    seen: Arc<Mutex<Vec<&'static str>>>,
}
impl StopTerminal {
    fn stop(&self, generic: bool, error: bool) -> AgentStateMutation {
        AgentStateMutation {
            stop_propagation: self.generic == generic && self.error == error,
            ..Default::default()
        }
    }
}
#[async_trait::async_trait]
impl AgentSubscriber for StopTerminal {
    async fn on_event(
        &self,
        event: &Event,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        match event {
            Event::RunFinished(_) => {
                self.seen.lock().unwrap().push("generic-finish");
                Ok(self.stop(true, false))
            }
            Event::RunError(_) => {
                self.seen.lock().unwrap().push("generic-error");
                Ok(self.stop(true, true))
            }
            _ => Ok(Default::default()),
        }
    }
    async fn on_run_finished_event(
        &self,
        _: &RunFinishedEvent,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.seen.lock().unwrap().push("typed-finish");
        Ok(self.stop(false, false))
    }
    async fn on_run_error_event(
        &self,
        _: &RunErrorEvent,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.seen.lock().unwrap().push("typed-error");
        Ok(self.stop(false, true))
    }
}
fn terminal() -> Value {
    json!({"type":"RUN_FINISHED","threadId":"thread","runId":"requested","result":{"value":7},"outcome":{"type":"success"},"usage":[{"inputTokens":1}]})
}

#[tokio::test]
async fn terminal_stops_preserve_verification_before_generic_and_reduction_before_typed() {
    for generic in [true, false] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let result = Script(vec![start("requested"), terminal()])
            .run_input(
                &input("requested"),
                (StopTerminal {
                    generic,
                    error: false,
                    seen: seen.clone(),
                },),
            )
            .await
            .unwrap();
        assert!(matches!(
            result.terminal_status,
            RunTerminalStatus::Finished { .. }
        ));
        assert_eq!(result.result, (!generic).then(|| json!({"value":7})));
        assert_eq!(result.outcome.is_some(), !generic);
        assert_eq!(result.usage.is_some(), !generic);
        assert_eq!(
            *seen.lock().unwrap(),
            if generic {
                vec!["generic-finish"]
            } else {
                vec!["generic-finish", "typed-finish"]
            }
        );

        let seen = Arc::new(Mutex::new(Vec::new()));
        let result = Script(vec![
            start("requested"),
            terminal(),
            json!({"type":"RUN_ERROR","message":"late","usage":[{"inputTokens":2}]}),
        ])
        .run_input(
            &input("requested"),
            (StopTerminal {
                generic,
                error: true,
                seen: seen.clone(),
            },),
        )
        .await
        .unwrap();
        assert!(matches!(
            result.terminal_status,
            RunTerminalStatus::ProducerError(_)
        ));
        assert!(result.result.is_none());
        assert!(result.result.is_none());
        assert!(result.outcome.is_none());
        assert_eq!(
            result.usage.unwrap()[0].input_tokens,
            Some(if generic { 1 } else { 2 })
        );
        assert_eq!(seen.lock().unwrap().contains(&"typed-error"), !generic);
    }
}

struct OutputAgent(Option<Value>);
#[async_trait::async_trait]
impl Agent for OutputAgent {
    async fn run(
        &self,
        _: &ag_ui_client::core::types::RunAgentInput,
    ) -> Result<futures::stream::BoxStream<'async_trait, Result<Event, AgentError>>, AgentError>
    {
        let mut finished = event(finish("requested"));
        let Event::RunFinished(finished_event) = &mut finished else {
            unreachable!()
        };
        finished_event.result = self.0.clone();
        Ok(Box::pin(futures::stream::iter([
            Ok(event(start("requested"))),
            Ok(finished),
        ])))
    }
}

#[tokio::test]
async fn result_omits_whole_null_but_preserves_nested_nulls() {
    for output in [None, Some(Value::Null), Some(json!({"nested":null}))] {
        let result = OutputAgent(output.clone())
            .run_input(&input("requested"), ())
            .await
            .unwrap();
        assert_eq!(
            result.result,
            output.clone().filter(|value| !value.is_null())
        );
    }
}

#[derive(Clone, Default)]
struct HistoryObserver {
    seen: Arc<Mutex<Vec<String>>>,
    notifications: Arc<Mutex<(usize, usize, usize)>>,
}
#[async_trait::async_trait]
impl AgentSubscriber for HistoryObserver {
    async fn on_event(
        &self,
        event: &Event,
        params: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.seen.lock().unwrap().push(
            serde_json::to_value(event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
        if matches!(event, Event::Custom(_)) {
            let messages = values(params.messages)
                .into_iter()
                .map(|mut value| {
                    value["subagentRunId"] = json!("new");
                    message(value)
                })
                .collect();
            return Ok(AgentStateMutation {
                messages: Some(messages),
                ..Default::default()
            });
        }
        Ok(Default::default())
    }
    async fn on_new_message(
        &self,
        _: &Message,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.notifications.lock().unwrap().0 += 1;
        Ok(())
    }
    async fn on_new_tool_call(
        &self,
        _: &ToolCall,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.notifications.lock().unwrap().1 += 1;
        Ok(())
    }
    async fn on_run_finalized(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.notifications.lock().unwrap().2 += 1;
        Ok(Default::default())
    }
}

#[tokio::test]
async fn subscriber_history_mutations_reseed_each_open_stream_owner() {
    for (open, continuation, close) in [
        (
            json!({"type":"TEXT_MESSAGE_START","messageId":"m","subagentRunId":"old"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"text"}),
            json!({"type":"TEXT_MESSAGE_END","messageId":"m"}),
        ),
        (
            json!({"type":"REASONING_MESSAGE_START","messageId":"m","role":"reasoning","subagentRunId":"old"}),
            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":"m","delta":"reason"}),
            json!({"type":"REASONING_MESSAGE_END","messageId":"m"}),
        ),
        (
            json!({"type":"TOOL_CALL_START","toolCallId":"call","toolCallName":"f","parentMessageId":"m","subagentRunId":"old"}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":"call","delta":"{}"}),
            json!({"type":"TOOL_CALL_END","toolCallId":"call"}),
        ),
    ] {
        for owner in ["new", "old"] {
            let capture = HistoryObserver::default();
            let mut continuation = continuation.clone();
            continuation["subagentRunId"] = json!(owner);
            let mut close = close.clone();
            close["subagentRunId"] = json!(owner);
            let result = Script(vec![
                start("requested"),
                open.clone(),
                json!({"type":"CUSTOM","name":"reassign","value":null}),
                continuation.clone(),
                close,
                finish("requested"),
            ])
            .run_input(&input("requested"), (capture.clone(),))
            .await;
            assert_eq!(result.is_ok(), owner == "new", "{continuation}: {result:?}");
            assert_eq!(
                capture
                    .seen
                    .lock()
                    .unwrap()
                    .contains(&continuation["type"].as_str().unwrap().to_owned()),
                owner == "new",
                "verification must precede generic delivery"
            );
            assert_eq!(capture.notifications.lock().unwrap().2, 1);
        }
    }
}

#[tokio::test]
async fn notifications_remain_once_only_across_segments_deletion_and_reintroduction() {
    let capture = HistoryObserver::default();
    let history = json!([{"id":"m","role":"assistant","toolCalls":[{"id":"call","type":"function","function":{"name":"f","arguments":"{}"}}]}]);
    let result = Script(vec![
        start("past"),
        json!({"type":"MESSAGES_SNAPSHOT","messages":history}),
        finish("past"),
        start("requested"),
        json!({"type":"MESSAGES_SNAPSHOT","messages":[]}),
        json!({"type":"MESSAGES_SNAPSHOT","messages":history}),
        finish("requested"),
    ])
    .run_input(&input("requested"), (capture.clone(),))
    .await
    .unwrap();
    assert_eq!(
        values(&result.messages),
        history.as_array().unwrap().clone()
    );
    assert_eq!(*capture.notifications.lock().unwrap(), (1, 1, 1));
}

#[tokio::test]
async fn result_is_exposed_only_for_successful_outcomes() {
    for outcome in [
        None,
        Some(json!({"type":"success"})),
        Some(json!({"type":"cancelled"})),
        Some(
            json!({"type":"interrupt","interrupts":[{"id":"approval","reason":"approval required"}]}),
        ),
    ] {
        for value in [
            None,
            Some(Value::Null),
            Some(json!({"nested":null})),
            Some(json!(false)),
            Some(json!(0)),
        ] {
            let mut terminal = finish("requested");
            if let Some(outcome) = &outcome {
                terminal["outcome"] = outcome.clone();
            }
            if let Some(value) = &value {
                terminal["result"] = value.clone();
            }
            let result = Script(vec![start("requested"), terminal])
                .run_input(&input("requested"), ())
                .await
                .unwrap();
            let success = outcome.as_ref().is_none_or(|o| o["type"] == "success");
            let expected = if success {
                value.filter(|v| !v.is_null())
            } else {
                None
            };
            assert_eq!(result.result, expected, "outcome: {outcome:?}");
        }
    }
}
