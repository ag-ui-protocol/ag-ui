//! Shared schema enforcement before protocol values reach typed consumers.
//!
//! Unknown additions are removed; malformed known values fail. This module
//! owns no transport or runtime dependencies, so clients and hosted endpoints
//! apply the same rules with independent feature sets.

use std::sync::OnceLock;

use serde_json::{Map, Value};

type Result<T> = std::result::Result<T, String>;

static SCHEMA: OnceLock<Value> = OnceLock::new();

fn schema() -> &'static Value {
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("protocol/schema-1.0.json"))
            .expect("the vendored AG-UI 1.0 schema must be valid JSON")
    })
}

#[cfg(feature = "client")]
pub(crate) fn event(mut value: Value) -> Result<Option<Value>> {
    if value.get("type").and_then(Value::as_str).is_none() {
        return Err(protocol_error("event /type must be a string"));
    }
    Ok(enforce(&mut value, schema())?.then_some(value))
}

#[cfg(feature = "axum")]
pub(crate) fn input(mut value: Value) -> Result<Value> {
    let shape = schema()
        .pointer("/$defs/RunAgentInput")
        .expect("input schema exists");
    if !enforce(&mut value, shape)? {
        return Err(protocol_error(
            "run input contains an unrecognised required value",
        ));
    }
    Ok(value)
}

fn enforce(value: &mut Value, shape: &Value) -> Result<bool> {
    let mut warnings = Vec::new();
    let keep = normalize(value, shape, "", &mut warnings)?;
    for warning in warnings {
        eprintln!("ag-ui: {warning}");
    }
    Ok(keep)
}

fn protocol_error(message: impl Into<String>) -> String {
    message.into()
}

/// Returns `false` for an unknown union member, which the parent removes from
/// its optional position or list. A malformed known member returns an error.
fn normalize(
    value: &mut Value,
    shape: &Value,
    path: &str,
    warnings: &mut Vec<String>,
) -> Result<bool> {
    if let Some(reference) = shape.get("$ref").and_then(Value::as_str) {
        let name = reference
            .strip_prefix("#/$defs/")
            .ok_or_else(|| protocol_error(format!("unsupported schema reference {reference}")))?;
        let definition = schema()
            .pointer(&format!("/$defs/{name}"))
            .ok_or_else(|| protocol_error(format!("missing schema definition {name}")))?;
        if !normalize(value, definition, path, warnings)? {
            return Ok(false);
        }
        // JSON Schema combines `$ref` with adjacent keywords. In particular,
        // RunAgentInput.state references open State while forbidding null here.
        let mut adjacent = shape.clone();
        adjacent
            .as_object_mut()
            .expect("schema reference is an object")
            .remove("$ref");
        return normalize(value, &adjacent, path, warnings);
    }

    if let Some(branches) = shape.get("oneOf").and_then(Value::as_array) {
        if let Some(branch) = selected_branch(value, branches) {
            return normalize(value, branch, path, warnings);
        }
        if has_unknown_discriminator(value, branches) {
            warnings.push(format!(
                "unrecognised union member at {}",
                display_path(path)
            ));
            return Ok(false);
        }
        return Err(protocol_error(format!(
            "{} does not match a known union member",
            display_path(path)
        )));
    }

    if let Some(expected) = shape.get("type").and_then(Value::as_str) {
        if !type_matches(value, expected) {
            return Err(protocol_error(format!(
                "{} must be {expected}",
                display_path(path)
            )));
        }
    }
    if shape.pointer("/not/type").and_then(Value::as_str) == Some("null") && value.is_null() {
        return Err(protocol_error(format!(
            "{} must not be null",
            display_path(path)
        )));
    }
    if let Some(minimum) = shape.get("minimum").and_then(Value::as_f64) {
        if value.as_f64().is_some_and(|number| number < minimum) {
            return Err(protocol_error(format!(
                "{} must be at least {minimum}",
                display_path(path)
            )));
        }
    }
    if let Some(maximum) = shape.get("maximum").and_then(Value::as_f64) {
        if value.as_f64().is_some_and(|number| number > maximum) {
            return Err(protocol_error(format!(
                "{} must be at most {maximum}",
                display_path(path)
            )));
        }
    }
    // JSON Schema's integer type is mathematical: `1.0` and `1e0` are
    // integers too. Canonicalize only after checking numeric bounds so serde's
    // integer types receive the same value, without truncating or saturating.
    if shape.get("type").and_then(Value::as_str) == Some("integer")
        && !value.is_i64()
        && !value.is_u64()
    {
        let number = value.as_f64().expect("integer type was checked above");
        *value = if number >= i64::MIN as f64 && number < -(i64::MIN as f64) {
            Value::from(number as i64)
        } else if number >= 0.0 && number < u64::MAX as f64 {
            Value::from(number as u64)
        } else {
            return Err(protocol_error(format!(
                "{} integer is outside the supported range",
                display_path(path)
            )));
        };
    }
    if let Some(pattern) = shape.get("pattern").and_then(Value::as_str) {
        if pattern != "^(/([^/~]|~[01])*)*$" {
            return Err(protocol_error(format!(
                "unsupported schema pattern at {}: {pattern}",
                display_path(path)
            )));
        }
        if value.as_str().is_some_and(|text| !is_json_pointer(text)) {
            return Err(protocol_error(format!(
                "{} must be an RFC 6901 JSON Pointer",
                display_path(path)
            )));
        }
    }
    if let Some(allowed) = shape.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            warnings.push(format!(
                "unrecognised enum member at {}",
                display_path(path)
            ));
            return Ok(false);
        }
    }
    if let Some(constant) = shape.get("const") {
        if value != constant {
            return Err(protocol_error(format!(
                "{} must equal {constant}",
                display_path(path)
            )));
        }
    }

    if let Some(items) = value.as_array_mut() {
        if let Some(item_schema) = shape.get("items") {
            let mut index = 0;
            while index < items.len() {
                if normalize(
                    &mut items[index],
                    item_schema,
                    &format!("{path}/{index}"),
                    warnings,
                )? {
                    index += 1;
                } else {
                    items.remove(index);
                }
            }
        }
        if let Some(minimum) = shape.get("minItems").and_then(Value::as_u64) {
            if items.len() < minimum as usize {
                return Err(protocol_error(format!(
                    "{} must contain at least {minimum} item(s)",
                    display_path(path)
                )));
            }
        }
        return Ok(true);
    }

    if let Some(object) = value.as_object_mut() {
        let properties = known_properties(shape)?;
        let required = required_fields(shape)?;
        for (name, property) in &properties {
            if let Some(member) = object.get_mut(name) {
                let member_path = format!("{path}/{}", name.replace('~', "~0").replace('/', "~1"));
                if !normalize(member, property, &member_path, warnings)? {
                    if required.contains(name) {
                        warnings.push(format!(
                            "dropped containing value at {} because {member_path} is required",
                            display_path(path)
                        ));
                        return Ok(false);
                    }
                    object.remove(name);
                }
            } else if required.contains(name) {
                return Err(protocol_error(format!(
                    "{} is missing required field {name}",
                    display_path(path)
                )));
            }
        }
        let closed = shape.get("unevaluatedProperties") == Some(&Value::Bool(false))
            || shape.get("additionalProperties") == Some(&Value::Bool(false));
        if closed {
            object.retain(|name, _| {
                let known = properties.contains_key(name);
                if !known {
                    warnings.push(format!("unrecognised property at {path}/{name}"));
                }
                known
            });
        }
    }
    Ok(true)
}

