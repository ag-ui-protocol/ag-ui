mod lifecycle_support;
use ag_ui_client::{Agent, agent::AgentError};
use lifecycle_support::*;
use serde_json::json;

#[tokio::test]
async fn encrypted_values_cannot_change_message_or_tool_owner() {
    for subtype in ["message", "tool-call"] {
        for owner in [None, Some("owner")] {
            for incoming in [None, Some("owner"), Some("other")] {
                let mut request = input("requested");
                let mut parent = json!({"id":"m","role":"assistant","content":"text","toolCalls":[{"id":"c","type":"function","function":{"name":"f","arguments":"{}"}}]});
                if let Some(owner) = owner {
                    parent["subagentRunId"] = json!(owner);
                }
                request.messages.push(message(parent));
                let mut encrypted = json!({"type":"REASONING_ENCRYPTED_VALUE","subtype":subtype,"entityId":if subtype == "message" {"m"} else {"c"},"encryptedValue":"cipher"});
                if let Some(incoming) = incoming {
                    encrypted["subagentRunId"] = json!(incoming);
                }
                let result = Script(vec![start("requested"), encrypted, finish("requested")])
                    .run_input(&request, ())
                    .await;
                let permitted = incoming.is_none() || incoming == owner;
                assert_eq!(
                    result.is_ok(),
                    permitted,
                    "{subtype} {owner:?} {incoming:?}"
                );
                if let Ok(result) = result {
                    let messages = values(&result.messages);
                    let target = if subtype == "message" {
                        &messages[0]
                    } else {
                        &messages[0]["toolCalls"][0]
                    };
                    assert_eq!(target["encryptedValue"], "cipher");
                }
            }
        }
    }
}

#[tokio::test]
async fn reopened_reasoning_span_preserves_original_owner() {
    for incoming in [None, Some("owner"), Some("other")] {
        let mut reopened = json!({"type":"REASONING_START","messageId":"r"});
        if let Some(incoming) = incoming {
            reopened["subagentRunId"] = json!(incoming);
        }
        let result = run(vec![
            start("requested"),
            json!({"type":"REASONING_START","messageId":"r","subagentRunId":"owner"}),
            json!({"type":"REASONING_END","messageId":"r","subagentRunId":"owner"}),
            reopened,
            json!({"type":"REASONING_END","messageId":"r","subagentRunId":"owner"}),
            finish("requested"),
        ])
        .await;
        assert_eq!(result.is_ok(), incoming != Some("other"), "{incoming:?}");
    }
}

#[tokio::test]
async fn reasoning_span_start_respects_reconciled_message_ownership() {
    let mut request = input("requested");
    request.messages.push(message(
        json!({"id":"r","role":"reasoning","content":"known","subagentRunId":"owner"}),
    ));
    let result = Script(vec![
        start("requested"),
        json!({"type":"REASONING_START","messageId":"r","subagentRunId":"other"}),
        json!({"type":"REASONING_END","messageId":"r"}),
        finish("requested"),
    ])
    .run_input(&request, ())
    .await;
    assert!(matches!(result, Err(AgentError::Execution { .. })));
}

#[tokio::test]
async fn late_subagent_announcement_recovers_after_attributed_events() {
    let result = run(vec![
        start("requested"),
        json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m","delta":"hello","subagentRunId":"s"}),
        json!({"type":"SUBAGENT_STARTED","subagentRunId":"s","name":"worker"}),
        json!({"type":"SUBAGENT_FINISHED","subagentRunId":"s"}),
        finish("requested"),
    ])
    .await
    .unwrap();
    let messages = values(&result.messages);
    assert_eq!(messages[0]["subagentRunId"], "s");
    assert_eq!(messages[0]["content"], "hello");
}

#[tokio::test]
async fn reasoning_span_and_message_openers_cannot_disagree_on_owner() {
    for span_first in [true, false] {
        let mut script = vec![start("requested")];
        let span = json!({"type":"REASONING_START","messageId":"r","subagentRunId":"span-owner"});
        let message = json!({"type":"REASONING_MESSAGE_START","messageId":"r","role":"reasoning","subagentRunId":"message-owner"});
        script.extend(if span_first {
            vec![span, message]
        } else {
            vec![message, span]
        });
        script.extend([
            json!({"type":"REASONING_MESSAGE_END","messageId":"r"}),
            json!({"type":"REASONING_END","messageId":"r"}),
            finish("requested"),
        ]);
        assert!(matches!(
            run(script).await,
            Err(AgentError::Execution { .. })
        ));
    }
}
