use ag_ui_core::{event::*, processing::*, types::*};
use serde_json::{Value, json};

fn input() -> Value {
    json!({"threadId":"thread", "runId":"run", "messages":[]})
}
fn wire(event: Event) -> Value {
    serde_json::to_value(event).unwrap()
}

#[test]
fn input_unknown_closed_fields_do_not_touch_opaque_json() {
    let raw = json!({"threadId":"t","runId":"r","messages":[{"role":"user","id":"u","content":[{"type":"text","text":"hi","extra":"strip","metadata":{"private":null}}],"extra":1,"metadata":{"secret":{"key":null}}}],"extra":true,"state":{"extra":null},"forwardedProps":[{"extra":null}],"tools":[{"name":"f","description":"d","parameters":{"extra":null},"extra":1}],"context":[{"description":"d","value":"v","extra":1}]});
    let result = normalize_run_input(raw).unwrap();
    let value = serde_json::to_value(result.input).unwrap();
    assert_eq!(value["state"], json!({"extra":null}));
    assert_eq!(value["forwardedProps"], json!([{"extra":null}]));
    assert_eq!(
        value["messages"][0]["metadata"],
        json!({"secret":{"key":null}})
    );
    assert_eq!(
        value["messages"][0]["content"][0]["metadata"],
        json!({"private":null})
    );
    assert_eq!(value["tools"][0]["parameters"], json!({"extra":null}));
    let paths: Vec<_> = result.diagnostics.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "/extra",
            "/messages/0/extra",
            "/messages/0/content/0/extra",
            "/tools/0/extra",
            "/context/0/extra"
        ]
    );
    assert!(
        result
            .diagnostics
            .iter()
            .all(|d| d.category == DiagnosticCategory::UnknownField)
    );
}
#[test]
fn unknown_unions_strip_at_required_optional_and_list_positions() {
    let raw = json!({"type":"MESSAGES_SNAPSHOT","messages":[{"id":"unknown","role":"new-role","content":"x"},{"role":"user","id":"u","content":[{"type":"new-part"},{"type":"image","source":{"type":"future-source"}},{"type":"text","text":"retained"}]}]});
    let result = normalize_event(raw).unwrap();
    assert_eq!(
        wire(result.event.unwrap()),
        json!({"type":"MESSAGES_SNAPSHOT","messages":[{"role":"user","id":"u","content":[{"type":"text","text":"retained"}]}]})
    );
    assert_eq!(
        result
            .diagnostics
            .iter()
            .map(|d| d.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "/messages/0/role",
            "/messages/1/content/0/type",
            "/messages/1/content/1/source/type"
        ]
    );
    let event = normalize_event(
        json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"future"}}),
    )
    .unwrap();
    assert!(wire(event.event.unwrap()).get("outcome").is_none());
    let event = normalize_event(json!({"type":"REASONING_ENCRYPTED_VALUE","entityId":"m","encryptedValue":"opaque","subtype":"future"})).unwrap();
    assert!(event.event.is_none());
    assert_eq!(event.diagnostics[0].path, "/subtype");
    assert!(
        normalize_event(json!({"type":"FUTURE_EVENT","anything":null}))
            .unwrap()
            .event
            .is_none()
    );
}
#[test]
fn unsupported_or_malformed_text_roles_fail_like_canonical_sdks() {
    for kind in ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK"] {
        for role in [json!("narrator"), json!(17), Value::Null] {
            let error =
                normalize_event(json!({"type":kind,"messageId":"m","role":role})).unwrap_err();
            assert_eq!(error.path, "/role");
        }
        for role in ["developer", "system", "assistant", "user"] {
            assert!(normalize_event(json!({"type":kind,"messageId":"m","role":role})).is_ok());
        }
        assert!(normalize_event(json!({"type":kind,"messageId":"m"})).is_ok());
    }
}

