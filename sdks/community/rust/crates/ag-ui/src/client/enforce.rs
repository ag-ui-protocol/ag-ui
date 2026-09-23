//! The compatibility boundary between wire JSON and the closed Rust event enum.
//!
//! The pinned schema describes what this version understands. Unknown additions
//! are removed before deserializing into `Event`; malformed values of fields it
//! does understand are errors. Keeping this step before chunk expansion and
//! verification gives the same decision to every SSE consumer.

use std::collections::VecDeque;
use std::sync::OnceLock;

use futures_core::Stream;
use futures_util::StreamExt;
use serde_json::{Map, Value};

use crate::Event;
use crate::client::error::{Error, Result};

static SCHEMA: OnceLock<Value> = OnceLock::new();

fn schema() -> &'static Value {
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!("schema-1.0.json"))
            .expect("the vendored AG-UI 1.0 schema must be valid JSON")
    })
}

/// Decodes a wire event, skipping only material that this protocol version
/// does not recognise. The strict `Event` type remains the application boundary.
pub(crate) fn decode(mut value: Value) -> Result<Option<Event>> {
    if value.get("type").and_then(Value::as_str).is_none() {
        return Err(Error::protocol("event /type must be a string"));
    }

    let mut warnings = Vec::new();
    let keep = normalize(&mut value, schema(), "", &mut warnings)?;
    for warning in warnings {
        eprintln!("ag-ui: {warning}");
    }
    if !keep {
        return Ok(None);
    }
    let event: Event = serde_json::from_value(value)?;
    if let Event::RunStarted(started) = &event {
        if let Some(version) = &started.protocol_version {
            let current = (1, 0);
            let declared = version.split_once('.').and_then(|(major, minor)| {
                Some((major.parse::<u64>().ok()?, minor.parse::<u64>().ok()?))
            });
            if declared.is_none_or(|peer| peer > current) {
                eprintln!(
                    "ag-ui: producer declared newer or uninterpretable protocol version {version}"
                );
            }
        }
    }
    Ok(Some(event))
}

/// Applies the same enforcement to every transport. An error stops the run;
/// unknown additions disappear without reaching the typed event stream.
pub(crate) fn stream<S>(raw: S) -> impl Stream<Item = Result<Event>>
where
    S: Stream<Item = Result<Value>>,
{
    futures_util::stream::unfold(
        (Box::pin(raw), false, Legacy::default(), VecDeque::new()),
        |(mut raw, done, mut legacy, mut ready)| async move {
            if done {
                return None;
            }
            loop {
                if let Some(value) = ready.pop_front() {
                    match decode(value) {
                        Ok(Some(event)) => return Some((Ok(event), (raw, false, legacy, ready))),
                        Ok(None) => continue,
                        Err(error) => return Some((Err(error), (raw, true, legacy, ready))),
                    }
                }
                match raw.next().await? {
                    Ok(value) => match legacy.translate(value) {
                        Ok(values) => ready.extend(values),
                        Err(error) => return Some((Err(error), (raw, true, legacy, ready))),
                    },
                    Err(error) => return Some((Err(error), (raw, true, legacy, ready))),
                }
            }
        },
    )
}

#[derive(Default)]
struct Legacy {
    reasoning_id: Option<String>,
    message_id: Option<String>,
}

