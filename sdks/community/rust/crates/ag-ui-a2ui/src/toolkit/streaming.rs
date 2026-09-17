//! Incremental parsing of a model's A2UI output as it streams.
//!
//! [`crate::toolkit::parser`] waits for the whole generation before it can hand
//! back a surface. That is the wrong shape for A2UI, whose entire component
//! model exists so a renderer can start painting as soon as `root` arrives.
//! [`StreamParser`] closes that gap: feed it token chunks and it emits renderable
//! A2UI as soon as enough of the tree has arrived to draw something.
//!
//! ```
//! use ag_ui_a2ui::catalog::Catalog;
//! use ag_ui_a2ui::toolkit::streaming::StreamParser;
//!
//! let catalog = Catalog::basic();
//! let mut parser = StreamParser::new(catalog);
//!
//! // Conversational text comes out immediately.
//! let parts = parser.process_chunk("Here you go. <a2ui-json>[").unwrap();
//! assert_eq!(parts[0].text, "Here you go. ");
//!
//! // A message is emitted the moment it closes, mid-array.
//! let parts = parser
//!     .process_chunk(r#"{"version":"v0.9","createSurface":{"surfaceId":"s","catalogId":"c"}},"#)
//!     .unwrap();
//! assert_eq!(parts[0].a2ui.as_ref().unwrap().len(), 1);
//! ```
//!
//! # What "as soon as possible" actually means
//!
//! Four mechanisms do the work, and they are the reason this is not simply a
//! JSON parser fed one byte at a time:
//!
//! **Healing cut tokens.** A chunk boundary can land anywhere, including inside
//! a string. The parser closes open braces and brackets to make the fragment
//! parseable, but it will only close an open *string* for a key on the cuttable
//! list — `text`, `label`, `hint` and friends. Cutting `"id"` or `"path"` would
//! invent an identifier or a binding that the model never wrote, so those
//! fragments are held back until the next chunk instead.
//!
//! **Placeholder synthesis.** A parent usually arrives before its children. Its
//! child references are rewritten to `loading_<id>` and a stand-in component is
//! emitted alongside, so the renderer can lay out the tree immediately and swap
//! in the real component when it lands.
//!
//! **Reachability filtering.** Only components reachable from `root` are
//! emitted. A component that arrives before its parent is cached, not sent — it
//! would have nowhere to attach — and is re-sent as part of the tree once the
//! path from the root exists.
//!
//! **Validation as a filter, not a failure.** Partial fragments are validated
//! and silently dropped if they do not hold up. A placeholder of a type the
//! catalog does not define, or a component still missing a required property,
//! is simply not emitted yet. Structural failures that no further input can fix
//! — a reference loop, a message that matches no envelope — are errors.
//!
//! # State is per-stream
//!
//! A parser instance carries the surface state for one generation: which
//! surfaces exist, which components have been seen and emitted, and the data
//! model so far. Create a new one per generation.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::constants::{A2UI_CLOSE_TAG, A2UI_OPEN_TAG, PROTOCOL_VERSION, ROOT_ID};
use crate::error::{Error, Result};
use crate::toolkit::parser::ResponsePart;
use crate::validate::{OPERATIONS, ValidateOptions, Validator};

/// Message keys the parser recognizes, in envelope order.
const MSG_CREATE_SURFACE: &str = "createSurface";
const MSG_UPDATE_COMPONENTS: &str = "updateComponents";
const MSG_UPDATE_DATA_MODEL: &str = "updateDataModel";
const MSG_DELETE_SURFACE: &str = "deleteSurface";

/// The four together, for the places that ask "is this a message, and which".
const MESSAGE_KEYS: [&str; 4] = [
    MSG_CREATE_SURFACE,
    MSG_UPDATE_COMPONENTS,
    MSG_UPDATE_DATA_MODEL,
    MSG_DELETE_SURFACE,
];

/// Component properties that hold child references.
///
/// Pruning walks these by name rather than by catalog type, because a partial
/// component may not have named its type yet.
const CHILD_FIELDS: [&str; 6] = [
    "children",
    "explicitList",
    "child",
    "contentChild",
    "entryPointChild",
    "componentId",
];

/// How far the metadata sniffer rewinds between passes.
///
/// Comfortably longer than the keys it looks for (`"surfaceId"`, `"root"`), so a
/// key split across two passes is still matched whole.
const SNIFF_OVERLAP: usize = 16;

/// Keys whose string values may be closed early when a chunk cuts them.
///
/// Everything absent from this list is structural or atomic: healing `"id"` or
/// `"path"` mid-token would fabricate an identifier or a data binding that the
/// model never wrote, so those fragments wait for more input instead.
pub const DEFAULT_CUTTABLE_KEYS: [&str; 7] = [
    "literalString",
    "valueString",
    "label",
    "hint",
    "caption",
    "altText",
    "text",
];

/// Parses a model's A2UI output incrementally, one chunk at a time.
#[derive(Clone, Debug)]
pub struct StreamParser {
    catalog: Catalog,
    validate: bool,
    cuttable_keys: BTreeSet<String>,

    // --- text and JSON scanning ---
    buffer: String,
    found_delimiter: bool,
    json_buffer: String,
    /// Open brackets as `(kind, byte offset into json_buffer)`. Its length is
    /// the nesting depth and its first frame says whether the block opened with
    /// the array of messages, so neither is tracked separately.
    brace_stack: Vec<(char, usize)>,
    in_string: bool,
    string_escaped: bool,
    found_valid_json_in_block: bool,
    /// How much of `json_buffer` the metadata sniffer has already read.
    sniff_cursor: usize,

    // --- protocol state ---
    seen_components: BTreeMap<String, Value>,
    /// Data-model entries already emitted, per surface. Keyed by surface
    /// because two surfaces may legitimately hold the same value at the same
    /// path, and the second one still has to be sent.
    yielded_data_model: BTreeMap<String, Map<String, Value>>,
    deleted_surfaces: BTreeSet<String>,
    /// Component ids already emitted, per surface.
    yielded_ids: BTreeMap<String, BTreeSet<String>>,
    /// Canonical content of each emitted component, for change detection.
    yielded_contents: BTreeMap<(String, String), String>,
    root_ids: BTreeMap<String, String>,
    unbound_root_id: Option<String>,
    surface_id: Option<String>,
    yielded_start_messages: BTreeSet<String>,
    yielded_surfaces: BTreeSet<String>,
    active_msg_type: Option<String>,
    buffered_start_message: Option<Value>,
    topology_dirty: bool,
}

impl StreamParser {
    /// A parser for a stream of components drawn from `catalog`.
    pub fn new(catalog: Catalog) -> Self {
        Self {
            catalog,
            validate: true,
            cuttable_keys: DEFAULT_CUTTABLE_KEYS
                .iter()
                .map(|k| (*k).to_string())
                .collect(),
            buffer: String::new(),
            found_delimiter: false,
            json_buffer: String::new(),
            brace_stack: Vec::new(),
            in_string: false,
            string_escaped: false,
            found_valid_json_in_block: false,
            sniff_cursor: 0,
            seen_components: BTreeMap::new(),
            yielded_data_model: BTreeMap::new(),
            deleted_surfaces: BTreeSet::new(),
            yielded_ids: BTreeMap::new(),
            yielded_contents: BTreeMap::new(),
            root_ids: BTreeMap::new(),
            unbound_root_id: None,
            surface_id: None,
            yielded_start_messages: BTreeSet::new(),
            yielded_surfaces: BTreeSet::new(),
            active_msg_type: None,
            buffered_start_message: None,
            topology_dirty: false,
        }
    }

    /// Overrides which keys may have their string values closed early.
    ///
    /// A catalog whose components carry long free-text properties under other
    /// names can add them here to keep those streaming smoothly.
    #[must_use]
    pub fn with_cuttable_keys<I, S>(mut self, keys: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.cuttable_keys = keys.into_iter().map(Into::into).collect();
        self
    }

    /// Turns off validation, emitting whatever parses.
    ///
    /// Only useful when the catalog is not known to this process; the filtering
    /// that validation provides is most of what makes partial output safe to
    /// render.
    #[must_use]
    pub fn without_validation(mut self) -> Self {
        self.validate = false;
        self
    }

    /// The surface the stream is currently describing.
    pub fn surface_id(&self) -> Option<&str> {
        self.surface_id.as_deref()
    }

