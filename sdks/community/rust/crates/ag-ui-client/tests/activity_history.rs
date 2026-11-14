mod lifecycle_support;
use ag_ui_client::{
    Agent,
    agent::AgentError,
    core::processing::Diagnostic,
    subscriber::{AgentSubscriber, AgentSubscriberParams},
};
use lifecycle_support::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn text_roles_metadata_and_chunk_roles_survive_materialization() {
    let mut script = vec![start("requested")];
    for (i, role) in ["assistant", "user", "system", "developer"]
        .iter()
        .enumerate()
    {
        script.extend([
            json!({"type":"TEXT_MESSAGE_START","messageId":format!("m{i}"),"role":role,"name":"speaker","metadata":{"keep":true,"nested":{"old":1},"nullable":"old"}}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":format!("m{i}"),"delta":"one","metadata":{"nested":{"new":2},"nullable":null}}),
            json!({"type":"TEXT_MESSAGE_END","messageId":format!("m{i}"),"metadata":{"done":true}}),
            json!({"type":"TEXT_MESSAGE_START","messageId":format!("m{i}"),"role":role,"name":"speaker"}),
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":format!("m{i}"),"delta":"two"}),
            json!({"type":"TEXT_MESSAGE_END","messageId":format!("m{i}")}),
            json!({"type":"TEXT_MESSAGE_CHUNK","messageId":format!("c{i}"),"role":role,"delta":"chunk"}),
        ]);
    }
    script.push(finish("requested"));
    let result = run(script).await.unwrap();
    assert_eq!(result.messages.len(), 8);
    let messages = values(&result.messages);
    for (i, role) in ["assistant", "user", "system", "developer"]
        .iter()
        .enumerate()
    {
        assert_eq!(messages[i * 2]["role"], *role);
        assert_eq!(messages[i * 2]["name"], "speaker");
        assert_eq!(messages[i * 2]["content"], "onetwo");
        assert_eq!(
            messages[i * 2]["metadata"],
            json!({"keep":true,"nested":{"new":2},"nullable":null,"done":true})
        );
        assert_eq!(messages[i * 2 + 1]["role"], *role);
        assert_eq!(messages[i * 2 + 1]["content"], "chunk");
    }
}

#[tokio::test]
async fn activity_replacement_and_delta_merge_metadata_and_transfer_only_replacing_ownership() {
    for replace in [None, Some(true), Some(false)] {
        let mut snapshot = json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"second","content":{"n":2},"subagentRunId":"new","metadata":{"extra":true,"nested":{"new":2},"nil":null}});
        if let Some(replace) = replace {
            snapshot["replace"] = json!(replace);
        }
        let owner = if replace == Some(false) { "old" } else { "new" };
        let result = run(vec![start("requested"), json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"first","content":{"n":1},"subagentRunId":"old","metadata":{"keep":true,"nested":{"old":1},"nil":"old"}}), snapshot,
            json!({"type":"ACTIVITY_DELTA","messageId":"a","activityType":"third","patch":[{"op":"add","path":"/added","value":null,"vendor":{"keep":true}}],"subagentRunId":owner,"metadata":{"last":true}}), finish("requested")]).await.unwrap();
        assert_eq!(result.messages.len(), 1);
        let message = &values(&result.messages)[0];
        assert_eq!(message["activityType"], "third");
        assert_eq!(
            message["content"],
            json!({"n":if replace == Some(false) {1} else {2},"added":null})
        );
        assert_eq!(message["subagentRunId"], owner);
        assert_eq!(
            message["metadata"],
            json!({"keep":true,"extra":true,"nested":{"new":2},"nil":null,"last":true})
        );
        assert!(result.messages[0].content().is_none());
    }
    let result = run(vec![start("requested"),json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"one","content":{},"subagentRunId":"old"}),json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"two","content":{}}),finish("requested")]).await.unwrap();
    assert!(values(&result.messages)[0].get("subagentRunId").is_none());
}

#[tokio::test]
async fn activity_snapshot_retypes_in_place_without_duplicate_identity() {
    let mut request = input("requested");
    request.messages.push(message(
        json!({"id":"a","role":"assistant","content":"old"}),
    ));
    request
        .messages
        .push(message(json!({"id":"tail","role":"user","content":"last"})));
    let result = Script(vec![
        start("requested"),
        json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"progress","content":{}}),
        finish("requested"),
    ])
    .run_input(&request, ())
    .await
    .unwrap();
    assert_eq!(result.messages.len(), 2);
    let messages = values(&result.messages);
    assert_eq!(messages[0]["id"], "a");
    assert_eq!(messages[0]["role"], "activity");
    assert_eq!(messages[1]["id"], "tail");
    assert!(result.new_messages.is_empty());
}

