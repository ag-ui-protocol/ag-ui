use ag_ui_core::types::{AgentCapabilities, ExecutionCapabilities};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

fn validator(anchor: &str) -> jsonschema::Validator {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../../spec/1.0/schema.json");
    let mut schema: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    schema["$ref"] = json!(format!("#/$defs/{anchor}"));
    jsonschema::validator_for(&schema).expect("independent pinned schema compiles")
}

fn execution(field: &str, value: Option<u64>) -> ExecutionCapabilities {
    match field {
        "maxIterations" => {
            let mut execution = ExecutionCapabilities::default();
            execution.max_iterations = value;
            execution
        }
        "maxExecutionTime" => {
            let mut execution = ExecutionCapabilities::default();
            execution.max_execution_time = value;
            execution
        }
        _ => unreachable!(),
    }
}

#[test]
fn constructed_capabilities_emit_schema_valid_safe_integers_and_omit_absence() {
    let execution_schema = validator("ExecutionCapabilities");
    let agent_schema = validator("AgentCapabilities");
    for field in ["maxIterations", "maxExecutionTime"] {
        for value in [None, Some(0), Some(MAX_SAFE_JSON_INTEGER)] {
            let execution = execution(field, value);
            let expected = value.map_or_else(|| json!({}), |value| json!({field: value}));
            // Validate actual public serialization, not just the authored expectation.
            let bytes = serde_json::to_vec(&execution).unwrap();
            let emitted: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(emitted, expected);
            execution_schema.validate(&emitted).unwrap();
            assert_eq!(
                serde_json::from_slice::<ExecutionCapabilities>(&bytes).unwrap(),
                execution
            );

            let agent = {
                let mut value = AgentCapabilities::default();
                value.execution = Some(execution);
                value
            };
            let bytes = serde_json::to_vec(&agent).unwrap();
            let emitted: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(emitted, json!({"execution": expected}));
            agent_schema.validate(&emitted).unwrap();
            assert_eq!(
                serde_json::from_slice::<AgentCapabilities>(&bytes).unwrap(),
                agent
            );
        }
    }

    let omitted = serde_json::to_value(AgentCapabilities::default()).unwrap();
    assert_eq!(omitted, json!({}));
    agent_schema.validate(&omitted).unwrap();
}

#[test]
fn constructed_capabilities_reject_unsafe_integers_directly_and_when_nested() {
    let execution_schema = validator("ExecutionCapabilities");
    let agent_schema = validator("AgentCapabilities");
    for field in ["maxIterations", "maxExecutionTime"] {
        for value in [MAX_SAFE_JSON_INTEGER + 1, u64::MAX] {
            let execution = execution(field, Some(value));
            assert!(
                serde_json::to_vec(&execution).is_err(),
                "{field} serialized unsafe integer {value}"
            );
            let agent = {
                let mut value = AgentCapabilities::default();
                value.execution = Some(execution);
                value
            };
            assert!(serde_json::to_vec(&agent).is_err());

            let raw = json!({field: value});
            assert!(execution_schema.validate(&raw).is_err());
            assert!(serde_json::from_value::<ExecutionCapabilities>(raw.clone()).is_err());
            let nested = json!({"execution": raw});
            assert!(agent_schema.validate(&nested).is_err());
            assert!(serde_json::from_value::<AgentCapabilities>(nested).is_err());
        }
    }
}