    /// The root component id for the active surface.
    pub fn root_id(&self) -> &str {
        match &self.surface_id {
            Some(sid) => self
                .root_ids
                .get(sid)
                .map(String::as_str)
                .unwrap_or(ROOT_ID),
            None => self.unbound_root_id.as_deref().unwrap_or(ROOT_ID),
        }
    }

    fn set_surface_id(&mut self, value: Option<String>) {
        if let (Some(sid), Some(root)) = (&value, self.unbound_root_id.take()) {
            self.root_ids.insert(sid.clone(), root);
        }
        self.surface_id = value;
    }

    fn set_root_id(&mut self, value: String) {
        match &self.surface_id {
            Some(sid) => {
                self.root_ids.insert(sid.clone(), value);
            }
            None => self.unbound_root_id = Some(value),
        }
    }

    /// Feeds the next chunk of the model's output.
    ///
    /// Returns the parts that became renderable because of this chunk:
    /// conversational text, complete A2UI messages, and partial updates that are
    /// safe to draw. An empty vector means the chunk did not complete anything.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Parse`] for a block that contained no JSON at all, and
    /// [`Error::Validation`] for output no further input can rescue: a message
    /// matching no envelope, a missing required envelope field, or a reference
    /// loop.
    pub fn process_chunk(&mut self, chunk: &str) -> Result<Vec<ResponsePart>> {
        let mut parts: Vec<ResponsePart> = Vec::new();
        self.buffer.push_str(chunk);

        loop {
            if !self.found_delimiter {
                match find_open_tag(&self.buffer) {
                    Some((start, Some(end))) => {
                        if start > 0 {
                            parts.push(text_part(&self.buffer[..start]));
                        }
                        self.buffer = self.buffer[end..].to_string();
                        self.found_delimiter = true;
                        continue;
                    }
                    // A tag has started but has not closed. Hold it back, so
                    // `<a2u` or a half-written attribute list never escapes as
                    // conversational text.
                    Some((start, None)) => {
                        if start > 0 {
                            parts.push(text_part(&self.buffer[..start]));
                            self.buffer = self.buffer[start..].to_string();
                        }
                    }
                    None => {
                        if !self.buffer.is_empty() {
                            parts.push(text_part(&self.buffer));
                            self.buffer.clear();
                        }
                    }
                }
                break;
            }

            if let Some(index) = self.buffer.find(A2UI_CLOSE_TAG) {
                let fragment = self.buffer[..index].to_string();
                self.process_json_chunk(&fragment, &mut parts)?;
                if !self.found_valid_json_in_block {
                    return Err(Error::parse(
                        "Failed to parse JSON: No valid JSON object found in A2UI block.",
                    ));
                }
                self.buffer = self.buffer[index + A2UI_CLOSE_TAG.len()..].to_string();
                self.found_delimiter = false;
                self.reset_json_state();
                continue;
            }

            let keep = trailing_prefix_len(&self.buffer, A2UI_CLOSE_TAG);
            if keep < self.buffer.len() {
                let split = self.buffer.len() - keep;
                let fragment = self.buffer[..split].to_string();
                self.buffer = self.buffer[split..].to_string();
                self.process_json_chunk(&fragment, &mut parts)?;
            }
            break;
        }
        Ok(parts)
    }

    fn reset_json_state(&mut self) {
        self.json_buffer.clear();
        self.brace_stack.clear();
        self.in_string = false;
        self.string_escaped = false;
        self.found_valid_json_in_block = false;
        self.sniff_cursor = 0;
        // `active_msg_type` and the yielded-content map deliberately survive, so
        // a second block can keep updating the surface built by the first.
    }

    /// Whether the block's outermost open container is the array of messages.
    fn in_top_level_list(&self) -> bool {
        matches!(self.brace_stack.first(), Some(('[', _)))
    }

    /// Scans one JSON fragment, emitting whatever it completes.
    fn process_json_chunk(&mut self, chunk: &str, parts: &mut Vec<ResponsePart>) -> Result<()> {
        for ch in chunk.chars() {
            // Outside any object, only a container opener is interesting.
            if self.brace_stack.is_empty() && ch != '[' && ch != '{' {
                continue;
            }

            if self.in_string {
                self.scan_string_char(ch);
            } else {
                match ch {
                    '"' => {
                        self.in_string = true;
                        self.string_escaped = false;
                        self.push_json(ch);
                    }
                    '{' | '[' => {
                        self.brace_stack.push((ch, self.json_buffer.len()));
                        self.json_buffer.push(ch);
                    }
                    '}' => self.close_object(parts)?,
                    ']' => {
                        if self.brace_stack.last().map(|(k, _)| *k) == Some('[') {
                            self.brace_stack.pop();
                            self.json_buffer.push(']');
                        }
                    }
                    _ => self.push_json(ch),
                }
            }

            // Identifiers are sniffed eagerly on delimiters so a surfaceId is
            // known before the message carrying it finishes.
            if !self.brace_stack.is_empty() && matches!(ch, '"' | ':' | ',' | '}' | ']') {
                self.sniff_metadata();
            }
        }

        if !self.brace_stack.is_empty() && !self.json_buffer.is_empty() {
            self.sniff_partial_component();
            self.sniff_partial_data_model(parts);
        }
        if self.topology_dirty {
            self.yield_reachable(parts)?;
            self.topology_dirty = false;
        }
        Ok(())
    }

    fn push_json(&mut self, ch: char) {
        if !self.brace_stack.is_empty() {
            self.json_buffer.push(ch);
        }
    }

    fn scan_string_char(&mut self, ch: char) {
        if self.string_escaped {
            self.string_escaped = false;
        } else if ch == '\\' {
            self.string_escaped = true;
        } else if ch == '"' {
            self.in_string = false;
        }
        self.push_json(ch);
    }

    /// Handles a `}`: pops the frame and, if the object parses, dispatches it.
    fn close_object(&mut self, parts: &mut Vec<ResponsePart>) -> Result<()> {
        let Some((_, start)) = self.brace_stack.pop() else {
            return Ok(());
        };
        self.json_buffer.push('}');

        let fragment = self.json_buffer[start..].to_string();
        if !fragment.starts_with('{') || !fragment.ends_with('}') {
            return Ok(());
        }
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&fragment) else {
            return Ok(());
        };
        self.found_valid_json_in_block = true;
        let obj = Value::Object(map);

        let is_protocol = self.in_top_level_list() && is_protocol_message(&obj);
        let is_component = obj.get("id").is_some() && obj.get("component").is_some();
        let is_top_level = self.brace_stack.is_empty()
            || (self.in_top_level_list() && self.brace_stack.len() == 1);

        if is_component {
            self.handle_partial_component(&obj);
        } else if (is_top_level || is_protocol) && !self.handle_complete_object(&obj, parts)? {
            // Nothing recognized it, so validate it to surface the reason.
            self.yield_message(obj.clone(), parts, false)?;
        }

