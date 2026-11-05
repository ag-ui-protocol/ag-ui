use crate::JsonValue;
use crate::state::AgentState;
use crate::types::{Message, Role};
use crate::types::{MessageId, RunId, ThreadId, ToolCallId};
use serde::{Deserialize, Serialize};

/// Event types for AG-UI protocol
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[non_exhaustive]
pub enum EventType {
    /// Event indicating the start of a text message
    ActivitySnapshot,
    ActivityDelta,
    ReasoningStart,
    ReasoningMessageStart,
    ReasoningMessageContent,
    ReasoningMessageEnd,
    ReasoningMessageChunk,
    ReasoningEnd,
    ReasoningEncryptedValue,
    SubagentStarted,
    SubagentFinished,
    SubagentError,
    TextMessageStart,
    /// Event containing a piece of text message content
    TextMessageContent,
    /// Event indicating the end of a text message
    TextMessageEnd,
    /// Event containing a chunk of text message content
    TextMessageChunk,
    /// Event indicating the start of a thinking text message
    ThinkingTextMessageStart,
    /// Event indicating a piece of a thinking text message
    ThinkingTextMessageContent,
    /// Event indicating the end of a thinking text message
    ThinkingTextMessageEnd,
    /// Event indicating the start of a tool call
    ToolCallStart,
    /// Event containing tool call arguments
    ToolCallArgs,
    /// Event indicating the end of a tool call
    ToolCallEnd,
    /// Event containing a chunk of tool call content
    ToolCallChunk,
    /// Event containing the result of a tool call
    ToolCallResult,
    /// Event indicating the start of a thinking step event
    ThinkingStart,
    /// Event indicating the end of a thinking step event
    ThinkingEnd,
    /// Event containing a snapshot of the state
    StateSnapshot,
    /// Event containing a delta of the state
    StateDelta,
    /// Event containing a snapshot of the messages
    MessagesSnapshot,
    /// Event containing a raw event
    Raw,
    /// Event containing a custom event
    Custom,
    /// Event indicating that a run has started
    RunStarted,
    /// Event indicating that a run has finished
    RunFinished,
    /// Event indicating that a run has encountered an error
    RunError,
    /// Event indicating that a step has started
    StepStarted,
    /// Event indicating that a step has finished
    StepFinished,
}

/// Base event for all events in the Agent User Interaction Protocol.
/// Contains common fields that are present in all event types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct BaseEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "deserialize_timestamp", default)]
    pub timestamp: Option<i64>,
    #[serde(rename = "rawEvent", skip_serializing_if = "Option::is_none")]
    pub raw_event: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub metadata: Option<serde_json::Map<String, JsonValue>>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::types::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

fn deserialize_tool_role<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Role>, D::Error> {
    let role = Role::deserialize(d)?;
    if role != Role::Tool {
        return Err(serde::de::Error::custom("tool result role must be tool"));
    }
    Ok(Some(role))
}
fn deserialize_timestamp<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    let n = i64::deserialize(d)?;
    if !(-9007199254740991..=9007199254740991).contains(&n) {
        return Err(serde::de::Error::custom(
            "timestamp outside safe integer range",
        ));
    }
    Ok(Some(n))
}

/// Event indicating the start of a text message.
/// This event is sent when the agent begins generating a text message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>, // Absent means assistant.
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::types::non_null_option",
        default
    )]
    pub name: Option<String>,
}

/// Event containing a piece of text message content.
/// This event is sent for each chunk of content as the agent generates a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TextMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    pub delta: String,
}

/// Event indicating the end of a text message.
/// This event is sent when the agent completes a text message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TextMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}

/// Event containing a chunk of text message content.
/// This event combines start, content, and potentially end information in a single event,
/// with optional fields that may or may not be present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct TextMessageChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::types::non_null_option",
        default
    )]
    pub name: Option<String>,
}

/// Event indicating the start of a thinking text message.
/// This event is sent when the agent begins generating internal thinking content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct ThinkingTextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Event indicating a piece of a thinking text message.
/// This event contains chunks of the agent's internal thinking process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ThinkingTextMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub delta: String,
}

