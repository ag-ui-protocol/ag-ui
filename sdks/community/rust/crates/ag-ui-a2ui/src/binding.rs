//! Data-model binding: JSON Pointer resolution, scopes, and `formatString`.
//!
//! A2UI keeps UI structure and application state apart. Components reference
//! state through [JSON Pointers][rfc6901], resolved against the surface's data
//! model at render time.
//!
//! # Absolute and relative paths
//!
//! A2UI deliberately extends RFC 6901 with *relative* paths to make template
//! iteration expressible:
//!
//! - A path starting with `/` is **absolute** and always resolves from the root
//!   of the data model, wherever the component sits in the tree.
//! - A path **not** starting with `/` is **relative** and resolves inside the
//!   current collection scope. A container whose `children` is a template over
//!   `/employees` opens one scope per element, so `name` inside the template
//!   resolves to `/employees/0/name`, `/employees/1/name`, and so on.
//!
//! [`Scope`] models exactly this: [`Scope::root`] for the default scope and
//! [`Scope::item`] to descend into one element of a bound collection.
//!
//! # Stringification
//!
//! Whenever a non-string is interpolated into text, the conversion is fixed by
//! spec so every renderer agrees: numbers and booleans use their standard
//! representation, `null` and missing paths become `""`, and objects and arrays
//! are stringified as compact JSON.
//!
//! ```
//! use ag_ui_a2ui::binding::Scope;
//! use serde_json::json;
//!
//! let data = json!({"company": "Acme", "employees": [{"name": "Alice"}, {"name": "Bob"}]});
//! let root = Scope::root(&data);
//! let item = root.item("/employees", 1);
//!
//! // Relative inside the collection scope, absolute escapes back to the root.
//! assert_eq!(item.format_string("${name} @ ${/company} (#${@index(offset: 1)})").unwrap(),
//!            "Bob @ Acme (#2)");
//! ```
//!
//! # Depth
//!
//! Resolution walks a `serde_json::Value`, and a walk over a tree is a stack
//! frame per level unless something stops it. Two things do. Anything arriving
//! over the wire has already passed through `serde_json`, which refuses to
//! parse deeper than 127 levels, so a `Value` from a model or a transport is
//! bounded before this module sees it. On top of that,
//! [`Scope::resolve_dynamic`] and [`collect_bindings`] carry their own cap
//! ([`MAX_VALUE_DEPTH`]) for values built in memory, which `serde_json` does not
//! check. The component *graph* — where depth is genuinely unbounded — is walked
//! iteratively in [`crate::validate`] instead.
//!
//! [rfc6901]: https://datatracker.ietf.org/doc/html/rfc6901

use std::collections::BTreeMap;

use jsonptr::Pointer;
use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// Deepest nesting these walks will descend into a value.
///
/// Well past `serde_json`'s own parse limit of 127, so it never fires on
/// anything that arrived as text; it exists for values assembled in memory,
/// which nothing else bounds.
pub const MAX_VALUE_DEPTH: usize = 256;

/// Whether a string parses as an RFC 6901 JSON Pointer.
///
/// The rule that catches real mistakes is the escape alphabet: `~` may only be
/// followed by `0` or `1`, so a path written with a raw `~` in a key is invalid
/// rather than merely absent.
pub(crate) fn pointer_is_valid(path: &str) -> bool {
    Pointer::parse(path).is_ok()
}

/// Encodes one path segment for use inside a JSON Pointer.
fn encode_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}

