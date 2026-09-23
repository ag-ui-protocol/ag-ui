//! The whole agent-side loop, end to end.
//!
//! Each unit test covers one module. These cover the seams between them: a turn
//! that creates a surface, a follow-up turn that edits it by recovering it from
//! history, and the failure path where a model's output is rejected and the
//! errors go back out as an error envelope.

#![cfg(feature = "toolkit")]

use ag_ui_a2ui::binding::Scope;
use ag_ui_a2ui::catalog::Catalog;
use ag_ui_a2ui::constants::{A2UI_OPERATIONS_KEY, BASIC_CATALOG_ID, PROTOCOL_VERSION};
use ag_ui_a2ui::message::{AgentPayload, Component};
use ag_ui_a2ui::toolkit::envelope::{wrap_as_operations_envelope, wrap_error_envelope};
use ag_ui_a2ui::toolkit::history::{HistoryMessage, find_prior_surface};
use ag_ui_a2ui::toolkit::negotiate::{ClientCapabilities, select_catalog_schema};
use ag_ui_a2ui::toolkit::ops::{Intent, SurfaceSpec, assemble_ops};
use ag_ui_a2ui::toolkit::prompt::{PromptSpec, build_subagent_prompt};
use ag_ui_a2ui::toolkit::recovery::{RecoveryOptions, generate_with_recovery};
use ag_ui_a2ui::toolkit::schema::SchemaBundle;
use ag_ui_a2ui::toolkit::streaming::StreamParser;
use ag_ui_a2ui::validate::{ErrorCode, Validator};
use serde_json::{Value, json};

/// A model that returns a canned response, wrapped in the expected tags.
fn model(response: &'static str) -> impl FnMut(&str, u32) -> ag_ui_a2ui::Result<String> {
    move |_prompt, _attempt| Ok(response.to_string())
}

const CREATE_RESPONSE: &str = r#"Here is your order.
<a2ui-json>[
  {"version": "v0.9", "createSurface": {"surfaceId": "order", "catalogId": "https://a2ui.org/specification/v0_9/basic_catalog.json"}},
  {"version": "v0.9", "updateComponents": {"surfaceId": "order", "components": [
    {"id": "root", "component": "Column", "children": ["heading", "items"]},
    {"id": "heading", "component": "Text", "text": {"path": "/title"}, "variant": "h2"},
    {"id": "items", "component": "List", "children": {"componentId": "row", "path": "/items"}},
    {"id": "row", "component": "Text", "text": {"call": "formatString", "args": {"value": "${@index(offset: 1)}. ${name}"}}}
  ]}},
  {"version": "v0.9", "updateDataModel": {"surfaceId": "order", "path": "/", "value": {
    "title": "Your order", "items": [{"name": "Espresso"}, {"name": "Croissant"}]
  }}}
]</a2ui-json>"#;

#[test]
fn a_turn_generates_validates_and_ships_a_surface() {
    let catalog = Catalog::basic();

    // 1. Build the prompt for the generating model.
    let spec = PromptSpec::new("You build UI surfaces.", "Show my coffee order.", &catalog);
    let prompt = build_subagent_prompt(&spec);
    assert!(prompt.contains("Intent: create"));

    // 2. Generate, validating and retrying if needed.
    let surface = generate_with_recovery(
        &prompt,
        &catalog,
        &RecoveryOptions::default(),
        model(CREATE_RESPONSE),
        |_| {},
    )
    .expect("the canned response is valid A2UI");

    assert_eq!(surface.attempts, 1);
    assert_eq!(surface.text, "Here is your order.");
    assert_eq!(surface.components.len(), 4);

    // 3. The reconstructed surface validates against its own data.
    let report = Validator::new(&catalog).validate_model(&surface.components, &surface.data_model);
    assert!(report.is_valid(), "{:?}", report.errors);
    assert!(report.unreachable.is_empty());

    // 4. Bindings resolve the way the renderer will resolve them.
    let json_model = surface.data_model.to_json().unwrap();
    let root = Scope::root(&json_model);
    assert_eq!(root.resolve_string("/title"), "Your order");
    assert_eq!(
        root.item("/items", 1)
            .format_string("${@index(offset: 1)}. ${name}")
            .unwrap(),
        "2. Croissant"
    );

    // 5. Ship it.
    let envelope = wrap_as_operations_envelope(&surface.operations).unwrap();
    let value: Value = serde_json::from_str(&envelope).unwrap();
    let operations = value[A2UI_OPERATIONS_KEY].as_array().unwrap();
    assert_eq!(operations.len(), 3);
    assert_eq!(operations[0]["version"], PROTOCOL_VERSION);
    assert_eq!(
        operations[0]["createSurface"]["catalogId"],
        BASIC_CATALOG_ID
    );
}