/// Event indicating the end of a thinking text message.
/// This event is sent when the agent completes its internal thinking process.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct ThinkingTextMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Event indicating the start of a tool call.
/// This event is sent when the agent begins to call a tool with specific parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolCallStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    #[serde(rename = "toolCallName")]
    pub tool_call_name: String,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub parent_message_id: Option<MessageId>,
}

/// Event containing tool call arguments.
/// This event contains chunks of the arguments being passed to a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolCallArgsEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    pub delta: String,
}

/// Event indicating the end of a tool call.
/// This event is sent when the agent completes sending arguments to a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolCallEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
}

/// Event containing the result of a tool call.
/// This event is sent when a tool has completed execution and returns its result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolCallResultEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    pub content: crate::types::MessageContent,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_tool_role"
    )]
    pub role: Option<Role>, // If present, always "tool".
}

/// Event containing a chunk of tool call content.
/// This event combines start, args, and potentially end information in a single event,
/// with optional fields that may or may not be present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct ToolCallChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    #[serde(rename = "toolCallName", skip_serializing_if = "Option::is_none")]
    pub tool_call_name: Option<String>,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub parent_message_id: Option<MessageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}

/// Event indicating the start of a thinking step event.
/// This event is sent when the agent begins a deliberate thinking phase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct ThinkingStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Event indicating the end of a thinking step event.
/// This event is sent when the agent completes a thinking phase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct ThinkingEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Event containing a snapshot of the state.
/// This event provides a complete representation of the current agent state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(bound(deserialize = ""))]
#[non_exhaustive]
pub struct StateSnapshotEvent<StateT: AgentState = JsonValue> {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub snapshot: StateT,
}

/// Event containing a delta of the state.
/// This event contains JSON Patch operations (RFC 6902) that describe changes to the agent state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct StateDeltaEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub delta: Vec<crate::types::JsonPatchOperation>,
}

/// Event containing a snapshot of the messages.
/// This event provides a complete list of all current conversation messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct MessagesSnapshotEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub messages: Vec<Message>,
}

/// Event containing a raw event.
/// This event type allows wrapping arbitrary events from external sources.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RawEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub event: JsonValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Event containing a custom event.
/// This event type allows for application-specific custom events with arbitrary data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct CustomEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub name: String,
    pub value: JsonValue,
}

/// Event indicating that a run has started.
/// This event is sent when an agent run begins execution within a specific thread.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RunStartedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(rename = "protocolVersion", skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(rename = "parentRunId", skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<crate::types::RunAgentInput>,
}

/// Event indicating that a run has finished.
/// This event is sent when an agent run completes successfully, potentially with a result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RunFinishedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub outcome: Option<crate::types::RunFinishedOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Vec<crate::types::TokenUsage>>,
}

/// Event indicating that a run has encountered an error.
/// This event is sent when an agent run fails with an error message and optional error code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RunErrorEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Vec<crate::types::TokenUsage>>,
}

/// Event indicating that a step has started.
/// This event is sent when a specific named step within a run begins execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct StepStartedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "stepName")]
    pub step_name: String,
}

/// Event indicating that a step has finished.
/// This event is sent when a specific named step within a run completes execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct StepFinishedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "stepName")]
    pub step_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ActivitySnapshotEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(rename = "activityType")]
    pub activity_type: String,
    pub content: serde_json::Map<String, JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ActivityDeltaEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    #[serde(rename = "activityType")]
    pub activity_type: String,
    pub patch: Vec<crate::types::JsonPatchOperation>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReasoningStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReasoningMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    pub role: Role,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReasoningMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    pub delta: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReasoningMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[non_exhaustive]
