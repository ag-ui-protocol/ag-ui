#![cfg(feature = "author")]
use ag_ui_a2ui::schema_validation::SchemaValidator;
use ag_ui_a2ui::toolkit::schema::SchemaBundle;
use ag_ui_a2ui::{A2uiAuthor, A2uiVersion, Error};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};
fn ready<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("fixture unexpectedly waited"),
    }
}
fn ops() -> Vec<Value> {
    vec![
        json!({"version":"v0.9.1","createSurface":{"surfaceId":"s","catalogId":ag_ui_a2ui::constants::OFFICIAL_BASIC_CATALOG_ID}}),
        json!({"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Text","text":"Hello"}]}}),
        json!({"version":"v0.9.1","updateDataModel":{"surfaceId":"s","path":"/","value":{"memo":null,"items":[1,null]}}}),
    ]
}
#[test]
fn official_schema_resolves_locally_and_rejects_invalid_raw_documents() {
    let schema = SchemaValidator::new(&SchemaBundle::basic().unwrap(), &BTreeMap::new()).unwrap();
    for message in ops() {
        schema.validate_message(&message).unwrap();
    }
    let mut wrong_enum = ops()[1].clone();
    wrong_enum["updateComponents"]["components"][0]["variant"] = json!("banana");
    let mut unknown_prop = ops()[1].clone();
    unknown_prop["updateComponents"]["components"][0]["secret"] = json!(true);
    let mut extra_payload = ops()[0].clone();
    extra_payload["deleteSurface"] = json!({"surfaceId":"s"});
    let mut empty = ops()[1].clone();
    empty["updateComponents"]["components"] = json!([]);
    let mut missing_version = ops()[0].clone();
    missing_version.as_object_mut().unwrap().remove("version");
    for invalid in [
        wrong_enum,
        unknown_prop,
        extra_payload,
        empty,
        missing_version,
    ] {
        assert!(schema.validate_message(&invalid).is_err(), "{invalid}");
    }
    let mut bundle = SchemaBundle::basic().unwrap();
    bundle.s2c["$ref"] = json!("https://unregistered.invalid/schema.json");
    assert!(SchemaValidator::new(&bundle, &BTreeMap::new()).is_err());
}
#[test]
fn create_and_edit_pin_target_version_catalog_and_lifecycle() {
    let author = A2uiAuthor::basic(A2uiVersion::V0_9_1).unwrap();
    let initial = author.validate_create("s", &ops()).unwrap();
    for field in ["surfaceId", "catalogId"] {
        let mut wrong = ops();
        wrong[0]["createSurface"][field] = json!("other");
        assert!(author.validate_create("s", &wrong).is_err());
    }
    let mut wrong = ops();
    wrong[1]["version"] = json!("v0.9");
    assert!(author.validate_create("s", &wrong).is_err());
    assert!(author.validate_edit(&initial, &ops()).is_err());
    assert!(
        author
            .validate_edit(
                &initial,
                &[json!({"version":"v0.9.1","deleteSurface":{"surfaceId":"s"}})]
            )
            .is_err()
    );
    let edited = author
        .validate_edit(
            &initial,
            &[json!({"version":"v0.9.1","updateDataModel":{"surfaceId":"s","path":"/items/0"}})],
        )
        .unwrap();
    assert!(edited.data_model().to_json().is_err());
    let saved: Vec<Value> = edited
        .history()
        .iter()
        .map(|op| serde_json::to_value(op).unwrap())
        .collect();
    assert_eq!(
        author.validate_create("s", &saved).unwrap().data_model(),
        edited.data_model()
    );
}
#[test]
fn async_generation_corrects_documents_and_preserves_provider_errors() {
    let author = A2uiAuthor::basic(A2uiVersion::V0_9_1).unwrap();
    let future = author
        .create("s", "greet")
        .generate(|prompt, attempt| async move {
            if attempt == 1 {
                Ok("invalid generated output".into())
            } else {
                assert!(prompt.contains("Correction required"));
                Ok(serde_json::to_string(&ops()).unwrap())
            }
        });
    fn assert_send<T: Send>(_: &T) {}
    assert_send(&future);
    let surface = ready(future).unwrap();
    assert_eq!(surface.attempts(), 2);
    let calls = std::rc::Rc::new(std::cell::Cell::new(0));
    let callback_calls = calls.clone();
    let error = ready(author.create("s", "greet").generate(move |_, _| {
        let calls = callback_calls.clone();
        async move {
            calls.set(calls.get() + 1);
            Err(Error::generation(std::io::Error::other(
                "provider unavailable",
            )))
        }
    }))
    .unwrap_err();
    assert_eq!(calls.get(), 1);
    assert!(matches!(error, Error::Generation(_)));
    assert!(std::error::Error::source(&error).is_some());
}
#[test]
fn undefined_bindings_fail_while_null_is_present() {
    use ag_ui_a2ui::{Catalog, Component, DataModel, DataModelUpdate, Validator};
    let components = vec![Component::new("root", "Text").with("text", json!({"path":"/items/0"}))];
    let mut model = DataModel::from(json!({"items":[null]}));
    let catalog = Catalog::basic();
    let validator = Validator::new(&catalog);
    assert!(validator.validate_model(&components, &model).is_valid());
    model.apply("/items/0", &DataModelUpdate::Remove).unwrap();
    assert!(!validator.validate_model(&components, &model).is_valid());
}

