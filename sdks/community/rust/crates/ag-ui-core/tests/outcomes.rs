use ag_ui_core::{
    event::Event,
    processing::{normalize_event, normalize_producer_event},
    types::{RunFinishedOutcome, SubagentFinishedOutcome},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn assert_roundtrip<T: DeserializeOwned + Serialize>(value: Value) {
    let parsed: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    let parsed: T = serde_json::from_str(&value.to_string()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}

fn assert_rejected<T: DeserializeOwned>(value: Value) {
    assert!(
        serde_json::from_value::<T>(value.clone()).is_err(),
        "{value}"
    );
    assert!(
        serde_json::from_str::<T>(&value.to_string()).is_err(),
        "{value}"
    );
}

#[test]
fn outcome_variants_preserve_canonical_serialization() {
    for value in [
        json!({"type":"success"}),
        json!({"type":"success","pendingToolCallIds":[]}),
        json!({"type":"success","pendingToolCallIds":["call"]}),
        json!({"type":"interrupt","interrupts":[{"id":"i","reason":"approval"}]}),
        json!({"type":"interrupt","interrupts":[{"id":"i","reason":"approval","metadata":{"nested":null}}]}),
        json!({"type":"cancelled"}),
    ] {
        assert_roundtrip::<RunFinishedOutcome>(value.clone());
        let wire = json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":value});
        let event = normalize_event(wire.clone()).unwrap().event.unwrap();
        assert_eq!(normalize_producer_event(&event).unwrap(), wire);
    }
    for value in [
        json!({"type":"success"}),
        json!({"type":"suspended"}),
        json!({"type":"suspended","interruptIds":[]}),
        json!({"type":"suspended","interruptIds":["i"]}),
    ] {
        assert_roundtrip::<SubagentFinishedOutcome>(value.clone());
        let wire = json!({"type":"SUBAGENT_FINISHED","subagentRunId":"sub","outcome":value});
        let event = normalize_event(wire.clone()).unwrap().event.unwrap();
        assert_eq!(normalize_producer_event(&event).unwrap(), wire);
    }
}

#[test]
fn outcome_discriminators_require_known_strings() {
    for value in [
        Value::Null,
        json!(false),
        json!([]),
        json!("success"),
        json!({}),
        json!({"type":null}),
        json!({"type":3}),
        json!({"type":[]}),
        json!({"type":"future"}),
    ] {
        assert_rejected::<RunFinishedOutcome>(value.clone());
        assert_rejected::<SubagentFinishedOutcome>(value);
    }
}

#[test]
fn outcome_array_constraints_are_enforced_by_direct_and_ingress_parsing() {
    for (tag, key) in [
        ("success", "pendingToolCallIds"),
        ("interrupt", "interrupts"),
    ] {
        for value in [
            Value::Null,
            json!(1),
            json!({}),
            json!("id"),
            json!([null]),
            json!([1]),
        ] {
            let outcome = json!({"type":tag,key:value});
            assert_rejected::<RunFinishedOutcome>(outcome.clone());
            let normalized = normalize_event(
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":outcome}),
            );
            if tag == "success" && value.is_null() {
                // Direct producer parsing remains strict; inbound legacy optional
                // nulls use the same omission shim as TypeScript's boundary.
                let normalized = normalized.unwrap();
                assert_eq!(normalized.diagnostics.len(), 1);
                assert_eq!(
                    normalized.diagnostics[0].path,
                    "/outcome/pendingToolCallIds"
                );
            } else {
                assert!(normalized.is_err());
            }
        }
    }
    for interrupts in [
        json!([]),
        json!([{}]),
        json!([{"id":"i"}]),
        json!([{"reason":"approval"}]),
        json!([{"id":4,"reason":"approval"}]),
    ] {
        let outcome = json!({"type":"interrupt","interrupts":interrupts});
        assert_rejected::<RunFinishedOutcome>(outcome.clone());
        assert!(
            normalize_event(
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":outcome})
            )
            .is_err()
        );
    }
    assert_rejected::<RunFinishedOutcome>(json!({"type":"interrupt"}));
    for value in [
        Value::Null,
        json!(1),
        json!({}),
        json!("id"),
        json!([null]),
        json!([1]),
    ] {
        let outcome = json!({"type":"suspended","interruptIds":value});
        assert_rejected::<SubagentFinishedOutcome>(outcome.clone());
        assert!(
            normalize_event(
                json!({"type":"SUBAGENT_FINISHED","subagentRunId":"sub","outcome":outcome})
            )
            .is_err()
        );
    }
}

#[test]
fn every_variant_rejects_unknown_and_cross_variant_fields_before_normalization() {
    for tag in ["success", "interrupt", "cancelled"] {
        for key in [
            "unknown",
            "interruptIds",
            "pendingToolCallIds",
            "interrupts",
        ] {
            if (tag == "success" && key == "pendingToolCallIds")
                || (tag == "interrupt" && key == "interrupts")
            {
                continue;
            }
            let mut outcome = if tag == "interrupt" {
                json!({"type":tag,"interrupts":[{"id":"i","reason":"approval"}]})
            } else {
                json!({"type":tag})
            };
            outcome[key] = json!([]);
            assert_rejected::<RunFinishedOutcome>(outcome.clone());
            let normalized = normalize_event(
                json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":outcome}),
            )
            .unwrap();
            assert_eq!(normalized.diagnostics.len(), 1);
            assert_eq!(normalized.diagnostics[0].path, format!("/outcome/{key}"));
            let event: Event = normalized.event.unwrap();
            assert!(
                normalize_producer_event(&event).unwrap()["outcome"]
                    .get(key)
                    .is_none()
            );
        }
    }
    for tag in ["success", "suspended"] {
        for key in [
            "unknown",
            "interruptIds",
            "pendingToolCallIds",
            "interrupts",
        ] {
            if tag == "suspended" && key == "interruptIds" {
                continue;
            }
            let outcome = json!({"type":tag,key:[]});
            assert_rejected::<SubagentFinishedOutcome>(outcome.clone());
            let normalized = normalize_event(
                json!({"type":"SUBAGENT_FINISHED","subagentRunId":"sub","outcome":outcome}),
            )
            .unwrap();
            assert_eq!(normalized.diagnostics.len(), 1);
            assert_eq!(normalized.diagnostics[0].path, format!("/outcome/{key}"));
            assert!(
                normalize_producer_event(&normalized.event.unwrap()).unwrap()["outcome"]
                    .get(key)
                    .is_none()
            );
        }
    }
}
