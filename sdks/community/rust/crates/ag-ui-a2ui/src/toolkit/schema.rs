//! The three JSON Schema documents that describe a surface, and surgery on them.
//!
//! A2UI v0.9 splits its schema into three files that travel together:
//!
//! - **server-to-client** — the message envelopes;
//! - **common types** — `ComponentId`, `ChildList`, the `Dynamic*` bindings;
//! - **catalog** — the components and functions themselves.
//!
//! [`SchemaBundle`] holds all three, because everything you do with one you do
//! with all three: put them in a prompt, restrict them to a subset of
//! components, hand them to a validator.
//!
//! # Why prune
//!
//! The whole point of the v0.9 "prompt-first" design is that the schema goes
//! into the model's context. That context is finite, and an agent usually wants
//! the model to use ten components rather than the catalog's eighty. Pruning is
//! how you say so: [`SchemaBundle::prune`] keeps the components (or messages)
//! you allow and then walks `$ref`s to drop every type that nothing kept still
//! refers to — including transitively, so a shared type survives exactly as long
//! as something still points at it.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::toolkit::streaming::DEFAULT_CUTTABLE_KEYS;

/// Markers around the schema block in a generated prompt.
///
/// Fixed strings rather than prose: the reference toolkits emit exactly these,
/// and evaluation harnesses key on them to find the block.
pub const SCHEMA_BLOCK_START: &str = "---BEGIN A2UI JSON SCHEMA---";
/// Closing marker of the prompt's schema block.
pub const SCHEMA_BLOCK_END: &str = "---END A2UI JSON SCHEMA---";

/// The three schema documents describing one surface contract.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SchemaBundle {
    /// The server-to-client envelope schema.
    pub s2c: Value,
    /// Shared type definitions the other two reference.
    pub common_types: Value,
    /// The component and function catalog.
    pub catalog: Value,
    /// Keys whose string values may be closed early while streaming.
    ///
    /// `None` uses [`DEFAULT_CUTTABLE_KEYS`]. Override it when a catalog puts
    /// long free text under a name the defaults do not cover.
    pub custom_cuttable_keys: Option<Vec<String>>,
}

impl SchemaBundle {
    /// The unmodified official v0.9.1 schemas (which accept both wire versions).
    /// No network or filesystem access is performed.
    pub fn basic() -> Result<Self> {
        Ok(Self {
            s2c: serde_json::from_str(include_str!("../../schemas/v0_9_1/server_to_client.json"))?,
            common_types: serde_json::from_str(include_str!(
                "../../schemas/v0_9_1/common_types.json"
            ))?,
            catalog: serde_json::from_str(include_str!("../../schemas/v0_9_1/catalog.json"))?,
            custom_cuttable_keys: None,
        })
    }