#[tokio::test]
async fn snapshots_reconcile_each_client_role_independently_and_last_duplicate_id_wins() {
    for declared_role in ["activity", "reasoning"] {
        let mut request = input("requested");
        request.messages = vec![
            message(json!({"id":"keep","role":"assistant","content":"old"})),
            message(json!({"id":"activity","role":"activity","activityType":"a","content":{}})),
            message(json!({"id":"reasoning","role":"reasoning","content":"private"})),
            message(json!({"id":"drop","role":"user","content":"gone"})),
        ];
        let declared = if declared_role == "activity" {
            json!({"id":"new-client","role":"activity","activityType":"b","content":{}})
        } else {
            json!({"id":"new-client","role":"reasoning","content":"new"})
        };
        let result = Script(vec![start("requested"),json!({"type":"MESSAGES_SNAPSHOT","messages":[{"id":"keep","role":"system","content":"first"},declared,{"id":"keep","role":"developer","content":"last","metadata":{"nested":null}}]}),finish("requested")]).run_input(&request,()).await.unwrap();
        let messages = values(&result.messages);
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages[0],
            json!({"id":"keep","role":"developer","content":"last","metadata":{"nested":null}})
        );
        assert_eq!(
            messages[1]["role"],
            if declared_role == "activity" {
                "reasoning"
            } else {
                "activity"
            }
        );
        assert_eq!(messages[2]["id"], "new-client");
    }
}

#[tokio::test]
async fn snapshots_seed_activity_and_tool_ownership_and_false_snapshot_does_not_steal_it() {
    for role in ["activity", "assistant"] {
        let seeded = if role == "activity" {
            json!({"id":"a","role":"activity","activityType":"a","content":{},"subagentRunId":"owner"})
        } else {
            json!({"id":"a","role":"assistant","content":"","subagentRunId":"owner","toolCalls":[{"id":"call","type":"function","function":{"name":"f","arguments":"{}"}}]})
        };
        let offending = if role == "activity" {
            vec![
                json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"other","content":{},"replace":false,"subagentRunId":"intruder"}),
                json!({"type":"ACTIVITY_DELTA","messageId":"a","activityType":"a","patch":[],"subagentRunId":"intruder"}),
            ]
        } else {
            vec![
                json!({"type":"TOOL_CALL_START","toolCallId":"call","toolCallName":"f","parentMessageId":"a","subagentRunId":"intruder"}),
            ]
        };
        let mut script = vec![
            start("requested"),
            json!({"type":"MESSAGES_SNAPSHOT","messages":[seeded]}),
        ];
        script.extend(offending);
        script.push(finish("requested"));
        assert!(matches!(
            run(script).await,
            Err(AgentError::Execution { .. })
        ));
    }
}

struct Diagnostics(Arc<Mutex<Vec<Diagnostic>>>);
#[async_trait::async_trait]
impl AgentSubscriber for Diagnostics {
    async fn on_diagnostic(
        &self,
        diagnostic: &Diagnostic,
        _: AgentSubscriberParams<'async_trait, Value, Value>,
    ) -> Result<(), AgentError> {
        self.0.lock().unwrap().push(diagnostic.clone());
        Ok(())
    }
}
#[tokio::test]
async fn patches_fail_atomically_but_activity_metadata_still_merges_and_warnings_are_observable() {
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    let result = Script(vec![start("requested"),json!({"type":"STATE_SNAPSHOT","snapshot":{"keep":1}}),json!({"type":"STATE_DELTA","delta":[{"op":"add","path":"/partial","value":true},{"op":"remove","path":"/missing"}]}),json!({"type":"ACTIVITY_SNAPSHOT","messageId":"a","activityType":"old","content":{"keep":1}}),json!({"type":"ACTIVITY_DELTA","messageId":"a","activityType":"new","patch":[{"op":"add","path":"/partial","value":true},{"op":"remove","path":"/missing"}],"metadata":{"received":true}}),json!({"type":"ACTIVITY_DELTA","messageId":"missing","activityType":"new","patch":[]}),finish("requested")]).run_input(&input("requested"),(Diagnostics(diagnostics.clone()),)).await.unwrap();
    assert_eq!(result.new_state, json!({"keep":1}));
    let messages = values(&result.messages);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], json!({"keep":1}));
    assert_eq!(messages[0]["activityType"], "old");
    assert_eq!(messages[0]["metadata"], json!({"received":true}));
    let diagnostics = diagnostics.lock().unwrap();
    assert_eq!(diagnostics.len(), 3);
    assert_eq!(diagnostics[0].path, "/delta");
    assert_eq!(diagnostics[1].path, "/patch");
    assert!(
        diagnostics[0]
            .message
            .contains("Failed to apply state patch")
    );
}

