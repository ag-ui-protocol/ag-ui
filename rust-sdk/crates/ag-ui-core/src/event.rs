use crate::types::messages::Message;
use serde::{Deserialize, Serialize};
use crate::JsonValue;
use crate::types::ids::ToolCallId;

/// Event types for AG-UI protocol
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    TextMessageChunk,
    ThinkingTextMessageStart,
    ThinkingTextMessageContent,
    ThinkingTextMessageEnd,
    ToolCallStart,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallChunk,
    ToolCallResult,
    ThinkingStart,
    ThinkingEnd,
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,
    Raw,
    Custom,
    RunStarted,
    RunFinished,
    RunError,
    StepStarted,
    StepFinished,
}

/// Base event fields common to all events
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaseEvent {
    #[serde(rename = "type")]
    pub event_type: EventType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    #[serde(rename = "rawEvent", skip_serializing_if = "Option::is_none")]
    pub raw_event: Option<JsonValue>,
}

/// Text message start event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub role: String, // "assistant"
}

/// Text message content event with delta text
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub delta: String,
}

/// Text message end event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: String,
}

/// Text message chunk event (optional fields)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMessageChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}

/// Thinking text message start event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingTextMessageStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Thinking text message content event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingTextMessageContentEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub delta: String,
}

/// Thinking text message end event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingTextMessageEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// Tool call start event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    #[serde(rename = "toolCallName")]
    pub tool_call_name: String,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
}

/// Tool call arguments event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallArgsEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    pub delta: String,
}

/// Tool call end event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
}

/// Tool call result event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallResultEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>, // "tool"
}

/// Tool call chunk event (optional fields)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallChunkEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    #[serde(rename = "toolCallName", skip_serializing_if = "Option::is_none")]
    pub tool_call_name: Option<String>,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
}

/// Thinking start event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingStartEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Thinking end event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingEndEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
}

/// State snapshot event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateSnapshotEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub snapshot: JsonValue,
}

/// State delta event (JSON Patch RFC 6902)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateDeltaEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub delta: Vec<JsonValue>,
}

/// Messages snapshot event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessagesSnapshotEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub messages: Vec<Message>,
}

/// Raw event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub event: JsonValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Custom event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub name: String,
    pub value: JsonValue,
}

/// Run started event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunStartedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

/// Run finished event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunFinishedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JsonValue>,
}

/// Run error event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunErrorEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// Step started event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepStartedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "stepName")]
    pub step_name: String,
}

/// Step finished event
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepFinishedEvent {
    #[serde(flatten)]
    pub base: BaseEvent,
    #[serde(rename = "stepName")]
    pub step_name: String,
}

/// Union of all possible events
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Event {
    TextMessageStart(TextMessageStartEvent),
    TextMessageContent(TextMessageContentEvent),
    TextMessageEnd(TextMessageEndEvent),
    TextMessageChunk(TextMessageChunkEvent),
    ThinkingTextMessageStart(ThinkingTextMessageStartEvent),
    ThinkingTextMessageContent(ThinkingTextMessageContentEvent),
    ThinkingTextMessageEnd(ThinkingTextMessageEndEvent),
    ToolCallStart(ToolCallStartEvent),
    ToolCallArgs(ToolCallArgsEvent),
    ToolCallEnd(ToolCallEndEvent),
    ToolCallChunk(ToolCallChunkEvent),
    ToolCallResult(ToolCallResultEvent),
    ThinkingStart(ThinkingStartEvent),
    ThinkingEnd(ThinkingEndEvent),
    StateSnapshot(StateSnapshotEvent),
    StateDelta(StateDeltaEvent),
    MessagesSnapshot(MessagesSnapshotEvent),
    Raw(RawEvent),
    Custom(CustomEvent),
    RunStarted(RunStartedEvent),
    RunFinished(RunFinishedEvent),
    RunError(RunErrorEvent),
    StepStarted(StepStartedEvent),
    StepFinished(StepFinishedEvent),
}

impl Event {
    /// Get the event type
    pub fn event_type(&self) -> EventType {
        match self {
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
    pub fn timestamp(&self) -> Option<f64> {
        match self {
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

/// Validation error for events
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
        if self.delta.is_empty() {
            return Err(EventValidationError::EmptyDelta);
        }
        Ok(())
    }
}

/// Builder pattern for creating events
impl TextMessageStartEvent {
    pub fn new(message_id: String) -> Self {
        Self {
            base: BaseEvent {
                event_type: EventType::TextMessageStart,
                timestamp: None,
                raw_event: None,
            },
            message_id,
            role: "assistant".to_string(),
        }
    }

    pub fn with_timestamp(mut self, timestamp: f64) -> Self {
        self.base.timestamp = Some(timestamp);
        self
    }

    pub fn with_raw_event(mut self, raw_event: JsonValue) -> Self {
        self.base.raw_event = Some(raw_event);
        self
    }
}

impl TextMessageContentEvent {
    pub fn new(message_id: String, delta: String) -> Result<Self, EventValidationError> {
        let event = Self {
            base: BaseEvent {
                event_type: EventType::TextMessageContent,
                timestamp: None,
                raw_event: None,
            },
            message_id,
            delta,
        };
        event.validate()?;
        Ok(event)
    }

    pub fn with_timestamp(mut self, timestamp: f64) -> Self {
        self.base.timestamp = Some(timestamp);
        self
    }
}
