#![cfg(feature = "schema-validation")]

use ag_ui_a2ui::schema_validation::SurfaceValidator;
use ag_ui_a2ui::toolkit::schema::SchemaBundle;
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

#[test]
fn all_official_basic_examples_pass_schema_and_state_validation() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/spec_v0_9/examples");
    let mut files: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert_eq!(files.len(), 43, "update the pinned corpus deliberately");
    let bundle = SchemaBundle::basic().unwrap();
    for path in files {
        let example: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut validator = SurfaceValidator::new();
        validator.register(&bundle, &BTreeMap::new()).unwrap();
        for (index, message) in example["messages"].as_array().unwrap().iter().enumerate() {
            validator
                .push(message)
                .unwrap_or_else(|error| panic!("{} message {index}: {error}", path.display()));
        }
        validator
            .finish()
            .unwrap_or_else(|error| panic!("{} final state: {error}", path.display()));
    }
}
