//! Reads the frozen AG-UI 1.0 JSON Schema as the normative event surface.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::upstream::{Field, Upstream, UpstreamEvent};

pub fn extract(text: &str) -> Result<Upstream, String> {
    let document: Value = serde_json::from_str(text)
        .map_err(|error| format!("protocol schema is invalid JSON: {error}"))?;
    if document.get("$id").and_then(Value::as_str) != Some("https://ag-ui.com/spec/1.0/schema.json")
    {
        return Err("expected the frozen AG-UI 1.0 schema $id".to_owned());
    }
    if document.get("$ref").and_then(Value::as_str) != Some("#/$defs/Event") {
        return Err("the schema root must reference #/$defs/Event".to_owned());
    }
    let defs = document
        .get("$defs")
        .and_then(Value::as_object)
        .ok_or("protocol schema has no $defs object")?;
    let event_types = defs
        .get("EventType")
        .and_then(|v| v.get("enum"))
        .and_then(Value::as_array)
        .ok_or("protocol schema has no EventType enum")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "EventType enum contains a non-string member".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let base_fields = fields(defs.get("BaseEvent").ok_or("missing BaseEvent")?, defs, &[])?
        .into_iter()
        .filter(|field| field.name != "type")
        .collect::<Vec<_>>();
    let inherited = base_fields
        .iter()
        .map(|field| field.name.as_str())
        .chain(std::iter::once("type"))
        .collect::<Vec<_>>();
    let union = defs
        .get("Event")
        .and_then(|value| value.get("oneOf"))
        .and_then(Value::as_array)
        .ok_or("protocol schema has no Event.oneOf")?;
    let mut events = Vec::with_capacity(union.len());
    let mut seen = BTreeSet::new();
    for reference in union {
        let name = reference
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|reference| reference.strip_prefix("#/$defs/"))
            .ok_or("Event.oneOf contains an unsupported reference")?;
        let shape = defs
            .get(name)
            .ok_or_else(|| format!("Event.oneOf points at missing {name}"))?;
        let event_type = shape
            .pointer("/properties/type/const")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{name} has no type.const"))?;
        if !event_types.iter().any(|known| known == event_type) {
            return Err(format!(
                "{name} declares {event_type}, absent from EventType"
            ));
        }
        if !seen.insert(event_type.to_owned()) {
            return Err(format!("Event.oneOf declares {event_type} more than once"));
        }
        let event_fields = fields(shape, defs, &inherited)?;
        events.push(UpstreamEvent {
            event_type: event_type.to_owned(),
            schema: Some(name.to_owned()),
            fields: event_fields,
            unparsed: None,
        });
    }
    let expected = event_types.iter().cloned().collect::<BTreeSet<_>>();
    if expected.len() != event_types.len() {
        return Err("EventType enum contains duplicate values".to_owned());
    }
    if seen != expected {
        return Err(format!(
            "Event.oneOf does not match EventType: missing {:?}",
            expected.difference(&seen).collect::<Vec<_>>()
        ));
    }
    Ok(Upstream {
        event_types,
        base_fields,
        events,
        schema_signatures: defs
            .iter()
            .map(|(name, shape)| (name.clone(), signature(shape)))
            .collect(),
        notes: Vec::new(),
    })
}

/// FNV-1a over a canonical JSON representation. This is a drift fingerprint,
/// not a security hash: changed field types and union variants must demand
/// review even when their names and requiredness did not change.
fn signature(shape: &Value) -> String {
    let canonical = canonical(shape);
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in canonical.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut fields = BTreeMap::new();
            for (key, value) in object {
                if !matches!(
                    key.as_str(),
                    "description" | "$anchor" | "title" | "examples"
                ) {
                    fields.insert(key, value);
                }
            }
            let pairs = fields
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{pairs}}}")
        }
        Value::Array(array) => {
            let items = array.iter().map(canonical).collect::<Vec<_>>().join(",");
            format!("[{items}]")
        }
        _ => serde_json::to_string(value).expect("JSON Value serializes"),
    }
}

fn fields(
    shape: &Value,
    defs: &serde_json::Map<String, Value>,
    inherited: &[&str],
) -> Result<Vec<Field>, String> {
    let mut fields = BTreeMap::new();
    let mut required = Vec::new();
    collect(shape, defs, &mut fields, &mut required)?;
    Ok(fields
        .into_iter()
        .filter(|(name, _)| !inherited.contains(&name.as_str()))
        .map(|(name, shape)| Field {
            required: required.contains(&name),
            name,
            kind: wire_kind(&shape, defs),
        })
        .collect())
}