impl Legacy {
    fn translate(&mut self, mut value: Value) -> Result<Vec<Value>> {
        let Some(tag) = value.get("type").and_then(Value::as_str).map(str::to_owned) else {
            return Ok(vec![value]);
        };
        if tag == "RUN_STARTED" {
            self.reasoning_id = None;
            self.message_id = None;
        }
        if !is_legacy_reasoning_tag(&tag) {
            return Ok(vec![value]);
        }
        // Validate the retired shape before translation: compatibility must
        // never turn a malformed known value into an apparently valid one.
        let _: Event = serde_json::from_value(value.clone())?;
        let mut before = Vec::new();
        let (replacement, generated) = match tag.as_str() {
            "THINKING_START" => {
                let id = crate::client::thread::random_id()?;
                self.reasoning_id = Some(id.clone());
                if let Some(title) = value.as_object_mut().and_then(|v| v.remove("title")) {
                    eprintln!(
                        "ag-ui: THINKING_START.title {title} was dropped during reasoning translation"
                    );
                }
                ("REASONING_START", id)
            }
            "THINKING_TEXT_MESSAGE_START" => {
                let id = match &self.reasoning_id {
                    Some(id) => id.clone(),
                    None => crate::client::thread::random_id()?,
                };
                self.message_id = Some(id.clone());
                value["role"] = Value::String("reasoning".to_owned());
                ("REASONING_MESSAGE_START", id)
            }
            "THINKING_TEXT_MESSAGE_CONTENT" => {
                let id = match &self.message_id {
                    Some(id) => id.clone(),
                    None => {
                        let id = match &self.reasoning_id {
                            Some(id) => id.clone(),
                            None => crate::client::thread::random_id()?,
                        };
                        self.message_id = Some(id.clone());
                        before.push(serde_json::json!({
                            "type": "REASONING_MESSAGE_START",
                            "messageId": id,
                            "role": "reasoning"
                        }));
                        id
                    }
                };
                ("REASONING_MESSAGE_CONTENT", id)
            }
            "THINKING_TEXT_MESSAGE_END" => {
                let id = match self.message_id.take() {
                    Some(id) => id,
                    None => {
                        let id = match &self.reasoning_id {
                            Some(id) => id.clone(),
                            None => crate::client::thread::random_id()?,
                        };
                        before.push(serde_json::json!({
                            "type": "REASONING_MESSAGE_START",
                            "messageId": id,
                            "role": "reasoning"
                        }));
                        id
                    }
                };
                ("REASONING_MESSAGE_END", id)
            }
            "THINKING_END" => {
                let id = match self.reasoning_id.take() {
                    Some(id) => id,
                    None => crate::client::thread::random_id()?,
                };
                if let Some(message_id) = self.message_id.take() {
                    before.push(serde_json::json!({
                        "type": "REASONING_MESSAGE_END",
                        "messageId": message_id
                    }));
                }
                ("REASONING_END", id)
            }
            _ => unreachable!(),
        };
        value["type"] = Value::String(replacement.to_owned());
        value["messageId"] = Value::String(generated);
        eprintln!("ag-ui: translated retired {tag} to {replacement}");
        before.push(value);
        Ok(before)
    }
}

fn is_legacy_reasoning_tag(tag: &str) -> bool {
    matches!(
        tag,
        "THINKING_START"
            | "THINKING_END"
            | "THINKING_TEXT_MESSAGE_START"
            | "THINKING_TEXT_MESSAGE_CONTENT"
            | "THINKING_TEXT_MESSAGE_END"
    )
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
            .ok_or_else(|| Error::protocol(format!("unsupported schema reference {reference}")))?;
        let definition = schema()
            .pointer(&format!("/$defs/{name}"))
            .ok_or_else(|| Error::protocol(format!("missing schema definition {name}")))?;
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
        return Err(Error::protocol(format!(
            "{} does not match a known union member",
            display_path(path)
        )));
    }

    if let Some(expected) = shape.get("type").and_then(Value::as_str) {
        if !type_matches(value, expected) {
            return Err(Error::protocol(format!(
                "{} must be {expected}",
                display_path(path)
            )));
        }
    }
    if shape.pointer("/not/type").and_then(Value::as_str) == Some("null") && value.is_null() {
        return Err(Error::protocol(format!(
            "{} must not be null",
            display_path(path)
        )));
    }
    if let Some(minimum) = shape.get("minimum").and_then(Value::as_f64) {
        if value.as_f64().is_some_and(|number| number < minimum) {
            return Err(Error::protocol(format!(
                "{} must be at least {minimum}",
                display_path(path)
            )));
        }
    }
    if let Some(maximum) = shape.get("maximum").and_then(Value::as_f64) {
        if value.as_f64().is_some_and(|number| number > maximum) {
            return Err(Error::protocol(format!(
                "{} must be at most {maximum}",
                display_path(path)
            )));
        }
    }
    if let Some(pattern) = shape.get("pattern").and_then(Value::as_str) {
        if pattern != "^(/([^/~]|~[01])*)*$" {
            return Err(Error::protocol(format!(
                "unsupported schema pattern at {}: {pattern}",
                display_path(path)
            )));
        }
        if value.as_str().is_some_and(|text| !is_json_pointer(text)) {
            return Err(Error::protocol(format!(
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
            return Err(Error::protocol(format!(
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
                return Err(Error::protocol(format!(
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
                return Err(Error::protocol(format!(
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
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn display_path(path: &str) -> &str {
    if path.is_empty() { "/" } else { path }
}
