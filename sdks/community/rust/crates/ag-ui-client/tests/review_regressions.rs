mod lifecycle_support;
use ag_ui_client::{
    Agent,
    agent::{AgentError, AgentStateMutation},
    core::{
        event::*,
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
async fn tool_chunk_inherits_reconciled_parent_owner_without_closing_root_lane() {
    for source in ["input", "snapshot", "stream"] {
        let parent = json!({"id":"m","role":"assistant","content":"parent","subagentRunId":"s"});
        let mut request = input("requested");
        let mut script = vec![
            start("requested"),
            json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
        ];
        match source {
            "input" => request.messages.push(message(parent)),
            "snapshot" => {
                request.messages.push(message(json!({"id":"m","role":"assistant","content":"old root parent"})));
                script.push(json!({"type":"MESSAGES_SNAPSHOT","messages":[parent]}));
            }
            "stream" => script.extend([
                json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant","subagentRunId":"s"}),
                json!({"type":"TEXT_MESSAGE_END","messageId":"m"}),
            ]),
            _ => unreachable!(),
        }
        script.extend([
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"root","delta":"A"}),
            json!({"type":"TOOL_CALL_CHUNK","toolCallId":"c","toolCallName":"f","parentMessageId":"m","delta":"{"}),
            json!({"type":"TOOL_CALL_CHUNK","toolCallId":"c","subagentRunId":"s","delta":"}"}),
            json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
            json!({"type":"TEXT_MESSAGE_CHUNK","delta":"B"}),
            finish("requested"),
        ]);
        let capture = Capture::default();
        let result = Script(script)
            .run_input(&request, (capture.clone(),))
            .await
            .unwrap();
        let history = values(&result.messages);
        let parent = history.iter().find(|m| m["id"] == "m").unwrap();
        assert_eq!(
            parent["toolCalls"][0]["function"]["arguments"], "{}",
            "{source}"
        );
        assert_eq!(parent["subagentRunId"], "s");
        assert_eq!(
            history.iter().find(|m| m["id"] == "root").unwrap()["content"],
            "AB"
        );
        let events = capture.events.lock().unwrap();
        let position = |kind: &str| {
            events
                .iter()
                .position(|event| event["type"] == kind)
                .unwrap()
        };
        assert!(position("TOOL_CALL_END") < position("SUBAGENT_FINISHED"));
        let root_end = events
            .iter()
            .position(|event| event["type"] == "TEXT_MESSAGE_END" && event["messageId"] == "root")
            .unwrap();
        assert!(position("SUBAGENT_FINISHED") < root_end);
        assert_eq!(
            events
                .iter()
                .filter(
                    |event| event["type"] == "TEXT_MESSAGE_START" && event["messageId"] == "root"
                )
                .count(),
            1
        );
        assert_eq!(events[position("TOOL_CALL_START")]["subagentRunId"], "s");
        assert_eq!(events[position("TOOL_CALL_END")]["subagentRunId"], "s");
    }
}

#[tokio::test]
async fn tool_chunk_checks_original_explicit_tag_before_any_lane_is_closed() {
    for parent in [
        json!({"id":"m","role":"assistant","content":"root"}),
        json!({"id":"m","role":"assistant","content":"child","subagentRunId":"other"}),
    ] {
        let mut request = input("requested");
        request.messages.push(message(parent));
        let capture = Capture::default();
        let result = Script(vec![start("requested"),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"root","delta":"A"}),
            json!({"type":"TOOL_CALL_CHUNK","toolCallId":"c","toolCallName":"f","parentMessageId":"m","subagentRunId":"s","delta":"{}"}),
            finish("requested")]).run_input(&request, (capture.clone(),)).await;
        assert!(result.is_err());
        assert!(
            !capture
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "TEXT_MESSAGE_END"
                    || event["type"] == "TOOL_CALL_START")
        );
    }
}

#[tokio::test]
async fn reopened_tool_chunk_inherits_existing_call_owner_without_parent_hint() {
    let mut request = input("requested");
    request.messages.push(message(json!({"id":"m","role":"assistant","subagentRunId":"s","toolCalls":[{"id":"c","type":"function","function":{"name":"f","arguments":""}}]})));
    let capture = Capture::default();
    let result = Script(vec![
        start("requested"),
        json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
        json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"root","delta":"A"}),
        json!({"type":"TOOL_CALL_CHUNK","toolCallId":"c","toolCallName":"f","delta":"{"}),
        json!({"type":"TOOL_CALL_CHUNK","toolCallId":"c","subagentRunId":"s","delta":"}"}),
        json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
        json!({"type":"TEXT_MESSAGE_CHUNK","delta":"B"}),
        finish("requested"),
    ])
    .run_input(&request, (capture.clone(),))
    .await
    .unwrap();
    let history = values(&result.messages);
    assert_eq!(history[0]["toolCalls"][0]["function"]["arguments"], "{}");
    assert_eq!(history[1]["content"], "AB");
    let events = capture.events.lock().unwrap();
    let position = |kind| {
        events
            .iter()
            .position(|event| event["type"] == kind)
            .unwrap()
    };
    assert!(position("TOOL_CALL_END") < position("SUBAGENT_FINISHED"));
    assert!(position("SUBAGENT_FINISHED") < position("TEXT_MESSAGE_END"));
}

