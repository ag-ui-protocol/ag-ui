//! Shared schema enforcement before protocol values reach typed consumers.
//!
//! Unknown additions are removed; malformed known values fail. What is removed
//! is pushed onto the caller's `warnings`, which decides where it goes; nothing
//! here prints. This module owns no transport or runtime dependencies, so
//! clients and hosted endpoints apply the same rules with independent feature
//! sets.

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
pub(crate) fn event(mut value: Value, warnings: &mut Vec<String>) -> Result<Option<Value>> {
    if value.get("type").and_then(Value::as_str).is_none() {
        return Err(protocol_error("event /type must be a string"));
    }
    let shape = schema()
        .pointer("/$defs/Event")
        .expect("event schema exists");
    Ok(normalize(&mut value, shape, "", warnings)?.then_some(value))
}

pub(crate) fn input(mut value: Value, warnings: &mut Vec<String>) -> Result<Value> {
    // An older client's request may carry the registered nulls too; nothing
    // ahead of this function reads them as omitted.
    omit_input_nulls(&mut value, &mut Noticed::default(), warnings);
    crate::message::upgrade_wire_messages(value.get_mut("messages"), "/messages", warnings);
    let shape = schema()
        .pointer("/$defs/RunAgentInput")
        .expect("input schema exists");
    if !normalize(&mut value, shape, "", warnings)? {
        return Err(protocol_error(
            "run input contains an unrecognised required value",
        ));
    }
    Ok(value)
}

fn protocol_error(message: impl Into<String>) -> String {
    message.into()
}

pub(crate) use crate::serde_util::excerpt;

/// The AG-UI 1.0 optional-null registry: whole optional fields that pre-1.0
/// producers wrote as `null`, which a consumer reads as omitted. Each row is a
/// field and where it sits, in the order of the "`X: null` → omit the field"
/// rows of upstream `DEPRECATIONS.md`, read at ag-ui-protocol/ag-ui
/// 2330368a2a74573902858867072406638ba3073d. A location in capitals is an event
/// type. A `null` in any other optional field is left for enforcement to
/// reject, and a `null` inside application data is never touched.
const OPTIONAL_NULLS: [(&str, &str); 23] = [
    ("parentMessageId", "TOOL_CALL_START"),
    ("parentMessageId", "TOOL_CALL_CHUNK"),
    ("outcome", "RUN_FINISHED"),
    ("rawEvent", "an event"),
    ("result", "RUN_FINISHED"),
    ("result", "SUBAGENT_FINISHED"),
    ("payload", "a resume entry"),
    ("metadata", "an image content part"),
    ("metadata", "an audio content part"),
    ("metadata", "a video content part"),
    ("metadata", "a document content part"),
    ("parameters", "a tool"),
    ("forwardedProps", "RunAgentInput"),
    ("subagentRunId", "an event"),
    ("parentRunId", "RUN_STARTED"),
    ("input", "RUN_STARTED"),
    ("role", "TOOL_CALL_RESULT"),
    ("pendingToolCallIds", "a RUN_FINISHED outcome"),
    ("provider", "a RUN_FINISHED usage entry"),
    ("reasoningTokens", "a RUN_FINISHED usage entry"),
    ("cachedInputTokens", "a RUN_FINISHED usage entry"),
    ("cacheWriteInputTokens", "a RUN_FINISHED usage entry"),
    ("usage", "RUN_ERROR"),
];

/// Which registry rows have been reported, one bit per row. A producer that
/// writes one of these nulls writes it on every event, so, as in the reference
/// client, each row is reported once per run, or once per request.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Noticed(u32);

const _: () = assert!(OPTIONAL_NULLS.len() <= u32::BITS as usize);

/// Reads the registered `null`s on one wire event, whose type is `tag`, as
/// omitted fields. This runs before enforcement, which would reject them.
#[cfg(feature = "client")]
pub(crate) fn omit_event_nulls(
    event: &mut Value,
    tag: &str,
    noticed: &mut Noticed,
    warnings: &mut Vec<String>,
) {
    omit_nulls(event, "an event", noticed, warnings);
    if tag
        .bytes()
        .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
    {
        omit_nulls(event, tag, noticed, warnings);
    }
    match tag {
        "RUN_STARTED" => {
            if let Some(input) = event.get_mut("input") {
                omit_input_nulls(input, noticed, warnings);
            }
        }
        "RUN_FINISHED" => {
            if let Some(outcome) = event.get_mut("outcome") {
                omit_nulls(outcome, "a RUN_FINISHED outcome", noticed, warnings);
            }
            for entry in event
                .get_mut("usage")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                omit_nulls(entry, "a RUN_FINISHED usage entry", noticed, warnings);
            }
        }
        "TOOL_CALL_RESULT" => omit_content_nulls(event, noticed, warnings),
        "MESSAGES_SNAPSHOT" => {
            for message in event
                .get_mut("messages")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                omit_content_nulls(message, noticed, warnings);
            }
        }
        _ => {}
    }
}

/// The registry rows inside a `RunAgentInput`: on a request, and on the copy
/// `RUN_STARTED.input` carries.
fn omit_input_nulls(input: &mut Value, noticed: &mut Noticed, warnings: &mut Vec<String>) {
    omit_nulls(input, "RunAgentInput", noticed, warnings);
    for (list, location) in [("tools", "a tool"), ("resume", "a resume entry")] {
        for entry in input
            .get_mut(list)
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            omit_nulls(entry, location, noticed, warnings);
        }
    }
    for message in input
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        omit_content_nulls(message, noticed, warnings);
    }
}

