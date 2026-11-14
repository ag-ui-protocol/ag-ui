#![cfg(feature = "toolkit")]

use std::collections::BTreeMap;

use ag_ui_a2ui::catalog::Catalog;
use ag_ui_a2ui::toolkit::parser::parse_and_fix;
use ag_ui_a2ui::toolkit::streaming::StreamParser;
use serde_json::{Value, json};

fn document(components: Value) -> String {
    format!(
        "<a2ui-json>{}</a2ui-json>",
        json!([
            {"version":"v0.9.1", "createSurface":{"surfaceId":"s","catalogId":"c"}},
            {"version":"v0.9.1", "updateComponents":{"surfaceId":"s","components":components}}
        ])
    )
}

fn stream(catalog: Catalog, chunks: &[&str]) -> Vec<Value> {
    let mut parser = StreamParser::new(catalog);
    chunks
        .iter()
        .flat_map(|chunk| parser.process_chunk(chunk).unwrap())
        .filter_map(|part| part.a2ui)
        .flatten()
        .collect()
}

fn components(messages: &[Value]) -> impl Iterator<Item = &Value> {
    messages
        .iter()
        .filter_map(|message| message["updateComponents"]["components"].as_array())
        .flatten()
}

fn latest(messages: &[Value]) -> BTreeMap<&str, &Value> {
    components(messages)
        .map(|component| (component["id"].as_str().unwrap(), component))
        .collect()
}

#[test]
fn valid_json_and_trailing_comma_repairs_preserve_unicode_text() {
    let value = json!({"text":"Say “hello”: don’t change ‘quoted’ text, ] or \\\"escapes\\\"."});
    let raw = value.to_string();
    assert_eq!(parse_and_fix(&raw).unwrap(), vec![value.clone()]);
    assert_eq!(parse_and_fix(&format!("[{raw},]")).unwrap(), vec![value]);
    assert_eq!(
        parse_and_fix("{“text”:“literal ,]”,}").unwrap(),
        vec![json!({"text":"literal ,]"})]
    );
}

#[test]
fn modal_children_arrive_with_every_character_split() {
    let input = document(json!([
        {"id":"root","component":"Modal","trigger":"trigger","content":"content"},
        {"id":"trigger","component":"Text","text":"Open"},
        {"id":"content","component":"Text","text":"Body “본문”"}
    ]));
    let chunks: Vec<_> = input
        .char_indices()
        .map(|(offset, ch)| &input[offset..offset + ch.len_utf8()])
        .collect();
    for messages in [
        stream(Catalog::basic(), &[&input]),
        stream(Catalog::basic(), &chunks),
    ] {
        let state = latest(&messages);
        assert_eq!(state["root"]["trigger"], "trigger");
        assert_eq!(state["root"]["content"], "content");
        assert_eq!(state["trigger"]["text"], "Open");
        assert_eq!(state["content"]["text"], "Body “본문”");
    }
}

#[test]
fn opaque_action_context_is_preserved_at_every_chunk_boundary() {
    let context = json!({
        "child":"root", "children":["sku-42"], "componentId":"root",
        "nested":{"contentChild":"root","entryPointChild":"root","explicitList":["root"]}
    });
    let input = document(json!([
        {"id":"root","component":"Button","child":"label","action":{"event":{"name":"choose","context":context}}},
        {"id":"label","component":"Text","text":"Choose"}
    ]));
    for (split, _) in input.char_indices() {
        let messages = stream(Catalog::basic(), &[&input[..split], &input[split..]]);
        for root in components(&messages).filter(|component| component["id"] == "root") {
            assert_eq!(root["action"]["event"]["context"], context, "split {split}");
        }
        assert_eq!(latest(&messages)["root"]["child"], "label");
    }
}

