//! Recovering a previously rendered surface from conversation history.
//!
//! `intent = "update"` is only useful if the agent knows what it is updating.
//! The surface it rendered a few turns ago is not stored anywhere — it went out
//! over the transport and the renderer holds it. What the agent *does* still
//! have is the conversation, and the operations it emitted are in there.
//!
//! [`find_prior_surface`] walks the messages newest-first, finds the most
//! recently rendered surface, and replays every operation for that surface in
//! order to reconstruct its components, data model, and `catalogId`. That
//! reconstruction becomes the "here is what is on screen now" section of the
//! next generation prompt.
//!
//! # Where the operations are found
//!
//! Two encodings are recognized, because both occur in practice: the
//! [`A2UI_OPERATIONS_KEY`](crate::constants::A2UI_OPERATIONS_KEY) transport
//! envelope, and raw `<a2ui-json>` blocks in an assistant turn. A message may
//! also be the envelope itself rather than text containing one.
//!
//! A generation that failed is deliberately none of those — see
//! [`wrap_error_envelope`](crate::toolkit::envelope::wrap_error_envelope) — so
//! it contributes no operations and cannot be recovered as a surface that was
//! never on screen.

use serde_json::Value;

use crate::constants::DEFAULT_SURFACE_ID;
use crate::message::{AgentMessage, Component};
use crate::toolkit::envelope::{is_operations_envelope, unwrap_operations_envelope};
use crate::toolkit::parser::unwrap_response;

/// One entry of conversation history, oldest first in a slice.
///
/// Deliberately minimal: this crate does not depend on any particular chat
/// message type, so callers map their own history onto this.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HistoryMessage {
    /// Who produced the message. Only used for reporting.
    pub role: String,
    /// The textual content, which may embed an envelope or `<a2ui-json>` blocks.
    pub content: String,
    /// Structured payload, when the transport carried one (a tool result, an
    /// A2A data part). Checked before `content`.
    pub data: Option<Value>,
}

impl HistoryMessage {
    /// A message with textual content only.
    pub fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            data: None,
        }
    }

    /// A message carrying a structured payload.
    pub fn data(role: impl Into<String>, data: Value) -> Self {
        Self {
            role: role.into(),
            content: String::new(),
            data: Some(data),
        }
    }
}

/// A surface reconstructed from history.
#[derive(Debug, Clone, PartialEq)]
pub struct PriorSurface {
    /// The surface's id, to reuse on update.
    pub surface_id: String,
    /// Catalog observed at creation. Successful strict replay always supplies it.
    /// Partial histories require explicit prior state via `SurfaceStore`.
    pub catalog_id: Option<String>,
    /// Components as they stood after the last operation, in first-definition
    /// order, with later definitions of the same id replacing earlier ones.
    pub components: Vec<Component>,
    /// The data model after replaying every `updateDataModel`.
    pub data_model: crate::DataModel,
    /// Whether the surface was deleted after being rendered.
    pub deleted: bool,
}

impl PriorSurface {
    /// A component by id.
    pub fn component(&self, id: &str) -> Option<&Component> {
        self.components.iter().find(|c| c.id == id)
    }
}

/// Finds the most recently rendered surface in the conversation.
///
/// Messages are newest-last, as they would be in a chat transcript. The scan
/// runs backwards to pick the surface, then forwards to replay it, so an update
/// targets whatever the user is actually looking at.
///
/// Returns `None` when no surface exists or its history cannot be replayed.
/// Use [`try_find_prior_surface_by_id`] when replay failures must be reported.
pub fn find_prior_surface(messages: &[HistoryMessage]) -> Option<PriorSurface> {
    find_prior_surface_by_id(messages, None)
}

/// [`find_prior_surface`] restricted to one `surfaceId`.
///
/// Use this when several surfaces are live and the caller knows which one the
/// user means.
pub fn find_prior_surface_by_id(
    messages: &[HistoryMessage],
    surface_id: Option<&str>,
) -> Option<PriorSurface> {
    try_find_prior_surface(messages, surface_id).ok().flatten()
}

