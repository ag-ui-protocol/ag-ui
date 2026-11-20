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

/// The upstream `DEPRECATIONS.md` rows that sit inside a `RunAgentInput`: an
/// older client's explicit `null` reads as the omitted field.
#[test]
fn registered_optional_nulls_in_a_request_read_as_omitted_fields() {
    let request = |extra: serde_json::Value| {
        let mut body = json!({"threadId":"t", "runId":"r", "messages":[]});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        body
    };
    let media = |kind: &str| {
        request(json!({"messages":[{"id":"m", "role":"user", "content":[{
            "type": kind,
            "source": {"type":"url", "value":"https://example.com/attachment"},
            "metadata": null
        }]}]}))
    };
    for (row, body, pointer) in [
        (
            "forwardedProps: null on RunAgentInput",
            request(json!({"forwardedProps": null})),
            "/forwardedProps",
        ),
        (
            "parameters: null on a tool",
            request(
                json!({"tools":[{"name":"lookup", "description":"Lookup", "parameters":null}]}),
            ),
            "/tools/0/parameters",
        ),
        (
            "payload: null on a resume entry",
            request(json!({"resume":[{"interruptId":"i", "status":"resolved", "payload":null}]})),
            "/resume/0/payload",
        ),
        (
            "metadata: null on an image content part",
            media("image"),
            "/messages/0/content/0/metadata",
        ),
        (
            "metadata: null on an audio content part",
            media("audio"),
            "/messages/0/content/0/metadata",
        ),
        (
            "metadata: null on a video content part",
            media("video"),
            "/messages/0/content/0/metadata",
        ),
        (
            "metadata: null on a document content part",
            media("document"),
            "/messages/0/content/0/metadata",
        ),
    ] {
        let (parent, field) = pointer.rsplit_once('/').unwrap();
        let mut omitted = body.clone();
        let removed = omitted
            .pointer_mut(parent)
            .and_then(serde_json::Value::as_object_mut)
            .and_then(|object| object.remove(field));
        assert_eq!(removed, Some(serde_json::Value::Null), "{row}");
        let expected = decode(&serde_json::to_vec(&omitted).unwrap()).unwrap();
        let actual = decode(&serde_json::to_vec(&body).unwrap())
            .unwrap_or_else(|error| panic!("{row}: {error}"));
        assert_eq!(actual, expected, "{row}");
    }
}

#[test]
fn an_unregistered_optional_null_in_a_request_is_still_rejected() {
    for (body, field) in [
        // Registered on RUN_STARTED only, not on the request.
        (
            json!({"threadId":"t","runId":"r","messages":[],"parentRunId":null}),
            "parentRunId",
        ),
        // Registered on media parts only.
        (
            json!({"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[
                {"type":"text","text":"hi","metadata":null}
            ]}]}),
            "metadata",
        ),
        // Registered for `payload` only.
        (
            json!({"threadId":"t","runId":"r","messages":[],"resume":[
                {"interruptId":"i","status":"resolved","metadata":null}
            ]}),
            "metadata",
        ),
    ] {
        let error = decode(&serde_json::to_vec(&body).unwrap()).unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert!(error.to_string().contains(field), "{error}");
    }
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