#[test]
fn malformed_known_values_fail_with_specific_paths() {
    let cases = [
        (
            json!({"type":"TEXT_MESSAGE_CONTENT","messageId":7,"delta":"x"}),
            "/messageId",
        ),
        (
            json!({"type":"TEXT_MESSAGE_START","messageId":"m","metadata":null}),
            "/metadata",
        ),
        (
            json!({"type":"TEXT_MESSAGE_START","messageId":"m","timestamp":9007199254740992_i64}),
            "/timestamp",
        ),
        (
            json!({"type":"STATE_DELTA","delta":[{"op":"add","path":"/x"}]}),
            "/delta/0/value",
        ),
        (
            json!({"type":"STATE_DELTA","delta":[{"op":"remove","path":"/~2"}]}),
            "/delta/0/path",
        ),
        (
            json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"interrupt","interrupts":[]}}),
            "/outcome/interrupts",
        ),
        (
            json!({"type":"MESSAGES_SNAPSHOT","messages":[{"role":"user","id":"m","content":[{"type":"image","source":{"type":"data","value":"a"}}]}]}),
            "/messages/0/content/0/source/mimeType",
        ),
    ];
    for (value, path) in cases {
        let error = normalize_event(value).unwrap_err();
        assert_eq!(error.path, path);
        assert_eq!(error.category, DiagnosticCategory::InvalidValue);
    }
    for field in ["tools", "context", "resume", "protocolVersion"] {
        let mut value = input();
        value[field] = Value::Null;
        assert_eq!(
            normalize_run_input(value).unwrap_err().path,
            format!("/{field}")
        );
    }
}
#[test]
fn null_state_baseline_is_distinct_from_required_snapshot_null() {
    for state in [
        None,
        Some(Value::Null),
        Some(json!({})),
        Some(json!([1, null])),
        Some(json!(false)),
        Some(json!(23)),
        Some(json!("x")),
    ] {
        let mut raw = input();
        if let Some(state) = &state {
            raw["state"] = state.clone();
        }
        let result = normalize_run_input(raw).unwrap();
        let expected = state.clone().filter(|v| !v.is_null()).unwrap_or(json!({}));
        assert_eq!(result.effective_state, expected);
        assert_eq!(
            serde_json::to_value(result.input).unwrap().get("state"),
            state.as_ref().filter(|v| !v.is_null())
        );
    }
    let result = normalize_event(json!({"type":"STATE_SNAPSHOT","snapshot":null})).unwrap();
    assert_eq!(
        wire(result.event.unwrap()),
        json!({"type":"STATE_SNAPSHOT","snapshot":null})
    );
}
#[test]
fn version_components_are_numeric_and_overflow_is_uninterpretable() {
    for version in [None, Some("1.0"), Some("01.00")] {
        let mut value = input();
        if let Some(v) = version {
            value["protocolVersion"] = json!(v);
        }
        assert!(normalize_run_input(value).unwrap().diagnostics.is_empty());
    }
    for version in ["1.1", "1.10"] {
        let mut value = input();
        value["protocolVersion"] = json!(version);
        assert_eq!(
            normalize_run_input(value).unwrap().diagnostics[0].category,
            DiagnosticCategory::NewerMinorVersion
        );
    }
    for version in [
        "",
        "1",
        "latest",
        "1.0.0",
        "1.-1",
        "18446744073709551616.0",
        "2.18446744073709551616",
    ] {
        let mut value = input();
        value["protocolVersion"] = json!(version);
        assert_eq!(
            normalize_run_input(value).unwrap().diagnostics[0].category,
            DiagnosticCategory::UninterpretableVersion
        );
    }
    for version in ["0.0", "2.0", "10.0"] {
        let mut value = input();
        value["protocolVersion"] = json!(version);
        assert_eq!(
            normalize_run_input(value).unwrap_err().category,
            DiagnosticCategory::UnsupportedMajorVersion
        );
    }
}
#[test]
fn known_patch_extensions_roundtrip_in_state_and_activity() {
    let operations = json!([
      {"op":"add","path":"/a","value":null,"vendor":{"token":null},"from":123},
      {"op":"remove","path":"/a","value":null,"from":[1,2]},
      {"op":"replace","path":"/a","value":3,"extra":false},
      {"op":"move","path":"/a","from":"/b","value":{"extra":null}},
      {"op":"copy","path":"/a","from":"/b","extra":[null]},
      {"op":"test","path":"/a","value":null,"extra":"x"}
    ]);
    for (kind, key) in [("STATE_DELTA", "delta"), ("ACTIVITY_DELTA", "patch")] {
        let mut value = json!({"type":kind,key:operations});
        if kind == "ACTIVITY_DELTA" {
            value["messageId"] = json!("m");
            value["activityType"] = json!("a");
        }
        let result = normalize_event(value.clone()).unwrap();
        assert!(result.diagnostics.is_empty());
        assert_eq!(wire(result.event.unwrap()), value);
    }
    let result=normalize_event(json!({"type":"ACTIVITY_DELTA","messageId":"a","activityType":"t","patch":[{"op":"future"}]})).unwrap();
    assert_eq!(wire(result.event.unwrap())["patch"], json!([]));
    assert_eq!(result.diagnostics[0].path, "/patch/0/op");
}
#[test]
fn patch_extensions_cannot_shadow_defined_fields() {
    for key in ["op", "path", "value"] {
        let operation = JsonPatchOperation::Add {
            path: JsonPointer("/a".into()),
            value: json!(1),
            extra: serde_json::Map::from_iter([(key.into(), json!("shadow"))]),
        };
        assert!(serde_json::to_value(operation).is_err());
    }
    let operation = JsonPatchOperation::Remove {
        path: JsonPointer("/a".into()),
        extra: serde_json::Map::from_iter([("value".into(), Value::Null)]),
    };
    assert_eq!(
        serde_json::to_value(operation).unwrap(),
        json!({"op":"remove","path":"/a","value":null})
    );
}
#[test]
fn outgoing_projection_preserves_application_history_and_own_version() {
    let value = json!({"threadId":"t","runId":"r","protocolVersion":"9.0","messages":[{"id":"a","role":"activity","activityType":"ui","content":{}},{"id":"u","role":"user","content":[{"type":"text","text":"hi"}]}],"state":null,"forwardedProps":null});
    let input: RunAgentInput = serde_json::from_value(value).unwrap();
    let output = prepare_run_input(&input).unwrap();
    assert_eq!(input.messages.len(), 2);
    assert_eq!(output.input.messages.len(), 1);
    assert_eq!(output.input.protocol_version.as_deref(), Some("1.0"));
    assert_eq!(output.effective_state, json!({}));
    assert!(
        serde_json::to_value(output.input)
            .unwrap()
            .get("state")
            .is_none()
    );
}
#[test]
fn diagnostics_are_bounded_and_do_not_log_payloads() {
    let mut value = json!({"type":"TEXT_MESSAGE_END","messageId":"m"});
    value["secret".repeat(1000)] = json!({"credential":"do-not-log-this"});
    let result = normalize_event(value).unwrap();
    assert!(result.diagnostics[0].path.len() <= 256);
    assert!(!format!("{:?}", result.diagnostics).contains("do-not-log-this"));
}