#[test]
fn registered_multi_catalog_stream_is_transactional_and_finalization_checks_pending_refs() {
    use ag_ui_a2ui::schema_validation::SurfaceValidator;
    let bundle = SchemaBundle::basic().unwrap();
    let mut stream = SurfaceValidator::new();
    stream.register(&bundle, &BTreeMap::new()).unwrap();
    stream.push(&ops()[0]).unwrap();
    assert!(stream.finish().is_err());
    let mut root = ops()[1].clone();
    root["updateComponents"]["components"] =
        json!([{"id":"root","component":"Card","child":"later"}]);
    stream.push(&root).unwrap();
    assert!(stream.finish().is_err());
    let before = stream.state().clone();
    let mut bad = root.clone();
    bad["updateComponents"]["components"][0]["child"] = json!("root");
    assert!(stream.push(&bad).is_err());
    assert_eq!(stream.state(), &before);
    stream.push(&json!({"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":[{"id":"later","component":"Text","text":"arrived"}]}})).unwrap();
    stream.finish().unwrap();
    let mut other = bundle.clone();
    other.catalog["catalogId"] = json!("example.com:other");
    stream.register(&other, &BTreeMap::new()).unwrap();
    stream.push(&json!({"version":"v0.9.1","createSurface":{"surfaceId":"other","catalogId":"example.com:other"}})).unwrap();
    stream.push(&json!({"version":"v0.9.1","updateComponents":{"surfaceId":"other","components":[{"id":"root","component":"Text","text":"independent"}]}})).unwrap();
    stream.finish().unwrap();
    assert_eq!(stream.state().surfaces().count(), 2);
    let mut resumed = SurfaceValidator::from_state(stream.state().clone());
    resumed.register(&bundle, &BTreeMap::new()).unwrap();
    resumed.register(&other, &BTreeMap::new()).unwrap();
    resumed.push(&json!({"version":"v0.9.1","updateDataModel":{"surfaceId":"other","path":"/memo","value":null}})).unwrap();
    resumed.finish().unwrap();
}

#[test]
fn an_edit_revalidates_prior_components_against_the_current_contract() {
    let mut weak_bundle = SchemaBundle::basic().unwrap();
    weak_bundle.catalog["components"]["Text"]["allOf"][2]["properties"]["variant"] =
        json!({"type":"string"});
    let weak = A2uiAuthor::new(A2uiVersion::V0_9_1, weak_bundle, BTreeMap::new()).unwrap();
    let mut messages = ops();
    messages[1]["updateComponents"]["components"][0]["variant"] = json!("banana");
    let prior = weak.validate_create("s", &messages).unwrap();
    let strict = A2uiAuthor::basic(A2uiVersion::V0_9_1).unwrap();
    assert!(strict.validate_edit(&prior, &[ops()[2].clone()]).is_err());
    assert!(strict.validate_edit(&prior, &[ops()[1].clone()]).is_err());
    let generated =
        ready(strict.edit(&prior, "repair").generate(|_, _| async {
            panic!("incompatible prior must fail before provider call")
        }));
    assert!(generated.is_err());
}

#[test]
fn inline_capabilities_keep_function_array_theme_and_local_resources() {
    use ag_ui_a2ui::toolkit::negotiate::{ClientCapabilitiesWire, select_catalog_schema};
    let wire = json!({"v0.9":{"supportedCatalogIds":["example.com:inline"],"inlineCatalogs":[{
        "catalogId":"example.com:inline",
        "components":{"Label":{"type":"object","properties":{"value":{"$ref":"https://local.example/label.json"}},"required":["value"]}},
        "functions":[{"name":"label","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false},"returnType":"string"}],
        "theme":{"accent":{"type":"string","enum":["blue","green"]}}
    }]}});
    let caps = ClientCapabilitiesWire::from_json(&wire).unwrap();
    let selected = select_catalog_schema(&[], &caps.v0_9, true).unwrap();
    assert!(selected["functions"].is_array());
    assert_eq!(
        selected["theme"],
        wire["v0.9"]["inlineCatalogs"][0]["theme"]
    );
    let bundle = SchemaBundle::from_inline_catalog(selected).unwrap();
    let resources = BTreeMap::from([(
        "https://local.example/label.json".into(),
        json!({"$schema":"https://json-schema.org/draft/2020-12/schema","type":"string","minLength":1}),
    )]);
    let author = A2uiAuthor::new(A2uiVersion::V0_9_1, bundle, resources).unwrap();
    let messages = vec![
        json!({"version":"v0.9.1","createSurface":{"surfaceId":"s","catalogId":"example.com:inline","theme":{"accent":"blue"}}}),
        json!({"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Label","value":"local"}]}}),
    ];
    author.validate_create("s", &messages).unwrap();
    let mut invalid = wire;
    invalid["v0.9"]["inlineCatalogs"][0]["functions"][0]["returnType"] = json!("invalid");
    assert!(ClientCapabilitiesWire::from_json(&invalid).is_err());
}
