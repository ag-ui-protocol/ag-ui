//! Hosted input applies schema enforcement before typed serde defaults.
#![cfg(feature = "axum")]

use ag_ui::axum::extract::decode;
use axum::http::StatusCode;
use serde_json::json;

#[test]
fn malformed_known_input_fields_fail_before_defaulting() {
    for (body, field) in [
        (
            json!({"threadId":"t","runId":"r","messages":[],"protocolVersion":null}),
            "protocolVersion",
        ),
        (
            json!({"threadId":"t","runId":"r","messages":[],"resume":null}),
            "resume",
        ),
        (
            json!({"threadId":"t","runId":"r","messages":[{"id":"m","role":"assistant","content":null}]}),
            "content",
        ),
        (
            json!({"threadId":"t","runId":"r","messages":[{"id":"m","role":"assistant","toolCalls":[{"id":"c","function":{"name":"tool","arguments":"{}"}}]}]}),
            "type",
        ),
        (
            json!({"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"text","text":42}]}]}),
            "text",
        ),
    ] {
        let error = decode(&serde_json::to_vec(&body).unwrap()).unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.code(), "INVALID_INPUT");
        assert!(error.to_string().contains(field), "{error}");
    }
}

#[test]
fn unknown_input_material_is_stripped_and_open_values_survive() {
    let body = json!({
        "threadId":"t", "runId":"r", "futureField":true,
        "messages":[
            {"id":"future","role":"future_role","content":"opaque"},
            {"id":"m","role":"user","futureField":true,"content":[
                {"type":"future_part","payload":true},
                {"type":"image","source":{"type":"future_source","value":"opaque"}},
                {"type":"text","text":"hello","metadata":{"futureField":true}}
            ]}
        ],
        "resume":[{"interruptId":"i","status":"future_status"}],
        "forwardedProps":{"futureField":true}
    });
    let input = decode(&serde_json::to_vec(&body).unwrap()).unwrap();
    let value = serde_json::to_value(input).unwrap();
    assert!(value.get("futureField").is_none());
    assert_eq!(value["messages"].as_array().unwrap().len(), 1);
    assert!(value["messages"][0].get("futureField").is_none());
    assert_eq!(
        value["messages"][0]["content"],
        json!([
            {"type":"text","text":"hello","metadata":{"futureField":true}}
        ])
    );
    assert_eq!(value["resume"], json!([]));
    assert_eq!(value["forwardedProps"], json!({"futureField":true}));
}

#[test]
fn minimal_input_keeps_optional_defaults() {
    let input = decode(br#"{"threadId":"t","runId":"r","messages":[]}"#).unwrap();
    assert!(input.tools.is_empty());
    assert!(input.context.is_empty());
    assert!(input.resume.is_none());
    assert!(input.protocol_version.is_none());
    assert_eq!(
        serde_json::to_value(input).unwrap(),
        json!({
            "threadId":"t", "runId":"r", "messages":[], "tools":[], "context":[]
        })
    );
}