#[test]
fn fixed_literal_roles_are_malformed_known_values() {
    for raw in [
        json!({"type":"REASONING_MESSAGE_START","messageId":"m","role":"assistant"}),
        json!({"type":"REASONING_MESSAGE_START","messageId":"m","role":"future"}),
        json!({"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"t","content":"x","role":"user"}),
    ] {
        let error = normalize_event(raw).unwrap_err();
        assert_eq!(error.category, DiagnosticCategory::InvalidValue);
        assert_eq!(error.path, "/role");
    }
}
#[test]
fn consumer_newer_major_proceeds_but_producer_ingress_rejects() {
    let event = normalize_event(
        json!({"type":"RUN_STARTED","threadId":"t","runId":"r","protocolVersion":"2.0"}),
    )
    .unwrap();
    assert!(event.event.is_some());
    assert_eq!(
        event.diagnostics[0].category,
        DiagnosticCategory::UnsupportedMajorVersion
    );
    let mut input = input();
    input["protocolVersion"] = json!("2.0");
    assert_eq!(
        normalize_run_input(input).unwrap_err().category,
        DiagnosticCategory::UnsupportedMajorVersion
    );
}
#[test]
fn integer_json_number_spellings_are_accepted_without_accepting_fractions() {
    for number in [1.0, -0.0, -1.0, 9_007_199_254_740_991_f64] {
        let result =
            normalize_event(json!({"type":"TEXT_MESSAGE_END","messageId":"m","timestamp":number}))
                .unwrap();
        assert_eq!(result.event.unwrap().timestamp(), Some(number as i64));
    }
    assert_eq!(
        normalize_event(json!({"type":"TEXT_MESSAGE_END","messageId":"m","timestamp":1.25}))
            .unwrap_err()
            .path,
        "/timestamp"
    );
    let result = normalize_event(
        json!({"type":"RUN_ERROR","message":"failure","usage":[{"inputTokens":1.0}]}),
    )
    .unwrap();
    assert_eq!(wire(result.event.unwrap())["usage"][0]["inputTokens"], 1);
}

/// The strict schema and tolerant processing lanes intentionally disagree on
/// precisely these current-1.0 additions and documented whole-null shims.
#[test]
fn every_invalid_event_and_input_fixture_has_an_explicit_processing_verdict() {
    use std::{fs, path::PathBuf};
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../../spec/1.0/fixtures");
    let mut total = 0;
    let mut normalized = 0;
    let mut rejected = 0;
    for directory in fs::read_dir(root).unwrap() {
        let directory = directory.unwrap();
        let kind = directory.file_name().into_string().unwrap();
        if !kind.ends_with("Event") && kind != "RunAgentInput" {
            continue;
        }
        let invalid = directory.path().join("invalid");
        if !invalid.exists() {
            continue;
        }
        for entry in fs::read_dir(invalid).unwrap() {
            let path = entry.unwrap().path();
            let filename = path.file_name().unwrap().to_str().unwrap();
            if !filename.ends_with(".json") || filename.ends_with(".expect.json") {
                continue;
            }
            total += 1;
            let name = format!("{kind}/{filename}");
            let raw: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let actual = if kind == "RunAgentInput" {
                normalize_run_input(raw.clone())
                    .map(|p| (Some(serde_json::to_value(p.input).unwrap()), p.diagnostics))
            } else {
                normalize_event(raw.clone()).map(|p| (p.event.map(wire), p.diagnostics))
            };
            // (diagnostic category, diagnostic path, location removed from raw)
            let tolerance = match name.as_str() {
                "MessagesSnapshotEvent/role-shaped-like-a-tool-message.json"
                | "MessagesSnapshotEvent/role-shaped-like-an-activity-message.json"
                | "MessagesSnapshotEvent/role-shaped-like-an-assistant-message.json"
                | "MessagesSnapshotEvent/unknown-role.json" => Some((
                    DiagnosticCategory::UnknownVariant,
                    "/messages/0/role",
                    "/messages/0",
                )),
                "ReasoningEncryptedValueEvent/unknown-subtype.json" => {
                    Some((DiagnosticCategory::UnknownEnumValue, "/subtype", ""))
                }
                "RunFinishedEvent/outcome-cancelled-carrying-interrupts.json"
                | "RunFinishedEvent/outcome-success-carrying-interrupts.json" => Some((
                    DiagnosticCategory::UnknownField,
                    "/outcome/interrupts",
                    "/outcome/interrupts",
                )),
                "RunFinishedEvent/outcome-interrupt-carrying-pending-tool-call-ids.json" => Some((
                    DiagnosticCategory::UnknownField,
                    "/outcome/pendingToolCallIds",
                    "/outcome/pendingToolCallIds",
                )),
                "RunFinishedEvent/outcome-null.json" => {
                    Some((DiagnosticCategory::OptionalNull, "/outcome", "/outcome"))
                }
                "StateDeltaEvent/patch-unknown-op.json" => Some((
                    DiagnosticCategory::UnknownVariant,
                    "/delta/0/op",
                    "/delta/0",
                )),
                "SubagentFinishedEvent/outcome-success-carrying-interrupt-ids.json" => Some((
                    DiagnosticCategory::UnknownField,
                    "/outcome/interruptIds",
                    "/outcome/interruptIds",
                )),
                "TextMessageContentEvent/subagent-run-id-null.json" => Some((
                    DiagnosticCategory::OptionalNull,
                    "/subagentRunId",
                    "/subagentRunId",
                )),
                "TextMessageEndEvent/raw-event-null.json" => {
                    Some((DiagnosticCategory::OptionalNull, "/rawEvent", "/rawEvent"))
                }
                "TextMessageEndEvent/unknown-property.json" => Some((
                    DiagnosticCategory::UnknownField,
                    "/somethingNewer",
                    "/somethingNewer",
                )),
                "ToolCallChunkEvent/parent-message-id-null.json"
                | "ToolCallStartEvent/parent-message-id-null.json" => Some((
                    DiagnosticCategory::OptionalNull,
                    "/parentMessageId",
                    "/parentMessageId",
                )),
                "ToolCallResultEvent/content-part-unknown-type.json" => Some((
                    DiagnosticCategory::UnknownVariant,
                    "/content/0/type",
                    "/content/0",
                )),
                _ => None,
            };
            if let Some((category, diagnostic_path, removed)) = tolerance {
                let (actual, diagnostics) = actual.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(diagnostics.len(), 1, "{name}: {diagnostics:?}");
                assert_eq!(diagnostics[0].category, category, "{name}");
                assert_eq!(diagnostics[0].path, diagnostic_path, "{name}");
                let expected = if removed.is_empty() {
                    None
                } else {
                    let mut expected = raw;
                    let (parent, key) = removed.rsplit_once('/').unwrap();
                    let parent = expected.pointer_mut(parent).unwrap();
                    match parent {
                        Value::Object(map) => {
                            map.remove(key).unwrap();
                        }
                        Value::Array(array) => {
                            array.remove(key.parse().unwrap());
                        }
                        _ => panic!("invalid test removal"),
                    };
                    Some(expected)
                };
                assert_eq!(actual, expected, "{name}");
                normalized += 1;
            } else {
                let error = actual.expect_err(&name);
                assert_eq!(error.category, DiagnosticCategory::InvalidValue, "{name}");
                let companion: Value =
                    serde_json::from_slice(&fs::read(path.with_extension("expect.json")).unwrap())
                        .unwrap();
                let expected_path = if companion["keyword"] == "required" {
                    match name.as_str() {
                        "CustomEvent/name-missing.json"
                        | "SubagentStartedEvent/name-missing.json" => "/name",
                        "CustomEvent/value-missing.json" => "/value",
                        "RawEvent/event-missing.json" => "/event",
                        "ReasoningMessageStartEvent/role-missing.json" => "/role",
                        "RunAgentInput/messages-missing.json" => "/messages",
                        "StateDeltaEvent/patch-add-without-value.json"
                        | "StateDeltaEvent/patch-replace-without-value.json"
                        | "StateDeltaEvent/patch-test-without-value.json" => "/delta/0/value",
                        "StateDeltaEvent/patch-copy-without-from.json"
                        | "StateDeltaEvent/patch-move-without-from.json" => "/delta/0/from",
                        "StateDeltaEvent/patch-path-missing.json" => "/delta/0/path",
                        "StateSnapshotEvent/snapshot-missing.json" => "/snapshot",
                        "TextMessageContentEvent/delta-missing.json" => "/delta",
                        _ => panic!(
                            "new required-field fixture needs an explicit processing path: {name}"
                        ),
                    }
                } else {
                    companion["instanceLocation"].as_str().unwrap()
                };
                assert_eq!(error.path, expected_path, "{name}");
                rejected += 1;
            }
        }
    }
    assert!(total >= 60, "invalid fixture corpus unexpectedly shrank");
    assert_eq!(total, normalized + rejected);
    assert!(
        normalized > 0 && rejected > 0,
        "both tolerance and rejection paths must run"
    );
}

#[test]
fn null_shims_are_selective_even_between_content_part_kinds() {
    let text = json!({"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":[{"type":"text","text":"x","metadata":null}]});
    assert_eq!(
        normalize_event(text).unwrap_err().path,
        "/content/0/metadata"
    );
    for kind in ["image", "audio", "video", "document"] {
        let media = json!({"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":[{"type":kind,"source":{"type":"url","value":"https://example.invalid"},"metadata":null}]});
        let result = normalize_event(media).unwrap();
        assert_eq!(
            result.diagnostics[0].category,
            DiagnosticCategory::OptionalNull
        );
        assert!(
            wire(result.event.unwrap())["content"][0]
                .get("metadata")
                .is_none()
        );
    }
}

#[test]
fn maf_optional_null_fields_are_omitted_with_diagnostics() {
    let events = [
        json!({"type":"RUN_STARTED","threadId":"t","runId":"r","parentRunId":null,"input":null}),
        json!({"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"hi","subagentRunId":null}),
        json!({"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":"ok","role":null}),
        json!({"type":"RUN_ERROR","message":"error","usage":null}),
        json!({"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"success","pendingToolCallIds":null},"usage":[{"provider":null,"reasoningTokens":null,"cachedInputTokens":null,"cacheWriteInputTokens":null}]}),
    ];
    for raw in events {
        let processed = normalize_event(raw).unwrap();
        assert!(processed.event.is_some());
        assert!(!processed.diagnostics.is_empty());
        assert!(
            processed
                .diagnostics
                .iter()
                .all(|d| d.category == DiagnosticCategory::OptionalNull)
        );
    }
}

#[test]
fn diagnostic_flood_is_bounded_and_summarized() {
    let mut raw = json!({"type":"CUSTOM","name":"x","value":{"opaque":true}});
    for i in 0..1000 {
        raw[format!("unknown_{i}")] = json!(0);
    }
    let processed = normalize_event(raw).unwrap();
    assert_eq!(processed.diagnostics.len(), 257);
    let summary = processed.diagnostics.last().unwrap();
    assert_eq!(summary.category, DiagnosticCategory::DiagnosticLimit);
    assert_eq!(summary.message, "744 more diagnostics omitted");
    assert_eq!(
        wire(processed.event.unwrap())["value"],
        json!({"opaque":true})
    );
}