#[tokio::test]
async fn encrypted_missing_targets_warn_without_mutating_unrelated_envelopes() {
    let mut request = input("requested");
    request.messages = vec![
        message(json!({"id":"a","role":"assistant","content":"untouched"})),
        message(json!({"id":"activity","role":"activity","activityType":"progress","content":{}})),
    ];
    let capture = Capture::default();
    let result = Script(vec![start("requested"),
        json!({"type":"REASONING_ENCRYPTED_VALUE","subtype":"message","entityId":"missing-message","encryptedValue":"OPAQUE_CIPHERTEXT"}),
        json!({"type":"REASONING_ENCRYPTED_VALUE","subtype":"message","entityId":"activity","encryptedValue":"OPAQUE_CIPHERTEXT"}),
        json!({"type":"REASONING_ENCRYPTED_VALUE","subtype":"tool-call","entityId":"missing-call","encryptedValue":"OPAQUE_CIPHERTEXT"}),
        finish("requested")]).run_input(&request, (capture.clone(),)).await.unwrap();
    assert_eq!(result.messages, request.messages);
    let diagnostics = capture.diagnostics.lock().unwrap();
    assert_eq!(diagnostics.len(), 3);
    for diagnostic in diagnostics.iter() {
        assert_eq!(diagnostic.category, DiagnosticCategory::MissingTarget);
        assert_eq!(diagnostic.path, "/entityId");
        assert!(!format!("{diagnostic:?}").contains("OPAQUE_CIPHERTEXT"));
        assert!(!diagnostic.message.contains("missing-message"));
    }
}

type SeenMutations = Arc<Mutex<Vec<(usize, Value, Vec<Value>)>>>;

#[derive(Clone)]
struct Mutator {
    index: usize,
    generic: bool,
    stop: bool,
    seen: SeenMutations,
    finalized: Arc<Mutex<Vec<usize>>>,
}
impl Mutator {
    fn mutate(&self, params: AgentSubscriberParams<'_, Value, Value>) -> AgentStateMutation {
        self.seen
            .lock()
            .unwrap()
            .push((self.index, params.state.clone(), values(params.messages)));
        if self.index == 0 {
            AgentStateMutation {
                state: Some(json!({"first": true})),
                messages: (!self.stop).then(|| {
                    vec![message(
                        json!({"id":"replacement","role":"user","content":"from first"}),
                    )]
                }),
                stop_propagation: self.stop,
            }
        } else {
            Default::default()
        }
    }
}
#[async_trait::async_trait]
impl AgentSubscriber for Mutator {
    async fn on_event(
        &self,
        event: &Event,
        params: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        Ok(
            if self.generic && matches!(event, Event::ActivitySnapshot(_)) {
                self.mutate(params)
            } else {
                Default::default()
            },
        )
    }
    async fn on_activity_snapshot_event(
        &self,
        _: &ActivitySnapshotEvent,
        params: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        Ok(if !self.generic {
            self.mutate(params)
        } else {
            Default::default()
        })
    }
    async fn on_run_finalized(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        self.finalized.lock().unwrap().push(self.index);
        Ok(Default::default())
    }
}

#[tokio::test]
async fn generic_and_typed_callbacks_apply_mutations_before_next_subscriber_and_stop_immediately() {
    for generic in [true, false] {
        for stop in [true, false] {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let finalized = Arc::new(Mutex::new(Vec::new()));
            let subscribers = (0..2)
                .map(|index| Mutator {
                    index,
                    generic,
                    stop,
                    seen: seen.clone(),
                    finalized: finalized.clone(),
                })
                .collect::<Vec<_>>();
            let result = Script(vec![start("requested"), json!({"type":"ACTIVITY_SNAPSHOT","messageId":"activity","activityType":"progress","content":{}}), finish("requested")]).run_input(&input("requested"), subscribers).await.unwrap();
            assert_eq!(result.new_state, json!({"first":true}));
            let seen = seen.lock().unwrap();
            assert_eq!(seen.len(), if stop { 1 } else { 2 });
            if !stop {
                assert_eq!(seen[1].1, json!({"first":true}));
                assert_eq!(
                    seen[1].2,
                    vec![json!({"id":"replacement","role":"user","content":"from first"})]
                );
            } else {
                // Generic stop precedes reduction; typed stop preserves reduction.
                assert_eq!(result.messages.len(), if generic { 0 } else { 1 });
            }
            assert_eq!(*finalized.lock().unwrap(), vec![0, 1]);
        }
    }
}