    /// Builds a complete v0.9-family bundle from an inline capabilities catalog.
    /// The selected document retains its ID, components, function array, and
    /// theme. Local definitions supply the envelope's component/function unions;
    /// external references must still be registered explicitly by the caller.
    pub fn from_inline_catalog(catalog: Value) -> Result<Self> {
        let mut bundle = Self::basic()?;
        let mut catalog = catalog
            .as_object()
            .cloned()
            .ok_or_else(|| Error::catalog("inline catalog must be an object"))?;
        if catalog.get("catalogId").and_then(Value::as_str).is_none() {
            return Err(Error::catalog("inline catalogId is required"));
        }
        let components = catalog
            .get("components")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let component_union:Vec<_>=components.keys().map(|name|serde_json::json!({"allOf":[
            {"$ref":"https://a2ui.org/specification/v0_9/common_types.json#/$defs/ComponentCommon"},
            {"$ref":format!("#/components/{}",name.replace('~',"~0").replace('/',"~1"))},
            {"properties":{"component":{"const":name}},"required":["component"]}
        ]})).collect();
        let mut function_union = Vec::new();
        let mut seen = BTreeSet::new();
        if let Some(functions) = catalog.get("functions") {
            let functions = functions
                .as_array()
                .ok_or_else(|| Error::catalog("inline functions must be an array"))?;
            for function in functions {
                let name = function
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::catalog("inline function needs a name"))?;
                if !seen.insert(name) {
                    return Err(Error::catalog("duplicate inline function"));
                }
                let parameters = function
                    .get("parameters")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| {
                        Error::catalog("inline function parameters must be a schema object")
                    })?;
                let result = function
                    .get("returnType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::catalog("inline function returnType is required"))?;
                function_union.push(serde_json::json!({"type":"object","properties":{"call":{"const":name},"args":parameters,"returnType":{"const":result}},"required":["call","args"],"additionalProperties":false}));
            }
        }
        let component_schema = if component_union.is_empty() {
            Value::Bool(false)
        } else {
            serde_json::json!({"oneOf":component_union})
        };
        let function_schema = if function_union.is_empty() {
            Value::Bool(false)
        } else {
            serde_json::json!({"oneOf":function_union})
        };
        let theme = catalog
            .get("theme")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        catalog.insert(
            "$schema".into(),
            Value::String("https://json-schema.org/draft/2020-12/schema".into()),
        );
        catalog.insert(
            "$id".into(),
            Value::String("https://a2ui.invalid/local/inline-catalog.json".into()),
        );
        catalog.insert("$defs".into(),serde_json::json!({"anyComponent":component_schema,"anyFunction":function_schema,"theme":{"type":"object","properties":theme,"additionalProperties":false}}));
        bundle.catalog = Value::Object(catalog);
        Ok(bundle)
    }

    /// A bundle holding only a catalog document.
    pub fn from_catalog(catalog: Value) -> Self {
        Self {
            catalog,
            ..Self::default()
        }
    }

    /// The `catalogId` this bundle's catalog declares.
    pub fn catalog_id(&self) -> Option<&str> {
        self.catalog.get("catalogId").and_then(Value::as_str)
    }

    /// The keys whose string values may be closed early while streaming.
    pub fn cuttable_keys(&self) -> Vec<String> {
        match &self.custom_cuttable_keys {
            Some(keys) => keys.clone(),
            None => DEFAULT_CUTTABLE_KEYS
                .iter()
                .map(|key| (*key).to_string())
                .collect(),
        }
    }

    /// Renders the bundle as the schema block of a prompt.
    ///
    /// The common-types section is dropped when it has nothing to say — no
    /// `$defs`, or an empty one — so the model is not handed an empty document
    /// to reason about.
    pub fn render_llm_instructions(&self) -> String {
        let mut sections = vec![SCHEMA_BLOCK_START.to_string()];
        sections.push(format!(
            "### Server To Client Schema:\n{}",
            compact(&self.s2c)
        ));
        if has_defs(&self.common_types) {
            sections.push(format!(
                "### Common Types Schema:\n{}",
                compact(&self.common_types)
            ));
        }
        sections.push(format!("### Catalog Schema:\n{}", compact(&self.catalog)));
        sections.push(SCHEMA_BLOCK_END.to_string());
        sections.join("\n\n")
    }

    /// Restricts the bundle to a subset of components and message types.
    ///
    /// Either list may be empty, meaning "keep everything of that kind". After
    /// the restriction, unreferenced type definitions are dropped from both the
    /// envelope schema and the common types.
    #[must_use]
    pub fn prune(mut self, allowed_components: &[String], allowed_messages: &[String]) -> Self {
        if !allowed_components.is_empty() {
            prune_components(&mut self.catalog, allowed_components);
        }
        if !allowed_messages.is_empty() {
            prune_messages(&mut self.s2c, allowed_messages);
        }
        // Common types are shared, so what survives depends on what the other
        // two documents still reference.
        prune_common_types(&mut self.common_types, &[&self.catalog, &self.s2c]);
        self
    }

    /// Drops `additionalProperties: false` everywhere in the catalog.
    ///
    /// Structured-output APIs reject schemas that forbid extra properties in
    /// places they need them; explicit `true` is left alone because that is a
    /// deliberate statement rather than a default.
    #[must_use]
    pub fn relaxed(mut self) -> Self {
        remove_strict_validation(&mut self.s2c);
        remove_strict_validation(&mut self.common_types);
        remove_strict_validation(&mut self.catalog);
        self
    }
}