#[test]
fn a_follow_up_turn_edits_the_surface_without_re_creating_it() {
    let catalog = Catalog::basic();

    // Turn one is in history as the envelope the agent emitted.
    let first = generate_with_recovery(
        "prompt",
        &catalog,
        &RecoveryOptions::default(),
        model(CREATE_RESPONSE),
        |_| {},
    )
    .unwrap();
    let history = vec![
        HistoryMessage::text("user", "Show my coffee order."),
        HistoryMessage::text(
            "assistant",
            wrap_as_operations_envelope(&first.operations).unwrap(),
        ),
        HistoryMessage::text("user", "Add the total."),
    ];

    // Turn two recovers what is on screen.
    let prior = find_prior_surface(&history).expect("the surface is in history");
    assert_eq!(prior.surface_id, "order");
    assert_eq!(prior.catalog_id.as_deref(), Some(BASIC_CATALOG_ID));
    assert_eq!(prior.components.len(), 4);
    assert_eq!(
        prior.data_model.to_json().unwrap()["items"][0]["name"],
        "Espresso"
    );

    // The prompt shows the model the current tree and forbids re-creation.
    let prompt = build_subagent_prompt(
        &PromptSpec::new("You build UI surfaces.", "Add the total.", &catalog).updating(&prior),
    );
    assert!(prompt.contains("Do NOT emit `createSurface` for 'order'"));
    assert!(prompt.contains("\"id\": \"heading\""));

    // The edit ships as an update, so no createSurface goes out.
    let edit = SurfaceSpec::new(&prior.surface_id)
        .with_components(vec![
            Component::new("root", "Column").with("children", json!(["heading", "items", "total"])),
            Component::new("total", "Text").with("text", json!({"path": "/total"})),
        ])
        .with_data_model(json!("$7.50"))
        .with_data_path("/total");

    let operations = assemble_ops(Intent::Update, &edit);
    assert!(
        !operations
            .iter()
            .any(|op| matches!(op.payload, AgentPayload::CreateSurface(_))),
        "updating an existing surface must never re-create it"
    );

    // Validating the edit against the merged surface catches nothing: the new
    // component and its binding both resolve.
    let mut merged = prior.components.clone();
    merged.retain(|c| c.id != "root");
    merged.extend(edit.components.iter().cloned());
    let mut data = prior.data_model.to_json().unwrap();
    data["total"] = json!("$7.50");
    let report = Validator::new(&catalog).validate_surface(&merged, Some(&data));
    assert!(report.is_valid(), "{:?}", report.errors);
}

