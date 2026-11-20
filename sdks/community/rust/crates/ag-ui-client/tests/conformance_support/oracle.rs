//! Independent assertions over observations, never over fixture input events.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const EXPECTATION_KEYS: [&str; 14] = [
    "outcome",
    "errorContains",
    "runError",
    "eventTypes",
    "eventTypesAbsent",
    "eventPaths",
    "eventAbsentPaths",
    "warnings",
    "noWarnings",
    "messageCount",
    "messages",
    "state",
    "request",
    "requestAbsentPaths",
];

#[derive(Debug, Clone, Default)]
pub struct Observation {
    pub error: Option<String>,
    pub events: Vec<Value>,
    pub warnings: Vec<String>,
    pub messages: Vec<Value>,
    pub state: Value,
    pub request: Value,
    pub request_headers: BTreeMap<String, String>,
    pub request_bytes: Vec<u8>,
}

pub fn subset(actual: &Value, expected: &Value, path: &str) -> Result<(), String> {
    match expected {
        Value::Object(fields) => {
            let actual = actual
                .as_object()
                .ok_or_else(|| format!("{path}: expected object, got {actual}"))?;
            for (key, value) in fields {
                let next = format!("{path}.{key}");
                let actual = actual
                    .get(key)
                    .ok_or_else(|| format!("{next}: missing property"))?;
                subset(actual, value, &next)?;
            }
        }
        Value::Array(items) => {
            let actual = actual
                .as_array()
                .ok_or_else(|| format!("{path}: expected array, got {actual}"))?;
            if actual.len() != items.len() {
                return Err(format!(
                    "{path}: array length {} != {}",
                    actual.len(),
                    items.len()
                ));
            }
            for (index, (actual, expected)) in actual.iter().zip(items).enumerate() {
                subset(actual, expected, &format!("{path}[{index}]"))?;
            }
        }
        _ if actual != expected => {
            return Err(format!("{path}: expected {expected}, got {actual}"));
        }
        _ => {}
    }
    Ok(())
}

/// Unlike Value indexing, this distinguishes absent from an explicit null.
pub fn at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(value, |value, segment| match value {
            Value::Object(object) => object.get(segment),
            Value::Array(array) => segment
                .parse::<usize>()
                .ok()
                .and_then(|index| array.get(index)),
            _ => None,
        })
}

pub fn validate_expectation(expected: &Value) -> Result<(), String> {
    let fields = expected.as_object().ok_or("expect must be an object")?;
    let mut effective = false;
    for (key, value) in fields {
        if !EXPECTATION_KEYS.contains(&key.as_str()) {
            return Err(format!("unknown expectation key {key}"));
        }
        let string_array = || {
            value
                .as_array()
                .is_some_and(|items| items.iter().all(Value::is_string))
        };
        let shape = match key.as_str() {
            "outcome" => matches!(value.as_str(), Some("completed" | "failed")),
            "errorContains" => value.is_string(),
            "runError" => value.is_boolean() || value.is_string(),
            "eventTypes" | "eventTypesAbsent" | "eventAbsentPaths" | "warnings"
            | "requestAbsentPaths" => string_array(),
            "eventPaths" | "request" => value.is_object(),
            "noWarnings" => value.is_boolean(),
            "messageCount" => value.as_u64().is_some(),
            "messages" => value.is_array(),
            "state" => true,
            _ => unreachable!(),
        };
        if !shape {
            return Err(format!("{key}: invalid expectation shape {value}"));
        }
        effective |= match key.as_str() {
            "outcome" => false,
            "errorContains" => value.as_str().is_some_and(|s| !s.is_empty()),
            "runError" => value == true || value.as_str().is_some_and(|s| !s.is_empty()),
            "noWarnings" => value == true,
            "eventTypesAbsent" | "eventAbsentPaths" | "warnings" | "requestAbsentPaths" => {
                !value.as_array().unwrap().is_empty()
            }
            "eventPaths" | "request" => !value.as_object().unwrap().is_empty(),
            _ => true,
        };
    }
    if !effective {
        return Err("fixture has no effective assertion beyond outcome".into());
    }
    if expected.get("outcome").and_then(Value::as_str) == Some("failed")
        && expected
            .get("errorContains")
            .and_then(Value::as_str)
            .is_none_or(|s| s.is_empty())
    {
        return Err("client failure must name its rejection reason".into());
    }
    Ok(())
}