fn compact(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

fn has_defs(schema: &Value) -> bool {
    schema
        .get("$defs")
        .and_then(Value::as_object)
        .is_some_and(|defs| !defs.is_empty())
}

/// Keeps only the named components, and the `anyComponent` branches that reach
/// them.
pub(crate) fn prune_components(catalog: &mut Value, allowed: &[String]) {
    let allowed: BTreeSet<&str> = allowed.iter().map(String::as_str).collect();
    let Some(object) = catalog.as_object_mut() else {
        return;
    };
    if let Some(Value::Object(components)) = object.get_mut("components") {
        components.retain(|name, _| allowed.contains(name.as_str()));
    }
    // The catalog's discriminated union must lose the same branches, or it
    // still admits components the document no longer defines.
    if let Some(Value::Object(defs)) = object.get_mut("$defs") {
        if let Some(Value::Object(any_component)) = defs.get_mut("anyComponent") {
            for key in ["oneOf", "anyOf"] {
                if let Some(Value::Array(branches)) = any_component.get_mut(key) {
                    branches.retain(|branch| match branch.get("$ref").and_then(Value::as_str) {
                        Some(reference) => reference
                            .rsplit('/')
                            .next()
                            .is_some_and(|name| allowed.contains(name)),
                        None => true,
                    });
                }
            }
        }
    }
}

/// Keeps only the named messages, then drops definitions nothing reaches.
///
/// Handles both envelope shapes: a `oneOf` of `$ref`s, and a flat `properties`
/// map keyed by message name.
pub(crate) fn prune_messages(s2c: &mut Value, allowed: &[String]) {
    let allowed: BTreeSet<&str> = allowed.iter().map(String::as_str).collect();
    let Some(object) = s2c.as_object_mut() else {
        return;
    };

    let mut pruned_union = false;
    for key in ["oneOf", "anyOf"] {
        if let Some(Value::Array(branches)) = object.get_mut(key) {
            branches.retain(|branch| match branch.get("$ref").and_then(Value::as_str) {
                Some(reference) => reference
                    .rsplit('/')
                    .next()
                    .is_some_and(|name| allowed.contains(name)),
                None => true,
            });
            pruned_union = true;
        }
    }
    if let Some(Value::Object(properties)) = object.get_mut("properties") {
        if !pruned_union {
            properties.retain(|name, _| allowed.contains(name.as_str()));
        }
    }

    if pruned_union {
        let roots: Vec<Value> = object
            .iter()
            .filter(|(key, _)| *key != "$defs")
            .map(|(_, value)| value.clone())
            .collect();
        let roots: Vec<&Value> = roots.iter().collect();
        retain_reachable_defs(object, &roots, "#/$defs/");
    }
}

/// Keeps only the common types still referenced by the given documents.
pub(crate) fn prune_common_types(common_types: &mut Value, referenced_by: &[&Value]) {
    let Some(object) = common_types.as_object_mut() else {
        return;
    };
    if object.get("$defs").and_then(Value::as_object).is_none() {
        return;
    }
    retain_reachable_defs(object, referenced_by, "common_types.json#/$defs/");
}

/// Retains `$defs` entries reachable from `roots`, following refs transitively.
///
/// `external_prefix` is how another document names these definitions; the
/// document's own `#/$defs/` form is always followed as well.
fn retain_reachable_defs(object: &mut Map<String, Value>, roots: &[&Value], external_prefix: &str) {
    let Some(defs) = object.get("$defs").and_then(Value::as_object).cloned() else {
        return;
    };

    let mut keep: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<Value> = roots.iter().map(|root| (*root).clone()).collect();

    while let Some(value) = queue.pop() {
        for reference in collect_refs(&value) {
            let name = reference
                .strip_prefix(external_prefix)
                .or_else(|| reference.strip_prefix("#/$defs/"))
                .map(str::to_string);
            let Some(name) = name else { continue };
            if !defs.contains_key(&name) || !keep.insert(name.clone()) {
                continue;
            }
            if let Some(definition) = defs.get(&name) {
                queue.push(definition.clone());
            }
        }
    }

    if let Some(Value::Object(target)) = object.get_mut("$defs") {
        target.retain(|name, _| keep.contains(name));
    }
}

/// Every `$ref` string anywhere inside a value.
fn collect_refs(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    walk_refs(value, &mut out);
    out
}

fn walk_refs(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == "$ref" {
                    if let Some(reference) = child.as_str() {
                        out.push(reference.to_string());
                    }
                }
                walk_refs(child, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk_refs(item, out);
            }
        }
        _ => {}
    }
}