#[test]
fn a_surface_that_cannot_be_fixed_ships_as_an_error_envelope() {
    let catalog = Catalog::basic();
    // Every attempt names a child that was never defined.
    let broken = r#"<a2ui-json>[
        {"version": "v0.9", "createSurface": {"surfaceId": "order", "catalogId": "c"}},
        {"version": "v0.9", "updateComponents": {"surfaceId": "order", "components": [
          {"id": "root", "component": "Card", "child": "never-defined"}
        ]}}
    ]</a2ui-json>"#;

    let mut attempts = 0;
    let error = generate_with_recovery(
        "prompt",
        &catalog,
        &RecoveryOptions::default(),
        |_, _| {
            attempts += 1;
            Ok(broken.to_string())
        },
        |_| {},
    )
    .unwrap_err();
    assert_eq!(attempts, 3, "the loop should use its whole budget");

    let ag_ui_a2ui::Error::RecoveryExhausted { last, .. } = error else {
        panic!("expected RecoveryExhausted");
    };
    assert_eq!(last.as_slice()[0].code, ErrorCode::UnresolvedChild);

    // The frontend receives the reason, and nothing that looks like a surface.
    let envelope =
        wrap_error_envelope("order", "Could not build the surface.", last.as_slice()).unwrap();
    let value: Value = serde_json::from_str(&envelope).unwrap();
    assert!(value.get(A2UI_OPERATIONS_KEY).is_none(), "{value}");
    assert_eq!(value["error"], "Could not build the surface.");
    assert_eq!(value["code"], "VALIDATION_FAILED");
    assert_eq!(value["path"], "components[0].child");
    assert_eq!(value["details"][0]["code"], "unresolved_child");

    // So the next turn does not offer the surface that was never built as the
    // one the user is looking at.
    assert!(find_prior_surface(&[HistoryMessage::text("assistant", envelope)]).is_none());
}

#[test]
fn a_custom_catalog_drives_validation_the_same_way() {
    // A design system that only allows MenuItem inside Menu.
    let catalog = Catalog::from_schema(&json!({
        "catalogId": "example.com:design-system",
        "components": {
            "Menu": {
                "type": "object",
                "allowedChildren": ["MenuItem"],
                "properties": {
                    "component": {"const": "Menu"},
                    "children": {"$ref": "common_types.json#/$defs/ChildList"}
                },
                "required": ["component", "children"]
            },
            "MenuItem": {
                "type": "object",
                "allowedParents": ["Menu"],
                "properties": {
                    "component": {"const": "MenuItem"},
                    "label": {"type": "string"}
                },
                "required": ["component", "label"]
            },
            "Banner": {"type": "object", "properties": {"component": {"const": "Banner"}}}
        }
    }))
    .unwrap();

    let components = vec![
        Component::new("root", "Menu").with("children", json!(["one", "stray"])),
        Component::new("one", "MenuItem").with("label", json!("First")),
        Component::new("stray", "Banner"),
    ];

    // Structurally sound: every reference resolves, no cycles, root present.
    let report = Validator::new(&catalog).validate(&components);
    assert!(report.is_valid(), "{:?}", report.errors);

    // But composition constraints reject the Banner inside the Menu.
    let violations = catalog.composition_violations(&components);
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0].code.as_str(), "UNALLOWED_CHILD");
    assert_eq!(violations[0].path, "components[0].children[1]");

    // A missing required property is caught by the validator itself.
    let report = Validator::new(&catalog).validate(&[
        Component::new("root", "Menu").with("children", json!(["one"])),
        Component::new("one", "MenuItem"),
    ]);
    assert_eq!(report.errors.len(), 1);
    assert_eq!(report.errors[0].code, ErrorCode::MissingRequiredProp);
    assert_eq!(report.errors[0].path, "components[1].label");
}

