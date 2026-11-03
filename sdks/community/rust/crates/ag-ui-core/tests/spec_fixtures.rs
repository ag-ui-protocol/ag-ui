use ag_ui_core::{event::Event, types::*};
use serde_json::Value;
use std::{fs, path::PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../../spec/1.0/fixtures")
}
fn parse(kind: &str, bytes: &[u8]) -> Result<(), String> {
    macro_rules! typed {
        ($type:ty) => {
            serde_json::from_slice::<$type>(bytes)
                .map(|_| ())
                .map_err(|e| e.to_string())
        };
    }
    match kind {
        "RunAgentInput" => typed!(RunAgentInput),
        "UserMessage" => typed!(Message),
        "ToolMessage" => typed!(Message),
        "Tool" => typed!(Tool),
        "FileSource" => typed!(PartSource),
        "Interrupt" => typed!(Interrupt),
        "ResumeEntry" => typed!(ResumeEntry),
        "SubagentInfo" => typed!(SubagentInfo),
        "AgentCapabilities" => typed!(AgentCapabilities),
        "ExecutionCapabilities" => typed!(ExecutionCapabilities),
        "MultiAgentCapabilities" => typed!(MultiAgentCapabilities),
        _ => typed!(Event),
    }
}
#[test]
fn valid_spec_fixtures_parse() {
    let mut failures = Vec::new();
    let mut count = 0;
    for dir in fs::read_dir(fixtures()).unwrap() {
        let dir = dir.unwrap();
        let kind = dir.file_name().into_string().unwrap();
        let valid = dir.path().join("valid");
        if !valid.exists() {
            continue;
        }
        for entry in fs::read_dir(valid).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            count += 1;
            let bytes = fs::read(&path).unwrap();
            if let Err(error) = parse(&kind, &bytes) {
                failures.push(format!("{}: {}", path.display(), error));
            }
        }
    }
    assert_eq!(
        count, 135,
        "reconcile changed valid representation fixture inventory"
    );
    assert!(
        failures.is_empty(),
        "{} of {} valid fixtures failed:\n{}",
        failures.len(),
        count,
        failures.join("\n")
    );
}
#[test]
fn strict_schema_fixtures_and_diagnostic_companions() {
    use jsonschema::error::{ValidationError, ValidationErrorKind};
    use std::collections::{BTreeMap, BTreeSet};
    fn errors(error: &ValidationError<'_>, out: &mut Vec<(String, String)>) {
        out.push((
            error.instance_path.to_string(),
            error.schema_path.to_string(),
        ));
        match &error.kind {
            ValidationErrorKind::AnyOf { context }
            | ValidationErrorKind::OneOfNotValid { context }
            | ValidationErrorKind::OneOfMultipleValid { context } => {
                for error in context.iter().flatten() {
                    errors(error, out);
                }
            }
            _ => {}
        }
    }
    fn walk(root: &std::path::Path, path: &std::path::Path, output: &mut BTreeSet<String>) {
        for entry in fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, output);
            } else if path
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                output.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    let root = fixtures();
    let names: Vec<String> = fs::read_to_string(root.join("MANIFEST.txt"))
        .unwrap()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect();
    let listed: BTreeSet<String> = names.iter().cloned().collect();
    assert_eq!(
        names.len(),
        listed.len(),
        "duplicate schema manifest entries"
    );
    let mut found = BTreeSet::new();
    walk(&root, &root, &mut found);
    assert_eq!(
        listed, found,
        "schema manifest must cover every document and companion both ways"
    );
    let schema: Value =
        serde_json::from_slice(&fs::read(root.join("../schema.json")).unwrap()).unwrap();
    let mut validators = BTreeMap::new();
    let mut valid = 0;
    let mut invalid = 0;
    let mut companions = 0;
    let mut failures = Vec::new();
    for name in &names {
        if name.ends_with(".expect.json") {
            companions += 1;
            continue;
        }
        let anchor = name.split('/').next().unwrap();
        let validator = validators.entry(anchor.to_string()).or_insert_with(|| {
            let mut selected = schema.clone();
            assert!(
                selected["$defs"].get(anchor).is_some(),
                "unknown anchor {anchor}"
            );
            selected["$ref"] = serde_json::json!(format!("#/$defs/{anchor}"));
            jsonschema::validator_for(&selected)
                .expect("independent pinned 2020-12 schema compiles")
        });
        let document: Value = serde_json::from_slice(&fs::read(root.join(name)).unwrap()).unwrap();
        let mut reported = Vec::new();
        for error in validator.iter_errors(&document) {
            errors(&error, &mut reported);
        }
        if name.contains("/valid/") {
            valid += 1;
            if !reported.is_empty() {
                failures.push(format!("{name}: rejected valid fixture: {reported:?}"));
            }
        } else {
            invalid += 1;
            let companion = name.strip_suffix(".json").unwrap().to_string() + ".expect.json";
            assert!(
                listed.contains(&companion),
                "missing diagnostic companion {companion}"
            );
            let expected: Value =
                serde_json::from_slice(&fs::read(root.join(companion)).unwrap()).unwrap();
            assert_eq!(
                expected
                    .as_object()
                    .unwrap()
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>(),
                BTreeSet::from(["keyword", "instanceLocation", "keywordLocation"]),
                "unknown diagnostic companion key"
            );
            let instance = expected["instanceLocation"].as_str().unwrap();
            let keyword = expected["keyword"].as_str().unwrap();
            let keyword_location = expected["keywordLocation"].as_str().unwrap();
            let matched = reported.iter().any(|(actual_instance, actual_schema)| {
                actual_instance == instance
                    && actual_schema.rsplit('/').next() == Some(keyword)
                    && diagnostic_location_matches(&schema, anchor, actual_schema, keyword_location)
            });
            if !matched {
                failures.push(format!(
                    "{name}: expected {expected}, reported {reported:?}"
                ));
            }
        }
    }
    assert_eq!(
        (valid, invalid, companions),
        (135, 84, 84),
        "review and reconcile any corpus inventory change"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// jsonschema reports evaluation paths, including each `$ref` traversal;
/// AJV reports a schema pointer relative to the last compiled definition or an
/// absolute `$defs` pointer. Resolve every reference against the pinned schema
/// and retain both exact locations. No keyword-only or instance-only matching.
fn diagnostic_location_matches(schema: &Value, anchor: &str, actual: &str, expected: &str) -> bool {
    let mut selected = schema.clone();
    selected["$ref"] = serde_json::json!(format!("#/$defs/{anchor}"));
    let mut node = &selected;
    let mut absolute = String::new();
    let mut relative = String::new();
    for segment in actual.strip_prefix('/').unwrap().split('/') {
        if segment == "$ref" {
            let reference = node["$ref"]
                .as_str()
                .expect("evaluation reference must exist");
            absolute = reference
                .strip_prefix('#')
                .expect("local pinned reference")
                .to_string();
            node = schema
                .pointer(&absolute)
                .expect("referenced schema must exist");
            relative.clear();
        } else {
            node = match node {
                Value::Array(items) => {
                    &items[segment.parse::<usize>().expect("schema array index")]
                }
                Value::Object(fields) => fields.get(segment).expect("reported keyword must exist"),
                _ => panic!("evaluation path traversed a non-container"),
            };
            absolute.push('/');
            absolute.push_str(segment);
            relative.push('/');
            relative.push_str(segment);
        }
    }
    let expected = expected
        .strip_prefix('#')
        .expect("companion schema pointer");
    expected == absolute || (!expected.starts_with("/$defs/") && expected == relative)
}

#[test]
fn schema_diagnostic_mapping_rejects_changed_rule_locations() {
    let schema: Value =
        serde_json::from_slice(&fs::read(fixtures().join("../schema.json")).unwrap()).unwrap();
    let actual = "/$ref/properties/execution/$ref/properties/maxIterations/type";
    assert!(diagnostic_location_matches(
        &schema,
        "AgentCapabilities",
        actual,
        "#/$defs/ExecutionCapabilities/properties/maxIterations/type"
    ));
    assert!(diagnostic_location_matches(
        &schema,
        "AgentCapabilities",
        actual,
        "#/properties/maxIterations/type"
    ));
    assert!(!diagnostic_location_matches(
        &schema,
        "AgentCapabilities",
        actual,
        "#/$defs/TransportCapabilities/properties/maxIterations/type"
    ));
    assert!(!diagnostic_location_matches(
        &schema,
        "AgentCapabilities",
        actual,
        "#/properties/maxExecutionTime/type"
    ));
    assert!(!diagnostic_location_matches(
        &schema,
        "AgentCapabilities",
        actual,
        "#/properties/maxIterations/maximum"
    ));
}

#[test]
fn opaque_ids_and_optional_fields_roundtrip() {
    let wire =
        serde_json::json!({"type":"RUN_STARTED","threadId":"thread/with spaces:☃","runId":"run-α"});
    let event: Event = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(event).unwrap(), wire);
    let input: RunAgentInput = serde_json::from_value(
        serde_json::json!({"threadId":"any string","runId":"r-1","messages":[]}),
    )
    .unwrap();
    let encoded = serde_json::to_value(&input).unwrap();
    assert_eq!(encoded["threadId"], "any string");
    assert!(encoded.get("protocolVersion").is_none());
    assert!(encoded.get("parentRunId").is_none());
    assert!(encoded.get("resume").is_none());
    let message: Message = serde_json::from_value(serde_json::json!({"id":"m-with / punctuation","role":"user","content":[{"type":"text","text":"hello"}]})).unwrap();
    assert_eq!(
        serde_json::to_value(message).unwrap()["id"],
        "m-with / punctuation"
    );
}