pub fn check(actual: &Observation, expected: &Value) -> Result<(), String> {
    validate_expectation(expected)?;
    let events = Value::Array(actual.events.clone());
    for (key, expected) in expected.as_object().unwrap() {
        match key.as_str() {
            "outcome" => {
                let actual_outcome = if actual.error.is_some() {
                    "failed"
                } else {
                    "completed"
                };
                if expected != actual_outcome {
                    return Err(format!(
                        "outcome: expected {expected}, got {actual_outcome}: {:?}",
                        actual.error
                    ));
                }
            }
            "errorContains" => {
                if let Some(fragment) = expected.as_str().filter(|s| !s.is_empty())
                    && !actual
                        .error
                        .as_ref()
                        .is_some_and(|error| error.contains(fragment))
                {
                    return Err(format!(
                        "errorContains: expected {fragment:?}, got {:?}",
                        actual.error
                    ));
                }
            }
            "runError" => {
                let reported: Vec<_> = actual
                    .events
                    .iter()
                    .filter(|event| event.get("type").and_then(Value::as_str) == Some("RUN_ERROR"))
                    .collect();
                let matches = match expected {
                    Value::Bool(wanted) => *wanted != reported.is_empty(),
                    Value::String(fragment) => reported.iter().any(|event| {
                        event
                            .get("message")
                            .and_then(Value::as_str)
                            .is_some_and(|s| s.contains(fragment))
                    }),
                    _ => unreachable!(),
                };
                if !matches {
                    return Err(format!(
                        "runError: expected {expected}, delivered {reported:?}"
                    ));
                }
            }
            "eventTypes" => {
                let types = Value::Array(
                    actual
                        .events
                        .iter()
                        .map(|event| event.get("type").cloned().unwrap_or(Value::Null))
                        .collect(),
                );
                if &types != expected {
                    return Err(format!("eventTypes: expected {expected}, got {types}"));
                }
            }
            "eventTypesAbsent" => {
                for forbidden in expected.as_array().unwrap() {
                    if actual
                        .events
                        .iter()
                        .any(|event| event.get("type") == Some(forbidden))
                    {
                        return Err(format!("eventTypesAbsent: delivered {forbidden}"));
                    }
                }
            }
            "eventPaths" => {
                for (path, expected) in expected.as_object().unwrap() {
                    let found = at_path(&events, path)
                        .ok_or_else(|| format!("eventPaths.{path}: missing"))?;
                    if found != expected {
                        return Err(format!(
                            "eventPaths.{path}: expected {expected}, got {found}"
                        ));
                    }
                }
            }
            "eventAbsentPaths" | "requestAbsentPaths" => {
                let target = if key == "eventAbsentPaths" {
                    &events
                } else {
                    &actual.request
                };
                for path in expected.as_array().unwrap() {
                    let path = path.as_str().unwrap();
                    if at_path(target, path).is_some() {
                        return Err(format!("{key}.{path}: present"));
                    }
                }
            }
            "warnings" => {
                for fragment in expected.as_array().unwrap() {
                    let fragment = fragment.as_str().unwrap();
                    if !actual
                        .warnings
                        .iter()
                        .any(|warning| warning.contains(fragment))
                    {
                        return Err(format!(
                            "warnings: missing {fragment:?} in {:?}",
                            actual.warnings
                        ));
                    }
                }
            }
            "noWarnings" => {
                if expected == true && !actual.warnings.is_empty() {
                    return Err(format!("noWarnings: got {:?}", actual.warnings));
                }
            }
            "messageCount" => {
                if expected.as_u64().unwrap() != actual.messages.len() as u64 {
                    return Err(format!(
                        "messageCount: expected {expected}, got {}",
                        actual.messages.len()
                    ));
                }
            }
            "messages" => subset(&Value::Array(actual.messages.clone()), expected, "messages")?,
            "state" => subset(&actual.state, expected, "state")?,
            "request" => subset(&actual.request, expected, "request")?,
            _ => unreachable!(),
        }
    }
    Ok(())
}

