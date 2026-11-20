//! Escape hatches: `RAW` and `CUSTOM`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::BaseEvent;
use crate::ids::SubagentRunId;

/// Forwards a provider event verbatim, for debugging and for consumers that
/// understand the upstream format.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RawEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The upstream event, untouched.
    pub event: Value,
    /// Which system produced it, for example `"openai"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl RawEvent {
    /// Forwards `event` as-is.
    pub fn new(event: impl Into<Value>) -> Self {
        Self {
            base: BaseEvent::default(),
            event: event.into(),
            source: None,
            subagent_run_id: None,
        }
    }
}

/// An application-defined event, outside the protocol's vocabulary.
///
/// Use this for anything a specific client and agent agree on; the protocol
/// only guarantees the envelope.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct CustomEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The event name both sides agreed on.
    pub name: String,
    /// The payload.
    pub value: Value,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl CustomEvent {
    /// Emits a named custom event.
    pub fn new(name: impl Into<String>, value: impl Into<Value>) -> Self {
        Self {
            base: BaseEvent::default(),
            name: name.into(),
            value: value.into(),
            subagent_run_id: None,
        }
    }
}