fn is_json_pointer(pointer: &str) -> bool {
    if !pointer.is_empty() && !pointer.starts_with('/') {
        return false;
    }
    let mut chars = pointer.chars();
    while let Some(c) = chars.next() {
        if c == '~' && !matches!(chars.next(), Some('0' | '1')) {
            return false;
        }
    }
    true
}

fn selected_branch<'a>(value: &Value, branches: &'a [Value]) -> Option<&'a Value> {
    if let Some(object) = value.as_object() {
        if let Some(branch) = branches.iter().find(|branch| {
            let definition = resolve(branch).unwrap_or(branch);
            definition
                .get("properties")
                .and_then(Value::as_object)
                .is_some_and(|properties| {
                    properties.iter().any(|(name, property)| {
                        property
                            .get("const")
                            .is_some_and(|constant| object.get(name) == Some(constant))
                    })
                })
        }) {
            return Some(branch);
        }
    }
    let mut matching = branches.iter().filter(|branch| {
        resolve(branch)
            .unwrap_or(branch)
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|expected| type_matches(value, expected))
    });
    let candidate = matching.next()?;
    matching.next().is_none().then_some(candidate)
}

fn has_unknown_discriminator(value: &Value, branches: &[Value]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    ["type", "role", "op"].iter().any(|name| {
        object.get(*name).is_some_and(Value::is_string)
            && branches.iter().all(|branch| {
                resolve(branch)
                    .unwrap_or(branch)
                    .pointer(&format!("/properties/{name}/const"))
                    .is_some()
            })
    })
}

fn resolve(shape: &Value) -> Option<&Value> {
    let name = shape.get("$ref")?.as_str()?.strip_prefix("#/$defs/")?;
    schema().pointer(&format!("/$defs/{name}"))
}

fn known_properties(shape: &Value) -> Result<Map<String, Value>> {
    let mut result = Map::new();
    if let Some(properties) = shape.get("properties").and_then(Value::as_object) {
        result.extend(properties.clone());
    }
    if let Some(composed) = shape.get("allOf").and_then(Value::as_array) {
        for part in composed {
            let part = resolve(part).unwrap_or(part);
            result.extend(known_properties(part)?);
        }
    }
    Ok(result)
}

fn required_fields(shape: &Value) -> Result<Vec<String>> {
    let mut required = shape
        .get("required")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(composed) = shape.get("allOf").and_then(Value::as_array) {
        for part in composed {
            required.extend(required_fields(resolve(part).unwrap_or(part))?);
        }
    }
    Ok(required)
}

fn type_matches(value: &Value, expected: &str) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "integer" => {
            value.is_i64()
                || value.is_u64()
                || value
                    .as_f64()
                    .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
        }
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn display_path(path: &str) -> &str {
    if path.is_empty() { "/" } else { path }
}
