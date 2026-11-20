use ag_ui_core::{event::Event, types::AgentCapabilities};
use serde_json::Value;
use std::{collections::BTreeSet, fs, path::PathBuf};

fn shared_fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../fixtures")
        .join(name);
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn null_omission_typed_representation_fixtures_roundtrip() {
    let fixture = shared_fixture("null-omission.json");
    let cases = fixture["stream"].as_array().unwrap();
    assert!(
        cases.len() >= 35,
        "shared fixture inventory unexpectedly shrank"
    );
    let names: BTreeSet<_> = cases
        .iter()
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names.len(),
        cases.len(),
        "duplicate null-omission fixture names"
    );
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let produced_by = case["producedBy"].as_array().unwrap();
        if !produced_by.iter().any(|sdk| sdk == "rust") {
            continue;
        }
        match serde_json::from_value::<Event>(case["input"].clone()) {
            Ok(event) => {
                let actual = serde_json::to_value(event).unwrap();
                if actual != case["expected"] {
                    failures.push(format!(
                        "{name}: expected {}, got {actual}",
                        case["expected"]
                    ));
                }
            }
            Err(error) => failures.push(format!("{name}: {error}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn agent_capabilities_fixtures_roundtrip() {
    let fixture = shared_fixture("agent-capabilities.json");
    let cases = fixture["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 4,
        "shared fixture inventory unexpectedly shrank"
    );
    let names: BTreeSet<_> = cases
        .iter()
        .map(|case| case["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names.len(),
        cases.len(),
        "duplicate capability fixture names"
    );
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let produced_by = case["producedBy"].as_array().unwrap();
        if !produced_by.iter().any(|sdk| sdk == "rust") {
            continue;
        }
        let capabilities: AgentCapabilities = serde_json::from_value(case["input"].clone())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let actual = serde_json::to_value(capabilities).unwrap();
        assert_eq!(actual, case["expected"], "{name}");
    }
}

#[test]
fn run_input_keeps_absent_and_explicitly_empty_collections_distinct() {
    for (tools, context) in [(None, None), (Some(Vec::new()), Some(Vec::new()))] {
        let input = {
            let mut value = ag_ui_core::types::RunAgentInput::new(
                "thread_1",
                "run_1",
                Value::Null,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Value::Null,
            );
            value.tools = tools;
            value.context = context;
            value
        };
        let wire = serde_json::to_value(&input).unwrap();
        assert_eq!(wire.get("tools").is_some(), input.tools.is_some());
        assert_eq!(wire.get("context").is_some(), input.context.is_some());
        let parsed: ag_ui_core::types::RunAgentInput = serde_json::from_value(wire).unwrap();
        assert_eq!(parsed.tools, input.tools);
        assert_eq!(parsed.context, input.context);
    }
}

#[test]
fn run_input_requires_arrays_when_tools_or_context_are_present() {
    let base = serde_json::json!({"threadId":"thread_1","runId":"run_1","messages":[]});
    for field in ["tools", "context"] {
        let mut wire = base.clone();
        wire[field] = Value::Null;
        assert!(
            serde_json::from_value::<ag_ui_core::types::RunAgentInput>(wire).is_err(),
            "{field}: explicit null must be rejected"
        );
    }

    let populated = serde_json::json!({
        "threadId":"thread_1",
        "runId":"run_1",
        "messages":[],
        "tools":[{"name":"search","description":"Search the web"}],
        "context":[{"description":"locale","value":"en-US"}]
    });
    let input: ag_ui_core::types::RunAgentInput =
        serde_json::from_value(populated.clone()).unwrap();
    assert_eq!(serde_json::to_value(input).unwrap(), populated);
}
