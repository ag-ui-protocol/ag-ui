//! Shared state and message-history snapshots: `STATE_SNAPSHOT`,
//! `STATE_DELTA`, `MESSAGES_SNAPSHOT`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::BaseEvent;
use crate::ids::SubagentRunId;
use crate::message::Message;
use crate::patch::PatchOperation;

/// Replaces the shared state wholesale.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct StateSnapshotEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The complete new state. Free-form JSON, opaque to the protocol.
    pub snapshot: Value,
    /// The subagent that produced this update; absent means the parent
    /// agent. A JSON `null` is rejected — see [`crate::event::subagent`].
    /// Provenance, not ownership: state is run-scoped, and an attributed
    /// snapshot still replaces the run's one state document.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl StateSnapshotEvent {
    /// Publishes a new state.
    pub fn new(snapshot: impl Into<Value>) -> Self {
        Self {
            base: BaseEvent::default(),
            snapshot: snapshot.into(),
            subagent_run_id: None,
        }
    }
}

/// Mutates the shared state with a JSON Patch document.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct StateDeltaEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// RFC 6902 operations, applied in order to the previous state.
    pub delta: Vec<PatchOperation>,
    /// The subagent that produced this update; absent means the parent
    /// agent. A JSON `null` is rejected — see [`crate::event::subagent`].
    /// Provenance, not ownership, as on [`StateSnapshotEvent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl StateDeltaEvent {
    /// Publishes a patch against the current state.
    pub fn new(delta: impl Into<Vec<PatchOperation>>) -> Self {
        Self {
            base: BaseEvent::default(),
            delta: delta.into(),
            subagent_run_id: None,
        }
    }
}

/// Replaces the message history wholesale.
///
/// Used to reconcile after a reconnect, or when an agent rewrites history (for
/// example after summarizing older turns).
///
/// Carries no `subagentRunId` of its own: one snapshot mixes messages from
/// several producers, so attribution travels per message instead.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct MessagesSnapshotEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The complete message list, oldest first.
    pub messages: Vec<Message>,
}

impl MessagesSnapshotEvent {
    /// Publishes a new message history.
    pub fn new(messages: impl Into<Vec<Message>>) -> Self {
        Self {
            base: BaseEvent::default(),
            messages: messages.into(),
        }
    }
}
