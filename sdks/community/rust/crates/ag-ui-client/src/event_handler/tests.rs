use super::*;

#[cfg(test)]
mod name_tests {
    use super::*;
    use crate::core::types::{RunId, ThreadId};
    use serde_json::json;

    #[tokio::test]
    async fn named_text_events_materialize_author() {
        let input = RunAgentInput::new(
            ThreadId::from("t"),
            RunId::from("r"),
            json!({}),
            vec![],
            vec![],
            vec![],
            json!({}),
        );
        let mut handler = EventHandler::new(vec![], json!({}), &input, Subscribers::new(vec![]));
        let run_start: Event =
            serde_json::from_value(json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}))
                .unwrap();
        handler.handle_event(&run_start).await.unwrap();
        let start: Event = serde_json::from_value(
            json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant","name":"Ada"}),
        )
        .unwrap();
        handler.handle_event(&start).await.unwrap();
        assert_eq!(
            serde_json::to_value(&handler.messages[0]).unwrap()["name"],
            "Ada"
        );

        let chunk: Event = serde_json::from_value(json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"other","role":"assistant","name":"Grace","delta":"Hi"})).unwrap();
        let mut chunks = crate::chunk::ChunkExpander::default();
        for expanded in chunks.expand(chunk, &handler.messages).unwrap() {
            let mutation = handler.handle_event(&expanded).await.unwrap();
            handler.apply_mutation(mutation).await.unwrap();
        }
        let materialized = serde_json::to_value(&handler.messages[1]).unwrap();
        assert_eq!(materialized["name"], "Grace");
        assert_eq!(materialized["content"], "Hi");
    }
}

#[cfg(test)]
mod conformance_tests {
    use super::*;
    use crate::core::types::{RunId, ThreadId};
    use serde_json::{Value, json};

    fn subset(actual: &Value, expected: &Value) {
        match (actual, expected) {
            (Value::Object(a), Value::Object(e)) => {
                for (key, value) in e {
                    assert!(a.contains_key(key), "missing {key} in {actual}");
                    subset(&a[key], value);
                }
            }
            (Value::Array(a), Value::Array(e)) => {
                assert_eq!(a.len(), e.len(), "array mismatch: {actual}");
                for (a, e) in a.iter().zip(e) {
                    subset(a, e);
                }
            }
            _ => assert_eq!(actual, expected),
        }
    }

    struct Hooks(std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>);

    #[async_trait::async_trait]
    impl crate::subscriber::AgentSubscriber for Hooks {
        async fn on_activity_snapshot_event(
            &self,
            _event: &crate::core::event::ActivitySnapshotEvent,
            _params: AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
        ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
            self.0.lock().unwrap().push("activity");
            Ok(AgentStateMutation::default())
        }
        async fn on_reasoning_message_start_event(
            &self,
            _event: &crate::core::event::ReasoningMessageStartEvent,
            _params: AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
        ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
            self.0.lock().unwrap().push("reasoning");
            Ok(AgentStateMutation::default())
        }
        async fn on_subagent_started_event(
            &self,
            _event: &crate::core::event::SubagentStartedEvent,
            _params: AgentSubscriberParams<'async_trait, JsonValue, JsonValue>,
        ) -> Result<AgentStateMutation<JsonValue>, AgentError> {
            self.0.lock().unwrap().push("subagent");
            Ok(AgentStateMutation::default())
        }
    }