pub struct ReasoningMessageChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<MessageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReasoningEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReasoningEncryptedValueEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub subtype: crate::types::ReasoningEncryptedValueSubtype,
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[serde(rename = "encryptedValue")]
    pub encrypted_value: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SubagentStartedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "subagentRunId")]
    pub subagent_run_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub description: Option<String>,
    #[serde(
        rename = "parentSubagentRunId",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_subagent_run_id: Option<String>,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub parent_message_id: Option<MessageId>,
    #[serde(rename = "parentToolCallId", skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<ToolCallId>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SubagentFinishedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "subagentRunId")]
    pub subagent_run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub outcome: Option<crate::types::SubagentFinishedOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonValue>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SubagentErrorEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "subagentRunId")]
    pub subagent_run_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(deserialize_with = "crate::types::non_null_option", default)]
    pub code: Option<String>,
}

/// Union of all possible events in the Agent User Interaction Protocol.
/// This enum represents the full set of events that can be exchanged
/// between the agent and the client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "SCREAMING_SNAKE_CASE",
    bound(deserialize = "")
)]
#[non_exhaustive]
pub enum Event<StateT: AgentState = JsonValue> {
    ActivitySnapshot(ActivitySnapshotEvent),
    ActivityDelta(ActivityDeltaEvent),
    ReasoningStart(ReasoningStartEvent),
    ReasoningMessageStart(ReasoningMessageStartEvent),
    ReasoningMessageContent(ReasoningMessageContentEvent),
    ReasoningMessageEnd(ReasoningMessageEndEvent),
    ReasoningMessageChunk(ReasoningMessageChunkEvent),
    ReasoningEnd(ReasoningEndEvent),
    ReasoningEncryptedValue(ReasoningEncryptedValueEvent),
    SubagentStarted(SubagentStartedEvent),
    SubagentFinished(SubagentFinishedEvent),
    SubagentError(SubagentErrorEvent),
    /// Signals the start of a text message from an agent.
    /// Contains the message ID and role information.
    TextMessageStart(TextMessageStartEvent),

    /// Represents a chunk of content being added to an in-progress text message.
    /// Contains the message ID and the text delta to append.
    TextMessageContent(TextMessageContentEvent),

    /// Signals the completion of a text message.
    /// Contains the message ID of the completed message.
    TextMessageEnd(TextMessageEndEvent),

    /// Represents a complete or partial message chunk in a single event.
    /// May contain optional message ID, role, and delta information.
    TextMessageChunk(TextMessageChunkEvent),

    /// Signals the start of a thinking text message.
    /// Used for internal agent thought processes that should be displayed to the user.
    ThinkingTextMessageStart(ThinkingTextMessageStartEvent),

    /// Represents content being added to an in-progress thinking text message.
    /// Contains the delta text to append.
    ThinkingTextMessageContent(ThinkingTextMessageContentEvent),

    /// Signals the completion of a thinking text message.
    ThinkingTextMessageEnd(ThinkingTextMessageEndEvent),

    /// Signals the start of a tool call by the agent.
    /// Contains the tool call ID, name, and optional parent message ID.
    ToolCallStart(ToolCallStartEvent),

    /// Represents arguments being added to an in-progress tool call.
    /// Contains the tool call ID and argument data delta.
    ToolCallArgs(ToolCallArgsEvent),

    /// Signals the completion of a tool call.
    /// Contains the tool call ID of the completed call.
    ToolCallEnd(ToolCallEndEvent),

    /// Represents a complete or partial tool call in a single event.
    /// May contain optional tool call ID, name, parent message ID, and delta.
    ToolCallChunk(ToolCallChunkEvent),

    /// Represents the result of a completed tool call.
    /// Contains the message ID, tool call ID, content, and optional role.
    ToolCallResult(ToolCallResultEvent),

    /// Signals the start of a thinking process.
    /// Contains an optional title describing the thinking process.
    ThinkingStart(ThinkingStartEvent),

    /// Signals the end of a thinking process.
    ThinkingEnd(ThinkingEndEvent),

    /// Provides a complete snapshot of the current state.
    /// Contains the full state as a JSON value.
    StateSnapshot(StateSnapshotEvent<StateT>),

    /// Provides incremental changes to the state.
    /// Contains a vector of delta operations to apply to the state.
    StateDelta(StateDeltaEvent),