/// Removes every `additionalProperties: false`, recursively.
pub fn remove_strict_validation(schema: &mut Value) {
    match schema {
        Value::Object(map) => {
            if map.get("additionalProperties") == Some(&Value::Bool(false)) {
                map.remove("additionalProperties");
            }
            for child in map.values_mut() {
                remove_strict_validation(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                remove_strict_validation(item);
            }
        }
        _ => {}
    }
}

/// Loads few-shot examples for a prompt.
///
/// `path` is a directory (every `*.json` inside it) or a glob pattern. Each
/// example is wrapped in `---BEGIN <stem>--- / ---END <stem>---` markers so the
/// model can tell where one ends and the next begins, and files are read in
/// sorted order so the prompt is byte-stable across runs.
///
/// A path that matches nothing yields an empty string: examples are an
/// optimization, and a missing directory should not take an agent down.
///
/// # Errors
///
/// With `validate` set, returns [`Error::Catalog`] if an example is not valid
/// JSON.
pub fn load_examples(path: Option<&Path>, validate: bool) -> Result<String> {
    let Some(path) = path else {
        return Ok(String::new());
    };
    let mut matches = if path.is_dir() {
        collect_matches(path, "*.json")
    } else {
        let pattern = path.to_string_lossy().to_string();
        let (base, pattern) = split_pattern(&pattern);
        collect_matches(&base, &pattern)
    };
    matches.sort();

    let mut blocks = Vec::new();
    for file in matches {
        if !file.is_file() {
            continue;
        }
        let stem = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let content = std::fs::read_to_string(&file).map_err(|e| {
            Error::catalog(format!("Failed to read example {}: {e}", file.display()))
        })?;
        if validate {
            serde_json::from_str::<Value>(&content).map_err(|e| {
                Error::catalog(format!(
                    "Failed to validate example {}: {e}",
                    file.display()
                ))
            })?;
        }
        blocks.push(format!("---BEGIN {stem}---\n{content}\n---END {stem}---"));
    }
    Ok(blocks.join("\n\n"))
}

/// Splits a glob pattern into its fixed base directory and the pattern tail.
///
/// Works on the string rather than on `PathBuf`, so a leading `/` survives:
/// pushing the empty first segment of an absolute path onto a `PathBuf` would
/// silently make it relative.
fn split_pattern(pattern: &str) -> (PathBuf, String) {
    let segments: Vec<&str> = pattern.split('/').collect();
    let first_wildcard = segments
        .iter()
        .position(|segment| segment.contains(['*', '?', '[']));

    let split_at = match first_wildcard {
        Some(index) => index,
        // No wildcard: the last segment is the name to match.
        None => segments.len().saturating_sub(1),
    };
    let base = segments[..split_at].join("/");
    let base = match base.as_str() {
        "" if pattern.starts_with('/') => PathBuf::from("/"),
        "" => PathBuf::from("."),
        other => PathBuf::from(other),
    };
    (base, segments[split_at..].join("/"))
}

/// Walks `base` collecting files matching `pattern`.
fn collect_matches(base: &Path, pattern: &str) -> Vec<PathBuf> {
    let recursive = pattern.contains("**");
    let mut out = Vec::new();
    let mut stack = vec![base.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if recursive {
                    stack.push(path);
                }
                continue;
            }
            let relative = path.strip_prefix(base).unwrap_or(&path).to_string_lossy();
            if glob_match(pattern, &relative) {
                out.push(path);
            }
        }
    }
    out
}

/// Matches a path against a glob pattern.
///
/// Supports `*`, `?`, character classes with ranges and `!` negation, and `**`
/// for "any number of directories". `*` alone never crosses a `/`, which is
/// what keeps `dir/*.json` from reaching into subdirectories.
pub(crate) fn glob_match(pattern: &str, text: &str) -> bool {
    // `**/` matches zero or more directories, so try it both ways.
    if let Some(rest) = pattern.strip_prefix("**/") {
        if glob_match(rest, text) {
            return true;
        }
        if let Some((_, tail)) = text.split_once('/') {
            return glob_match(pattern, tail);
        }
        return false;
    }
    match_here(
        &pattern.chars().collect::<Vec<_>>(),
        &text.chars().collect::<Vec<_>>(),
    )
}