struct Accumulator {
    index: usize,
    notifications: Arc<Mutex<(usize, usize)>>,
}
#[async_trait::async_trait]
impl AgentSubscriber for Accumulator {
    async fn on_event(
        &self,
        event: &Event,
        params: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<AgentStateMutation, AgentError> {
        if !matches!(event, Event::Custom(_)) {
            return Ok(Default::default());
        }
        if self.index == 0 {
            Ok(AgentStateMutation {
                state: Some(json!({"earlier":true})),
                ..Default::default()
            })
        } else {
            assert_eq!(params.state, &json!({"earlier":true}));
            Ok(AgentStateMutation {
                messages: Some(vec![message(
                    json!({"id":"replacement","role":"user","content":"later"}),
                )]),
                stop_propagation: true,
                ..Default::default()
            })
        }
    }
    async fn on_state_changed(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.notifications.lock().unwrap().0 += 1;
        Ok(())
    }
    async fn on_messages_changed(
        &self,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.notifications.lock().unwrap().1 += 1;
        Ok(())
    }
}

#[tokio::test]
async fn stopping_callback_preserves_earlier_mutations_and_both_change_notifications() {
    let notifications = Arc::new(Mutex::new((0, 0)));
    let subscribers = (0..2)
        .map(|index| Accumulator {
            index,
            notifications: notifications.clone(),
        })
        .collect::<Vec<_>>();
    let result = Script(vec![
        start("requested"),
        json!({"type":"CUSTOM","name":"mutate","value":null}),
        finish("requested"),
    ])
    .run_input(&input("requested"), subscribers)
    .await
    .unwrap();
    assert_eq!(result.new_state, json!({"earlier":true}));
    assert_eq!(
        values(&result.messages),
        vec![json!({"id":"replacement","role":"user","content":"later"})]
    );
    assert_eq!(*notifications.lock().unwrap(), (2, 2));
}

#[tokio::test]
async fn encrypted_values_retain_supported_message_and_tool_targets_without_diagnostics() {
    let mut request = input("requested");
    request.messages = vec![
        message(json!({"id":"a","role":"assistant","content":"untouched"})),
        message(
            json!({"id":"b","role":"assistant","toolCalls":[{"id":"call","type":"function","function":{"name":"f","arguments":"{}"}}]}),
        ),
    ];
    let capture = Capture::default();
    let result = Script(vec![start("requested"),
        json!({"type":"REASONING_ENCRYPTED_VALUE","subtype":"message","entityId":"b","encryptedValue":"message-cipher"}),
        json!({"type":"REASONING_ENCRYPTED_VALUE","subtype":"tool-call","entityId":"call","encryptedValue":"tool-cipher"}),
        finish("requested")]).run_input(&request, (capture.clone(),)).await.unwrap();
    let history = values(&result.messages);
    assert_eq!(history[0], values(&request.messages)[0]);
    assert_eq!(history[1]["encryptedValue"], "message-cipher");
    assert_eq!(history[1]["toolCalls"][0]["encryptedValue"], "tool-cipher");
    assert!(capture.diagnostics.lock().unwrap().is_empty());
}

#[tokio::test]
async fn nonassistant_tool_parent_warns_and_uses_a_unique_assistant() {
    let mut request = input("requested");
    request
        .messages
        .push(message(json!({"id":"m","role":"user","content":"keep me"})));
    let capture = Capture::default();
    let result = Script(vec![
        start("requested"),
        json!({"type":"TOOL_CALL_START","toolCallId":"c","toolCallName":"f","parentMessageId":"m"}),
        json!({"type":"TOOL_CALL_ARGS","toolCallId":"c","delta":"{}"}),
        json!({"type":"TOOL_CALL_END","toolCallId":"c"}),
        finish("requested"),
    ])
    .run_input(&request, (capture.clone(),))
    .await
    .unwrap();
    assert_eq!(result.messages.len(), 2);
    assert_eq!(result.messages[0], request.messages[0]);
    assert_ne!(result.messages[1].id(), result.messages[0].id());
    let history = values(&result.messages);
    assert_eq!(history[1]["role"], "assistant");
    assert_eq!(history[1]["toolCalls"][0]["function"]["arguments"], "{}");
    let diagnostics = capture.diagnostics.lock().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].category, DiagnosticCategory::MissingTarget);
    assert_eq!(diagnostics[0].path, "/parentMessageId");
}