    /// Provides a complete snapshot of all messages.
    /// Contains a vector of all current messages.
    MessagesSnapshot(MessagesSnapshotEvent),

    /// Wraps a raw event from an external source.
    /// Contains the original event as a JSON value and an optional source identifier.
    Raw(RawEvent),

    /// Represents a custom event type not covered by the standard events.
    /// Contains a name identifying the custom event type and an associated value.
    Custom(CustomEvent),

    /// Signals the start of an agent run.
    /// Contains thread ID and run ID to identify the run.
    RunStarted(Box<RunStartedEvent>),

    /// Signals the completion of an agent run.
    /// Contains thread ID, run ID, and optional result data.
    RunFinished(RunFinishedEvent),

    /// Signals an error that occurred during an agent run.
    /// Contains error message and optional error code.
    RunError(RunErrorEvent),

    /// Signals the start of a step within an agent run.
    /// Contains the name of the step being started.
    StepStarted(StepStartedEvent),

    /// Signals the completion of a step within an agent run.
    /// Contains the name of the completed step.
    StepFinished(StepFinishedEvent),
}

impl Event {
    /// Get the event type
    pub fn event_type(&self) -> EventType {
        match self {
            Event::ActivitySnapshot(_) => EventType::ActivitySnapshot,
            Event::ActivityDelta(_) => EventType::ActivityDelta,
            Event::ReasoningStart(_) => EventType::ReasoningStart,
            Event::ReasoningMessageStart(_) => EventType::ReasoningMessageStart,
            Event::ReasoningMessageContent(_) => EventType::ReasoningMessageContent,
            Event::ReasoningMessageEnd(_) => EventType::ReasoningMessageEnd,
            Event::ReasoningMessageChunk(_) => EventType::ReasoningMessageChunk,
            Event::ReasoningEnd(_) => EventType::ReasoningEnd,
            Event::ReasoningEncryptedValue(_) => EventType::ReasoningEncryptedValue,
            Event::SubagentStarted(_) => EventType::SubagentStarted,
            Event::SubagentFinished(_) => EventType::SubagentFinished,
            Event::SubagentError(_) => EventType::SubagentError,
            Event::TextMessageStart(_) => EventType::TextMessageStart,
            Event::TextMessageContent(_) => EventType::TextMessageContent,
            Event::TextMessageEnd(_) => EventType::TextMessageEnd,
            Event::TextMessageChunk(_) => EventType::TextMessageChunk,
            Event::ThinkingTextMessageStart(_) => EventType::ThinkingTextMessageStart,
            Event::ThinkingTextMessageContent(_) => EventType::ThinkingTextMessageContent,
            Event::ThinkingTextMessageEnd(_) => EventType::ThinkingTextMessageEnd,
            Event::ToolCallStart(_) => EventType::ToolCallStart,
            Event::ToolCallArgs(_) => EventType::ToolCallArgs,
            Event::ToolCallEnd(_) => EventType::ToolCallEnd,
            Event::ToolCallChunk(_) => EventType::ToolCallChunk,
            Event::ToolCallResult(_) => EventType::ToolCallResult,
            Event::ThinkingStart(_) => EventType::ThinkingStart,
            Event::ThinkingEnd(_) => EventType::ThinkingEnd,
            Event::StateSnapshot(_) => EventType::StateSnapshot,
            Event::StateDelta(_) => EventType::StateDelta,
            Event::MessagesSnapshot(_) => EventType::MessagesSnapshot,
            Event::Raw(_) => EventType::Raw,
            Event::Custom(_) => EventType::Custom,
            Event::RunStarted(_) => EventType::RunStarted,
            Event::RunFinished(_) => EventType::RunFinished,
            Event::RunError(_) => EventType::RunError,
            Event::StepStarted(_) => EventType::StepStarted,
            Event::StepFinished(_) => EventType::StepFinished,
        }
    }