#[tokio::test]
async fn null_baseline_is_object_but_canonical_snapshot_null_and_scalar_replacements_remain_exact()
{
    let mut request = input("requested");
    request.state = Value::Null;
    let result = Script(vec![
        start("requested"),
        json!({"type":"STATE_DELTA","delta":[{"op":"add","path":"/fromBaseline","value":true}]}),
        finish("requested"),
    ])
    .run_input(&request, ())
    .await
    .unwrap();
    assert_eq!(result.new_state, json!({"fromBaseline":true}));
    for snapshot in [Value::Null, json!(17), json!([null, 1])] {
        let result = run(vec![
            start("requested"),
            json!({"type":"STATE_SNAPSHOT","snapshot":snapshot}),
            finish("requested"),
        ])
        .await
        .unwrap();
        assert_eq!(result.new_state, snapshot);
    }
}

#[tokio::test]
async fn tool_reopen_preserves_single_call_and_merges_metadata_into_the_call() {
    let result=run(vec![start("requested"),json!({"type":"TOOL_CALL_START","toolCallId":"call","toolCallName":"f","parentMessageId":"a","subagentRunId":"owner","metadata":{"keep":true,"replace":{"old":1}}}),json!({"type":"TOOL_CALL_ARGS","toolCallId":"call","delta":"{"}),json!({"type":"TOOL_CALL_END","toolCallId":"call"}),json!({"type":"TOOL_CALL_START","toolCallId":"call","toolCallName":"f","parentMessageId":"a","metadata":{"replace":{"new":2}}}),json!({"type":"TOOL_CALL_ARGS","toolCallId":"call","delta":"{","subagentRunId":"owner"}),json!({"type":"TOOL_CALL_ARGS","toolCallId":"call","delta":"}","subagentRunId":"owner"}),json!({"type":"TOOL_CALL_END","toolCallId":"call","metadata":{"done":null}}),finish("requested")]).await.unwrap();
    let messages = values(&result.messages);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["toolCalls"].as_array().unwrap().len(), 1);
    assert_eq!(messages[0]["toolCalls"][0]["function"]["arguments"], "{}");
    assert_eq!(
        messages[0]["toolCalls"][0]["metadata"],
        json!({"keep":true,"replace":{"new":2},"done":null})
    );
    assert!(messages[0].get("metadata").is_none());
}

#[tokio::test]
async fn snapshot_ownership_is_authoritative_for_an_open_message() {
    let result=run(vec![start("requested"),json!({"type":"TEXT_MESSAGE_START","messageId":"a","subagentRunId":"old"}),json!({"type":"MESSAGES_SNAPSHOT","messages":[{"id":"a","role":"assistant","content":"snapshot","subagentRunId":"new"}]}),json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"a","delta":"+tail","subagentRunId":"new"}),json!({"type":"TEXT_MESSAGE_END","messageId":"a","subagentRunId":"new"}),finish("requested")]).await.unwrap();
    let messages = values(&result.messages);
    assert_eq!(messages[0]["subagentRunId"], "new");
    assert_eq!(messages[0]["content"], "snapshot+tail");
}

#[tokio::test]
async fn reminted_non_activity_target_skips_delta_instead_of_using_stale_ownership() {
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    // A snapshot may authoritatively replace a message's role. A streamed
    // tool result with a colliding ID must instead preserve the old message.
    let result = Script(vec![
        start("requested"),
        json!({"type":"ACTIVITY_SNAPSHOT","messageId":"same","activityType":"progress","content":{},"subagentRunId":"old"}),
        json!({"type":"MESSAGES_SNAPSHOT","messages":[{"id":"same","role":"tool","toolCallId":"call","content":"done","subagentRunId":"new"}]}),
        json!({"type":"ACTIVITY_DELTA","messageId":"same","activityType":"progress","patch":[],"subagentRunId":"new"}),
        finish("requested"),
    ]).run_input(&input("requested"), (Diagnostics(diagnostics.clone()),)).await.unwrap();
    assert_eq!(result.messages.len(), 1);
    assert_eq!(values(&result.messages)[0]["role"], "tool");
    assert_eq!(values(&result.messages)[0]["subagentRunId"], "new");
    let diagnostics = diagnostics.lock().unwrap();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(
        diagnostics[0].category,
        ag_ui_client::core::processing::DiagnosticCategory::MissingTarget
    );
    assert_eq!(diagnostics[0].path, "/patch");
}

