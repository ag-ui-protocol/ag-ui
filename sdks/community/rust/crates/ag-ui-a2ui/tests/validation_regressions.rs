use ag_ui_a2ui::binding::{ModelScope, Scope};
use ag_ui_a2ui::{Catalog, Component, DataModel, ErrorCode, ValidateOptions, Validator};
use serde_json::json;

fn nested_components() -> Vec<Component> {
    vec![
        Component::new("root", "Column")
            .with("children", json!({"path":"/groups","componentId":"group"})),
        Component::new("group", "Column")
            .with("children", json!({"path":"members","componentId":"member"})),
        Component::new("member", "Text").with("text", json!({"path":"name"})),
    ]
}

#[test]
fn relative_pointer_escapes_and_empty_segments_are_preserved_in_both_scopes() {
    let data = json!({"groups":{"": [{"a/b":"slash", "a~b":"tilde", "":"empty"}]}});
    let model = DataModel::from(data.clone());
    let scope = Scope::root(&data).item("/groups/", 0);
    let lossless = ModelScope::root(&model).item("/groups/", 0);
    assert_eq!(scope.base(), "/groups//0");
    assert_eq!(lossless.base(), scope.base());
    for (path, expected) in [("a~1b", "slash"), ("a~0b", "tilde")] {
        assert_eq!(scope.resolve_string(path), expected);
        assert_eq!(
            lossless.resolve(path).unwrap().unwrap().to_json().unwrap(),
            json!(expected)
        );
    }
    assert!(scope.resolve("a~2b").is_none());
    assert!(lossless.resolve("a~2b").is_err());
}

#[test]
fn nested_templates_validate_every_item_independent_of_component_order() {
    let catalog = Catalog::basic();
    let validator = Validator::with_options(
        &catalog,
        ValidateOptions {
            require_bound_values: true,
            ..Default::default()
        },
    );
    let mut components = nested_components();
    components.reverse();
    let data = json!({"groups":[{"members":[{"name":"Ada"}]},{"members":[{"name":"Lin"}]}]});
    assert!(
        validator
            .validate_surface(&components, Some(&data))
            .is_valid()
    );
    assert!(
        validator
            .validate_model(&components, &DataModel::from(data))
            .is_valid()
    );
    let missing = json!({"groups":[{"members":[{"name":"Ada"}]},{"members":[{}]}]});
    let report = validator.validate_surface(&components, Some(&missing));
    assert_eq!(report.errors.len(), 1, "{report:?}");
    assert_eq!(report.errors[0].path, "components[0].text");
    assert!(
        report.errors[0]
            .message
            .contains("/groups/1/members/0/name")
    );
}

#[test]
fn optional_existence_lint_does_not_hide_existing_collection_type_errors() {
    let catalog = Catalog::basic();
    let validator = Validator::new(&catalog);
    let components = nested_components();
    for data in [json!({}), json!({"groups":[]}), json!({"groups":[{}]})] {
        assert!(
            validator
                .validate_surface(&components, Some(&data))
                .is_valid()
        );
    }
    for bad in [
        json!({"groups":false}),
        json!({"groups":[{"members":[]},{"members":{}}]}),
    ] {
        let report = validator.validate_surface(&components, Some(&bad));
        assert_eq!(report.errors.len(), 1, "{report:?}");
        assert!(report.errors[0].message.contains("must point at an array"));
    }
}

#[test]
fn malformed_relative_pointers_fail_even_without_collection_data() {
    let catalog = Catalog::basic();
    let mut components = nested_components();
    components[2]
        .props
        .insert("text".into(), json!({"path":"bad~2escape"}));
    for report in [
        Validator::new(&catalog).validate(&components),
        Validator::new(&catalog).validate_surface(&components, Some(&json!({"groups":[]}))),
    ] {
        assert_eq!(report.errors.len(), 1, "{report:?}");
        assert_eq!(report.errors[0].code, ErrorCode::UnresolvedBinding);
        assert!(report.errors[0].message.contains("Invalid path syntax"));
    }
}

#[test]
fn nonnumeric_array_indices_fail_with_optional_missing_value_checks() {
    let catalog = Catalog::basic();
    let report = Validator::new(&catalog).validate_surface(
        &[Component::new("root", "Text").with("text", json!({"path":"/items/first"}))],
        Some(&json!({"items":["Ada"]})),
    );
    assert_eq!(report.errors.len(), 1, "{report:?}");
    assert!(report.errors[0].message.contains("canonical array index"));
}

#[test]
fn null_is_a_value_with_a_type_rather_than_a_missing_property() {
    let catalog = Catalog::basic();
    let report = Validator::new(&catalog)
        .validate(&[Component::new("root", "Text").with("text", json!(null))]);
    assert_eq!(report.errors.len(), 1, "{report:?}");
    assert_eq!(report.errors[0].code, ErrorCode::TypeMismatch);
}

#[test]
fn empty_collection_path_segment_is_preserved_by_validation() {
    let catalog = Catalog::basic();
    let validator = Validator::with_options(
        &catalog,
        ValidateOptions {
            require_bound_values: true,
            ..Default::default()
        },
    );
    let components = vec![
        Component::new("root", "Column").with(
            "children",
            json!({"path":"/groups/","componentId":"member"}),
        ),
        Component::new("member", "Text").with("text", json!({"path":"name"})),
    ];
    let data = json!({"groups":{"": [{"name":"Ada"}]}});
    assert!(
        validator
            .validate_surface(&components, Some(&data))
            .is_valid()
    );
    assert!(
        validator
            .validate_model(&components, &DataModel::from(data))
            .is_valid()
    );
}

#[test]
#[cfg(feature = "author")]
fn required_nullable_custom_property_is_present_but_still_type_checked() {
    use ag_ui_a2ui::{A2uiAuthor, A2uiVersion, toolkit::schema::SchemaBundle};
    let bundle = SchemaBundle::from_inline_catalog(json!({
        "catalogId":"example.com:nullable",
        "components":{"Nullable":{"type":"object",
            "properties":{"value":{"type":["string","null"]}},"required":["value"]}}
    }))
    .unwrap();
    let author = A2uiAuthor::new(A2uiVersion::V0_9_1, bundle, Default::default()).unwrap();
    let mut messages = vec![
        json!({"version":"v0.9.1","createSurface":{"surfaceId":"s","catalogId":"example.com:nullable"}}),
        json!({"version":"v0.9.1","updateComponents":{"surfaceId":"s","components":[{"id":"root","component":"Nullable","value":null}]}}),
    ];
    author.validate_create("s", &messages).unwrap();
    messages[1]["updateComponents"]["components"][0]["value"] = json!(42);
    assert!(author.validate_create("s", &messages).is_err());
    messages[1]["updateComponents"]["components"][0]
        .as_object_mut()
        .unwrap()
        .remove("value");
    assert!(author.validate_create("s", &messages).is_err());
}
