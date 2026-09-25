//! Structured progress updates: `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`.
//!
//! Activities are how an agent reports what it is *doing* — searching, reading
//! files, waiting on an API — in a shape the client renders itself, rather than
//! as prose in the reply.

use serde::{Deserialize, Serialize};

use crate::JsonObject;
use crate::event::BaseEvent;
use crate::ids::{MessageId, SubagentRunId};
use crate::patch::PatchOperation;

/// Publishes the full content of an activity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ActivitySnapshotEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The activity message being written.
    pub message_id: MessageId,
    /// Client-defined activity discriminator, for example `"web_search"`.
    pub activity_type: String,
    /// The activity payload.
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "std::collections::BTreeMap<String, serde_json::Value>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Object))]
    pub content: JsonObject,
    /// Whether this replaces the existing content (the default) or merges into
    /// it.
    #[serde(default = "default_replace")]
    pub replace: bool,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

/// The upstream schema defaults `replace` to `true`, so an omitted field means
/// "replace" rather than "merge".
const fn default_replace() -> bool {
    true
}

impl Default for ActivitySnapshotEvent {
    fn default() -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: MessageId::default(),
            activity_type: String::new(),
            content: JsonObject::new(),
            replace: default_replace(),
            subagent_run_id: None,
        }
    }
}

impl ActivitySnapshotEvent {
    /// Publishes an activity payload, replacing any previous content.
    pub fn new(
        message_id: impl Into<MessageId>,
        activity_type: impl Into<String>,
        content: JsonObject,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            activity_type: activity_type.into(),
            content,
            replace: true,
            subagent_run_id: None,
        }
    }
}

/// Mutates an activity's content with a JSON Patch document.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ActivityDeltaEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The activity message being patched.
    pub message_id: MessageId,
    /// Client-defined activity discriminator.
    pub activity_type: String,
    /// RFC 6902 operations, applied in order to the activity content.
    pub patch: Vec<PatchOperation>,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl ActivityDeltaEvent {
    /// Patches an activity's content.
    pub fn new(
        message_id: impl Into<MessageId>,
        activity_type: impl Into<String>,
        patch: impl Into<Vec<PatchOperation>>,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            activity_type: activity_type.into(),
            patch: patch.into(),
            subagent_run_id: None,
        }
    }
}
