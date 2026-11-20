use ag_ui_core::patch::apply_patch_to_copy;
use serde_json::{Value, json};

fn growing_patch(kind: &str, count: usize) -> Value {
    let mut operations = vec![json!({"op":"add","path":"/c","value":{}})];
    for _ in 0..count {
        operations.extend([
            json!({"op":"add","path":"/n","value":{}}),
            json!({"op":kind,"from":"/c","path":"/n/c"}),
            json!({"op":"move","from":"/n","path":"/c"}),
        ]);
    }
    json!(operations)
}

#[test]
fn failed_move_does_not_panic_and_working_copy_can_be_discarded() {
    let original = json!({"keep":1});
    let mut working_copy = original.clone();
    let operations: Vec<json_patch::PatchOperation> = serde_json::from_value(json!([
        {"op":"add","path":"/a","value":1},
        {"op":"move","from":"/a","path":"/missing/x"}
    ]))
    .unwrap();
    assert!(apply_patch_to_copy(&mut working_copy, &operations).is_err());
    drop(working_copy);
    assert_eq!(original, json!({"keep":1}));
}

#[test]
fn depth_growth_is_rejected_before_constructing_undroppable_values() {
    for kind in ["move", "copy"] {
        let original = json!({"keep":1});
        let mut working_copy = original.clone();
        let operations: Vec<json_patch::PatchOperation> =
            serde_json::from_value(growing_patch(kind, 4096)).unwrap();
        assert!(
            apply_patch_to_copy(&mut working_copy, &operations).is_err(),
            "{kind}"
        );
        // A depth check performed only after all operations would abort here
        // while recursively dropping the constructed document.
        drop(working_copy);
        assert_eq!(original, json!({"keep":1}));
    }
}

#[test]
fn patch_depth_boundary_is_checked_before_each_operation() {
    let mut document = json!({});
    let operations: Vec<json_patch::PatchOperation> =
        serde_json::from_value(growing_patch("move", 127)).unwrap();
    apply_patch_to_copy(&mut document, &operations).unwrap();
    // c plus 127 nested c properties reaches exactly 128 edges.
    let path = "/c".repeat(128);
    assert_eq!(document.pointer(&path), Some(&json!({})));
    let operations = serde_json::from_value::<Vec<json_patch::PatchOperation>>(json!([
        {"op":"add","path":"/n","value":{}},
        {"op":"move","from":"/c","path":"/n/c"}
    ]))
    .unwrap();
    assert!(apply_patch_to_copy(&mut document, &operations).is_err());
    assert!(
        document.pointer(&path).is_some(),
        "source is not removed before rejection"
    );
}

#[test]
fn insertion_depth_accounts_for_values_and_escaped_pointer_segments() {
    for operation in ["add", "replace"] {
        let mut document = json!({});
        let setup =
            serde_json::from_value::<Vec<json_patch::PatchOperation>>(growing_patch("move", 127))
                .unwrap();
        apply_patch_to_copy(&mut document, &setup).unwrap();
        let path = "/c".repeat(128);
        let operations = serde_json::from_value::<Vec<json_patch::PatchOperation>>(json!([
            {"op":operation,"path":path,"value":{"tooDeep":null}}
        ]))
        .unwrap();
        assert!(apply_patch_to_copy(&mut document, &operations).is_err());
    }
    let mut document = json!({});
    let operations = serde_json::from_value::<Vec<json_patch::PatchOperation>>(json!([
        {"op":"add","path":"/a~1b","value":{"":1}},
        {"op":"copy","from":"/a~1b","path":"/copy"},
        {"op":"test","path":"/copy/","value":1}
    ]))
    .unwrap();
    apply_patch_to_copy(&mut document, &operations).unwrap();
    assert_eq!(document, json!({"a/b":{"":1},"copy":{"":1}}));
}