    /// Get the timestamp if available
    pub fn timestamp(&self) -> Option<i64> {
        match self {
            Event::ActivitySnapshot(e) => e.base.timestamp,
            Event::ActivityDelta(e) => e.base.timestamp,
            Event::ReasoningStart(e) => e.base.timestamp,
            Event::ReasoningMessageStart(e) => e.base.timestamp,
            Event::ReasoningMessageContent(e) => e.base.timestamp,
            Event::ReasoningMessageEnd(e) => e.base.timestamp,
            Event::ReasoningMessageChunk(e) => e.base.timestamp,
            Event::ReasoningEnd(e) => e.base.timestamp,
            Event::ReasoningEncryptedValue(e) => e.base.timestamp,
            Event::SubagentStarted(e) => e.base.timestamp,
            Event::SubagentFinished(e) => e.base.timestamp,
            Event::SubagentError(e) => e.base.timestamp,
            Event::TextMessageStart(e) => e.base.timestamp,
            Event::TextMessageContent(e) => e.base.timestamp,
            Event::TextMessageEnd(e) => e.base.timestamp,
            Event::TextMessageChunk(e) => e.base.timestamp,
            Event::ThinkingTextMessageStart(e) => e.base.timestamp,
            Event::ThinkingTextMessageContent(e) => e.base.timestamp,
            Event::ThinkingTextMessageEnd(e) => e.base.timestamp,
            Event::ToolCallStart(e) => e.base.timestamp,
            Event::ToolCallArgs(e) => e.base.timestamp,
            Event::ToolCallEnd(e) => e.base.timestamp,
            Event::ToolCallChunk(e) => e.base.timestamp,
            Event::ToolCallResult(e) => e.base.timestamp,
            Event::ThinkingStart(e) => e.base.timestamp,
            Event::ThinkingEnd(e) => e.base.timestamp,
            Event::StateSnapshot(e) => e.base.timestamp,
            Event::StateDelta(e) => e.base.timestamp,
            Event::MessagesSnapshot(e) => e.base.timestamp,
            Event::Raw(e) => e.base.timestamp,
            Event::Custom(e) => e.base.timestamp,
            Event::RunStarted(e) => e.base.timestamp,
            Event::RunFinished(e) => e.base.timestamp,
            Event::RunError(e) => e.base.timestamp,
            Event::StepStarted(e) => e.base.timestamp,
            Event::StepFinished(e) => e.base.timestamp,
        }
    }
}

/// Validation error types for events in the Agent User Interaction Protocol.
/// These errors represent validation failures when creating or processing events.
#[derive(Debug, thiserror::Error)]
pub enum EventValidationError {
    #[error("Delta must not be an empty string")]
    EmptyDelta,
    #[error("Invalid event format: {0}")]
    InvalidFormat(String),
}

/// Validate text message content event
impl TextMessageContentEvent {
    pub fn validate(&self) -> Result<(), EventValidationError> {
        // Empty deltas are valid AG-UI 1.0 strings.
        Ok(())
    }
}

/// Builder pattern for creating events
impl TextMessageStartEvent {
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            role: Some(Role::Assistant),
            name: None,
        }
    }

    pub fn with_timestamp(mut self, timestamp: i64) -> Self {
        self.base.timestamp = Some(timestamp);
        self
    }

    pub fn with_raw_event(mut self, raw_event: JsonValue) -> Self {
        self.base.raw_event = Some(raw_event);
        self
    }
}

impl TextMessageContentEvent {
    pub fn new(
        message_id: impl Into<MessageId>,
        delta: String,
    ) -> Result<Self, EventValidationError> {
        let event = Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            delta,
        };
        event.validate()?;
        Ok(event)
    }

    pub fn with_timestamp(mut self, timestamp: i64) -> Self {
        self.base.timestamp = Some(timestamp);
        self
    }
}

