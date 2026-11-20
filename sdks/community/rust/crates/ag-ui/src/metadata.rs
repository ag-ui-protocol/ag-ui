//! Metadata: extra information attached to events, messages, tool calls and
//! resume entries.
//!
//! Token usage, a trace id, a finish reason — anything an application needs to
//! carry alongside the conversation goes in `metadata`, an object that is open
//! by key. Before it existed producers hung undeclared properties off events
//! and hoped consumers passed them through; metadata is the declared, typed
//! replacement, and consumers are required to carry it.
//!
//! # Where it lives
//!
//! Four places, all optional:
//!
//! - every event, declared once on [`BaseEvent`](crate::event::BaseEvent) so
//!   all 36 types have it;
//! - every message, all seven roles;
//! - every [`ToolCall`](crate::tool::ToolCall) — a tool call is not a message,
//!   and several calls can share one parent, so each carries its own;
//! - every [`ResumeEntry`](crate::outcome::ResumeEntry), for envelope data
//!   about an answer — signatures, routing keys — as opposed to the answer.
//!
//! # Shape
//!
//! Any JSON value is allowed under a key, `null` included. The object itself
//! is **absent or an object, never `null`**: an optional field with no value
//! is omitted from the JSON entirely, in every official SDK, and this crate
//! rejects `"metadata": null` at parse time rather than reading it as absent.
//! Unlike some older optional fields, metadata has no legacy producers to
//! tolerate — the crate-private `serde_util::reject_null` is the rule. An
//! empty object is valid and means the same as omitting it.
//!
//! The [`AGUI_METADATA_KEY`] (`"ag-ui"`) is reserved for the protocol's own
//! use. Every other key is yours. Nothing rejects a write to it at runtime —
//! that would contradict open-by-key — but treat it as off limits.
//!
//! # Merging into messages
//!
//! A message is assembled from a sequence of events, and the interesting
//! values are only known at the end: a provider does not know its token usage
//! until it has finished generating. So a consumer merges each event's
//! metadata into the message that event builds, as the sequence arrives, with
//! [`merge_metadata`]: last write wins, key by key, and a nested object or
//! array is replaced whole rather than blended. The client's applier does
//! this for the text, tool-call, activity and reasoning-message families; an
//! event that builds no message — `RUN_*`, `STEP_*`, `STATE_*`, `RAW`,
//! `CUSTOM`, `REASONING_START`/`END`/`ENCRYPTED_VALUE`, `MESSAGES_SNAPSHOT`,
//! `SUBAGENT_*` — keeps its metadata to itself.
//!
//! ```
//! use ag_ui::{JsonObject, merge_metadata};
//! use serde_json::json;
//!
//! let start: JsonObject = json!({ "source": "openai", "stage": "start" })
//!     .as_object().unwrap().clone();
//! let end: JsonObject = json!({ "stage": "end", "usage": { "output": 340 } })
//!     .as_object().unwrap().clone();
//!
//! let merged = merge_metadata(Some(&start), Some(&end)).unwrap();
//! assert_eq!(merged["source"], "openai");         // nothing later set it
//! assert_eq!(merged["stage"], "end");             // last write wins
//! assert_eq!(merged["usage"]["output"], 340);     // arrived only at the end
//! ```

use crate::JsonObject;

/// The key reserved for the protocol's own use inside a metadata object.
///
/// Reserved by convention: metadata is open by key, so nothing rejects a
/// write to it. AG-UI may put its own values under it in future versions,
/// which is why an application should not.
pub const AGUI_METADATA_KEY: &str = "ag-ui";

/// Folds `incoming` into `existing`, key by key, with the last write winning.
///
/// Returns a new object rather than mutating either argument. An absent
/// `incoming` returns `existing` unchanged (cloned); an empty `incoming`
/// changes nothing. A key's value is replaced outright — this never recurses,
/// so an object or array under any key, [`AGUI_METADATA_KEY`] included, is
/// replaced wholesale rather than blended with what was there before. To add
/// to a nested structure, send the complete new value.
pub fn merge_metadata(
    existing: Option<&JsonObject>,
    incoming: Option<&JsonObject>,
) -> Option<JsonObject> {
    let mut merged = existing.cloned();
    merge_metadata_into(&mut merged, incoming);
    merged
}

/// The in-place form of [`merge_metadata`], for a consumer folding a stream
/// of events into one message without cloning the accumulated object on every
/// delta.
pub fn merge_metadata_into(target: &mut Option<JsonObject>, incoming: Option<&JsonObject>) {
    let Some(incoming) = incoming else {
        return;
    };
    let target = target.get_or_insert_with(JsonObject::new);
    for (key, value) in incoming {
        target.insert(key.clone(), value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: serde_json::Value) -> JsonObject {
        value.as_object().expect("an object literal").clone()
    }

    #[test]
    fn absent_incoming_leaves_existing_alone_and_absent_existing_takes_incoming() {
        let existing = object(json!({ "a": 1 }));
        assert_eq!(
            merge_metadata(Some(&existing), None),
            Some(existing.clone())
        );
        assert_eq!(merge_metadata(None, Some(&existing)), Some(existing));
        assert_eq!(merge_metadata(None, None), None);
    }

    #[test]
    fn last_write_wins_and_nested_values_are_replaced_not_blended() {
        let existing = object(json!({ "tags": ["a", "b"], "keep": true, "ag-ui": { "x": 1 } }));
        let incoming = object(json!({ "tags": ["z"], "ag-ui": { "y": 2 }, "added": null }));
        let merged = merge_metadata(Some(&existing), Some(&incoming)).unwrap();
        assert_eq!(merged["tags"], json!(["z"]));
        assert_eq!(merged["keep"], json!(true));
        assert_eq!(merged["ag-ui"], json!({ "y": 2 }));
        // A null *value* under a key is data, and survives.
        assert!(merged.contains_key("added"));
        assert_eq!(merged["added"], json!(null));
    }

    #[test]
    fn an_empty_incoming_object_creates_an_empty_target_but_changes_nothing_else() {
        let mut target = None;
        merge_metadata_into(&mut target, Some(&JsonObject::new()));
        assert_eq!(target, Some(JsonObject::new()));

        let mut target = Some(object(json!({ "a": 1 })));
        merge_metadata_into(&mut target, Some(&JsonObject::new()));
        assert_eq!(target, Some(object(json!({ "a": 1 }))));
    }
}