fn match_here(pattern: &[char], text: &[char]) -> bool {
    let mut p = 0;
    let mut t = 0;
    // Backtracking point for the most recent `*`.
    let mut star: Option<(usize, usize)> = None;

    while t < text.len() {
        match pattern.get(p) {
            Some('*') => {
                star = Some((p, t));
                p += 1;
            }
            Some('?') if text[t] != '/' => {
                p += 1;
                t += 1;
            }
            Some('[') => match match_class(pattern, p, text[t]) {
                Some(next) => {
                    p = next;
                    t += 1;
                }
                None => match retry(&mut star, &mut p, &mut t, text) {
                    true => continue,
                    false => return false,
                },
            },
            Some(ch) if *ch == text[t] => {
                p += 1;
                t += 1;
            }
            _ => {
                if !retry(&mut star, &mut p, &mut t, text) {
                    return false;
                }
            }
        }
    }
    while pattern.get(p) == Some(&'*') {
        p += 1;
    }
    p == pattern.len()
}

/// Resumes from the last `*`, consuming one more character.
fn retry(star: &mut Option<(usize, usize)>, p: &mut usize, t: &mut usize, text: &[char]) -> bool {
    match star {
        // A single `*` never matches a path separator.
        Some((sp, st)) if text[*st] != '/' => {
            *p = *sp + 1;
            *st += 1;
            *t = *st;
            true
        }
        _ => false,
    }
}