/// Renders a value as a string using A2UI's fixed conversion rules.
///
/// `None` (an unresolved path) and `Value::Null` both become `""`.
pub fn stringify(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        // Objects and arrays are compact JSON so every renderer agrees.
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Supplies renderer-side functions to `formatString` beyond the built-ins.
///
/// This crate does not render, so it evaluates only what it can decide on its
/// own: data-model paths and `@index`. Pass a resolver to
/// [`Scope::format_string_with`] to evaluate catalog functions such as
/// `formatDate` or `formatCurrency`.
pub trait FunctionResolver {
    /// Evaluates `name` with the given already-resolved arguments.
    ///
    /// Return `None` for a function this resolver does not know; the caller then
    /// reports it as an unknown function.
    fn call(&self, name: &str, args: &Map<String, Value>) -> Option<Value>;
}

impl<F> FunctionResolver for F
where
    F: Fn(&str, &Map<String, Value>) -> Option<Value>,
{
    fn call(&self, name: &str, args: &Map<String, Value>) -> Option<Value> {
        self(name, args)
    }
}

struct NoFunctions;

impl FunctionResolver for NoFunctions {
    fn call(&self, _name: &str, _args: &Map<String, Value>) -> Option<Value> {
        None
    }
}

/// An evaluation scope: a data model plus the collection context bindings
/// resolve against.
///
/// The root scope resolves relative paths from `/`. Entering a template item
/// with [`Scope::item`] pushes the item's pointer as the new base and records
/// the iteration index for [`@index`](Scope::index).
#[derive(Debug, Clone)]
pub struct Scope<'a> {
    data: &'a Value,
    base: String,
    index: Option<usize>,
}

impl<'a> Scope<'a> {
    /// The root scope of a data model.
    pub fn root(data: &'a Value) -> Self {
        Self {
            data,
            base: String::new(),
            index: None,
        }
    }

