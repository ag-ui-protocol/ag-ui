//! Legacy attachments enter through raw JSON preparation, not the modern typed union.
use ag_ui_core::{
    processing::{
        DiagnosticCategory, PROTOCOL_VERSION, prepare_run_input, prepare_run_input_value,
    },
    types::RunAgentInput,
};
use serde_json::{Value, json};

#[test]
fn raw_request_preparation_upgrades_legacy_content_and_projects_http_history() {
    let raw = json!({
        "threadId":"thread", "runId":"run", "protocolVersion":"0.0.45",
        "state":{"private":null}, "forwardedProps":{"opaque":{"type":"binary"}},
        "messages":[
            {"id":"activity", "role":"activity", "activityType":"progress", "content":{"percent":50}},
            {"id":"user", "role":"user", "content":[
                {"type":"binary", "mimeType":"image/png", "data":"image", "filename":"photo.png"},
                {"type":"image", "source":{"type":"data", "value":"image", "mimeType":"image/png"}, "metadata":{"filename":"photo.png"}},
                {"type":"binary", "mimeType":"application/pdf", "url":"https://example.test/report.pdf", "filename":"report.pdf"}
            ]}
        ]
    });
    let original = raw.clone();
    let prepared = prepare_run_input_value(raw.clone()).unwrap();
    assert!(prepared.diagnostics.is_empty());
    assert_eq!(prepared.effective_state, original["state"]);
    let wire = serde_json::to_value(prepared.input).unwrap();
    assert_eq!(wire["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(wire["messages"].as_array().unwrap().len(), 1);
    assert_eq!(wire["messages"][0]["id"], "user");
    assert_eq!(wire["messages"][0]["content"].as_array().unwrap().len(), 2);
    assert_eq!(wire["messages"][0]["content"][0]["type"], "image");
    assert_eq!(
        wire["messages"][0]["content"][1],
        json!({"type":"document", "source":{"type":"url", "value":"https://example.test/report.pdf", "mimeType":"application/pdf"}, "metadata":{"filename":"report.pdf"}})
    );
    assert_eq!(wire["forwardedProps"], original["forwardedProps"]);
    assert_eq!(
        raw, original,
        "request projection must not mutate the caller's retained history"
    );
}

#[test]
fn raw_preparation_validates_activity_before_omitting_it() {
    let result = prepare_run_input_value(
        json!({"threadId":"t", "runId":"r", "messages":[{"id":"a", "role":"activity", "activityType":"progress", "content":"invalid-object"}]}),
    );
    let error = result.unwrap_err();
    assert_eq!(error.category, DiagnosticCategory::InvalidValue);
    assert_eq!(error.path, "/messages/0/content");
}

#[test]
fn raw_preparation_rejects_unconvertible_binary_instead_of_silently_dropping_it() {
    let result = prepare_run_input_value(
        json!({"threadId":"t", "runId":"r", "messages":[{"id":"u", "role":"user", "content":[{"type":"binary", "mimeType":"image/png", "id":"private-id"}]}]}),
    );
    let error = result.unwrap_err();
    assert_eq!(error.path, "/messages/0/content/0/type");
    assert!(!error.to_string().contains("private-id"));
}

#[test]
fn modern_typed_and_raw_preparation_have_the_same_projection() {
    let raw = json!({"threadId":"t", "runId":"r", "messages":[{"id":"u", "role":"user", "content":[{"type":"image", "source":{"type":"url", "value":"https://example.test/image.png", "mimeType":"image/png"}}]}]});
    let typed: RunAgentInput = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(
        prepare_run_input(&typed).unwrap(),
        prepare_run_input_value(raw).unwrap()
    );
}

#[test]
fn raw_projection_preserves_absent_state_but_provides_effective_empty_object() {
    let prepared =
        prepare_run_input_value(json!({"threadId":"t", "runId":"r", "messages":[]})).unwrap();
    assert_eq!(prepared.effective_state, json!({}));
    let wire: Value = serde_json::to_value(prepared.input).unwrap();
    assert!(wire.get("state").is_none());
}
