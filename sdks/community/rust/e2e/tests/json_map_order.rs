//! This consumer uses serde_json's default map policy. SDK dependencies must not
//! opt the whole application into insertion-ordered serialization.

use serde_json::{Map, Value};

#[test]
fn sdk_dependencies_preserve_the_consumers_default_json_map_order() {
    let mut object = Map::new();
    object.insert("z".into(), Value::from(1));
    object.insert("a".into(), Value::from(2));
    let snapshot = Value::Object(object);
    let event = ag_ui::Event::state_snapshot(snapshot);
    let event = serde_json::to_value(event).unwrap();
    assert_eq!(
        serde_json::to_string(&event["snapshot"]).unwrap(),
        r#"{"a":2,"z":1}"#
    );
}