    /// The data model this scope reads from.
    pub fn data(&self) -> &'a Value {
        self.data
    }

    /// The absolute pointer this scope resolves relative paths against.
    pub fn base(&self) -> &str {
        &self.base
    }

    /// The iteration index, when this scope is a collection item.
    pub fn index(&self) -> Option<usize> {
        self.index
    }

    /// Descends into element `index` of the collection at `collection_path`.
    ///
    /// `collection_path` is itself resolved through this scope, so nested
    /// templates compose.
    #[must_use]
    pub fn item(&self, collection_path: &str, index: usize) -> Scope<'a> {
        let base = self.resolve_pointer(collection_path);
        Scope {
            data: self.data,
            base: format!("{base}/{index}"),
            index: Some(index),
        }
    }

    /// Turns an A2UI path (absolute or relative) into an absolute JSON Pointer.
    ///
    /// The empty path and `/` both denote the whole data model.
    pub fn resolve_pointer(&self, path: &str) -> String {
        if path.is_empty() || path == "/" {
            return String::new();
        }
        if let Some(rest) = path.strip_prefix('/') {
            // Already absolute; keep the caller's escaping verbatim.
            return format!("/{rest}");
        }
        let mut out = self.base.clone();
        for segment in path.split('/') {
            out.push('/');
            out.push_str(&encode_token(segment));
        }
        out
    }

    /// Resolves a path to a value in the data model, or `None` if absent.
    pub fn resolve(&self, path: &str) -> Option<&'a Value> {
        let pointer = self.resolve_pointer(path);
        if pointer.is_empty() {
            return Some(self.data);
        }
        Pointer::parse(&pointer)
            .ok()
            .and_then(|p| p.resolve(self.data).ok())
    }

    /// Resolves a path and stringifies the result.
    pub fn resolve_string(&self, path: &str) -> String {
        stringify(self.resolve(path))
    }

    /// Resolves a `DynamicValue`: a literal, a `{"path": ...}` binding, or a
    /// `{"call": ..., "args": ...}` function call.
    ///
    /// Objects and arrays are walked recursively so nested bindings inside an
    /// action `context` resolve too.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Binding`] if a `formatString` template is malformed or
    /// names a function this crate cannot evaluate.
    pub fn resolve_dynamic(&self, value: &Value) -> Result<Value> {
        self.resolve_dynamic_with(value, &NoFunctions)
    }

    /// [`Scope::resolve_dynamic`] with catalog functions supplied by the caller.
    ///
    /// # Errors
    ///
    /// See [`Scope::resolve_dynamic`].
    pub fn resolve_dynamic_with(
        &self,
        value: &Value,
        functions: &dyn FunctionResolver,
    ) -> Result<Value> {
        self.resolve_dynamic_at(value, functions, 0)
    }

    fn resolve_dynamic_at(
        &self,
        value: &Value,
        functions: &dyn FunctionResolver,
        depth: usize,
    ) -> Result<Value> {
        if depth > MAX_VALUE_DEPTH {
            return Err(Error::binding(
                "<value>",
                format!("value nests deeper than {MAX_VALUE_DEPTH} levels"),
            ));
        }
        match value {
            Value::Object(map) => {
                if let Some(Value::String(path)) = map.get("path") {
                    // `{componentId, path}` is a child template, not a binding.
                    if !map.contains_key("componentId") {
                        return Ok(self.resolve(path).cloned().unwrap_or(Value::Null));
                    }
                }
                if let Some(Value::String(name)) = map.get("call") {
                    let mut args = Map::new();
                    if let Some(Value::Object(raw)) = map.get("args") {
                        for (key, raw_value) in raw {
                            args.insert(
                                key.clone(),
                                self.resolve_dynamic_at(raw_value, functions, depth + 1)?,
                            );
                        }
                    }
                    return self.call_function(name, &args, functions);
                }
                let mut out = Map::new();
                for (key, raw_value) in map {
                    out.insert(
                        key.clone(),
                        self.resolve_dynamic_at(raw_value, functions, depth + 1)?,
                    );
                }
                Ok(Value::Object(out))
            }
            Value::Array(items) => items
                .iter()
                .map(|item| self.resolve_dynamic_at(item, functions, depth + 1))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array),
            other => Ok(other.clone()),
        }
    }

    fn call_function(
        &self,
        name: &str,
        args: &Map<String, Value>,
        functions: &dyn FunctionResolver,
    ) -> Result<Value> {
        match name {
            "formatString" => {
                let template = stringify(args.get("value"));
                self.format_string_with(&template, functions)
                    .map(Value::String)
            }
            "@index" => self.eval_index(args).map(Value::from),
            _ => functions.call(name, args).ok_or_else(|| {
                Error::binding(name, "function is not evaluable outside a renderer")
            }),
        }
    }

    fn eval_index(&self, args: &Map<String, Value>) -> Result<i64> {
        // Per spec, `@index` is only meaningful inside a collection scope.
        let index = self
            .index
            .ok_or_else(|| Error::binding("@index", "used outside of a template iteration scope"))?
            as i64;
        let offset = match args.get("offset") {
            None | Some(Value::Null) => 0,
            Some(Value::Number(n)) => n
                .as_i64()
                .ok_or_else(|| Error::binding("@index", "offset must be an integer"))?,
            Some(_) => return Err(Error::binding("@index", "offset must be a number")),
        };
        // The template comes from the model, so the offset is remote input.
        // A wrapping add would hand the renderer a nonsense index; a plain one
        // would abort the process on a debug build.
        index
            .checked_add(offset)
            .ok_or_else(|| Error::binding("@index", "offset is out of range"))
    }

    /// Interpolates a `formatString` template against this scope.
    ///
    /// Expressions are written `${...}` and may contain an absolute path
    /// (`${/user/name}`), a relative path (`${name}`), a literal, a nested
    /// `${...}`, or a function call (`${@index(offset: 1)}`). A literal `${` is
    /// written `\${`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Binding`] for an unterminated expression, trailing
    /// characters after an expression, or a function this crate cannot evaluate.
    pub fn format_string(&self, template: &str) -> Result<String> {
        self.format_string_with(template, &NoFunctions)
    }

    /// [`Scope::format_string`] with catalog functions supplied by the caller.
    ///
    /// # Errors
    ///
    /// See [`Scope::format_string`].
    pub fn format_string_with(
        &self,
        template: &str,
        functions: &dyn FunctionResolver,
    ) -> Result<String> {
        let mut out = String::with_capacity(template.len());
        let chars: Vec<char> = template.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '\\' && matches(&chars, i + 1, "${") {
                out.push_str("${");
                i += 3;
                continue;
            }
            if matches(&chars, i, "${") {
                let (body, next) = take_expression(&chars, i + 2)?;
                let value = self.eval_expression(&body, functions, 0)?;
                out.push_str(&stringify(Some(&value)));
                i = next;
                continue;
            }
            out.push(chars[i]);
            i += 1;
        }
        Ok(out)
    }

    fn eval_expression(
        &self,
        expression: &str,
        functions: &dyn FunctionResolver,
        depth: usize,
    ) -> Result<Value> {
        const MAX_DEPTH: usize = 10;
        if depth > MAX_DEPTH {
            return Err(Error::binding(expression, "expression nesting is too deep"));
        }
        let expression = expression.trim();
        if expression.is_empty() {
            return Ok(Value::String(String::new()));
        }

        let chars: Vec<char> = expression.chars().collect();

        // Nested `${...}`, used to make a binding explicit or chain calls.
        if matches(&chars, 0, "${") {
            let (body, next) = take_expression(&chars, 2)?;
            if next != chars.len() {
                return Err(Error::binding(
                    expression,
                    "unexpected characters after nested expression",
                ));
            }
            return self.eval_expression(&body, functions, depth + 1);
        }

        if let Some(literal) = parse_literal(expression) {
            return Ok(literal);
        }

        // `name(...)` is a function call; anything else is a data-model path.
        match expression.find('(') {
            Some(open) if expression.ends_with(')') => {
                let name = expression[..open].trim();
                let raw_args = &expression[open + 1..expression.len() - 1];
                let mut args = Map::new();
                for (key, raw) in split_arguments(raw_args, expression)? {
                    args.insert(key, self.eval_expression(&raw, functions, depth + 1)?);
                }
                self.call_function(name, &args, functions)
            }
            Some(_) => Err(Error::binding(expression, "unbalanced parentheses")),
            None => Ok(self.resolve(expression).cloned().unwrap_or(Value::Null)),
        }
    }
}

