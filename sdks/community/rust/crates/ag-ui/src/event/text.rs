//! Streaming assistant text: `TEXT_MESSAGE_*`.

use serde::{Deserialize, Deserializer, Serialize};

use crate::event::BaseEvent;
use crate::ids::{MessageId, SubagentRunId};

/// Reads an omitted *or* explicitly null `role` as [`TextMessageRole`]'s
/// default.
///
/// The field is optional on the wire, and a producer that models an optional
/// field as *nullable* writes the absent case as `null` rather than by leaving
/// the key out — the same case [`ToolCallStartEvent::parent_message_id`]
/// documents. Without this, `"role": null` fails to deserialize and takes the
/// whole event, and so usually the whole run, with it.
///
/// [`ToolCallStartEvent::parent_message_id`]: crate::event::ToolCallStartEvent::parent_message_id
fn null_role_is_the_default<'de, D>(deserializer: D) -> Result<TextMessageRole, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<TextMessageRole>::deserialize(deserializer)?.unwrap_or_default())
}

/// The roles a streamed text message may carry.
///
/// Every role except `tool` — a tool result is not streamed as text, it arrives
/// whole in `TOOL_CALL_RESULT`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum TextMessageRole {
    /// Out-of-band developer instructions.
    Developer,
    /// System prompt.
    System,
    /// Model output. The default when a producer omits the field.
    #[default]
    Assistant,
    /// End-user input.
    User,
}

impl TextMessageRole {
    /// The role string as it appears on the wire.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Developer => "developer",
            Self::System => "system",
            Self::Assistant => "assistant",
            Self::User => "user",
        }
    }
}

/// Opens a text message. Every following `TEXT_MESSAGE_CONTENT` with the same
/// `message_id` appends to it, until `TEXT_MESSAGE_END`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct TextMessageStartEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// Id of the message being opened.
    pub message_id: MessageId,
    /// Who is speaking. Defaults to `assistant` when omitted, and a JSON `null`
    /// reads as omitted.
    #[serde(default, deserialize_with = "null_role_is_the_default")]
    pub role: TextMessageRole,
    /// Display name for the author.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl TextMessageStartEvent {
    /// Opens a message with the given id and role.
    pub fn new(message_id: impl Into<MessageId>, role: TextMessageRole) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            role,
            name: None,
            subagent_run_id: None,
        }
    }
}

/// Appends a chunk of text to an open message.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct TextMessageContentEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The message being appended to.
    pub message_id: MessageId,
    /// The text to append.
    pub delta: String,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl TextMessageContentEvent {
    /// Appends `delta` to the message.
    pub fn new(message_id: impl Into<MessageId>, delta: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            delta: delta.into(),
            subagent_run_id: None,
        }
    }
}

/// Closes a text message.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct TextMessageEndEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The message being closed.
    pub message_id: MessageId,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl TextMessageEndEvent {
    /// Closes the message.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            subagent_run_id: None,
        }
    }
}

/// A self-contained text update: start, content and end folded into one event.
///
/// Producers that cannot bracket a message use this; consumers expand a run of
/// chunks sharing a `message_id` into the equivalent start/content/end triple.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct TextMessageChunkEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The message this chunk belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
    /// Who is speaking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<TextMessageRole>,
    /// The text to append.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    /// Display name for the author.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`]. Under
    /// concurrency a chunk that omits its `message_id` is resolved within the
    /// sending subagent's own stream, so attribute every chunk when several
    /// subagents stream at once.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl TextMessageChunkEvent {
    /// Builds a chunk carrying a message id and a text delta.
    pub fn new(message_id: Option<MessageId>, delta: Option<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id,
            role: None,
            delta,
            name: None,
            subagent_run_id: None,
        }
    }
}