#[test]
fn a_surface_renders_progressively_while_it_is_generated() {
    // The same generation as the first test, but delivered in token-sized
    // chunks: the user sees the tree fill in instead of waiting for the end.
    let catalog = Catalog::basic();
    let mut parser = StreamParser::new(catalog);

    let mut seen_text = Vec::new();
    let mut renders: Vec<Value> = Vec::new();
    let mut cursor = 0;
    while cursor < CREATE_RESPONSE.len() {
        // A chunk boundary at an arbitrary character, including mid-token.
        let mut end = (cursor + 37).min(CREATE_RESPONSE.len());
        while !CREATE_RESPONSE.is_char_boundary(end) {
            end += 1;
        }
        for part in parser
            .process_chunk(&CREATE_RESPONSE[cursor..end])
            .expect("the canned response streams cleanly")
        {
            if !part.text.is_empty() {
                seen_text.push(part.text);
            }
            renders.extend(part.a2ui.into_iter().flatten());
        }
        cursor = end;
    }

    // Streaming text is passed through verbatim, newline and all: trimming it
    // would swallow whitespace that separates one chunk from the next.
    assert_eq!(
        seen_text,
        vec![
            "Here is your order.
"
            .to_string()
        ]
    );

    // The surface was created before any components arrived.
    assert!(renders[0].get("createSurface").is_some());

    // Something renderable was emitted well before the generation finished.
    assert!(
        renders.len() > 3,
        "expected several progressive updates, got {}",
        renders.len()
    );

    // Placeholders stood in for components still on the wire.
    let placeholders: Vec<&Value> = renders
        .iter()
        .filter_map(|message| message.pointer("/updateComponents/components"))
        .filter_map(Value::as_array)
        .flatten()
        .filter(|component| {
            component
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("loading_"))
        })
        .collect();
    assert!(!placeholders.is_empty(), "expected loading placeholders");

    // The last component update is the finished tree, with no placeholders left.
    let final_components = renders
        .iter()
        .rev()
        .find_map(|message| message.pointer("/updateComponents/components"))
        .and_then(Value::as_array)
        .expect("a final component update");
    let ids: Vec<&str> = final_components
        .iter()
        .filter_map(|component| component.get("id").and_then(Value::as_str))
        .collect();
    assert!(!ids.iter().any(|id| id.starts_with("loading_")), "{ids:?}");
    for expected in ["root", "heading", "items", "row"] {
        assert!(ids.contains(&expected), "{expected} missing from {ids:?}");
    }

    // And what streamed out validates as a whole surface.
    let components: Vec<Component> = final_components
        .iter()
        .map(|component| serde_json::from_value(component.clone()).expect("a component"))
        .collect();
    let data = renders
        .iter()
        .rev()
        .find_map(|message| message.pointer("/updateDataModel/value"))
        .cloned()
        .expect("a data model update");
    let report = Validator::new(&Catalog::basic()).validate_surface(&components, Some(&data));
    assert!(report.is_valid(), "{:?}", report.errors);
}

#[test]
fn a_catalog_is_negotiated_then_pruned_into_the_prompt() {
    // The renderer prefers a catalog the agent has, and adds one component of
    // its own.
    let agent_catalogs = vec![json!({
        "catalogId": "example.com:design-system",
        "components": {
            "Text": {"type": "object", "properties": {"component": {"const": "Text"}}},
            "Chart": {"type": "object", "properties": {"component": {"const": "Chart"}}}
        }
    })];
    let renderer = ClientCapabilities {
        supported_catalog_ids: vec!["example.com:extended".to_string()],
        inline_catalogs: vec![
            json!({"catalogId":"example.com:extended","components": {"Text":{}, "Sparkline": {"type": "object"}}}),
        ],
    };

    let negotiated = select_catalog_schema(&agent_catalogs, &renderer, true).unwrap();
    assert_eq!(negotiated["catalogId"], "example.com:extended");
    assert!(negotiated["components"]["Sparkline"].is_object());

    // The prompt carries only the components this turn is allowed to use.
    let bundle = SchemaBundle {
        s2c: json!({"title": "envelope"}),
        common_types: json!({"$defs": {"ComponentId": {"type": "string"}}}),
        catalog: negotiated,
        custom_cuttable_keys: None,
    }
    .prune(&["Text".to_string(), "Sparkline".to_string()], &[]);

    assert!(bundle.catalog["components"]["Chart"].is_null());

    let catalog = Catalog::empty("example.com:design-system");
    let prompt = build_subagent_prompt(
        &PromptSpec::new("You build UI.", "Chart my week.", &catalog).with_schemas(&bundle),
    );
    assert!(prompt.contains("## Workflow Description:"));
    assert!(prompt.contains("---BEGIN A2UI JSON SCHEMA---"));
    assert!(prompt.contains("Sparkline"));
    assert!(
        !prompt.contains("Chart\":"),
        "the pruned component must be gone"
    );
}