fn matches(chars: &[char], at: usize, needle: &str) -> bool {
    needle
        .chars()
        .enumerate()
        .all(|(offset, want)| chars.get(at + offset) == Some(&want))
}

/// Reads an expression body starting just after `${`, returning it and the
/// index just past the closing `}`.
///
/// Tracks brace depth and skips over quoted strings so that
/// `${formatDate(format:'{yyyy}')}` and nested `${...}` both survive.
fn take_expression(chars: &[char], start: usize) -> Result<(String, usize)> {
    let mut depth = 1usize;
    let mut i = start;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Ok((chars[start..i].iter().collect(), i + 1));
                }
            }
            '\'' | '"' => {
                let quote = ch;
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        i += 1;
                    } else if chars[i] == quote {
                        break;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(Error::binding(
        chars[start..].iter().collect::<String>(),
        "unterminated interpolation: missing '}'",
    ))
}

fn parse_literal(expression: &str) -> Option<Value> {
    let bytes: Vec<char> = expression.chars().collect();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == '\'' || first == '"') && first == last {
            let inner: String = bytes[1..bytes.len() - 1].iter().collect();
            return Some(Value::String(
                inner.replace("\\'", "'").replace("\\\"", "\""),
            ));
        }
    }
    match expression {
        "true" => return Some(Value::Bool(true)),
        "false" => return Some(Value::Bool(false)),
        // `null` interpolates as the empty string, matching the reference
        // toolkits rather than resolving a path named "null".
        "null" => return Some(Value::String(String::new())),
        _ => {}
    }
    if expression
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit() || c == '-')
    {
        // Integers stay integers: `@index(offset: 1)` must not become 1.0.
        if let Ok(integer) = expression.parse::<i64>() {
            return Some(Value::Number(integer.into()));
        }
        if let Ok(number) = expression.parse::<f64>() {
            return serde_json::Number::from_f64(number).map(Value::Number);
        }
    }
    None
}

/// Splits `name: value, name: value` argument lists, respecting nesting.
fn split_arguments(raw: &str, expression: &str) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    if raw.trim().is_empty() {
        return Ok(out);
    }
    let chars: Vec<char> = raw.chars().collect();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut i = 0usize;
    let mut pieces: Vec<String> = Vec::new();
    while i < chars.len() {
        match chars[i] {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth = depth.saturating_sub(1),
            '\'' | '"' => {
                let quote = chars[i];
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        i += 1;
                    } else if chars[i] == quote {
                        break;
                    }
                    i += 1;
                }
            }
            ',' if depth == 0 => {
                pieces.push(chars[start..i].iter().collect());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    pieces.push(chars[start..].iter().collect());

    for piece in pieces {
        let piece = piece.trim().to_string();
        if piece.is_empty() {
            continue;
        }
        let colon = split_top_level_colon(&piece).ok_or_else(|| {
            Error::binding(
                expression,
                format!("argument {piece:?} is missing a 'name: value' separator"),
            )
        })?;
        let name = piece[..colon].trim().to_string();
        let value = piece[colon + 1..].trim().to_string();
        out.push((name, value));
    }
    Ok(out)
}