impl TextMessageStartEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl TextMessageContentEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl TextMessageEndEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl TextMessageChunkEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ThinkingTextMessageStartEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ThinkingTextMessageContentEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(delta: String) -> Self {
        Self {
            base: BaseEvent::default(),
            delta,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ThinkingTextMessageEndEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ToolCallStartEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(tool_call_id: impl Into<ToolCallId>, tool_call_name: String) -> Self {
        Self {
            base: BaseEvent::default(),
            tool_call_id: tool_call_id.into(),
            tool_call_name,
            parent_message_id: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ToolCallArgsEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(tool_call_id: impl Into<ToolCallId>, delta: String) -> Self {
        Self {
            base: BaseEvent::default(),
            tool_call_id: tool_call_id.into(),
            delta,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ToolCallEndEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(tool_call_id: impl Into<ToolCallId>) -> Self {
        Self {
            base: BaseEvent::default(),
            tool_call_id: tool_call_id.into(),
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ToolCallResultEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(
        message_id: impl Into<MessageId>,
        tool_call_id: impl Into<ToolCallId>,
        content: crate::types::MessageContent,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            tool_call_id: tool_call_id.into(),
            content,
            role: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ToolCallChunkEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ThinkingStartEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ThinkingEndEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl<StateT: AgentState> StateSnapshotEvent<StateT> {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(snapshot: StateT) -> Self {
        Self {
            base: BaseEvent::default(),
            snapshot,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl StateDeltaEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(delta: Vec<crate::types::JsonPatchOperation>) -> Self {
        Self {
            base: BaseEvent::default(),
            delta,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl MessagesSnapshotEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(messages: Vec<Message>) -> Self {
        Self {
            base: BaseEvent::default(),
            messages,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl RawEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(event: JsonValue) -> Self {
        Self {
            base: BaseEvent::default(),
            event,
            source: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl CustomEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(name: String, value: JsonValue) -> Self {
        Self {
            base: BaseEvent::default(),
            name,
            value,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl RunStartedEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        Self {
            base: BaseEvent::default(),
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            protocol_version: None,
            parent_run_id: None,
            input: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl RunFinishedEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        Self {
            base: BaseEvent::default(),
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            result: None,
            outcome: None,
            usage: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl RunErrorEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(message: String) -> Self {
        Self {
            base: BaseEvent::default(),
            message,
            code: None,
            usage: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl StepStartedEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(step_name: String) -> Self {
        Self {
            base: BaseEvent::default(),
            step_name,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl StepFinishedEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(step_name: String) -> Self {
        Self {
            base: BaseEvent::default(),
            step_name,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ActivitySnapshotEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(
        message_id: impl Into<MessageId>,
        activity_type: String,
        content: serde_json::Map<String, JsonValue>,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            activity_type,
            content,
            replace: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ActivityDeltaEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(
        message_id: impl Into<MessageId>,
        activity_type: String,
        patch: Vec<crate::types::JsonPatchOperation>,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            activity_type,
            patch,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ReasoningStartEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ReasoningMessageStartEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            role: Role::Reasoning,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ReasoningMessageContentEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(message_id: impl Into<MessageId>, delta: String) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
            delta,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ReasoningMessageEndEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ReasoningMessageChunkEvent {
    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ReasoningEndEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(message_id: impl Into<MessageId>) -> Self {
        Self {
            base: BaseEvent::default(),
            message_id: message_id.into(),
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl ReasoningEncryptedValueEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(
        subtype: crate::types::ReasoningEncryptedValueSubtype,
        entity_id: String,
        encrypted_value: String,
    ) -> Self {
        Self {
            base: BaseEvent::default(),
            subtype,
            entity_id,
            encrypted_value,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl SubagentStartedEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(subagent_run_id: String, name: String) -> Self {
        Self {
            base: BaseEvent::default(),
            subagent_run_id,
            name,
            description: None,
            parent_subagent_run_id: None,
            parent_message_id: None,
            parent_tool_call_id: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl SubagentFinishedEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(subagent_run_id: String) -> Self {
        Self {
            base: BaseEvent::default(),
            subagent_run_id,
            outcome: None,
            result: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}

impl SubagentErrorEvent {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(subagent_run_id: String, message: String) -> Self {
        Self {
            base: BaseEvent::default(),
            subagent_run_id,
            message,
            code: None,
        }
    }

    /// Sets the common event metadata.
    pub fn with_base(mut self, base: BaseEvent) -> Self {
        self.base = base;
        self
    }
}
