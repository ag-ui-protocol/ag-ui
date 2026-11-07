//! Model reasoning: `REASONING_*`, plus the deprecated `THINKING_*` events
//! they replaced.

use serde::{Deserialize, Serialize};

use crate::event::BaseEvent;
use crate::ids::{MessageId, SubagentRunId};

/// Opens a reasoning block. Reasoning messages inside it are bracketed by
/// `REASONING_MESSAGE_START` / `REASONING_MESSAGE_END`, and the block closes
/// with `REASONING_END`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningStartEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The message this reasoning belongs to.
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

impl ReasoningStartEvent {
    /// Opens a reasoning block for `message_id`.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            subagent_run_id: None,
        }
    }
}

/// The single role a reasoning message may declare.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum ReasoningRole {
    /// `"reasoning"`.
    #[default]
    #[serde(rename = "reasoning")]
    Reasoning,
}

/// Opens a reasoning message.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningMessageStartEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// Id of the reasoning message being opened.
    pub message_id: MessageId,
    /// Always [`ReasoningRole::Reasoning`]. Required, unlike the optional role
    /// on `TEXT_MESSAGE_START`.
    pub role: ReasoningRole,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl ReasoningMessageStartEvent {
    /// Opens a reasoning message.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            role: ReasoningRole::Reasoning,
            subagent_run_id: None,
        }
    }
}

/// Appends a chunk of reasoning text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningMessageContentEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The reasoning message being appended to.
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

impl ReasoningMessageContentEvent {
    /// Appends `delta` to the reasoning message.
    pub fn new(message_id: impl Into<MessageId>, delta: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            delta: delta.into(),
            subagent_run_id: None,
        }
    }
}

/// Closes a reasoning message.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningMessageEndEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The reasoning message being closed.
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

impl ReasoningMessageEndEvent {
    /// Closes the reasoning message.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            subagent_run_id: None,
        }
    }
}

/// A self-contained reasoning update: start, content and end folded into one.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningMessageChunkEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The reasoning message this chunk belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
    /// The text to append.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
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

impl ReasoningMessageChunkEvent {
    /// Builds a reasoning chunk.
    pub fn new(message_id: Option<MessageId>, delta: Option<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id,
            delta,
            subagent_run_id: None,
        }
    }
}

/// Closes a reasoning block.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningEndEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The message whose reasoning block is closing.
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

impl ReasoningEndEvent {
    /// Closes the reasoning block for `message_id`.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            subagent_run_id: None,
        }
    }
}

/// What an encrypted reasoning signature belongs to.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum ReasoningEncryptedValueSubtype {
    /// The signature covers a tool call.
    #[serde(rename = "tool-call")]
    ToolCall,
    /// The signature covers a message.
    #[default]
    #[serde(rename = "message")]
    Message,
}

impl ReasoningEncryptedValueSubtype {
    /// The subtype string as it appears on the wire.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::ToolCall => "tool-call",
            Self::Message => "message",
        }
    }
}

/// Carries a provider's opaque reasoning signature.
///
/// Under zero-data-retention the provider returns no readable reasoning, only a
/// blob that must be replayed on the next request for the model to continue
/// coherently.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningEncryptedValueEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// Whether `entity_id` names a tool call or a message.
    pub subtype: ReasoningEncryptedValueSubtype,
    /// The tool call or message the blob belongs to.
    pub entity_id: String,
    /// The opaque blob.
    pub encrypted_value: String,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl ReasoningEncryptedValueEvent {
    /// Attaches an encrypted reasoning blob to an entity.
    pub fn new(
        subtype: ReasoningEncryptedValueSubtype,
        entity_id: impl Into<String>,
        encrypted_value: impl Into<String>,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            subtype,
            entity_id: entity_id.into(),
            encrypted_value: encrypted_value.into(),
            subagent_run_id: None,
        }
    }
}

// The five THINKING_* payloads below are deprecated, but `#[deprecated]` is
// suppressed when the `utoipa` feature is on: utoipa 5.5's derive emits a
// `.deprecated()` call on the `AllOf` builder it uses for `#[serde(flatten)]`
// structs and tagged-enum variants, and that builder has no such method, so the
// crate would not compile. The deprecation stays unconditional on the
// `Event::thinking_*` constructors, which utoipa never sees.
//
// None of them carries `subagentRunId`: the family predates subagents and is
// excluded from the attribution table upstream, so accepting the field here
// would let TypeScript-shaped payloads through that Python and .NET reject.

/// Opens a thinking block.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
#[cfg_attr(
    not(feature = "utoipa"),
    deprecated(note = "use the REASONING_* events: ReasoningStartEvent")
)]
pub struct ThinkingStartEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// Heading to show above the block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl ThinkingStartEvent {
    /// Opens a thinking block with an optional title.
    pub fn new(title: Option<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            title,
        }
    }
}

/// Closes a thinking block.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
#[cfg_attr(
    not(feature = "utoipa"),
    deprecated(note = "use the REASONING_* events: ReasoningEndEvent")
)]
pub struct ThinkingEndEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Opens a thinking text message.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
#[cfg_attr(
    not(feature = "utoipa"),
    deprecated(note = "use the REASONING_* events: ReasoningMessageStartEvent")
)]
pub struct ThinkingTextMessageStartEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Appends a chunk of thinking text.
///
/// Unlike its replacement it carries no message id — a thinking block could
/// only ever have one message in flight, which is why the event was replaced.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
#[cfg_attr(
    not(feature = "utoipa"),
    deprecated(note = "use the REASONING_* events: ReasoningMessageContentEvent")
)]
pub struct ThinkingTextMessageContentEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The text to append.
    pub delta: String,
}

impl ThinkingTextMessageContentEvent {
    /// Appends `delta` to the open thinking message.
    pub fn new(delta: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            delta: delta.into(),
        }
    }
}

/// Closes a thinking text message.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
#[cfg_attr(
    not(feature = "utoipa"),
    deprecated(note = "use the REASONING_* events: ReasoningMessageEndEvent")
)]
pub struct ThinkingTextMessageEndEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
}