fn split_top_level_colon(piece: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_quote: Option<char> = None;
    for (index, ch) in piece.char_indices() {
        match (in_quote, ch) {
            (Some(quote), c) if c == quote => in_quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"') => in_quote = Some(ch),
            (None, '(' | '{' | '[') => depth += 1,
            (None, ')' | '}' | ']') => depth = depth.saturating_sub(1),
            (None, ':') if depth == 0 => return Some(index),
            _ => {}
        }
    }
    None
}

/// Every data-model path referenced anywhere inside a JSON value.
///
/// Walks the value looking for `{"path": "..."}` bindings, skipping
/// `{"componentId", "path"}` child templates, whose `path` points at a
/// collection rather than at a bound value. Paths are returned in encounter
/// order with duplicates removed, keyed by the property path they were found
/// at so a validator can report a precise locator.
pub fn collect_bindings(value: &Value) -> Vec<Binding> {
    let mut out = Vec::new();
    let mut seen = BTreeMap::new();
    walk_bindings(value, String::new(), 0, &mut out, &mut seen);
    out
}

/// One data-model path reference found inside a component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    /// Where in the component the reference was found, e.g. `text` or
    /// `action.event.context.email`.
    pub location: String,
    /// The path exactly as written on the wire.
    pub path: String,
    /// Whether the path is a template `path`, iterated rather than read.
    pub is_collection: bool,
}

fn walk_bindings(
    value: &Value,
    location: String,
    depth: usize,
    out: &mut Vec<Binding>,
    seen: &mut BTreeMap<(String, String), ()>,
) {
    // Stop rather than fail: a binding buried past this depth is unreachable in
    // practice, and the validator reports the nesting itself.
    if depth > MAX_VALUE_DEPTH {
        return;
    }
    match value {
        Value::Object(map) => {
            if let Some(Value::String(path)) = map.get("path") {
                let is_collection = map.contains_key("componentId");
                let key = (location.clone(), path.clone());
                if seen.insert(key, ()).is_none() {
                    out.push(Binding {
                        location: location.clone(),
                        path: path.clone(),
                        is_collection,
                    });
                }
                if is_collection {
                    return;
                }
            }
            for (key, child) in map {
                if key == "path" {
                    continue;
                }
                let next = if location.is_empty() {
                    key.clone()
                } else {
                    format!("{location}.{key}")
                };
                walk_bindings(child, next, depth + 1, out, seen);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                walk_bindings(item, format!("{location}[{index}]"), depth + 1, out, seen);
            }
        }
        _ => {}
    }
}