        // Drop processed objects from the buffer so it does not grow without
        // bound across a long generation.
        if is_top_level {
            if self.in_top_level_list() && self.brace_stack.len() == 1 {
                let mut kept = self.json_buffer[..start].to_string();
                kept.push_str(&self.json_buffer[start + fragment.len()..]);
                self.json_buffer = kept;
            } else {
                self.json_buffer = self.json_buffer[fragment.len()..].to_string();
                let shift = fragment.len();
                for entry in &mut self.brace_stack {
                    entry.1 = entry.1.saturating_sub(shift);
                }
            }
        }
        Ok(())
    }

    /// Reacts to a fully parsed protocol message. Returns whether it was one.
    fn handle_complete_object(
        &mut self,
        obj: &Value,
        parts: &mut Vec<ResponsePart>,
    ) -> Result<bool> {
        if !is_protocol_message(obj) {
            return Ok(false);
        }
        if self.validate {
            self.validate_message(obj)?;
        }

        let payload_surface = MESSAGE_KEYS
            .iter()
            .find_map(|key| obj.get(*key))
            .and_then(|payload| payload.get("surfaceId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if payload_surface.is_some() {
            self.set_surface_id(payload_surface);
        }
        let sid = self
            .surface_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string());

        if let Some(payload) = obj.get(MSG_CREATE_SURFACE) {
            if let Some(root) = payload.get("root").and_then(Value::as_str) {
                self.set_root_id(root.to_string());
            }
            self.active_msg_type = Some(MSG_CREATE_SURFACE.to_string());
            self.buffered_start_message = Some(obj.clone());
            if !self.yielded_start_messages.contains(&sid) {
                self.yield_message(obj.clone(), parts, false)?;
                self.yielded_start_messages.insert(sid.clone());
                self.yielded_surfaces.insert(sid.clone());
                self.buffered_start_message = None;
            }
            // A fresh surface is live again: replacing a surface is
            // delete-then-create on the same id, and leaving it marked deleted
            // would suppress every component that follows.
            self.deleted_surfaces.remove(&sid);
            self.yield_reachable(parts)?;
            return Ok(true);
        }

        if let Some(payload) = obj.get(MSG_UPDATE_COMPONENTS) {
            self.active_msg_type = Some(MSG_UPDATE_COMPONENTS.to_string());
            if let Some(root) = payload.get("root").and_then(Value::as_str) {
                self.set_root_id(root.to_string());
            }
            if let Some(components) = payload.get("components").and_then(Value::as_array) {
                for component in components {
                    if let Some(id) = component.get("id").and_then(Value::as_str) {
                        self.seen_components
                            .insert(id.to_string(), component.clone());
                    }
                }
            }
            self.yield_reachable(parts)?;
            return Ok(true);
        }

        if obj.get(MSG_DELETE_SURFACE).is_some() {
            if !self.yielded_start_messages.contains(&sid) {
                // The surface was never created, so there is nothing to delete
                // and nothing to forward: a renderer that never drew it would
                // have to invent it in order to remove it.
                return Ok(true);
            }
            self.delete_surface(&sid);
            self.yield_message(obj.clone(), parts, false)?;
            return Ok(true);
        }

        if obj.get(MSG_UPDATE_DATA_MODEL).is_some() {
            self.yield_message(obj.clone(), parts, false)?;
            return Ok(true);
        }
        Ok(false)
    }

    fn delete_surface(&mut self, sid: &str) {
        self.yielded_ids.remove(sid);
        self.yielded_contents
            .retain(|(surface, _), _| surface != sid);
        self.yielded_surfaces.remove(sid);
        self.yielded_start_messages.remove(sid);
        self.deleted_surfaces.insert(sid.to_string());
    }

    /// Caches a component seen before its message finished.
    fn handle_partial_component(&mut self, comp: &Value) {
        let Some(id) = comp.get("id").and_then(Value::as_str) else {
            return;
        };
        // An empty object anywhere means a property has been opened but not
        // filled — `"children": {`. Emitting that would violate the catalog, so
        // the parent is left to draw a placeholder instead.
        if has_empty_object(comp) {
            return;
        }
        self.seen_components.insert(id.to_string(), comp.clone());
        self.topology_dirty = true;
    }

    /// Emits every component currently reachable from the root.
    fn yield_reachable(&mut self, parts: &mut Vec<ResponsePart>) -> Result<()> {
        let Some(active_msg_type) = self.active_msg_type.clone() else {
            return Ok(());
        };
        let Some(sid) = self.surface_id.clone() else {
            return Ok(());
        };
        // Components mean nothing until the surface they attach to exists.
        if !self.yielded_surfaces.contains(&sid) && self.buffered_start_message.is_none() {
            return Ok(());
        }
        if self.deleted_surfaces.contains(&sid) {
            return Ok(());
        }

        let root_id = self.root_id().to_string();
        let reachable = self.analyze_topology(&root_id)?;

        // Hoisted out of the loop: both were being rebuilt per component, and
        // cloning the raw buffer once per component turns a large message into
        // quadratic copying.
        let seen: BTreeSet<&str> = self.seen_components.keys().map(String::as_str).collect();
        let mut processed: Vec<Value> = Vec::new();
        let mut extras: Vec<Value> = Vec::new();
        for id in &reachable {
            let Some(component) = self.seen_components.get(id) else {
                continue;
            };
            let mut component = component.clone();
            let comp_id = component
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            rewrite_children(
                &mut component,
                &comp_id,
                &seen,
                &mut extras,
                &self.json_buffer,
            );
            processed.push(component);
        }
        processed.extend(extras);

        let yielded = self.yielded_ids.entry(sid.clone()).or_default().clone();
        let mut should_yield = reachable.difference(&yielded).next().is_some();
        if !should_yield {
            // Nothing new, but an already-emitted component may have grown.
            should_yield = processed.iter().any(|component| {
                let Some(id) = component.get("id").and_then(Value::as_str) else {
                    return false;
                };
                let key = (sid.clone(), id.to_string());
                self.yielded_contents.get(&key) != Some(&canonical_json(component))
            });
        }
        if !should_yield {
            return Ok(());
        }

        if let Some(start) = self.buffered_start_message.clone() {
            if !self.yielded_start_messages.contains(&sid) {
                self.yield_message(start, parts, false)?;
                self.yielded_start_messages.insert(sid.clone());
                self.yielded_surfaces.insert(sid.clone());
            }
        }

        let mut payload = Map::new();
        payload.insert("surfaceId".to_string(), Value::String(sid.clone()));
        payload.insert("components".to_string(), Value::Array(processed.clone()));
        let key = if active_msg_type == MSG_CREATE_SURFACE {
            MSG_UPDATE_COMPONENTS
        } else {
            active_msg_type.as_str()
        };
        let mut message = Map::new();
        message.insert(
            "version".to_string(),
            Value::String(PROTOCOL_VERSION.into()),
        );
        message.insert(key.to_string(), Value::Object(payload));

        // A partial tree that does not hold up is dropped, not raised: the next
        // chunk usually completes it.
        if !self.yield_message(Value::Object(message), parts, true)? {
            return Ok(());
        }

        self.yielded_ids
            .entry(sid.clone())
            .or_default()
            .extend(reachable.iter().cloned());
        for component in &processed {
            if let Some(id) = component.get("id").and_then(Value::as_str) {
                self.yielded_contents
                    .insert((sid.clone(), id.to_string()), canonical_json(component));
            }
        }
        Ok(())
    }

    /// Ids reachable from the root, erroring on loops.
    ///
    /// A loop is fatal because no further input can undo it, unlike a dangling
    /// reference which the next chunk usually resolves.
    fn analyze_topology(&self, root_id: &str) -> Result<BTreeSet<String>> {
        let mut adjacency: BTreeMap<&str, Vec<(&str, String)>> = BTreeMap::new();
        for (id, component) in &self.seen_components {
            let mut edges = Vec::new();
            let mut references = Vec::new();
            collect_child_refs(component, &mut references);
            for reference in references {
                if reference.0 == *id {
                    return Err(Error::Parse(format!(
                        "Self-reference detected: Component '{id}' references itself in field \
                         '{}'",
                        reference.1
                    )));
                }
                edges.push((
                    self.seen_components
                        .get_key_value(&reference.0)
                        .map(|(k, _)| k.as_str())
                        .unwrap_or_default(),
                    reference.0,
                ));
            }
            adjacency.insert(id.as_str(), edges);
        }

        let mut visited: BTreeSet<String> = BTreeSet::new();
        let mut on_path: BTreeSet<String> = BTreeSet::new();
        if self.seen_components.contains_key(root_id) {
            walk(root_id, &adjacency, &mut visited, &mut on_path)?;
        }
        Ok(visited
            .into_iter()
            .filter(|id| self.seen_components.contains_key(id))
            .collect())
    }

    /// Emits a message, returning whether it survived validation.
    ///
    /// `partial` selects the filter behaviour: a partial fragment that fails
    /// validation is dropped, a complete message that fails is an error.
    fn yield_message(
        &mut self,
        message: Value,
        parts: &mut Vec<ResponsePart>,
        partial: bool,
    ) -> Result<bool> {
        if self.validate {
            if let Err(error) = self.validate_message(&message) {
                if partial {
                    return Ok(false);
                }
                return Err(error);
            }
        }
        if !self.deduplicate_data_model(&message) {
            return Ok(false);
        }

        match parts.last_mut() {
            Some(last) if last.a2ui.is_none() => last.a2ui = Some(vec![message]),
            Some(last) => {
                if let Some(existing) = last.a2ui.as_mut() {
                    existing.push(message);
                }
            }
            None => parts.push(ResponsePart {
                text: String::new(),
                raw: None,
                a2ui: Some(vec![message]),
                is_final: true,
            }),
        }
        Ok(true)
    }

    /// Suppresses a data-model update that repeats what that surface was
    /// already sent.
    fn deduplicate_data_model(&mut self, message: &Value) -> bool {
        let Some(Value::Object(update)) = message.get(MSG_UPDATE_DATA_MODEL) else {
            return true;
        };
        let sid = self.data_model_surface(update.get("surfaceId"));
        let yielded = self.yielded_data_model.entry(sid).or_default();
        let is_new = update
            .iter()
            .any(|(k, v)| k != "surfaceId" && k != "root" && yielded.get(k) != Some(v));
        if !is_new {
            return false;
        }
        for (k, v) in update {
            if k != "surfaceId" && k != "root" {
                yielded.insert(k.clone(), v.clone());
            }
        }
        true
    }

    /// The surface a data-model update belongs to: the one it names, or the one
    /// the stream is currently describing.
    fn data_model_surface(&self, named: Option<&Value>) -> String {
        named
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.surface_id.clone())
            .unwrap_or_else(|| "default".to_string())
    }

    /// Validates one complete message: envelope shape, then components.
    fn validate_message(&self, message: &Value) -> Result<()> {
        validate_envelope(message)?;

        let Some(components) = message
            .get(MSG_UPDATE_COMPONENTS)
            .and_then(|payload| payload.get("components"))
            .and_then(Value::as_array)
        else {
            return Ok(());
        };
        // Streaming fragments legitimately reference components still on the
        // wire and need not contain the root, so only the checks that cannot
        // come good later are applied here.
        let options = ValidateOptions {
            require_root: false,
            allow_dangling_children: true,
            check_bindings: false,
            check_binding_syntax: false,
            ..ValidateOptions::full_surface()
        };
        Validator::with_options(&self.catalog, options)
            .validate_json(components, None)
            .into_result()
    }

    // --- sniffers -----------------------------------------------------------

    /// Reads identifiers out of the raw buffer before their message closes.
    fn sniff_metadata(&mut self) {
        // Called on every delimiter character, so it reads only what has
        // arrived since last time. Re-scanning the whole buffer each time turns
        // a long message into quadratic work, which is a denial of service on
        // input a model controls.
        if self.json_buffer.len() < self.sniff_cursor {
            // The buffer was compacted; positions no longer mean anything.
            self.sniff_cursor = 0;
        }
        let start = floor_char_boundary(&self.json_buffer, self.sniff_cursor);
        let region = &self.json_buffer[start..];
        // Rewind far enough that a key straddling the boundary is seen whole on
        // the next pass. Once a key *is* seen, an unfinished value pins the
        // cursor to it, so this only has to cover the key itself.
        let mut next_cursor = self.json_buffer.len().saturating_sub(SNIFF_OVERLAP);

        let mut found: Vec<(&str, String)> = Vec::new();
        for key in ["surfaceId", "root"] {
            let (value, incomplete) = scan_string_values(region, key);
            if let Some(value) = value {
                found.push((key, value));
            }
            if let Some(offset) = incomplete {
                // A key whose value has not finished arriving: leave the cursor
                // before it so the next pass sees the whole pair.
                next_cursor = next_cursor.min(start + offset);
            }
        }
        for (key, value) in found {
            match key {
                "surfaceId" => self.set_surface_id(Some(value)),
                _ => self.set_root_id(value),
            }
        }
        self.sniff_cursor = next_cursor;

        if self.active_msg_type.is_none() {
            for key in [MSG_CREATE_SURFACE, MSG_UPDATE_COMPONENTS] {
                if self.json_buffer.contains(&format!("\"{key}\":")) {
                    self.active_msg_type = Some(key.to_string());
                    break;
                }
            }
        }
    }

    /// Looks for a component inside the still-open buffer.
    fn sniff_partial_component(&mut self) {
        if !self.json_buffer.contains("\"components\"") {
            return;
        }
        let frames: Vec<usize> = self
            .brace_stack
            .iter()
            .rev()
            .filter(|(kind, _)| *kind == '{')
            .map(|(_, start)| *start)
            .collect();
        for start in frames {
            let Some(fragment) = self.json_buffer.get(start..) else {
                continue;
            };
            let healed = self.heal_json(fragment);
            if healed.is_empty() {
                continue;
            }
            let Ok(obj) = serde_json::from_str::<Value>(&healed) else {
                continue;
            };
            let has_identity =
                obj.get("id").is_some() && obj.get("component").and_then(Value::as_str).is_some();
            if has_identity {
                self.handle_partial_component(&obj);
            }
        }
    }

    /// Looks for a data-model update inside the still-open buffer, emitting only
    /// what changed since the last one.
    fn sniff_partial_data_model(&mut self, parts: &mut Vec<ResponsePart>) {
        if !self
            .json_buffer
            .contains(&format!("\"{MSG_UPDATE_DATA_MODEL}\""))
        {
            return;
        }
        let frames: Vec<usize> = self
            .brace_stack
            .iter()
            .rev()
            .filter(|(kind, _)| *kind == '{')
            .map(|(_, start)| *start)
            .collect();

        for start in frames {
            let Some(fragment) = self.json_buffer.get(start..) else {
                continue;
            };
            let Some(obj) = self.parse_healed_or_trimmed(fragment) else {
                continue;
            };
            let Some(update) = obj.get(MSG_UPDATE_DATA_MODEL).and_then(Value::as_object) else {
                continue;
            };
            let Some(Value::Object(value)) = update.get("value") else {
                continue;
            };

            let sid = self.data_model_surface(update.get("surfaceId"));
            let known = self.yielded_data_model.get(&sid);
            let mut delta = Map::new();
            for (key, item) in value {
                if known.and_then(|entries| entries.get(key)) != Some(item) {
                    delta.insert(key.clone(), item.clone());
                }
            }
            if delta.is_empty() {
                continue;
            }

            let mut payload = Map::new();
            payload.insert("surfaceId".to_string(), Value::String(sid.clone()));
            payload.insert("value".to_string(), Value::Object(delta.clone()));
            let mut message = Map::new();
            message.insert(
                "version".to_string(),
                Value::String(PROTOCOL_VERSION.into()),
            );
            message.insert(MSG_UPDATE_DATA_MODEL.to_string(), Value::Object(payload));

            // The delta is recorded whether or not the message survives, so the
            // same keys are not offered again on the next chunk.
            let _ = self.yield_message(Value::Object(message), parts, true);
            let yielded = self.yielded_data_model.entry(sid).or_default();
            for (key, item) in delta {
                yielded.insert(key, item);
            }
        }
    }

    /// Parses a fragment, retreating to the last comma when healing is not enough.
    fn parse_healed_or_trimmed(&self, fragment: &str) -> Option<Value> {
        let healed = self.heal_json(fragment);
        if let Ok(value) = serde_json::from_str::<Value>(&healed) {
            return Some(value);
        }
        // `{"a": 1, "b":` heals to invalid JSON, but dropping the dangling
        // `"b":` leaves a complete object that is still worth emitting.
        let mut trimmed = fragment.to_string();
        while let Some(index) = trimmed.rfind(',') {
            trimmed.truncate(index);
            let healed = self.heal_json(&trimmed);
            if healed.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&healed) {
                return Some(value);
            }
        }
        None
    }

    /// Closes a cut JSON fragment so it can be parsed.
    ///
    /// Returns an empty string when the cut lands inside a string whose key is
    /// not cuttable: healing it would invent content the model never wrote.
    fn heal_json(&self, fragment: &str) -> String {
        let mut fixed = fragment.trim_end().to_string();
        if fixed.is_empty() {
            return String::new();
        }

        let mut stack: Vec<char> = Vec::new();
        let mut in_string = false;
        let mut escaped = false;
        let mut last_quote = None;
        for (index, ch) in fixed.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '"' => {
                    in_string = !in_string;
                    if in_string {
                        last_quote = Some(index);
                    }
                }
                '{' | '[' if !in_string => stack.push(ch),
                '}' | ']' if !in_string => {
                    stack.pop();
                }
                _ => {}
            }
        }

        if in_string {
            if let Some(quote) = last_quote {
                let prefix = fixed[..quote].trim_end();
                if prefix.ends_with(':') {
                    match key_before_colon(prefix) {
                        Some(key) if self.cuttable_keys.contains(&key) => {}
                        // Structural or unknown key: wait for the rest.
                        _ => return String::new(),
                    }
                }
            }
            fixed.push('"');
        }

        let trimmed = fixed.trim_end();
        let mut fixed = trimmed
            .strip_suffix(',')
            .unwrap_or(trimmed)
            .trim_end()
            .to_string();
        while let Some(open) = stack.pop() {
            fixed.push(if open == '{' { '}' } else { ']' });
        }
        fixed
    }
}