/// Fallible discovery and replay of the latest (or explicitly named) surface.
/// Malformed recognized A2UI blocks, wire messages, pointers, and lifecycles
/// fail the entire replay rather than returning a partially reconstructed view.
pub fn try_find_prior_surface(
    messages: &[HistoryMessage],
    surface_id: Option<&str>,
) -> crate::Result<Option<PriorSurface>> {
    let per_message: Vec<_> = messages
        .iter()
        .map(try_extract_operations)
        .collect::<crate::Result<_>>()?;
    let target = match surface_id {
        Some(id) => id.to_string(),
        None => match per_message
            .iter()
            .rev()
            .flat_map(|ops| ops.iter().rev())
            .find_map(|op| op.surface_id().map(str::to_string))
        {
            Some(id) => id,
            None => return Ok(None),
        },
    };
    try_replay(&per_message, &target)
}
/// Fallible history replay restricted to one surface ID.
pub fn try_find_prior_surface_by_id(
    messages: &[HistoryMessage],
    surface_id: &str,
) -> crate::Result<Option<PriorSurface>> {
    try_find_prior_surface(messages, Some(surface_id))
}

fn try_replay(
    per_message: &[Vec<AgentMessage>],
    target: &str,
) -> crate::Result<Option<PriorSurface>> {
    let mut store = crate::surface::SurfaceStore::new();
    for op in per_message
        .iter()
        .flatten()
        .filter(|op| op.surface_id() == Some(target))
    {
        store.apply(op)?;
    }
    Ok(store.get(target).map(|state| PriorSurface {
        surface_id: state.surface_id.clone(),
        catalog_id: Some(state.catalog_id.clone()),
        components: state.components.clone(),
        data_model: state.data_model.clone(),
        deleted: state.deleted,
    }))
}

/// A surface id that will not collide with anything already in history.
///
/// Conservatively avoids every ID seen in retained history. The protocol permits
/// reusing a deleted ID, but this helper does not require callers to track deletion.
pub fn next_surface_id(messages: &[HistoryMessage], base: &str) -> String {
    let base = if base.is_empty() {
        DEFAULT_SURFACE_ID
    } else {
        base
    };
    let used: Vec<String> = messages
        .iter()
        .flat_map(extract_operations)
        .filter_map(|op| op.surface_id().map(str::to_string))
        .collect();
    if !used.iter().any(|id| id == base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|candidate| !used.contains(candidate))
        .unwrap_or_else(|| format!("{base}-{}", used.len() + 1))
}

