//! Tool invocation: `TOOL_CALL_*`.

use serde::{Deserialize, Serialize};

use crate::event::BaseEvent;
use crate::ids::{MessageId, SubagentRunId, ToolCallId};

/// Opens a tool call. Arguments follow as `TOOL_CALL_ARGS` deltas.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ToolCallStartEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// Id correlating this call with its args, end and result.
    pub tool_call_id: ToolCallId,
    /// Name of the tool being called.
    pub tool_call_name: String,
    /// The assistant message that requested the call.
    ///
    /// A JSON `null` here deserializes to `None`: producers whose serializers
    /// emit nulls for absent optionals (notably the .NET Microsoft Agent
    /// Framework adapter) must not abort a run on their first tool call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<MessageId>,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`]. A tool
    /// call belongs to the message `parent_message_id` names, so a tag that
    /// disagrees with that message's owner is a protocol error; an untagged
    /// call inherits the message's owner.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl ToolCallStartEvent {
    /// Opens a call to `tool_call_name`.
    pub fn new(tool_call_id: impl Into<ToolCallId>, tool_call_name: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            tool_call_id: tool_call_id.into(),
            tool_call_name: tool_call_name.into(),
            parent_message_id: None,
            subagent_run_id: None,
        }
    }
}

/// Appends a chunk of the argument JSON for an open tool call.
///
/// The deltas concatenate to a JSON string; individual deltas are usually not
/// valid JSON on their own.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ToolCallArgsEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The call being appended to.
    pub tool_call_id: ToolCallId,
    /// The argument-JSON fragment.
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

impl ToolCallArgsEvent {
    /// Appends `delta` to the call's arguments.
    pub fn new(tool_call_id: impl Into<ToolCallId>, delta: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            tool_call_id: tool_call_id.into(),
            delta: delta.into(),
            subagent_run_id: None,
        }
    }
}

/// Closes a tool call. The arguments are complete.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ToolCallEndEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The call being closed.
    pub tool_call_id: ToolCallId,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl ToolCallEndEvent {
    /// Closes the call.
    pub fn new(tool_call_id: impl Into<ToolCallId>) -> Self {
        Self {
            base: BaseEvent::default(),
            tool_call_id: tool_call_id.into(),
            subagent_run_id: None,
        }
    }
}

/// A self-contained tool-call update: start, args and end folded into one.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ToolCallChunkEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The call this chunk belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    /// Name of the tool being called.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_name: Option<String>,
    /// The assistant message that requested the call. A JSON `null` reads as
    /// absent, as in [`ToolCallStartEvent`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<MessageId>,
    /// The argument-JSON fragment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    /// The subagent that produced this event; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl ToolCallChunkEvent {
    /// Builds a chunk carrying a call id, tool name and argument delta.
    pub fn new(
        tool_call_id: Option<ToolCallId>,
        tool_call_name: Option<String>,
        delta: Option<String>,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            tool_call_id,
            tool_call_name,
            parent_message_id: None,
            delta,
            subagent_run_id: None,
        }
    }
}

/// The result of a tool call, as a message appended to the thread.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ToolCallResultEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// Id of the tool message carrying the result.
    pub message_id: MessageId,
    /// The call this result answers.
    pub tool_call_id: ToolCallId,
    /// The result, already rendered to a string.
    pub content: String,
    /// Always `"tool"` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<ToolResultRole>,
    /// The subagent that *executed* the call; absent means the parent agent.
    /// A JSON `null` is rejected — see [`crate::event::subagent`]. Attributed
    /// independently of the call it answers, on purpose: a frontend-executed
    /// tool, or a supervisor running a call on a subagent's behalf, produces
    /// a result whose owner is not the caller.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl ToolCallResultEvent {
    /// Reports the result of a call.
    pub fn new(
        message_id: impl Into<MessageId>,
        tool_call_id: impl Into<ToolCallId>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            tool_call_id: tool_call_id.into(),
            content: content.into(),
            role: None,
            subagent_run_id: None,
        }
    }
}

/// The single role a [`ToolCallResultEvent`] may declare.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum ToolResultRole {
    /// `"tool"`.
    #[default]
    #[serde(rename = "tool")]
    Tool,
}