fn omit_content_nulls(carrier: &mut Value, noticed: &mut Noticed, warnings: &mut Vec<String>) {
    for part in carrier
        .get_mut("content")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let location = match part.get("type").and_then(Value::as_str) {
            Some("image") => "an image content part",
            Some("audio") => "an audio content part",
            Some("video") => "a video content part",
            Some("document") => "a document content part",
            _ => continue,
        };
        omit_nulls(part, location, noticed, warnings);
    }
}

/// Removes each field the registry lists for `location` whose value is `null`.
fn omit_nulls(
    value: &mut Value,
    location: &str,
    noticed: &mut Noticed,
    warnings: &mut Vec<String>,
) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    for (row, (field, at)) in OPTIONAL_NULLS.iter().enumerate() {
        if *at != location || !object.get(*field).is_some_and(Value::is_null) {
            continue;
        }
        object.remove(*field);
        let bit = 1 << row;
        if noticed.0 & bit == 0 {
            noticed.0 |= bit;
            warnings.push(format!(
                "deprecated {field}: null on {at} read as an omitted field"
            ));
        }
    }
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
        // Nothing below reads `$ref`, so the adjacent keywords are checked in
        // place rather than on a copy of the shape without it.
    }

    if let Some(branches) = shape.get("oneOf").and_then(Value::as_array) {
        if let Some(branch) = selected_branch(value, branches) {
            return normalize(value, branch, path, warnings);
        }
        if let Some(tag) = unknown_discriminator(value, branches) {
            warnings.push(format!(
                "unrecognised union member \"{}\" at {}",
                excerpt(tag, false),
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
            // One pass, so pruning stays linear. `index` counts every member
            // read, kept or not: a path names the member's position in the
            // input, which is where the producer can find it.
            let mut index = 0;
            let mut failure = None;
            items.retain_mut(|item| {
                if failure.is_some() {
                    return true;
                }
                let member_path = format!("{path}/{index}");
                index += 1;
                match normalize(item, item_schema, &member_path, warnings) {
                    Ok(keep) => keep,
                    Err(error) => {
                        failure = Some(error);
                        true
                    }
                }
            });
            if let Some(error) = failure {
                return Err(error);
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
                    warnings.push(format!(
                        "unrecognised property at {path}/{}",
                        excerpt(name, true)
                    ));
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

/// The object's value for the discriminator every branch declares, if it has
/// one. Called once no branch matched, so it names a member this version does
/// not know.
fn unknown_discriminator<'a>(value: &'a Value, branches: &[Value]) -> Option<&'a str> {
    let object = value.as_object()?;
    ["type", "role", "op"].iter().find_map(|name| {
        let tag = object.get(*name)?.as_str()?;
        branches
            .iter()
            .all(|branch| {
                resolve(branch)
                    .unwrap_or(branch)
                    .pointer(&format!("/properties/{name}/const"))
                    .is_some()
            })
            .then_some(tag)
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};

    #[test]
    fn pruning_is_linear_in_the_array_length() {
        // Removing 300,000 rejected members one at a time shifts the rest of
        // the list each time, about 1.4 TB of moves; one pass takes a fraction
        // of a second even in a debug build.
        let members = 300_000;
        let shape = json!({"type": "array", "items": {"enum": ["known"]}});
        let mut value = Value::Array(vec![Value::Null; members]);
        let mut warnings = Vec::new();
        let started = Instant::now();
        assert!(normalize(&mut value, &shape, "", &mut warnings).unwrap());
        let elapsed = started.elapsed();
        assert_eq!(value, json!([]));
        assert_eq!(warnings.len(), members);
        assert!(
            elapsed < Duration::from_secs(5),
            "pruning {members} members took {elapsed:?}"
        );
    }

    #[test]
    fn an_excerpt_is_bounded_escaped_and_marked_when_cut() {
        assert_eq!(excerpt("a/b~c", true), "a~1b~0c");
        assert_eq!(excerpt("a/b~c", false), "a/b~c");
        assert_eq!(excerpt("line\nbreak\u{1b}", false), "line\\nbreak\\u{1b}");
        let long = "é".repeat(crate::serde_util::EXCERPT + 1);
        assert_eq!(
            excerpt(&long, false),
            format!("{}…", "é".repeat(crate::serde_util::EXCERPT))
        );
        assert_eq!(
            excerpt(&"é".repeat(crate::serde_util::EXCERPT), false),
            "é".repeat(crate::serde_util::EXCERPT)
        );
    }

    #[test]
    fn a_path_names_the_members_index_in_the_input_not_in_the_pruned_list() {
        let shape = json!({"type": "array", "items": {"type": "string", "enum": ["known"]}});
        let mut value = json!(["unknown", "unknown", 3]);
        let mut warnings = Vec::new();
        let error = normalize(&mut value, &shape, "/delta", &mut warnings).unwrap_err();
        assert_eq!(error, "/delta/2 must be string");
        assert_eq!(
            warnings,
            [
                "unrecognised enum member at /delta/0",
                "unrecognised enum member at /delta/1"
            ]
        );
    }
}
