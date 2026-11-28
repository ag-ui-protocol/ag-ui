use ag_ui_core::event::Event;
use ag_ui_encoder::encode;
use serde_json::Value;
use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../..")
}
fn schema() -> jsonschema::Validator {
    let value: Value =
        serde_json::from_slice(&fs::read(root().join("spec/1.0/schema.json")).unwrap()).unwrap();
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&value)
        .unwrap()
}
fn payload(event: &Event) -> Value {
    let bytes = encode(event).unwrap();
    serde_json::from_slice(&bytes[6..bytes.len() - 2]).unwrap()
}
#[test]
fn every_shared_null_case_uses_real_encoder_exact_equality_and_independent_schema() {
    let fixture: Value =
        serde_json::from_slice(&fs::read(root().join("sdks/fixtures/null-omission.json")).unwrap())
            .unwrap();
    let cases = fixture["stream"].as_array().unwrap();
    assert!(cases.len() >= 35);
    let schema = schema();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if !case["producedBy"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "rust")
        {
            continue;
        }
        let event: Event = serde_json::from_value(case["input"].clone()).unwrap();
        let actual = payload(&event);
        assert_eq!(actual, case["expected"], "{name}");
        assert!(
            schema.is_valid(&actual),
            "{name}: {:?}",
            schema.iter_errors(&actual).collect::<Vec<_>>()
        );
    }
}
#[test]
fn all_named_valid_event_fixtures_pass_actual_encoder_and_schema() {
    let schema = schema();
    let mut count = 0;
    for dir in fs::read_dir(root().join("spec/1.0/fixtures")).unwrap() {
        let dir = dir.unwrap();
        let name = dir.file_name().into_string().unwrap();
        if !name.ends_with("Event") {
            continue;
        }
        let valid = dir.path().join("valid");
        if !valid.exists() {
            continue;
        }
        for file in fs::read_dir(valid).unwrap() {
            let path = file.unwrap().path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let event: Event = serde_json::from_value(value.clone())
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let actual = payload(&event);
            assert!(
                schema.is_valid(&actual),
                "{}: {:?}",
                path.display(),
                schema.iter_errors(&actual).collect::<Vec<_>>()
            );
            assert_eq!(actual, value, "{}", path.display());
            count += 1;
        }
    }
    assert!(
        count >= 98,
        "event fixture inventory changed; reconcile coverage"
    );
    eprintln!("encoded and independently schema-validated {count} named event fixtures");
}
#[test]
fn independent_schema_oracle_rejects_lost_required_fields_and_wrong_nulls() {
    let schema = schema();
    for invalid in [
        serde_json::json!({"type":"STATE_SNAPSHOT"}),
        serde_json::json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","result":null}),
        serde_json::json!({"type":"TEXT_MESSAGE_START","messageId":"m","role":"tool"}),
    ] {
        assert!(!schema.is_valid(&invalid));
    }
}