/// Depth-first walk collecting reachable ids and rejecting loops.
fn walk<'a>(
    root: &'a str,
    adjacency: &BTreeMap<&'a str, Vec<(&'a str, String)>>,
    visited: &mut BTreeSet<String>,
    on_path: &mut BTreeSet<String>,
) -> Result<()> {
    // Iterative rather than recursive: this runs on every chunk of a model's
    // output, over a component graph whose depth the model chooses. A recursive
    // walk would take the process down on a deep enough tree, and unlike a
    // validation failure there is nothing to report afterwards.
    let mut stack: Vec<(&str, usize)> = vec![(root, 0)];
    visited.insert(root.to_string());
    on_path.insert(root.to_string());

    while let Some(&(node, edge_index)) = stack.last() {
        let edges = adjacency.get(node).map(Vec::as_slice).unwrap_or_default();
        let Some((_, target)) = edges.get(edge_index) else {
            on_path.remove(node);
            stack.pop();
            continue;
        };
        if let Some(top) = stack.last_mut() {
            top.1 += 1;
        }
        if on_path.contains(target.as_str()) {
            return Err(Error::Parse(format!(
                "Circular reference detected involving component '{target}'"
            )));
        }
        if visited.insert(target.to_string()) {
            on_path.insert(target.to_string());
            // Borrow the key out of the map so the stack holds `&'a str`
            // rather than a reference into `adjacency`'s values.
            let next = adjacency
                .get_key_value(target.as_str())
                .map(|(key, _)| *key)
                .unwrap_or(target.as_str());
            stack.push((next, 0));
        }
    }
    Ok(())
}