/// Binding scope over the lossless model, preserving null versus missing/undefined.
#[derive(Debug, Clone)]
pub struct ModelScope<'a> {
    model: &'a crate::DataModel,
    prefix: String,
}
impl<'a> ModelScope<'a> {
    /// Starts at the model root.
    pub fn root(model: &'a crate::DataModel) -> Self {
        Self {
            model,
            prefix: String::new(),
        }
    }
    /// Resolves absolute bindings from the root and relative bindings within this scope.
    pub fn resolve(&self, path: &str) -> Result<Option<&'a crate::ModelValue>> {
        self.model.lookup(&self.absolute(path))
    }
    /// Opens an item scope in a collection, without inventing a missing item.
    pub fn item(&self, path: &str, index: usize) -> Self {
        let collection = self.absolute(path);
        Self {
            model: self.model,
            prefix: format!("{}/{index}", collection.trim_end_matches('/')),
        }
    }
    pub(crate) fn absolute(&self, path: &str) -> String {
        if path.starts_with('/') {
            path.into()
        } else {
            format!("{}/{}", self.prefix, path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model() -> Value {
        json!({
            "company": "Acme Corp",
            "count": 3,
            "flag": true,
            "nested": {"a": [1, 2]},
            "employees": [
                {"name": "Alice", "role": "Engineer"},
                {"name": "Bob", "role": "Designer"}
            ]
        })
    }

    #[test]
    fn absolute_paths_resolve_from_the_root_in_any_scope() {
        let data = model();
        let root = Scope::root(&data);
        let scope = root.item("/employees", 1);
        assert_eq!(scope.resolve_string("/company"), "Acme Corp");
        assert_eq!(root.resolve_string("/company"), "Acme Corp");
    }

    #[test]
    fn relative_paths_resolve_inside_the_collection_scope() {
        let data = model();
        let root = Scope::root(&data);
        for (index, expected) in [(0, "Alice"), (1, "Bob")] {
            let item = root.item("/employees", index);
            assert_eq!(item.resolve_string("name"), expected);
            assert_eq!(item.base(), format!("/employees/{index}"));
        }
    }

    #[test]
    fn nested_templates_compose_scopes() {
        let data = json!({"groups": [{"items": [{"label": "inner"}]}]});
        let root = Scope::root(&data);
        let group = root.item("/groups", 0);
        let item = group.item("items", 0);
        assert_eq!(item.base(), "/groups/0/items/0");
        assert_eq!(item.resolve_string("label"), "inner");
    }

    #[test]
    fn stringification_follows_the_spec_table() {
        let data = model();
        let scope = Scope::root(&data);
        assert_eq!(scope.resolve_string("/count"), "3");
        assert_eq!(scope.resolve_string("/flag"), "true");
        assert_eq!(scope.resolve_string("/missing"), "");
        assert_eq!(scope.resolve_string("/nested"), r#"{"a":[1,2]}"#);
        assert_eq!(scope.resolve_string("/nested/a"), "[1,2]");
        assert_eq!(stringify(Some(&Value::Null)), "");
    }

    #[test]
    fn format_string_mixes_text_paths_and_escapes() {
        let data = model();
        let scope = Scope::root(&data);
        assert_eq!(
            scope
                .format_string("Hello, ${/company}! You have ${/count} messages.")
                .unwrap(),
            "Hello, Acme Corp! You have 3 messages."
        );
        assert_eq!(
            scope.format_string(r"literal \${/company}").unwrap(),
            "literal ${/company}"
        );
        assert_eq!(
            scope.format_string("no expressions").unwrap(),
            "no expressions"
        );
        assert_eq!(scope.format_string("${/missing}").unwrap(), "");
    }

    #[test]
    fn format_string_supports_index_with_offset_and_nesting() {
        let data = model();
        let root = Scope::root(&data);
        let scope = root.item("/employees", 1);
        assert_eq!(scope.format_string("#${@index()}").unwrap(), "#1");
        assert_eq!(scope.format_string("#${@index(offset: 1)}").unwrap(), "#2");
        assert_eq!(scope.format_string("${${name}}").unwrap(), "Bob");
    }

    #[test]
    fn an_index_offset_that_would_overflow_is_reported_rather_than_wrapping() {
        let data = model();
        let root = Scope::root(&data);
        let scope = root.item("/employees", 1);
        // The template is model output, so the offset is remote input: an
        // extreme one must not take the process down (debug) or silently wrap
        // to a nonsense index (release).
        let error = scope
            .format_string("${@index(offset: 9223372036854775807)}")
            .unwrap_err();
        assert!(matches!(error, Error::Binding { .. }), "{error}");

        // Everything that does fit still evaluates, in both directions.
        assert_eq!(scope.format_string("${@index(offset: -1)}").unwrap(), "0");
        assert_eq!(scope.format_string("${@index(offset: 1)}").unwrap(), "2");
        assert_eq!(
            scope
                .format_string("${@index(offset: -9223372036854775808)}")
                .unwrap(),
            "-9223372036854775807"
        );
    }

    #[test]
    fn index_outside_a_collection_scope_is_an_error() {
        let data = model();
        let scope = Scope::root(&data);
        let err = scope.format_string("${@index()}").unwrap_err();
        assert!(matches!(err, Error::Binding { .. }));
    }

    #[test]
    fn unterminated_and_unknown_expressions_are_errors() {
        let data = model();
        let scope = Scope::root(&data);
        assert!(scope.format_string("${/company").is_err());
        assert!(
            scope
                .format_string("${formatDate(value: '2026-01-01')}")
                .is_err()
        );
    }

    #[test]
    fn caller_supplied_functions_are_used() {
        let data = model();
        let scope = Scope::root(&data);
        let upper = |name: &str, args: &Map<String, Value>| -> Option<Value> {
            (name == "upper").then(|| Value::String(stringify(args.get("value")).to_uppercase()))
        };
        assert_eq!(
            scope
                .format_string_with("${upper(value: ${/company})}", &upper)
                .unwrap(),
            "ACME CORP"
        );
    }

    #[test]
    fn resolve_dynamic_walks_bindings_and_calls() {
        let data = model();
        let scope = Scope::root(&data);
        let resolved = scope
            .resolve_dynamic(&json!({
                "literal": "static",
                "bound": {"path": "/company"},
                "formatted": {"call": "formatString", "args": {"value": "n=${/count}"}}
            }))
            .unwrap();
        assert_eq!(
            resolved,
            json!({"literal": "static", "bound": "Acme Corp", "formatted": "n=3"})
        );
    }

    #[test]
    fn collect_bindings_separates_templates_from_value_bindings() {
        let component = json!({
            "text": {"path": "/user/name"},
            "children": {"componentId": "tpl", "path": "/items"},
            "action": {"event": {"context": {"email": {"path": "/form/email"}}}}
        });
        let bindings = collect_bindings(&component);
        let found: Vec<_> = bindings
            .iter()
            .map(|b| (b.location.as_str(), b.path.as_str(), b.is_collection))
            .collect();
        assert!(found.contains(&("text", "/user/name", false)));
        assert!(found.contains(&("children", "/items", true)));
        assert!(found.contains(&("action.event.context.email", "/form/email", false)));
    }

    #[test]
    fn a_value_nested_past_the_cap_errors_instead_of_recursing_away() {
        let data = json!({"name": "Ada"});
        let scope = Scope::root(&data);

        // Deeper than MAX_VALUE_DEPTH, but shallow enough that `Value`'s own
        // recursive Clone and Drop still cope — past that point the type itself
        // is the limit, not this crate.
        let mut value = json!({"path": "/name"});
        for _ in 0..(MAX_VALUE_DEPTH + 50) {
            value = json!({"nested": value});
        }
        let error = scope.resolve_dynamic(&value).unwrap_err();
        assert!(matches!(error, Error::Binding { .. }), "{error}");

        // Just inside the cap still resolves.
        let mut value = json!({"path": "/name"});
        for _ in 0..10 {
            value = json!({"nested": value});
        }
        assert!(scope.resolve_dynamic(&value).is_ok());
    }

    /// Nests a binding `wrappers` objects deep. The outermost object sits at
    /// depth 0, so `wrappers` is the depth the innermost one is reached at.
    fn nested(wrappers: usize) -> Value {
        let mut value = json!({"path": "/name"});
        for _ in 0..wrappers {
            value = json!({"nested": value});
        }
        value
    }

    #[test]
    fn the_value_depth_cap_fires_one_level_past_it_and_not_before() {
        let data = json!({"name": "Ada"});
        let scope = Scope::root(&data);

        // Off-by-one here is the difference between rejecting input the spec
        // allows and letting a deeper one through, so the boundary is pinned
        // rather than probed from far away.
        assert!(scope.resolve_dynamic(&nested(MAX_VALUE_DEPTH)).is_ok());
        assert!(scope.resolve_dynamic(&nested(MAX_VALUE_DEPTH + 1)).is_err());

        // `collect_bindings` shares the cap but stops rather than failing, so
        // the binding at the bottom is simply not reported.
        assert_eq!(collect_bindings(&nested(MAX_VALUE_DEPTH)).len(), 1);
        assert!(collect_bindings(&nested(MAX_VALUE_DEPTH + 1)).is_empty());
    }

    #[test]
    fn collecting_bindings_stops_at_the_cap_rather_than_recursing_away() {
        let mut value = json!({"path": "/deep"});
        for _ in 0..(MAX_VALUE_DEPTH + 50) {
            value = json!({"nested": value});
        }
        // No panic, no overflow; the buried binding is simply not reported, and
        // the validator flags the nesting itself.
        assert!(collect_bindings(&value).is_empty());
    }

    #[test]
    fn pointer_escapes_round_trip() {
        assert_eq!(
            Scope::root(&json!({"a/b":{"c~d":1}})).resolve("/a~1b/c~0d"),
            Some(&json!(1))
        );
        let data = json!({"a/b": 7});
        assert_eq!(Scope::root(&data).resolve_string("/a~1b"), "7");
    }
}