fn wire_kind(shape: &Value, defs: &serde_json::Map<String, Value>) -> String {
    if let Some(reference) = shape.get("$ref").and_then(Value::as_str) {
        if let Some(name) = reference.strip_prefix("#/$defs/") {
            if let Some(definition) = defs.get(name) {
                return wire_kind(definition, defs);
            }
        }
        return format!("unsupported-ref:{reference}");
    }
    if let Some(ty) = shape.get("type").and_then(Value::as_str) {
        return ty.to_owned();
    }
    if let Some(constant) = shape.get("const") {
        return match constant {
            Value::String(_) => "string",
            Value::Bool(_) => "boolean",
            Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
            Value::Number(_) => "number",
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
        .to_owned();
    }
    if let Some(branches) = shape
        .get("oneOf")
        .or_else(|| shape.get("anyOf"))
        .and_then(Value::as_array)
    {
        let mut kinds = branches
            .iter()
            .map(|branch| wire_kind(branch, defs))
            .collect::<Vec<_>>();
        kinds.sort();
        kinds.dedup();
        return kinds.join("|");
    }
    if shape.get("properties").is_some() {
        return "object".to_owned();
    }
    "any".to_owned()
}

fn collect(
    shape: &Value,
    defs: &serde_json::Map<String, Value>,
    fields: &mut BTreeMap<String, Value>,
    required: &mut Vec<String>,
) -> Result<(), String> {
    if let Some(reference) = shape.get("$ref").and_then(Value::as_str) {
        let name = reference
            .strip_prefix("#/$defs/")
            .ok_or_else(|| format!("unsupported schema reference {reference}"))?;
        let definition = defs
            .get(name)
            .ok_or_else(|| format!("missing schema definition {name}"))?;
        return collect(definition, defs, fields, required);
    }
    if let Some(properties) = shape.get("properties").and_then(Value::as_object) {
        for (name, property) in properties {
            fields.insert(name.clone(), property.clone());
        }
    }
    if let Some(names) = shape.get("required").and_then(Value::as_array) {
        for name in names {
            let name = name
                .as_str()
                .ok_or("required list contains a non-string field")?;
            if !required.iter().any(|value| value == name) {
                required.push(name.to_owned());
            }
        }
    }
    if let Some(parts) = shape.get("allOf").and_then(Value::as_array) {
        for part in parts {
            collect(part, defs, fields, required)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_schema_exposes_version_and_inherited_fields() {
        let schema = include_str!("../../../../../../spec/1.0/schema.json");
        let surface = extract(schema).unwrap();
        assert_eq!(surface.event_types.len(), 31);
        let started = surface
            .events
            .iter()
            .find(|event| event.event_type == "RUN_STARTED")
            .unwrap();
        assert!(
            started
                .fields
                .iter()
                .any(|field| field.name == "protocolVersion" && !field.required)
        );
        assert!(!started.fields.iter().any(|field| field.name == "timestamp"));
    }

    #[test]
    fn signature_detects_a_known_field_type_change() {
        let schema = include_str!("../../../../../../spec/1.0/schema.json");
        let original = extract(schema).unwrap();
        let mut changed: Value = serde_json::from_str(schema).unwrap();
        changed["$defs"]["TextMessageContentEvent"]["properties"]["delta"]["type"] =
            Value::String("integer".into());
        let changed = extract(&changed.to_string()).unwrap();
        assert_ne!(
            original.schema_signatures["TextMessageContentEvent"],
            changed.schema_signatures["TextMessageContentEvent"]
        );
    }

    #[test]
    fn duplicated_event_union_member_cannot_hide_a_missing_type() {
        let schema = include_str!("../../../../../../spec/1.0/schema.json");
        let mut changed: Value = serde_json::from_str(schema).unwrap();
        let repeated = changed["$defs"]["Event"]["oneOf"][0].clone();
        changed["$defs"]["Event"]["oneOf"][30] = repeated;
        let error = extract(&changed.to_string()).unwrap_err();
        assert!(error.contains("more than once"), "{error}");
    }

    #[test]
    fn a_changed_schema_root_cannot_pass_as_event_conformance() {
        let schema = include_str!("../../../../../../spec/1.0/schema.json");
        let mut changed: Value = serde_json::from_str(schema).unwrap();
        changed["$ref"] = Value::String("#/$defs/RunAgentInput".into());
        let error = extract(&changed.to_string()).unwrap_err();
        assert!(error.contains("schema root"), "{error}");
    }
}