#[test]
fn valid_event_and_input_fixtures_use_public_ingress_without_data_loss() {
    use ag_ui_core::processing::{normalize_event, normalize_run_input};
    let mut tested = 0;
    let mut failures = Vec::new();
    for entry in fs::read_dir(fixtures()).unwrap() {
        let entry = entry.unwrap();
        let anchor = entry.file_name().into_string().unwrap();
        if !anchor.ends_with("Event") && anchor != "RunAgentInput" {
            continue;
        }
        let directory = entry.path().join("valid");
        if !directory.is_dir() {
            continue;
        }
        for file in fs::read_dir(directory).unwrap() {
            let path = file.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let result = (|| -> Result<(), String> {
                let (actual, diagnostics) = if anchor == "RunAgentInput" {
                    let processed =
                        normalize_run_input(raw.clone()).map_err(|error| error.to_string())?;
                    let effective = raw
                        .get("state")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    if processed.effective_state != effective {
                        return Err("wrong effective state".into());
                    }
                    (
                        serde_json::to_value(processed.input).unwrap(),
                        processed.diagnostics,
                    )
                } else {
                    let processed =
                        normalize_event(raw.clone()).map_err(|error| error.to_string())?;
                    (
                        serde_json::to_value(processed.event.ok_or("valid event dropped")?)
                            .unwrap(),
                        processed.diagnostics,
                    )
                };
                if !diagnostics.is_empty() {
                    return Err(format!("unwanted diagnostics: {diagnostics:?}"));
                }
                if actual != raw {
                    return Err(format!(
                        "ingress lost or manufactured payload; expected {raw}; got {actual}"
                    ));
                }
                Ok(())
            })();
            if let Err(error) = result {
                failures.push(format!("{}: {error}", path.display()));
            }
            tested += 1;
        }
    }
    println!("{tested} valid event/input fixtures verified through public ingress");
    assert_eq!(
        tested, 109,
        "reconcile changed event/input production fixture inventory"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