#[test]
fn custom_catalog_references_and_object_list_references_are_followed() {
    let custom = Catalog::from_schema(&json!({
        "catalogId":"c",
        "components":{"Panel":{
            "type":"object",
            "properties":{
                "heading.id":{"$ref":"common_types.json#/$defs/ComponentId"},
                "slots":{"type":"array", "items":{"type":"object", "properties":{
                    "body.id":{"$ref":"common_types.json#/$defs/ComponentId"},
                    "data":{"type":"object"}
                }}},
                "template":{"$ref":"common_types.json#/$defs/ChildList"}
            },
            "required":["heading.id", "slots", "template"]
        }}
    }))
    .unwrap();
    let mut catalog = Catalog::basic();
    catalog.insert_component(custom.component("Panel").unwrap().clone());
    let input = document(json!([
        {"id":"root","component":"Panel","heading.id":"heading",
         "slots":[{"body.id":"body","data":{"child":"sku"}}],
         "template":{"componentId":"item","path":"/items"}},
        {"id":"heading","component":"Text","text":"Title"},
        {"id":"body","component":"Text","text":"Body"},
        {"id":"item","component":"Text","text":"Item"}
    ]));
    let chunks: Vec<_> = input
        .char_indices()
        .map(|(offset, ch)| &input[offset..offset + ch.len_utf8()])
        .collect();
    let messages = stream(catalog, &chunks);
    let state = latest(&messages);
    for id in ["heading", "body", "item"] {
        assert!(state.contains_key(id), "missing {id}: {messages:#?}");
    }
    assert_eq!(state["root"]["heading.id"], "heading");
    assert_eq!(state["root"]["slots"][0]["body.id"], "body");
    assert_eq!(state["root"]["slots"][0]["data"]["child"], "sku");
    assert_eq!(state["root"]["template"]["componentId"], "item");
}

#[test]
fn an_empty_child_list_loses_its_placeholder_when_closed() {
    let input = document(json!([{"id":"root","component":"Row","children":[]}]));
    let messages = stream(Catalog::basic(), &[&input]);
    assert_eq!(latest(&messages)["root"]["children"], json!([]));
    assert!(components(&messages).all(|component| component["id"] == "root"));

    let chunks = [
        r#"<a2ui-json>[{"version":"v0.9.1","createSurface":{"surfaceId":"s","catalogId":"c"}},{"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Row","children":["#,
        "]}]}}]</a2ui-json>",
    ];
    let messages = stream(Catalog::basic(), &chunks);
    let roots: Vec<_> = components(&messages)
        .filter(|component| component["id"] == "root")
        .collect();
    assert_eq!(
        roots.first().unwrap()["children"],
        json!(["loading_children_root"])
    );
    assert_eq!(roots.last().unwrap()["children"], json!([]));
}

#[test]
fn placeholders_do_not_overwrite_components_or_share_distinct_targets() {
    let input = document(json!([
        {"id":"root","component":"Row","children":["loading_missing", "missing", "missing_1"]},
        {"id":"loading_missing","component":"Text","text":"Real component"}
    ]));
    let messages = stream(Catalog::basic(), &[&input]);
    let state = latest(&messages);
    assert_eq!(state["loading_missing"]["text"], "Real component");
    let children = state["root"]["children"].as_array().unwrap();
    assert_ne!(children[0], children[1]);
    assert_ne!(children[1], children[2]);
    assert_ne!(children[0], children[2]);
}

#[test]
fn a_cut_child_identifier_cannot_create_a_false_cycle() {
    let chunks = [
        r#"<a2ui-json>[{"version":"v0.9.1","createSurface":{"surfaceId":"s","catalogId":"c"}},{"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Row","children":["root"#,
        r#"-child"]},{"id":"root-child","component":"Text","text":"Complete child"}]}}]</a2ui-json>"#,
    ];
    let messages = stream(Catalog::basic(), &chunks);
    let state = latest(&messages);
    assert_eq!(state["root"]["children"], json!(["root-child"]));
    assert_eq!(state["root-child"]["text"], "Complete child");
}

#[test]
fn custom_references_remain_atomic_even_when_their_keys_are_cuttable() {
    let custom = Catalog::from_schema(&json!({
        "catalogId":"c",
        "components":{"Panel":{"type":"object", "properties":{
            "label":{"$ref":"common_types.json#/$defs/ComponentId"},
            "slots":{"type":"array", "items":{"type":"object", "properties":{
                "label":{"$ref":"common_types.json#/$defs/ComponentId"}
            }}}
        }}}
    }))
    .unwrap();
    let mut catalog = Catalog::basic();
    catalog.insert_component(custom.component("Panel").unwrap().clone());
    let chunks = [
        r#"<a2ui-json>[{"version":"v0.9.1","createSurface":{"surfaceId":"s","catalogId":"c"}},{"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Panel","label":"root"#,
        r#"-child","slots":[{"label":"root"#,
        r#"-child"}]},{"id":"root-child","component":"Text","text":"Complete child"}]}}]</a2ui-json>"#,
    ];
    let messages = stream(catalog, &chunks);
    let state = latest(&messages);
    assert_eq!(state["root"]["label"], "root-child");
    assert_eq!(state["root"]["slots"][0]["label"], "root-child");
    assert_eq!(state["root-child"]["text"], "Complete child");
}