    #[test]
    fn snapshots_preserve_client_roles_and_existing_positions() {
        let message = |value: Value| serde_json::from_value::<Message>(value).unwrap();
        let mut current = vec![
            message(json!({"id":"a","role":"assistant","content":"old"})),
            message(json!({"id":"act","role":"activity","activityType":"search","content":{}})),
            message(json!({"id":"r","role":"reasoning","content":"thought"})),
            message(json!({"id":"drop","role":"assistant","content":"obsolete"})),
        ];
        let snapshot = vec![
            message(json!({"id":"new","role":"assistant","content":"appended"})),
            message(json!({"id":"a","role":"assistant","content":"updated"})),
        ];
        reconcile_messages(&mut current, &snapshot);
        let values: Vec<_> = current
            .iter()
            .map(|m| serde_json::to_value(m).unwrap())
            .collect();
        assert_eq!(
            values
                .iter()
                .map(|m| m["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["a", "act", "r", "new"]
        );
        assert_eq!(values[0]["content"], "updated");
        let snapshot = vec![
            message(json!({"id":"a","role":"assistant","content":"updated"})),
            message(json!({"id":"act2","role":"activity","activityType":"search","content":{}})),
            message(json!({"id":"r2","role":"reasoning","content":"new thought"})),
        ];
        reconcile_messages(&mut current, &snapshot);
        let ids: Vec<_> = current.iter().map(|m| m.id().as_ref()).collect();
        assert_eq!(ids, ["a", "act2", "r2"]);
    }

    #[tokio::test]
    async fn activity_reasoning_and_subagent_hooks_are_delivered() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let input = RunAgentInput::new(
            ThreadId::from("t"),
            RunId::from("r"),
            json!({}),
            vec![],
            vec![],
            vec![],
            json!({}),
        );
        let mut handler = EventHandler::new(
            vec![],
            json!({}),
            &input,
            Subscribers::from_subscriber(Hooks(calls.clone())),
        );
        for raw in [
            json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
            json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"search","content":{}}),
            json!({"type":"REASONING_MESSAGE_START","messageId":"m","role":"reasoning"}),
            json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
        ] {
            let event: Event = serde_json::from_value(raw).unwrap();
            handler.handle_event(&event).await.unwrap();
        }
        assert_eq!(
            *calls.lock().unwrap(),
            ["activity", "reasoning", "subagent"]
        );
    }

    #[tokio::test]
    async fn named_streams_match_expectations() {
        let names = [
            "activity-snapshot-then-delta",
            "activity-replace-false-preserves",
            "chunk-expansion-assembles",
            "content-without-start-fatal",
            "custom-closes-chunk-stream-fatal",
            "encrypted-value-unknown-entity-tolerated",
            "reasoning-span-and-message",
            "reasoning-discipline-verified",
            "tool-result-parts-mint-tool-message",
            "tool-call-triad-assembles",
            "run-finished-interrupt-outcome-accepted",
            "state-delta-unappliable-warns-and-keeps",
            "metadata-merges-last-write-wins",
            "subagent-attribution-mismatch-fatal",
            "run-error-first-run-continues",
            "run-error-then-new-run-continues",
            "late-run-error-after-finished-run-continues",
            "subagent-unannounced-attribution-accepted",
            "subagent-terminal-closes-open-chunk-stream",
            "subagent-finished-unstarted-fatal",
        ];
        for name in names {
            let path = format!(
                "{}/../../../../../spec/1.0/conformance/streams/{name}.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let fixture: Value =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            let last_start = fixture["stream"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|event| event["type"] == "RUN_STARTED");
            let input = RunAgentInput::new(
                ThreadId::from(
                    last_start
                        .and_then(|event| event["threadId"].as_str())
                        .unwrap_or("t"),
                ),
                RunId::from(
                    last_start
                        .and_then(|event| event["runId"].as_str())
                        .unwrap_or("r"),
                ),
                json!({}),
                vec![],
                vec![],
                vec![],
                json!({}),
            );
            let mut handler =
                EventHandler::new(vec![], json!({}), &input, Subscribers::new(vec![]));
            let mut error = None;
            let mut chunks = crate::chunk::ChunkExpander::default();
            for raw in fixture["stream"].as_array().unwrap() {
                let event: Event = serde_json::from_value(raw.clone())
                    .unwrap_or_else(|e| panic!("{name}: {e}: {raw}"));
                let expanded = match chunks.expand(event, &handler.messages) {
                    Ok(events) => events,
                    Err(e) => {
                        error = Some(e.to_string());
                        break;
                    }
                };
                for event in expanded {
                    match handler.handle_event(&event).await {
                        Ok(mutation) => handler.apply_mutation(mutation).await.unwrap(),
                        Err(e) => {
                            error = Some(e.to_string());
                            break;
                        }
                    }
                }
                if error.is_some() {
                    break;
                }
            }
            let expected = &fixture["expect"];
            if expected["outcome"] == "failed" {
                let error = error.unwrap_or_else(|| panic!("{name}: expected failure"));
                assert!(
                    error.contains(expected["errorContains"].as_str().unwrap()),
                    "{name}: {error}"
                );
                continue;
            }
            assert!(error.is_none(), "{name}: {error:?}");
            if let Some(count) = expected["messageCount"].as_u64() {
                assert_eq!(handler.messages.len() as u64, count, "{name}");
            }
            if let Some(messages) = expected["messages"].as_array() {
                for (actual, expected) in handler.messages.iter().zip(messages) {
                    subset(&serde_json::to_value(actual).unwrap(), expected);
                }
            }
            if let Some(state) = expected.get("state") {
                assert_eq!(
                    serde_json::to_value(&handler.state).unwrap(),
                    *state,
                    "{name}"
                );
            }
        }
    }
}