fn is_protocol_message(obj: &Value) -> bool {
    MESSAGE_KEYS.iter().any(|key| obj.get(*key).is_some())
}

/// Checks the envelope of a message this parser is about to emit.
///
/// The *contract* — which operations exist and which of their fields are
/// required — is read from [`crate::validate::OPERATIONS`], the one table this
/// crate keeps the v0.9 envelope in. Only the rendering is local: the
/// language-agnostic conformance suite matches on these exact strings, so this
/// cannot simply forward the validator's report, which locates each failure by
/// path instead.
fn validate_envelope(message: &Value) -> Result<()> {
    let Some(map) = message.as_object() else {
        return Err(validation_error(
            "Validation failed: message must be an object",
        ));
    };

    let Some(key) = MESSAGE_KEYS.into_iter().find(|key| map.contains_key(*key)) else {
        return Err(validation_error(format!(
            "Validation failed: {:?} is not a valid A2UI message; it must contain exactly one of \
             {}",
            map.keys().collect::<Vec<_>>(),
            MESSAGE_KEYS.join(", ")
        )));
    };
    if !map.contains_key("version") {
        return Err(validation_error(
            "Validation failed: 'version' is a required property",
        ));
    }

    let Some(payload) = map.get(key).and_then(Value::as_object) else {
        return Err(validation_error(format!(
            "Validation failed: '{key}' must be an object"
        )));
    };
    let fields = OPERATIONS
        .iter()
        .find(|(name, _)| *name == key)
        .map_or(&[][..], |(_, fields)| *fields);
    for (field, _, required) in fields {
        if *required && !payload.contains_key(*field) {
            return Err(validation_error(format!(
                "Validation failed: '{field}' is a required property of {key}"
            )));
        }
    }
    Ok(())
}

fn validation_error(message: impl Into<String>) -> Error {
    Error::Validation {
        errors: crate::ValidationErrors(vec![crate::validate::ValidationError::new(
            crate::validate::ErrorCode::MissingField,
            "message",
            message,
        )]),
    }
}

fn text_part(text: &str) -> ResponsePart {
    ResponsePart {
        text: text.to_string(),
        raw: None,
        a2ui: None,
        is_final: true,
    }
}

/// Locates an `<a2ui-json ...>` open tag, as byte offsets into `text`.
///
/// Matches what [`crate::toolkit::parser`]'s scanner accepts, which is what a
/// model actually writes: attributes are tolerated, the match is
/// case-insensitive, and the tag name must end on a word boundary so
/// `<a2ui-jsonx>` is not one.
///
/// `Some((start, Some(end)))` is a complete tag occupying `start..end`.
/// `Some((start, None))` means a tag has begun at `start` but its `>` has not
/// arrived, so the caller must hold everything from there back for the next
/// chunk rather than emitting it as conversational text.
fn find_open_tag(text: &str) -> Option<(usize, Option<usize>)> {
    // `A2UI_OPEN_TAG` without its angle brackets.
    let name = &A2UI_OPEN_TAG[1..A2UI_OPEN_TAG.len() - 1];

    for (start, _) in text.match_indices('<') {
        let rest = &text[start + 1..];
        if rest.len() < name.len() {
            if name.as_bytes()[..rest.len()].eq_ignore_ascii_case(rest.as_bytes()) {
                return Some((start, None));
            }
            continue;
        }
        if !rest.as_bytes()[..name.len()].eq_ignore_ascii_case(name.as_bytes()) {
            continue;
        }
        let after = &rest[name.len()..];
        match after.chars().next() {
            None => return Some((start, None)),
            Some(c) if c.is_alphanumeric() || c == '_' => continue,
            Some(_) => {}
        }
        return Some((
            start,
            after
                .find('>')
                .map(|close| start + 1 + name.len() + close + 1),
        ));
    }
    None
}

/// Length of the longest suffix of `text` that is a prefix of `tag`.
fn trailing_prefix_len(text: &str, tag: &str) -> usize {
    let max = tag.len().saturating_sub(1).min(text.len());
    (1..=max)
        .rev()
        .find(|len| text.is_char_boundary(text.len() - len) && text.ends_with(&tag[..*len]))
        .unwrap_or(0)
}

/// Extracts the key from a `"key":` suffix.
fn key_before_colon(prefix: &str) -> Option<String> {
    let without_colon = prefix.strip_suffix(':')?.trim_end();
    let inner = without_colon.strip_suffix('"')?;
    let start = inner.rfind('"')?;
    Some(inner[start + 1..].to_string())
}

/// Reads `"key": "value"` pairs out of a buffer region, front to back.
///
/// Returns the last complete value found, and the offset of the first key whose
/// value has not finished arriving. A caller scanning incrementally must rewind
/// to that offset, or it would never see the finished pair.
fn scan_string_values(region: &str, key: &str) -> (Option<String>, Option<usize>) {
    let needle = format!("\"{key}\"");
    let mut latest = None;
    let mut incomplete = None;
    let mut cursor = 0;

    while let Some(offset) = region[cursor..].find(&needle) {
        let at = cursor + offset;
        let rest = region[at + needle.len()..].trim_start();
        match rest
            .strip_prefix(':')
            .map(str::trim_start)
            .and_then(|rest| rest.strip_prefix('"'))
        {
            Some(value) => match value.find('"') {
                Some(end) => latest = Some(value[..end].to_string()),
                None => {
                    incomplete = Some(at);
                    break;
                }
            },
            // Not a string value: `"root": 3` is not an identifier, and a key
            // whose colon has not arrived yet must be looked at again.
            None => {
                if rest.is_empty() || rest == ":" {
                    incomplete = Some(at);
                    break;
                }
            }
        }
        cursor = at + needle.len();
    }
    (latest, incomplete)
}

/// The largest char boundary at or below `index`.
fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// Whether any object nested inside the value is empty.
fn has_empty_object(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.is_empty() || map.values().any(has_empty_object),
        Value::Array(items) => items.iter().any(has_empty_object),
        _ => false,
    }
}

/// Collects child ids from the conventional reference fields.
fn collect_child_refs(value: &Value, refs: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) => {
            for field in CHILD_FIELDS {
                match map.get(field) {
                    Some(Value::String(id)) => refs.push((id.clone(), field.to_string())),
                    Some(Value::Array(items)) => {
                        for item in items {
                            if let Value::String(id) = item {
                                refs.push((id.clone(), field.to_string()));
                            }
                        }
                    }
                    _ => {}
                }
            }
            for (key, child) in map {
                if key == "id" || key == "component" {
                    continue;
                }
                collect_child_refs(child, refs);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_child_refs(item, refs);
            }
        }
        _ => {}
    }
}