#[tokio::test]
async fn colliding_tool_result_preserves_activity_content_and_ownership() {
    let result = run(vec![
        start("requested"),
        json!({"type":"ACTIVITY_SNAPSHOT","messageId":"same","activityType":"progress","content":{"keep":true},"subagentRunId":"old"}),
        json!({"type":"TOOL_CALL_RESULT","messageId":"same","toolCallId":"call","content":"done","subagentRunId":"new"}),
        finish("requested"),
    ]).await.unwrap();
    let messages = values(&result.messages);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "activity");
    assert_eq!(messages[0]["content"], json!({"keep":true}));
    assert_eq!(messages[0]["subagentRunId"], "old");
    assert_eq!(messages[1]["role"], "tool");
    assert_eq!(messages[1]["content"], "done");
    assert_eq!(messages[1]["subagentRunId"], "new");
}

#[tokio::test]
async fn snapshots_honor_explicit_activity_authority_and_fail_closed_on_invalid_metadata() {
    // Canonical TS authoritativeActivityTypes: absence infers authority; null owns
    // all types; arrays own only listed types; malformed declarations own nothing.
    let cases = [
        (json!({}), true, true),
        (json!({"@ag-ui/client": {}}), true, true),
        (
            json!({"@ag-ui/client": {"authoritativeActivityTypes": null}}),
            true,
            true,
        ),
        (
            json!({"@ag-ui/client": {"authoritativeActivityTypes": ["owned"]}}),
            true,
            false,
        ),
        (
            json!({"@ag-ui/client": {"authoritativeActivityTypes": []}}),
            false,
            false,
        ),
        (
            json!({"@ag-ui/client": {"authoritativeActivityTypes": ["owned", 7]}}),
            false,
            false,
        ),
        (
            json!({"@ag-ui/client": {"authoritativeActivityTypes": "owned"}}),
            false,
            false,
        ),
        (json!({"@ag-ui/client": null}), false, false),
        (json!({"@ag-ui/client": []}), false, false),
        (json!({"@ag-ui/client": "invalid"}), false, false),
        (json!({"@ag-ui/client": false}), false, false),
        (json!({"@ag-ui/client": 7}), false, false),
    ];
    for (metadata, owns_owned, owns_other) in cases {
        for carries_activity in [false, true] {
            let mut request = input("requested");
            request.messages = vec![
                message(
                    json!({"id":"owned","role":"activity","activityType":"owned","content":{}}),
                ),
                message(
                    json!({"id":"other","role":"activity","activityType":"other","content":{}}),
                ),
                message(json!({"id":"reasoning","role":"reasoning","content":"keep"})),
            ];
            let incoming = if carries_activity {
                vec![json!({"id":"new","role":"activity","activityType":"new","content":{}})]
            } else {
                vec![]
            };
            let result = Script(vec![
                start("requested"),
                json!({"type":"MESSAGES_SNAPSHOT","messages":incoming,"metadata":metadata}),
                finish("requested"),
            ])
            .run_input(&request, ())
            .await
            .unwrap();
            let ids: Vec<_> = result.messages.iter().map(|m| m.id().as_str()).collect();
            let inferred = metadata.get("@ag-ui/client").is_none()
                || metadata["@ag-ui/client"]
                    .as_object()
                    .is_some_and(|m| !m.contains_key("authoritativeActivityTypes"));
            assert_eq!(
                ids.contains(&"owned"),
                !(owns_owned && (!inferred || carries_activity)),
                "metadata={metadata}, activity={carries_activity}"
            );
            assert_eq!(
                ids.contains(&"other"),
                !(owns_other && (!inferred || carries_activity)),
                "metadata={metadata}, activity={carries_activity}"
            );
            assert!(ids.contains(&"reasoning"));
            assert_eq!(ids.contains(&"new"), carries_activity);
        }
    }
}

#[tokio::test]
async fn snapshot_updates_matching_activity_id_even_without_deletion_authority() {
    let mut request = input("requested");
    request.messages = vec![message(
        json!({"id":"a","role":"activity","activityType":"old","content":{"old":true}}),
    )];
    let replacement =
        json!({"id":"a","role":"activity","activityType":"new","content":{"new":true}});
    let result = Script(vec![start("requested"), json!({"type":"MESSAGES_SNAPSHOT","messages":[replacement],"metadata":{"@ag-ui/client":{"authoritativeActivityTypes":[]}}}), finish("requested")]).run_input(&request, ()).await.unwrap();
    assert_eq!(values(&result.messages), vec![replacement]);
}