/// Matches one character class starting at `open`, returning the index after it.
fn match_class(pattern: &[char], open: usize, ch: char) -> Option<usize> {
    let mut i = open + 1;
    let negated = matches!(pattern.get(i), Some('!') | Some('^'));
    if negated {
        i += 1;
    }
    let mut matched = false;
    let mut first = true;
    while i < pattern.len() {
        if pattern[i] == ']' && !first {
            return (matched != negated).then_some(i + 1);
        }
        first = false;
        // A range, unless the `-` is the last character before `]`.
        if pattern.get(i + 1) == Some(&'-') && pattern.get(i + 2).is_some_and(|c| *c != ']') {
            let (low, high) = (pattern[i], pattern[i + 2]);
            if low <= ch && ch <= high {
                matched = true;
            }
            i += 3;
            continue;
        }
        if pattern[i] == ch {
            matched = true;
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_schema_block_carries_all_three_documents() {
        let bundle = SchemaBundle {
            s2c: json!({"s2c": "schema"}),
            common_types: json!({"$defs": {"common": "types"}}),
            catalog: json!({"catalogId": "id_basic"}),
            custom_cuttable_keys: None,
        };
        let rendered = bundle.render_llm_instructions();
        assert_eq!(
            rendered,
            "---BEGIN A2UI JSON SCHEMA---\n\n\
             ### Server To Client Schema:\n{\"s2c\":\"schema\"}\n\n\
             ### Common Types Schema:\n{\"$defs\":{\"common\":\"types\"}}\n\n\
             ### Catalog Schema:\n{\"catalogId\":\"id_basic\"}\n\n\
             ---END A2UI JSON SCHEMA---"
        );
    }

    #[test]
    fn empty_common_types_are_left_out_of_the_block() {
        for common in [
            json!({}),
            json!({"something": "else"}),
            json!({"$defs": {}}),
        ] {
            let bundle = SchemaBundle {
                s2c: json!({"s2c": "schema"}),
                common_types: common,
                catalog: json!({"catalogId": "id"}),
                custom_cuttable_keys: None,
            };
            let rendered = bundle.render_llm_instructions();
            assert!(!rendered.contains("Common Types Schema"), "{rendered}");
            assert!(rendered.contains("Server To Client Schema"));
        }
    }

    #[test]
    fn pruning_components_also_prunes_the_union() {
        let mut catalog = json!({
            "catalogId": "basic",
            "$defs": {"anyComponent": {"oneOf": [
                {"$ref": "#/components/Text"},
                {"$ref": "#/components/Button"},
                {"$ref": "#/components/Image"}
            ]}},
            "components": {"Text": {}, "Button": {}, "Image": {}}
        });
        prune_components(&mut catalog, &["Text".to_string()]);
        assert_eq!(
            catalog,
            json!({
                "catalogId": "basic",
                "$defs": {"anyComponent": {"oneOf": [{"$ref": "#/components/Text"}]}},
                "components": {"Text": {}}
            })
        );
    }

    #[test]
    fn pruning_messages_drops_unreachable_definitions() {
        let mut s2c = json!({
            "oneOf": [{"$ref": "#/$defs/MessageA"}],
            "$defs": {
                "MessageA": {"type": "object", "properties": {"shared": {"$ref": "#/$defs/Shared"}}},
                "Shared": {"type": "string"},
                "Unused": {"type": "number"}
            }
        });
        prune_messages(&mut s2c, &["MessageA".to_string()]);
        let defs = s2c["$defs"].as_object().unwrap();
        assert!(defs.contains_key("MessageA"));
        assert!(
            defs.contains_key("Shared"),
            "a referenced type must survive"
        );
        assert!(!defs.contains_key("Unused"));
    }

    #[test]
    fn a_flat_message_map_prunes_by_property_name() {
        let mut s2c = json!({
            "properties": {
                "beginRendering": {"type": "object"},
                "surfaceUpdate": {"type": "object"},
                "deleteSurface": {"type": "object"}
            },
            "required": ["surfaceId"]
        });
        prune_messages(
            &mut s2c,
            &["beginRendering".to_string(), "deleteSurface".to_string()],
        );
        assert_eq!(
            s2c,
            json!({
                "properties": {
                    "beginRendering": {"type": "object"},
                    "deleteSurface": {"type": "object"}
                },
                "required": ["surfaceId"]
            })
        );
    }

    #[test]
    fn common_types_follow_what_still_references_them() {
        let bundle = SchemaBundle {
            s2c: Value::Null,
            common_types: json!({"$defs": {
                "TypeForA": {"type": "string", "$ref": "#/$defs/SubtypeForA"},
                "TypeForB": {"type": "number"},
                "SubtypeForA": {"type": "boolean"}
            }}),
            catalog: json!({"catalogId": "basic", "components": {
                "CompA": {"$ref": "common_types.json#/$defs/TypeForA"},
                "CompB": {"$ref": "common_types.json#/$defs/TypeForB"}
            }}),
            custom_cuttable_keys: None,
        };
        let pruned = bundle.prune(&["CompA".to_string()], &[]);
        assert_eq!(
            pruned.common_types,
            json!({"$defs": {
                "TypeForA": {"type": "string", "$ref": "#/$defs/SubtypeForA"},
                "SubtypeForA": {"type": "boolean"}
            }})
        );
    }

    #[test]
    fn strict_validation_is_removed_but_explicit_true_is_kept() {
        let mut schema = json!({
            "type": "object",
            "properties": {
                "a": {"type": "string", "additionalProperties": false},
                "b": {"type": "array", "items": {"type": "object", "additionalProperties": false}}
            },
            "additionalProperties": false
        });
        remove_strict_validation(&mut schema);
        assert_eq!(
            schema,
            json!({
                "type": "object",
                "properties": {
                    "a": {"type": "string"},
                    "b": {"type": "array", "items": {"type": "object"}}
                }
            })
        );

        let mut kept = json!({"type": "object", "additionalProperties": true});
        remove_strict_validation(&mut kept);
        assert_eq!(
            kept,
            json!({"type": "object", "additionalProperties": true})
        );
    }

    #[test]
    fn cuttable_keys_default_until_overridden() {
        let bundle = SchemaBundle::default();
        assert!(bundle.cuttable_keys().contains(&"text".to_string()));

        let custom = SchemaBundle {
            custom_cuttable_keys: Some(vec!["customKey1".to_string()]),
            ..SchemaBundle::default()
        };
        assert_eq!(custom.cuttable_keys(), vec!["customKey1".to_string()]);
    }

    #[test]
    fn globs_cover_stars_classes_ranges_and_negation() {
        assert!(glob_match("*.json", "example1.json"));
        assert!(!glob_match("*.json", "notes.txt"));
        assert!(glob_match("user_*.json", "user_profile.json"));
        assert!(!glob_match("user_*.json", "admin_profile.json"));
        assert!(glob_match("step[1-2].json", "step1.json"));
        assert!(!glob_match("step[1-2].json", "step3.json"));
        assert!(glob_match("[!i]*.json", "visible.json"));
        assert!(!glob_match("[!i]*.json", "index.json"));
        assert!(glob_match("**/*.json", "top.json"));
        assert!(glob_match("**/*.json", "nested/deep.json"));
        // A bare star must not cross a directory boundary.
        assert!(!glob_match("*.json", "nested/deep.json"));
        assert!(glob_match("a?c.json", "abc.json"));
    }

    #[test]
    fn a_missing_examples_path_is_not_an_error() {
        assert_eq!(load_examples(None, false).unwrap(), "");
        assert_eq!(
            load_examples(Some(Path::new("/no/such/place")), false).unwrap(),
            ""
        );
    }
}