/// Replaces references to unseen components with placeholders.
fn rewrite_children(
    value: &mut Value,
    comp_id: &str,
    seen: &BTreeSet<&str>,
    extras: &mut Vec<Value>,
    buffer: &str,
) {
    match value {
        Value::Object(map) => {
            for field in CHILD_FIELDS {
                match map.get_mut(field) {
                    Some(Value::Array(items)) => {
                        let mut resolved: Vec<Value> = Vec::with_capacity(items.len());
                        for item in items.iter() {
                            let Some(id) = item.as_str() else { continue };
                            if seen.contains(id) {
                                resolved.push(Value::String(id.to_string()));
                            } else {
                                let placeholder = format!("loading_{id}");
                                push_placeholder(&placeholder, extras);
                                resolved.push(Value::String(placeholder));
                            }
                        }
                        if resolved.is_empty()
                            && matches!(field, "children" | "explicitList")
                            && list_is_still_open(buffer, field)
                        {
                            // The list has been opened but no ids have arrived;
                            // give the renderer something to lay out.
                            let placeholder = format!("loading_children_{comp_id}");
                            push_placeholder(&placeholder, extras);
                            resolved.push(Value::String(placeholder));
                        }
                        *map.get_mut(field).expect("field present") = Value::Array(resolved);
                    }
                    Some(Value::String(id)) if !seen.contains(id.as_str()) => {
                        let placeholder = format!("loading_{id}");
                        push_placeholder(&placeholder, extras);
                        *id = placeholder;
                    }
                    _ => {}
                }
            }
            for (key, child) in map.iter_mut() {
                if key == "id" || key == "component" {
                    continue;
                }
                rewrite_children(child, comp_id, seen, extras, buffer);
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_children(item, comp_id, seen, extras, buffer);
            }
        }
        _ => {}
    }
}

fn push_placeholder(id: &str, extras: &mut Vec<Value>) {
    let already = extras
        .iter()
        .any(|extra| extra.get("id").and_then(Value::as_str) == Some(id));
    if already {
        return;
    }
    let mut placeholder = Map::new();
    placeholder.insert("id".to_string(), Value::String(id.to_string()));
    placeholder.insert("component".to_string(), Value::String("Row".to_string()));
    placeholder.insert("children".to_string(), Value::Array(Vec::new()));
    extras.push(Value::Object(placeholder));
}

/// Whether the raw buffer shows `"field": [` with no closing bracket yet.
fn list_is_still_open(buffer: &str, field: &str) -> bool {
    let needle = format!("\"{field}\"");
    let Some(index) = buffer.rfind(&needle) else {
        return false;
    };
    let after = &buffer[index + needle.len()..];
    match after.find('[') {
        Some(open) => !after[..open].contains(']'),
        None => false,
    }
}