pub fn manifest_matches(names: &[String], found: &BTreeSet<String>) -> Result<(), String> {
    let listed: BTreeSet<_> = names.iter().cloned().collect();
    if listed.len() != names.len() {
        return Err("duplicate manifest entries".into());
    }
    if &listed != found {
        return Err(format!(
            "manifest mismatch: missing {:?}; unlisted {:?}",
            listed.difference(found).collect::<Vec<_>>(),
            found.difference(&listed).collect::<Vec<_>>()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod negative_controls {
    use super::*;
    use serde_json::json;

    fn observation() -> Observation {
        Observation {
            events: vec![
                json!({"type":"STATE_DELTA","delta":[{"op":"remove","path":"/x","value":null}]}),
            ],
            messages: vec![json!({"id":"m","metadata":{"trace":null}})],
            state: json!({"kept":1,"extra":true}),
            warnings: vec!["UnknownField /future: stripped".into()],
            request: json!({"threadId":"t","state":{"x":null}}),
            ..Default::default()
        }
    }

    #[test]
    fn dropped_event_is_detected() {
        let expected = json!({"outcome":"completed","eventTypes":["STATE_DELTA"]});
        let mut actual = observation();
        check(&actual, &expected).unwrap();
        actual.events.clear();
        assert!(check(&actual, &expected).is_err());
    }

    #[test]
    fn lost_patch_extra_is_detected() {
        let expected = json!({"eventPaths":{"0.delta.0.value":null}});
        let mut actual = observation();
        check(&actual, &expected).unwrap();
        actual.events[0]["delta"][0]
            .as_object_mut()
            .unwrap()
            .remove("value");
        assert!(check(&actual, &expected).is_err());
    }

    #[test]
    fn lost_metadata_key_and_missing_instead_of_null_are_detected() {
        let expected = json!({"messages":[{"metadata":{"trace":null}}]});
        let mut actual = observation();
        check(&actual, &expected).unwrap();
        actual.messages[0]["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("trace");
        assert!(check(&actual, &expected).is_err());
        assert!(subset(&json!(null), &json!({}), "object").is_err());
        assert!(subset(&json!({}), &json!({"x":null}), "missing").is_err());
        assert!(subset(&json!([1, 2]), &json!([1]), "array").is_err());
        subset(&actual.state, &json!({"kept":1}), "state").unwrap();
        assert_eq!(at_path(&json!({"x":null}), "x"), Some(&Value::Null));
        assert_eq!(at_path(&json!({}), "x"), None);
    }

    #[test]
    fn required_and_unwanted_warnings_are_detected() {
        let mut actual = observation();
        check(&actual, &json!({"warnings":["/future"]})).unwrap();
        assert!(check(&actual, &json!({"noWarnings":true})).is_err());
        actual.warnings.clear();
        assert!(check(&actual, &json!({"warnings":["/future"]})).is_err());
        check(&actual, &json!({"noWarnings":true})).unwrap();
    }

    #[test]
    fn changed_request_and_present_null_are_detected() {
        let expected = json!({"request":{"threadId":"t","state":{"x":null}}});
        let mut actual = observation();
        check(&actual, &expected).unwrap();
        actual.request["threadId"] = json!("wrong");
        assert!(check(&actual, &expected).is_err());
        assert!(check(&actual, &json!({"requestAbsentPaths":["state.x"]})).is_err());
        check(&actual, &json!({"requestAbsentPaths":["state.absent"]})).unwrap();
    }

    #[test]
    fn consumer_exception_is_never_a_producer_run_error() {
        let mut actual = observation();
        actual.error = Some("socket closed".into());
        assert!(
            check(
                &actual,
                &json!({"outcome":"failed","errorContains":"socket","runError":true})
            )
            .is_err()
        );
        check(
            &actual,
            &json!({"outcome":"failed","errorContains":"socket","runError":false}),
        )
        .unwrap();
        actual.error = None;
        actual
            .events
            .push(json!({"type":"RUN_ERROR","message":"producer unavailable"}));
        check(
            &actual,
            &json!({"outcome":"completed","runError":"producer unavailable"}),
        )
        .unwrap();
    }

    #[test]
    fn mutated_manifest_and_unknown_expectation_fail_closed() {
        let found = BTreeSet::from(["actual.json".into()]);
        manifest_matches(&["actual.json".into()], &found).unwrap();
        assert!(manifest_matches(&["missing.json".into()], &found).is_err());
        assert!(manifest_matches(&["actual.json".into(), "actual.json".into()], &found).is_err());
        let mut temporary_fixture = json!({"outcome":"completed","messageCount":0});
        validate_expectation(&temporary_fixture).unwrap();
        temporary_fixture["messageCounts"] = json!(0);
        assert!(validate_expectation(&temporary_fixture).is_err());
        for vacuous in [
            json!({"outcome":"completed"}),
            json!({"outcome":"completed","warnings":[]}),
            json!({"outcome":"completed","request":{}}),
        ] {
            assert!(validate_expectation(&vacuous).is_err());
        }
    }

    #[test]
    fn every_expectation_key_is_known_and_checked() {
        assert_eq!(EXPECTATION_KEYS.iter().collect::<BTreeSet<_>>().len(), 14);
        let mut actual = observation();
        actual.warnings.clear();
        check(
            &actual,
            &json!({
                "outcome":"completed","errorContains":"","runError":false,
                "eventTypes":["STATE_DELTA"],"eventTypesAbsent":["RUN_ERROR"],
                "eventPaths":{"0.delta.0.value":null},"eventAbsentPaths":["0.missing"],
                "warnings":[],"noWarnings":true,"messageCount":1,
                "messages":[{"id":"m","metadata":{"trace":null}}],"state":{"kept":1},
                "request":{"threadId":"t"},"requestAbsentPaths":["missing"]
            }),
        )
        .unwrap();
    }
}