/// Pulls every A2UI operation out of one history message.
fn extract_operations(message: &HistoryMessage) -> Vec<AgentMessage> {
    try_extract_operations(message).unwrap_or_default()
}
fn try_extract_operations(message: &HistoryMessage) -> crate::Result<Vec<AgentMessage>> {
    let mut out = Vec::new();
    if let Some(data) = &message.data {
        collect_from_value(data, &mut out)?;
        if !out.is_empty() || data.get("error").is_some() {
            return Ok(out);
        }
    }
    let content = message.content.trim();
    if content.is_empty() {
        return Ok(out);
    }
    if let Ok(value) = serde_json::from_str::<Value>(content) {
        collect_from_value(&value, &mut out)?;
    }
    if content.contains(crate::constants::A2UI_OPEN_TAG) {
        for part in unwrap_response(content)? {
            if let Some(raw) = part.raw {
                let value: Value = serde_json::from_str(&raw)?;
                if is_operations_envelope(&value) {
                    out.extend(unwrap_operations_envelope(&value)?)
                } else if value.is_array() {
                    out.extend(serde_json::from_value::<Vec<AgentMessage>>(value)?)
                } else {
                    out.push(serde_json::from_value(value)?)
                }
            }
        }
    }
    Ok(out)
}
fn collect_from_value(value: &Value, out: &mut Vec<AgentMessage>) -> crate::Result<()> {
    if value.get("error").is_some() {
        return Ok(());
    }
    if is_operations_envelope(value) {
        out.extend(unwrap_operations_envelope(value)?);
        return Ok(());
    }
    match value {
        Value::Array(items) => {
            if items.iter().any(|item| {
                [
                    "createSurface",
                    "updateComponents",
                    "updateDataModel",
                    "deleteSurface",
                ]
                .iter()
                .any(|key| item.get(*key).is_some())
            }) {
                out.extend(serde_json::from_value::<Vec<AgentMessage>>(value.clone())?);
            }
        }
        Value::Object(object)
            if object.keys().any(|key| {
                matches!(
                    key.as_str(),
                    "createSurface"
                        | "updateComponents"
                        | "updateDataModel"
                        | "deleteSurface"
                        | "callRendererFunction"
                        | "agentFunctionResponse"
                )
            }) =>
        {
            out.push(serde_json::from_value(value.clone())?)
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toolkit::envelope::{wrap_as_operations_envelope, wrap_error_envelope};
    use crate::toolkit::ops::{Intent, SurfaceSpec, assemble_ops};
    use serde_json::json;

    fn rendered(surface: &str, text: &str) -> HistoryMessage {
        let spec = SurfaceSpec::new(surface)
            .with_components(vec![
                Component::new("root", "Column").with("children", json!(["label"])),
                Component::new("label", "Text").with("text", json!({"path": "/title"})),
            ])
            .with_data_model(json!({"title": text}));
        let envelope = wrap_as_operations_envelope(&assemble_ops(Intent::Create, &spec)).unwrap();
        HistoryMessage::text("assistant", envelope)
    }

    #[test]
    fn a_surface_is_recovered_from_an_operations_envelope() {
        let history = vec![
            HistoryMessage::text("user", "show me the cart"),
            rendered("cart", "Your cart"),
        ];
        let prior = find_prior_surface(&history).unwrap();
        assert_eq!(prior.surface_id, "cart");
        assert_eq!(
            prior.catalog_id.as_deref(),
            Some(crate::constants::BASIC_CATALOG_ID)
        );
        assert_eq!(prior.components.len(), 2);
        assert_eq!(
            prior.component("label").unwrap().prop("text"),
            Some(&json!({"path": "/title"}))
        );
        assert_eq!(prior.data_model, json!({"title": "Your cart"}));
        assert!(!prior.deleted);
    }

    #[test]
    fn the_newest_surface_wins() {
        let history = vec![
            rendered("first", "one"),
            HistoryMessage::text("user", "now show the other one"),
            rendered("second", "two"),
        ];
        assert_eq!(find_prior_surface(&history).unwrap().surface_id, "second");
        assert_eq!(
            find_prior_surface_by_id(&history, Some("first"))
                .unwrap()
                .data_model,
            json!({"title": "one"})
        );
    }

    #[test]
    fn later_updates_are_folded_onto_the_original() {
        let mut history = vec![rendered("cart", "Your cart")];
        let update = SurfaceSpec::new("cart")
            .with_components(vec![
                Component::new("label", "Text").with("text", json!("Checkout")),
                Component::new("extra", "Text").with("text", json!("free shipping")),
            ])
            .with_data_model(json!("Updated"))
            .with_data_path("/title");
        history.push(HistoryMessage::text(
            "assistant",
            wrap_as_operations_envelope(&assemble_ops(Intent::Update, &update)).unwrap(),
        ));

        let prior = find_prior_surface(&history).unwrap();
        // Redefinition replaces in place; a new id appends.
        let ids: Vec<&str> = prior.components.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["root", "label", "extra"]);
        assert_eq!(
            prior.component("label").unwrap().prop("text"),
            Some(&json!("Checkout"))
        );
        assert_eq!(prior.data_model, json!({"title": "Updated"}));
        assert_eq!(
            prior.catalog_id.as_deref(),
            Some(crate::constants::BASIC_CATALOG_ID)
        );
    }

    #[test]
    fn raw_a2ui_json_blocks_are_recognized_too() {
        let block = format!(
            "Here you go\n<a2ui-json>{}</a2ui-json>",
            serde_json::to_string(&assemble_ops(
                Intent::Create,
                &SurfaceSpec::new("inline").with_components(vec![
                    Component::new("root", "Text").with("text", json!("x"))
                ])
            ))
            .unwrap()
        );
        let prior = find_prior_surface(&[HistoryMessage::text("assistant", block)]).unwrap();
        assert_eq!(prior.surface_id, "inline");
        assert_eq!(prior.components.len(), 1);
    }

    #[test]
    fn structured_payloads_are_read_before_text() {
        let envelope: Value = serde_json::from_str(
            &wrap_as_operations_envelope(&assemble_ops(
                Intent::Create,
                &SurfaceSpec::new("tool-result").with_components(vec![
                    Component::new("root", "Text").with("text", json!("x")),
                ]),
            ))
            .unwrap(),
        )
        .unwrap();
        let prior = find_prior_surface(&[HistoryMessage::data("tool", envelope)]).unwrap();
        assert_eq!(prior.surface_id, "tool-result");
    }

    #[test]
    fn a_deleted_surface_is_reported_as_deleted() {
        let mut history = vec![rendered("cart", "Your cart")];
        history.push(HistoryMessage::text(
            "assistant",
            wrap_as_operations_envelope(&[AgentMessage::delete_surface("cart")]).unwrap(),
        ));
        let prior = find_prior_surface(&history).unwrap();
        assert!(prior.deleted);
        assert!(prior.components.is_empty());
    }

    #[test]
    fn recreating_a_surface_id_starts_it_over() {
        let history = vec![
            rendered("cart", "old"),
            HistoryMessage::text(
                "assistant",
                wrap_as_operations_envelope(&[AgentMessage::delete_surface("cart")]).unwrap(),
            ),
            rendered("cart", "new"),
        ];
        let prior = find_prior_surface(&history).unwrap();
        assert_eq!(prior.data_model, json!({"title": "new"}));
        assert_eq!(prior.components.len(), 2);
    }

    #[test]
    fn a_failed_surface_is_never_read_back_as_a_prior_one() {
        let failure = wrap_error_envelope("cart", "could not build the surface", &[]).unwrap();
        let as_text = HistoryMessage::text("assistant", failure.as_str());
        let as_data = HistoryMessage::data("tool", serde_json::from_str(&failure).unwrap());

        // Whichever way the transport carried it, it describes a surface that
        // was never rendered, so there is nothing to recover.
        assert!(find_prior_surface(std::slice::from_ref(&as_text)).is_none());
        assert!(find_prior_surface(&[as_data]).is_none());
        assert!(find_prior_surface_by_id(std::slice::from_ref(&as_text), Some("cart")).is_none());

        // And arriving after a real surface, it leaves that surface alone —
        // including its id, which the failure names too.
        let rendered_only = vec![rendered("cart", "Your cart")];
        let then_failed = vec![rendered("cart", "Your cart"), as_text];
        assert_eq!(
            find_prior_surface(&then_failed),
            find_prior_surface(&rendered_only)
        );
        assert_eq!(next_surface_id(&then_failed, "cart"), "cart-2");
    }

    #[test]
    fn a_failure_that_also_carries_operations_is_still_not_a_surface() {
        // Not this crate's own shape any more, but three producers still send
        // it: this crate before the envelope split, and the TypeScript and .NET
        // toolkits, whose part converters check `error` first and emit no A2UI
        // at all. Reading the operations back would put a surface the user
        // never saw into the next generation prompt.
        let mut failed = serde_json::from_str::<Value>(
            &wrap_as_operations_envelope(&crate::toolkit::ops::assemble_ops(
                Intent::Create,
                &SurfaceSpec::new("cart").with_components(vec![
                    Component::new("root", "Text").with("text", json!("x")),
                ]),
            ))
            .unwrap(),
        )
        .unwrap();

        for error in [json!("could not build the surface"), json!({"code": "X"})] {
            failed["error"] = error;
            let as_data = HistoryMessage::data("tool", failed.clone());
            let as_text = HistoryMessage::text("assistant", failed.to_string());
            assert!(find_prior_surface(&[as_data]).is_none(), "{failed}");
            assert!(find_prior_surface(&[as_text]).is_none(), "{failed}");
        }
    }

    #[test]
    fn history_without_a2ui_yields_nothing() {
        let history = vec![
            HistoryMessage::text("user", "hello"),
            HistoryMessage::text("assistant", "hi there"),
            HistoryMessage::text("assistant", r#"{"some": "unrelated json"}"#),
        ];
        assert!(find_prior_surface(&history).is_none());
        assert!(find_prior_surface_by_id(&history, Some("cart")).is_none());
    }

    #[test]
    fn next_surface_id_avoids_ids_already_used() {
        let history = vec![rendered("cart", "one")];
        assert_eq!(next_surface_id(&history, "cart"), "cart-2");
        assert_eq!(next_surface_id(&history, "other"), "other");
        assert_eq!(next_surface_id(&[], ""), DEFAULT_SURFACE_ID);
    }
}