/// Serializes with object keys sorted, so content comparison is stable.
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;
    use serde_json::json;

    /// A catalog with the component types the streaming tests use, including the
    /// `Row` the parser synthesizes placeholders from.
    fn catalog() -> Catalog {
        Catalog::from_schema(&json!({
            "catalogId": "test",
            "components": {
                "Text": {
                    "type": "object",
                    "properties": {"component": {"const": "Text"}, "text": {}},
                    "required": ["component"]
                },
                "Card": {
                    "type": "object",
                    "properties": {
                        "component": {"const": "Card"},
                        "child": {"$ref": "common_types.json#/$defs/ComponentId"}
                    },
                    "required": ["component"]
                },
                "Row": {
                    "type": "object",
                    "properties": {
                        "component": {"const": "Row"},
                        "children": {"$ref": "common_types.json#/$defs/ChildList"}
                    },
                    "required": ["component"]
                },
                "Audio": {
                    "type": "object",
                    "properties": {"component": {"const": "Audio"}, "url": {}, "label": {}},
                    "required": ["component", "url"]
                }
            }
        }))
        .expect("test catalog")
    }

    fn parser() -> StreamParser {
        StreamParser::new(catalog())
    }

    /// Feeds chunks and returns the A2UI messages from the final chunk.
    fn feed(parser: &mut StreamParser, chunks: &[&str]) -> Vec<Value> {
        let mut last = Vec::new();
        for chunk in chunks {
            last = parser
                .process_chunk(chunk)
                .expect("chunk should parse")
                .into_iter()
                .filter_map(|part| part.a2ui)
                .flatten()
                .collect();
        }
        last
    }

    const CREATE: &str =
        r#"{"version":"v0.9","createSurface":{"surfaceId":"s1","catalogId":"test"}},"#;

    const UPDATE_OPEN: &str =
        r#"{"version":"v0.9","updateComponents":{"surfaceId":"s1","components":"#;

    #[test]
    fn conversational_text_streams_before_and_after_the_block() {
        let mut parser = parser();
        let parts = parser.process_chunk("Hello! ").unwrap();
        assert_eq!(parts[0].text, "Hello! ");
        assert!(parts[0].a2ui.is_none());

        let parts = parser.process_chunk("Here you go: <a2ui-json>[").unwrap();
        assert_eq!(parts[0].text, "Here you go: ");

        parser.process_chunk(CREATE).unwrap();
        let parts = parser
            .process_chunk("]</a2ui-json> Anything else?")
            .unwrap();
        assert_eq!(parts.last().unwrap().text, " Anything else?");
    }

    #[test]
    fn a_tag_split_across_chunks_is_not_leaked_as_text() {
        let mut parser = parser();
        let parts = parser.process_chunk("Talking <a2u").unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(
            parts[0].text, "Talking ",
            "the partial tag must be held back"
        );

        let parts = parser.process_chunk("i-json>").unwrap();
        assert!(parts.is_empty());
    }

    #[test]
    fn an_open_tag_carrying_attributes_still_opens_a_block() {
        // `parse_response` accepts these; the streaming path used to look for
        // the bare tag literally, so an attributed one matched nothing and the
        // whole surface streamed out as conversational text for the user to
        // read as raw JSON.
        for open in [
            r#"<a2ui-json version="v0.9">"#,
            "<a2ui-json >",
            "<A2UI-JSON>",
        ] {
            let mut parser = parser();
            let mut messages = Vec::new();
            for chunk in [open, "[", CREATE, "]</a2ui-json>"] {
                messages.extend(feed(&mut parser, &[chunk]));
            }
            assert!(
                messages.iter().any(|m| m.get("createSurface").is_some()),
                "{open} did not open a block"
            );
        }

        // A lookalike is still not the tag, in either parser.
        let mut parser = parser();
        let parts = parser
            .process_chunk(r#"<a2ui-jsonx>[{"id":"t"}]</a2ui-jsonx>"#)
            .unwrap();
        assert_eq!(parts[0].text, r#"<a2ui-jsonx>[{"id":"t"}]</a2ui-jsonx>"#);
    }

    #[test]
    fn a_message_is_emitted_the_moment_it_closes() {
        let mut parser = parser();
        assert!(
            feed(
                &mut parser,
                &["<a2ui-json>[", r#"{"version":"v0.9","createSur"#]
            )
            .is_empty()
        );

        let messages = feed(
            &mut parser,
            &[r#"face":{"surfaceId":"s1","catalogId":"test"}},"#],
        );
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["createSurface"]["surfaceId"], "s1");
    }

    #[test]
    fn cut_text_is_healed_and_extended_as_more_arrives() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        let chunk = format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Text","text":"Em"#);
        let messages = feed(&mut parser, &[&chunk]);
        assert_eq!(
            messages[0]["updateComponents"]["components"][0]["text"],
            "Em"
        );

        let messages = feed(&mut parser, &[r#"ail"}]}}"#]);
        assert_eq!(
            messages[0]["updateComponents"]["components"][0]["text"],
            "Email"
        );
    }

    #[test]
    fn a_cut_identifier_is_held_back_rather_than_invented() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);
        // `id` is not cuttable: healing it would fabricate a component id.
        let chunk = format!(r#"{UPDATE_OPEN}[{{"id":"but"#);
        assert!(feed(&mut parser, &[&chunk]).is_empty());
    }

    #[test]
    fn a_missing_child_becomes_a_placeholder_and_is_swapped_in_later() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        let chunk = format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Card","child":"c1"}}, "#);
        let messages = feed(&mut parser, &[&chunk]);
        let components = messages[0]["updateComponents"]["components"]
            .as_array()
            .unwrap();
        assert_eq!(components[0]["child"], "loading_c1");
        assert_eq!(components[1]["id"], "loading_c1");
        assert_eq!(components[1]["component"], "Row");

        let messages = feed(
            &mut parser,
            &[r#"{"id":"c1","component":"Text","text":"hi"}]}}"#],
        );
        let components = messages[0]["updateComponents"]["components"]
            .as_array()
            .unwrap();
        // Sorted by id, and the placeholder is gone.
        assert_eq!(components[0]["id"], "c1");
        assert_eq!(components[1]["child"], "c1");
        assert_eq!(components.len(), 2);
    }

    #[test]
    fn components_wait_until_they_are_reachable_from_the_root() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        // The child arrives first; nothing can be drawn from it yet.
        let chunk = format!(r#"{UPDATE_OPEN}[{{"id":"c1","component":"Text","text":"hi"}}"#);
        assert!(feed(&mut parser, &[&chunk]).is_empty());

        let messages = feed(
            &mut parser,
            &[r#", {"id":"root","component":"Card","child":"c1"}]}}"#],
        );
        let components = messages[0]["updateComponents"]["components"]
            .as_array()
            .unwrap();
        assert_eq!(components.len(), 2);
    }

    #[test]
    fn unreachable_components_are_never_emitted() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);
        let chunk = format!(
            r#"{UPDATE_OPEN}[{{"id":"root","component":"Text","text":"root"}},{{"id":"orphan","component":"Text","text":"orphan"}}]}}}}"#
        );
        let messages = feed(&mut parser, &[&chunk]);
        let components = messages[0]["updateComponents"]["components"]
            .as_array()
            .unwrap();
        assert_eq!(components.len(), 1);
        assert_eq!(components[0]["id"], "root");
    }

    #[test]
    fn components_are_buffered_until_the_surface_exists() {
        let mut parser = parser();
        let chunk =
            format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Text","text":"hi"}}]}}}}, "#);
        let messages = feed(&mut parser, &["<a2ui-json>[", &chunk]);
        assert!(messages.is_empty(), "no surface to attach to yet");

        let messages = feed(&mut parser, &[CREATE]);
        assert_eq!(
            messages.len(),
            2,
            "the surface and its tree arrive together"
        );
        assert!(messages[0].get("createSurface").is_some());
        assert!(messages[1].get("updateComponents").is_some());
    }

    #[test]
    fn deleting_a_surface_that_was_never_created_is_dropped() {
        let mut parser = parser();
        let messages = feed(
            &mut parser,
            &[
                "<a2ui-json>[",
                r#"{"version":"v0.9","deleteSurface":{"surfaceId":"s1"}}, "#,
                CREATE,
            ],
        );
        assert_eq!(messages.len(), 1);
        assert!(messages[0].get("createSurface").is_some());
    }

    #[test]
    fn a_surface_recreated_after_a_delete_renders_again() {
        let mut parser = parser();
        let messages = feed(
            &mut parser,
            &[
                "<a2ui-json>[",
                CREATE,
                r#"{"version":"v0.9","deleteSurface":{"surfaceId":"s1"}}, "#,
                CREATE,
                &format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Text","text":"back"}}]}}}}"#),
            ],
        );
        // Replacing a surface is delete-then-create on the same id, which the
        // create path already anticipates. The components that follow belong to
        // the new surface, not the deleted one.
        let components = &messages
            .iter()
            .rev()
            .find(|m| m.get("updateComponents").is_some())
            .expect("the recreated surface must render")["updateComponents"]["components"];
        assert_eq!(components[0]["text"], "back");
    }

    #[test]
    fn a_self_reference_is_an_error_no_further_input_can_fix() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);
        let chunk =
            format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Card","child":"root"}}]}}}}"#);
        let error = parser.process_chunk(&chunk).unwrap_err();
        assert!(
            error.to_string().contains("Self-reference detected"),
            "{error}"
        );
    }

    #[test]
    fn a_reference_loop_across_messages_is_an_error() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);
        let chunk = format!(
            r#"{UPDATE_OPEN}[{{"id":"root","component":"Card","child":"c1"}}]}}}},{UPDATE_OPEN}[{{"id":"c1","component":"Card","child":"root"}}]}}}}"#
        );
        let error = parser.process_chunk(&chunk).unwrap_err();
        assert!(
            error.to_string().contains("Circular reference detected"),
            "{error}"
        );
    }

    #[test]
    fn a_message_matching_no_envelope_is_an_error() {
        let mut parser = parser();
        let error = parser
            .process_chunk(r#"<a2ui-json>[{"unknownMessage":"invalid"}]"#)
            .unwrap_err();
        assert!(error.to_string().contains("Validation failed"), "{error}");
    }

    #[test]
    fn a_missing_required_envelope_field_is_an_error() {
        let mut first = parser();
        let error = first
            .process_chunk(r#"<a2ui-json>[{"version":"v0.9","createSurface":{"surfaceId":"s1"}}]"#)
            .unwrap_err();
        assert!(error.to_string().contains("required property"), "{error}");

        let mut parser = parser();
        let error = parser
            .process_chunk(r#"<a2ui-json>[{"updateComponents":{"components":[]}}]"#)
            .unwrap_err();
        assert!(error.to_string().contains("Validation failed"), "{error}");
    }

    /// The streaming parser renders envelope failures in the wording the
    /// conformance suite pins, but reads *which* fields are required from the
    /// same table [`crate::validate`] uses — so a change to one operation's
    /// contract cannot reach only one of the two paths.
    #[test]
    fn the_envelope_contract_is_the_validators_own_table() {
        for (key, fields) in OPERATIONS {
            let required: Vec<&str> = fields
                .iter()
                .filter(|(_, _, required)| *required)
                .map(|(field, _, _)| *field)
                .collect();
            if !MESSAGE_KEYS.contains(&key) {
                continue;
            }
            for omitted in &required {
                let payload: Map<String, Value> = required
                    .iter()
                    .filter(|field| *field != omitted)
                    .map(|field| ((*field).to_string(), json!("x")))
                    .collect();
                let message = json!({"version": "v0.9", key: payload});
                let error = validate_envelope(&message)
                    .expect_err("a message missing a required field must not validate");
                assert!(
                    error.to_string().contains(&format!("'{omitted}'")),
                    "{key} without {omitted}: {error}"
                );
            }
        }
    }

    #[test]
    fn a_partial_component_missing_a_required_property_is_not_emitted_yet() {
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);
        // `Audio` requires `url`; the fragment has only `label` so far.
        let chunk =
            format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Audio","label":"almost ready""#);
        assert!(feed(&mut parser, &[&chunk]).is_empty());

        let messages = feed(&mut parser, &[r#", "url":"http://a.mp3"}]}}"#]);
        assert_eq!(
            messages[0]["updateComponents"]["components"][0]["url"],
            "http://a.mp3"
        );
    }

    #[test]
    fn a_placeholder_the_catalog_cannot_render_suppresses_the_partial_update() {
        // This catalog has no `Row`, so the synthesized placeholder would be
        // invalid; the partial tree is held back rather than sent broken.
        let catalog = Catalog::from_schema(&json!({
            "catalogId": "no-row",
            "components": {
                "Card": {
                    "type": "object",
                    "properties": {
                        "component": {"const": "Card"},
                        "child": {"$ref": "common_types.json#/$defs/ComponentId"}
                    },
                    "required": ["component"]
                },
                "Text": {"type": "object", "properties": {"component": {"const": "Text"}}}
            }
        }))
        .unwrap();
        let mut parser = StreamParser::new(catalog);
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        let chunk = format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Card","child":"c1"}}"#);
        assert!(feed(&mut parser, &[&chunk]).is_empty());
    }

    #[test]
    fn the_data_model_streams_as_deltas_then_settles() {
        let mut parser = parser();
        let messages = feed(
            &mut parser,
            &[
                "<a2ui-json>[",
                CREATE,
                r#"{"version":"v0.9","updateDataModel":{"surfaceId":"s1","value":{"a":1,"b":"#,
            ],
        );
        // The complete `a` is offered; the dangling `b` is not.
        assert_eq!(messages[0]["updateDataModel"]["value"], json!({"a": 1}));

        // Once the message closes it is sent whole, not as a delta, so the
        // renderer's model is exactly what the agent meant to send.
        let messages = feed(&mut parser, &["2}}}"]);
        assert_eq!(
            messages[0]["updateDataModel"]["value"],
            json!({"a": 1, "b": 2})
        );
    }

    #[test]
    fn an_unchanged_data_model_key_is_not_offered_twice() {
        let mut parser = parser();
        feed(
            &mut parser,
            &[
                "<a2ui-json>[",
                CREATE,
                r#"{"version":"v0.9","updateDataModel":{"surfaceId":"s1","value":{"a":1"#,
            ],
        );
        let messages = feed(&mut parser, &[", "]);
        assert!(messages.is_empty(), "nothing changed, so nothing to send");
    }

    #[test]
    fn two_surfaces_may_carry_the_same_data_model() {
        let mut parser = parser();
        let messages = feed(
            &mut parser,
            &[
                "<a2ui-json>[",
                CREATE,
                r#"{"version":"v0.9","updateDataModel":{"surfaceId":"s1","path":"/","value":{"a":1}}}, "#,
                r#"{"version":"v0.9","createSurface":{"surfaceId":"s2","catalogId":"test"}}, "#,
                r#"{"version":"v0.9","updateDataModel":{"surfaceId":"s2","path":"/","value":{"a":1}}}"#,
            ],
        );
        // Deduplication is per surface: the second surface's model is not a
        // repeat of anything it has been sent, however the first surface's
        // happens to be spelled.
        let updated: Vec<&Value> = messages
            .iter()
            .filter(|m| m.get(MSG_UPDATE_DATA_MODEL).is_some())
            .collect();
        assert_eq!(updated.len(), 1, "{messages:?}");
        assert_eq!(updated[0][MSG_UPDATE_DATA_MODEL]["surfaceId"], "s2");
    }

    #[test]
    fn custom_cuttable_keys_replace_the_defaults() {
        let mut parser = StreamParser::new(catalog())
            .with_cuttable_keys(["label"])
            .without_validation();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        // `label` is cuttable here, `text` no longer is.
        let chunk = format!(r#"{UPDATE_OPEN}[{{"id":"root","component":"Audio","label":"partial"#);
        let messages = feed(&mut parser, &[&chunk]);
        assert_eq!(
            messages[0]["updateComponents"]["components"][0]["label"],
            "partial"
        );
    }

    #[test]
    fn a_block_with_no_json_at_all_is_a_parse_error() {
        let mut parser = parser();
        let error = parser
            .process_chunk("<a2ui-json>not json at all</a2ui-json>")
            .unwrap_err();
        assert!(matches!(error, Error::Parse(_)), "{error}");
    }

    #[test]
    fn a_second_block_keeps_updating_the_first_surface() {
        let mut parser = parser();
        let first = format!(
            r#"{UPDATE_OPEN}[{{"id":"root","component":"Text","text":"first"}}]}}}}]</a2ui-json>"#
        );
        feed(&mut parser, &["<a2ui-json>[", CREATE, &first]);

        let second = format!(
            r#"<a2ui-json>[{UPDATE_OPEN}[{{"id":"root","component":"Text","text":"second"}}]}}}}]</a2ui-json>"#
        );
        let messages = feed(&mut parser, &[&second]);
        assert_eq!(
            messages[0]["updateComponents"]["components"][0]["text"],
            "second"
        );
    }

    #[test]
    fn the_root_id_and_surface_id_are_readable_while_streaming() {
        let mut parser = parser();
        assert_eq!(parser.surface_id(), None);
        assert_eq!(parser.root_id(), "root");

        feed(&mut parser, &["<a2ui-json>[", CREATE]);
        assert_eq!(parser.surface_id(), Some("s1"));
    }

    #[test]
    fn healing_refuses_to_close_a_non_cuttable_string() {
        let parser = parser();
        assert_eq!(parser.heal_json(r#"{"id": "part"#), "");
        assert_eq!(parser.heal_json(r#"{"path": "/us"#), "");
        assert_eq!(parser.heal_json(r#"{"text": "par"#), r#"{"text": "par"}"#);
        assert_eq!(parser.heal_json(r#"{"a": 1,"#), r#"{"a": 1}"#);
    }

    #[test]
    fn canonical_json_sorts_keys_at_every_level() {
        let a = json!({"b": 1, "a": {"d": 2, "c": [3, {"f": 4, "e": 5}]}});
        let b = json!({"a": {"c": [3, {"e": 5, "f": 4}], "d": 2}, "b": 1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_ne!(canonical_json(&a), canonical_json(&json!({"b": 2})));
    }

    #[test]
    fn a_very_deep_component_chain_does_not_blow_the_stack() {
        // The topology walk runs on every chunk, over a graph whose depth the
        // model chooses. If it recursed, this would abort the process rather
        // than fail a test.
        let mut parser = StreamParser::new(catalog()).without_validation();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        let depth = 20_000;
        let mut components = String::from(r#"[{"id":"root","component":"Card","child":"n0"}"#);
        for i in 0..depth {
            let child = if i + 1 == depth {
                "leaf".to_string()
            } else {
                format!("n{}", i + 1)
            };
            components.push_str(&format!(
                r#",{{"id":"n{i}","component":"Card","child":"{child}"}}"#
            ));
        }
        components.push_str(r#",{"id":"leaf","component":"Text","text":"end"}]"#);

        let chunk = format!(r#"{UPDATE_OPEN}{components}}}}}"#);
        let messages = feed(&mut parser, &[&chunk]);
        let emitted = messages[0]["updateComponents"]["components"]
            .as_array()
            .expect("components");
        assert_eq!(emitted.len(), depth + 2);
    }

    #[test]
    fn a_deep_chain_with_a_loop_at_the_bottom_is_still_caught() {
        // Depth must not let a cycle slip past: the walk has to reach the end.
        let mut parser = StreamParser::new(catalog()).without_validation();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        let depth = 5_000;
        let mut components = String::from(r#"[{"id":"root","component":"Card","child":"n0"}"#);
        for i in 0..depth {
            let child = if i + 1 == depth {
                "root".to_string() // closes the loop
            } else {
                format!("n{}", i + 1)
            };
            components.push_str(&format!(
                r#",{{"id":"n{i}","component":"Card","child":"{child}"}}"#
            ));
        }
        components.push(']');

        let chunk = format!(r#"{UPDATE_OPEN}{components}}}}}"#);
        let error = parser.process_chunk(&chunk).unwrap_err();
        assert!(
            error.to_string().contains("Circular reference detected"),
            "{error}"
        );
    }

    #[test]
    fn a_surface_id_split_across_chunks_is_still_picked_up() {
        // The metadata sniffer reads only what is new since the last pass, so a
        // key landing on a chunk boundary is the case that breaks it.
        let mut parser = parser();
        feed(&mut parser, &["<a2ui-json>[", CREATE]);

        // `"surfaceId"` is split down the middle, and its value again after.
        let messages = feed(
            &mut parser,
            &[
                r#"{"version":"v0.9","updateComponents":{"surf"#,
                r#"aceId":"s1","components":[{"id":"root","component":"Text","text":"hi"}"#,
            ],
        );
        assert_eq!(
            messages[0]["updateComponents"]["surfaceId"], "s1",
            "the split key must still be found"
        );
    }

    #[test]
    fn a_later_surface_does_not_leak_into_an_earlier_one() {
        let mut parser = parser();
        feed(
            &mut parser,
            &[
                "<a2ui-json>[",
                r#"{"version":"v0.9","createSurface":{"surfaceId":"one","catalogId":"test"}},"#,
                r#"{"version":"v0.9","createSurface":{"surfaceId":"two","catalogId":"test"}},"#,
            ],
        );
        // Back to the first surface: the sniffer has to notice the switch.
        let messages = feed(
            &mut parser,
            &[concat!(
                r#"{"version":"v0.9","updateComponents":{"surfaceId":"one","components":"#,
                r#"[{"id":"root","component":"Text","text":"hi"}"#
            )],
        );
        assert_eq!(messages[0]["updateComponents"]["surfaceId"], "one");
    }

    #[test]
    fn scanning_reads_the_last_pair_and_flags_an_unfinished_one() {
        let buffer = r#"{"surfaceId": "first"} {"surfaceId" : "second"}"#;
        let (value, incomplete) = scan_string_values(buffer, "surfaceId");
        assert_eq!(value, Some("second".to_string()));
        assert_eq!(incomplete, None);

        assert_eq!(scan_string_values(buffer, "missing"), (None, None));

        // A key with a non-string value is skipped rather than mis-read.
        assert_eq!(scan_string_values(r#"{"root": 3}"#, "root"), (None, None));

        // A value still arriving must be looked at again next time, and the
        // earlier complete value is still reported.
        let cut = r#"{"surfaceId": "done"}, {"surfaceId": "partia"#;
        let (value, incomplete) = scan_string_values(cut, "surfaceId");
        assert_eq!(value, Some("done".to_string()));
        assert_eq!(incomplete, Some(cut.rfind("\"surfaceId\"").unwrap()));
    }
}
