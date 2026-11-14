use ag_ui_core::{compatibility::*, processing::DiagnosticCategory};
use serde_json::{Value, json};

fn normalize(boundary: &mut CompatibilityBoundary, value: Value) -> Value {
    serde_json::to_value(
        boundary
            .normalize_event::<Value>(value)
            .unwrap()
            .event
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn legacy_reasoning_tracks_span_and_message_ids_independently() {
    let mut boundary = CompatibilityBoundary::new();
    let span = normalize(
        &mut boundary,
        json!({"type":"THINKING_START","title":"private-title","timestamp":12}),
    );
    let start = normalize(&mut boundary, json!({"type":"THINKING_TEXT_MESSAGE_START"}));
    let content = normalize(
        &mut boundary,
        json!({"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"private-content"}),
    );
    let end = normalize(&mut boundary, json!({"type":"THINKING_TEXT_MESSAGE_END"}));
    let span_end = normalize(&mut boundary, json!({"type":"THINKING_END"}));
    assert_eq!(span["type"], "REASONING_START");
    assert_eq!(span["timestamp"], 12);
    assert!(span.get("title").is_none());
    assert_eq!(start["role"], "reasoning");
    assert_ne!(span["messageId"], start["messageId"]);
    assert_eq!(start["messageId"], content["messageId"]);
    assert_eq!(start["messageId"], end["messageId"]);
    assert_eq!(span["messageId"], span_end["messageId"]);
    assert_eq!(content["delta"], "private-content");
}

#[test]
fn orphan_and_loss_diagnostics_are_explicit_without_values() {
    let mut boundary = CompatibilityBoundary::new();
    let loss = boundary
        .normalize_event::<Value>(json!({"type":"THINKING_START","title":"secret-title"}))
        .unwrap();
    assert_eq!(loss.diagnostics.len(), 2);
    assert!(
        loss.diagnostics
            .iter()
            .all(|d| d.category == DiagnosticCategory::DeprecatedEvent
                && !d.message.contains("secret-title"))
    );
    let orphan = boundary
        .normalize_event::<Value>(
            json!({"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"secret-content"}),
        )
        .unwrap();
    assert_eq!(orphan.diagnostics.len(), 2);
    assert!(orphan.diagnostics[1].message.contains("no opener"));
    assert!(!format!("{:?}", orphan.diagnostics).contains("secret-content"));
}

#[test]
fn state_is_reset_for_each_run_and_boundary() {
    let mut boundary = CompatibilityBoundary::new();
    let start = normalize(&mut boundary, json!({"type":"THINKING_TEXT_MESSAGE_START"}));
    normalize(
        &mut boundary,
        json!({"type":"RUN_STARTED","threadId":"t","runId":"r"}),
    );
    let orphan = boundary
        .normalize_event::<Value>(json!({"type":"THINKING_TEXT_MESSAGE_END"}))
        .unwrap();
    assert_eq!(orphan.diagnostics.len(), 2);
    assert_ne!(
        serde_json::to_value(orphan.event.unwrap()).unwrap()["messageId"],
        start["messageId"]
    );
    let mut other = CompatibilityBoundary::new();
    assert_eq!(
        other
            .normalize_event::<Value>(json!({"type":"THINKING_END"}))
            .unwrap()
            .diagnostics
            .len(),
        2
    );
}

#[test]
fn binaries_upgrade_all_mime_types_and_data_precedes_url() {
    let mut message = json!({"role":"user","id":"u","content":[
        {"type":"binary","mimeType":"image/png","data":"secret-image","url":"ignored","filename":"image.png"},
        {"type":"binary","mimeType":"audio/wav","url":"secret-audio"},
        {"type":"binary","mimeType":"video/mp4","data":"secret-video"},
        {"type":"binary","mimeType":"application/pdf","data":"secret-pdf"}
    ]});
    let diagnostics = upgrade_message_content(&mut message, "/messages/0");
    assert_eq!(diagnostics.len(), 4);
    assert!(!format!("{diagnostics:?}").contains("secret"));
    let parts = message["content"].as_array().unwrap();
    for (part, kind) in parts.iter().zip(["image", "audio", "video", "document"]) {
        assert_eq!(part["type"], kind);
    }
    assert_eq!(parts[0]["source"]["type"], "data");
    assert_eq!(parts[0]["metadata"]["filename"], "image.png");
    assert_eq!(parts[1]["source"]["type"], "url");
}

#[test]
fn mirrors_are_removed_only_against_originals_retaining_filenames() {
    let binary =
        json!({"type":"binary","mimeType":"image/png","data":"image","filename":"photo.png"});
    let modern = json!({"type":"image","source":{"type":"data","value":"image","mimeType":"image/png"},"metadata":{"filename":"photo.png"}});
    let mut message = json!({"content":[binary.clone(), modern.clone(), modern.clone()]});
    upgrade_message_content(&mut message, "");
    assert_eq!(message["content"], json!([modern.clone(), modern]));
    let mut repeated = json!({"content":[binary.clone(),binary.clone()]});
    upgrade_message_content(&mut repeated, "");
    assert_eq!(repeated["content"].as_array().unwrap().len(), 2);
    let mut no_filename = json!({"content":[binary,{"type":"image","source":{"type":"data","value":"image","mimeType":"image/png"}}]});
    upgrade_message_content(&mut no_filename, "");
    assert_eq!(no_filename["content"].as_array().unwrap().len(), 2);
}

#[test]
fn snapshot_and_run_input_are_upgraded_but_opaque_payloads_are_not() {
    let messages = json!([{"role":"user","id":"u","content":[{"type":"binary","mimeType":"image/png","data":"image"}]}]);
    let mut boundary = CompatibilityBoundary::new();
    let snapshot = normalize(
        &mut boundary,
        json!({"type":"MESSAGES_SNAPSHOT","messages":messages.clone()}),
    );
    assert_eq!(snapshot["messages"][0]["content"][0]["type"], "image");
    let run = normalize(
        &mut boundary,
        json!({"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":messages.clone(),"state":{"messages":messages}}}),
    );
    assert_eq!(run["input"]["messages"][0]["content"][0]["type"], "image");
    assert_eq!(
        run["input"]["state"]["messages"][0]["content"][0]["type"],
        "binary"
    );
}

#[test]
fn unconvertible_parts_warn_and_then_normal_processing_drops_them() {
    let mut boundary = CompatibilityBoundary::new();
    let result = boundary.normalize_event::<Value>(json!({"type":"MESSAGES_SNAPSHOT","messages":[{"role":"user","id":"u","content":[{"type":"binary","mimeType":"image/png","id":"secret-id"}]}]})).unwrap();
    assert_eq!(
        result.diagnostics[0].category,
        DiagnosticCategory::DeprecatedEvent
    );
    assert!(!format!("{:?}", result.diagnostics).contains("secret-id"));
    assert_eq!(
        serde_json::to_value(result.event.unwrap()).unwrap()["messages"][0]["content"],
        json!([])
    );
}

#[test]
fn combined_diagnostics_remain_bounded_and_count_every_omission() {
    let messages: Vec<_> = (0..400).map(|i| json!({"role":"user","id":i.to_string(),"extra":"private","content":[{"type":"binary","mimeType":"image/png","data":"private"}]})).collect();
    let mut boundary = CompatibilityBoundary::new();
    let result = boundary
        .normalize_event::<Value>(json!({"type":"MESSAGES_SNAPSHOT","messages":messages}))
        .unwrap();
    assert_eq!(result.diagnostics.len(), 257);
    assert_eq!(
        result.diagnostics[256].category,
        DiagnosticCategory::DiagnosticLimit
    );
    assert_eq!(
        result.diagnostics[256].message,
        "544 more diagnostics omitted"
    );
}

#[test]
fn modern_stream_is_unchanged_and_unknown_legacy_names_are_not_guessed() {
    let mut boundary = CompatibilityBoundary::new();
    let modern = json!({"type":"REASONING_MESSAGE_START","messageId":"m","role":"reasoning"});
    let result = boundary.normalize_event::<Value>(modern.clone()).unwrap();
    assert!(result.diagnostics.is_empty());
    assert_eq!(serde_json::to_value(result.event.unwrap()).unwrap(), modern);
    assert!(
        boundary
            .normalize_event::<Value>(json!({"type":"THINKING_UNKNOWN"}))
            .unwrap()
            .event
            .is_none()
    );
}

#[test]
fn failed_legacy_openers_and_closers_do_not_change_translation_state() {
    let mut boundary = CompatibilityBoundary::new();
    let original = normalize(&mut boundary, json!({"type":"THINKING_TEXT_MESSAGE_START"}));
    assert!(
        boundary
            .normalize_event::<Value>(
                json!({"type":"THINKING_TEXT_MESSAGE_START","timestamp":"invalid"})
            )
            .is_err()
    );
    let content = normalize(
        &mut boundary,
        json!({"type":"THINKING_TEXT_MESSAGE_CONTENT","delta":"a"}),
    );
    assert_eq!(content["messageId"], original["messageId"]);
    assert!(
        boundary
            .normalize_event::<Value>(
                json!({"type":"THINKING_TEXT_MESSAGE_END","timestamp":"invalid"})
            )
            .is_err()
    );
    let end = normalize(&mut boundary, json!({"type":"THINKING_TEXT_MESSAGE_END"}));
    assert_eq!(end["messageId"], original["messageId"]);
    let orphan = boundary
        .normalize_event::<Value>(json!({"type":"THINKING_TEXT_MESSAGE_END"}))
        .unwrap();
    assert_eq!(orphan.diagnostics.len(), 2);
}

#[test]
fn outgoing_lossless_conversion_is_quiet_but_unconvertible_parts_warn() {
    let mut input = json!({"messages":[{"content":[
        {"type":"binary","mimeType":"image/png","data":"image"},
        {"type":"image","source":{"type":"data","value":"image","mimeType":"image/png"}},
        {"type":"binary","mimeType":"application/pdf","url":"document"}
    ]}]});
    assert!(upgrade_outgoing_messages(&mut input, "").is_empty());
    assert_eq!(input["messages"][0]["content"].as_array().unwrap().len(), 2);
    assert_eq!(input["messages"][0]["content"][1]["type"], "document");
    input["messages"][0]["content"] =
        json!([{"type":"binary","mimeType":"image/png","id":"private-id"}]);
    let diagnostics = upgrade_outgoing_messages(&mut input, "");
    assert_eq!(diagnostics.len(), 1);
    assert!(!format!("{diagnostics:?}").contains("private-id"));
}
