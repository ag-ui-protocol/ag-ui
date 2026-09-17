//! Ergonomic constructors for every event type.
//!
//! These mirror the `create*Event` helpers in the TypeScript SDK: each takes
//! the fields the schema requires and leaves the optional ones unset. Anything
//! optional is set afterwards, either on the payload struct or through
//! [`Event::with_timestamp`] and [`Event::with_raw_event`].
//!
//! ```
//! # use ag_ui::{Event, RunOutcome, Interrupt};
//! let paused = Event::run_finished_interrupt(
//!     "thread-1",
//!     "run-1",
//!     vec![Interrupt::new("i-1", "tool_approval")],
//! )
//! .with_timestamp(1_700_000_000_000);
//! ```

use serde_json::Value;

use crate::JsonObject;
use crate::event::Event;
use crate::event::activity::{ActivityDeltaEvent, ActivitySnapshotEvent};
use crate::event::lifecycle::{
    RunErrorEvent, RunFinishedEvent, RunStartedEvent, StepFinishedEvent, StepStartedEvent,
};
use crate::event::reasoning::{
    ReasoningEncryptedValueEvent, ReasoningEncryptedValueSubtype, ReasoningEndEvent,
    ReasoningMessageChunkEvent, ReasoningMessageContentEvent, ReasoningMessageEndEvent,
    ReasoningMessageStartEvent, ReasoningStartEvent, ThinkingEndEvent, ThinkingStartEvent,
    ThinkingTextMessageContentEvent, ThinkingTextMessageEndEvent, ThinkingTextMessageStartEvent,
};
use crate::event::special::{CustomEvent, RawEvent};
use crate::event::state::{MessagesSnapshotEvent, StateDeltaEvent, StateSnapshotEvent};
use crate::event::subagent::{
    SubagentErrorEvent, SubagentFinishedEvent, SubagentOutcome, SubagentStartedEvent,
};
use crate::event::text::{
    TextMessageChunkEvent, TextMessageContentEvent, TextMessageEndEvent, TextMessageRole,
    TextMessageStartEvent,
};
use crate::event::tool::{
    ToolCallArgsEvent, ToolCallChunkEvent, ToolCallEndEvent, ToolCallResultEvent,
    ToolCallStartEvent,
};
use crate::ids::{MessageId, RunId, StepName, SubagentRunId, ThreadId, ToolCallId};
use crate::message::Message;
use crate::outcome::{Interrupt, RunOutcome};
use crate::patch::PatchOperation;

impl Event {
    /// `TEXT_MESSAGE_START` — opens a text message.
    pub fn text_message_start(message_id: impl Into<MessageId>, role: TextMessageRole) -> Self {
        TextMessageStartEvent::new(message_id, role).into()
    }

    /// `TEXT_MESSAGE_CONTENT` — appends text to an open message.
    pub fn text_message_content(
        message_id: impl Into<MessageId>,
        delta: impl Into<String>,
    ) -> Self {
        TextMessageContentEvent::new(message_id, delta).into()
    }

    /// `TEXT_MESSAGE_END` — closes a text message.
    pub fn text_message_end(message_id: impl Into<MessageId>) -> Self {
        TextMessageEndEvent::new(message_id).into()
    }

    /// `TEXT_MESSAGE_CHUNK` — a whole text update in one event.
    pub fn text_message_chunk(message_id: Option<MessageId>, delta: Option<String>) -> Self {
        TextMessageChunkEvent::new(message_id, delta).into()
    }

    /// `TOOL_CALL_START` — opens a tool call.
    pub fn tool_call_start(
        tool_call_id: impl Into<ToolCallId>,
        tool_call_name: impl Into<String>,
    ) -> Self {
        ToolCallStartEvent::new(tool_call_id, tool_call_name).into()
    }

    /// `TOOL_CALL_ARGS` — appends argument JSON to an open call.
    pub fn tool_call_args(tool_call_id: impl Into<ToolCallId>, delta: impl Into<String>) -> Self {
        ToolCallArgsEvent::new(tool_call_id, delta).into()
    }

    /// `TOOL_CALL_END` — closes a tool call.
    pub fn tool_call_end(tool_call_id: impl Into<ToolCallId>) -> Self {
        ToolCallEndEvent::new(tool_call_id).into()
    }

    /// `TOOL_CALL_CHUNK` — a whole tool call in one event.
    pub fn tool_call_chunk(
        tool_call_id: Option<ToolCallId>,
        tool_call_name: Option<String>,
        delta: Option<String>,
    ) -> Self {
        ToolCallChunkEvent::new(tool_call_id, tool_call_name, delta).into()
    }

    /// `TOOL_CALL_RESULT` — reports what a tool returned.
    pub fn tool_call_result(
        message_id: impl Into<MessageId>,
        tool_call_id: impl Into<ToolCallId>,
        content: impl Into<String>,
    ) -> Self {
        ToolCallResultEvent::new(message_id, tool_call_id, content).into()
    }

    /// `THINKING_START` — opens a thinking block.
    #[deprecated(note = "use Event::reasoning_start")]
    pub fn thinking_start(title: Option<String>) -> Self {
        ThinkingStartEvent::new(title).into()
    }

    /// `THINKING_END` — closes a thinking block.
    #[deprecated(note = "use Event::reasoning_end")]
    pub fn thinking_end() -> Self {
        ThinkingEndEvent::default().into()
    }

    /// `THINKING_TEXT_MESSAGE_START` — opens a thinking message.
    #[deprecated(note = "use Event::reasoning_message_start")]
    pub fn thinking_text_message_start() -> Self {
        ThinkingTextMessageStartEvent::default().into()
    }

    /// `THINKING_TEXT_MESSAGE_CONTENT` — appends thinking text.
    #[deprecated(note = "use Event::reasoning_message_content")]
    pub fn thinking_text_message_content(delta: impl Into<String>) -> Self {
        ThinkingTextMessageContentEvent::new(delta).into()
    }

    /// `THINKING_TEXT_MESSAGE_END` — closes a thinking message.
    #[deprecated(note = "use Event::reasoning_message_end")]
    pub fn thinking_text_message_end() -> Self {
        ThinkingTextMessageEndEvent::default().into()
    }

    /// `STATE_SNAPSHOT` — replaces the shared state.
    pub fn state_snapshot(snapshot: impl Into<Value>) -> Self {
        StateSnapshotEvent::new(snapshot).into()
    }

    /// `STATE_DELTA` — patches the shared state.
    pub fn state_delta(delta: impl Into<Vec<PatchOperation>>) -> Self {
        StateDeltaEvent::new(delta).into()
    }

    /// `MESSAGES_SNAPSHOT` — replaces the message history.
    pub fn messages_snapshot(messages: impl Into<Vec<Message>>) -> Self {
        MessagesSnapshotEvent::new(messages).into()
    }

    /// `ACTIVITY_SNAPSHOT` — publishes an activity payload.
    pub fn activity_snapshot(
        message_id: impl Into<MessageId>,
        activity_type: impl Into<String>,
        content: JsonObject,
    ) -> Self {
        ActivitySnapshotEvent::new(message_id, activity_type, content).into()
    }

    /// `ACTIVITY_DELTA` — patches an activity payload.
    pub fn activity_delta(
        message_id: impl Into<MessageId>,
        activity_type: impl Into<String>,
        patch: impl Into<Vec<PatchOperation>>,
    ) -> Self {
        ActivityDeltaEvent::new(message_id, activity_type, patch).into()
    }

    /// `RAW` — forwards a provider event verbatim.
    pub fn raw(event: impl Into<Value>) -> Self {
        RawEvent::new(event).into()
    }

    /// `CUSTOM` — an application-defined event.
    pub fn custom(name: impl Into<String>, value: impl Into<Value>) -> Self {
        CustomEvent::new(name, value).into()
    }

    /// `RUN_STARTED` — starts a run.
    pub fn run_started(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        RunStartedEvent::new(thread_id, run_id).into()
    }

    /// `RUN_FINISHED` without an outcome — the legacy shape, which consumers
    /// read as success.
    pub fn run_finished(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        RunFinishedEvent::new(thread_id, run_id).into()
    }

    /// `RUN_FINISHED` with an explicit success outcome.
    pub fn run_finished_success(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        RunFinishedEvent::new(thread_id, run_id)
            .with_outcome(RunOutcome::Success)
            .into()
    }

    /// `RUN_FINISHED` with an interrupt outcome — the run is paused until the
    /// client answers.
    pub fn run_finished_interrupt(
        thread_id: impl Into<ThreadId>,
        run_id: impl Into<RunId>,
        interrupts: impl Into<Vec<Interrupt>>,
    ) -> Self {
        RunFinishedEvent::new(thread_id, run_id)
            .with_outcome(RunOutcome::interrupt(interrupts))
            .into()
    }

    /// `RUN_ERROR` — fails the run.
    pub fn run_error(message: impl Into<String>) -> Self {
        RunErrorEvent::new(message).into()
    }

    /// `STEP_STARTED` — opens a named step.
    pub fn step_started(step_name: impl Into<StepName>) -> Self {
        StepStartedEvent::new(step_name).into()
    }

    /// `STEP_FINISHED` — closes a named step.
    pub fn step_finished(step_name: impl Into<StepName>) -> Self {
        StepFinishedEvent::new(step_name).into()
    }

    /// `REASONING_START` — opens a reasoning block.
    pub fn reasoning_start(message_id: impl Into<MessageId>) -> Self {
        ReasoningStartEvent::new(message_id).into()
    }

    /// `REASONING_MESSAGE_START` — opens a reasoning message.
    pub fn reasoning_message_start(message_id: impl Into<MessageId>) -> Self {
        ReasoningMessageStartEvent::new(message_id).into()
    }

    /// `REASONING_MESSAGE_CONTENT` — appends reasoning text.
    pub fn reasoning_message_content(
        message_id: impl Into<MessageId>,
        delta: impl Into<String>,
    ) -> Self {
        ReasoningMessageContentEvent::new(message_id, delta).into()
    }

    /// `REASONING_MESSAGE_END` — closes a reasoning message.
    pub fn reasoning_message_end(message_id: impl Into<MessageId>) -> Self {
        ReasoningMessageEndEvent::new(message_id).into()
    }

    /// `REASONING_MESSAGE_CHUNK` — a whole reasoning update in one event.
    pub fn reasoning_message_chunk(message_id: Option<MessageId>, delta: Option<String>) -> Self {
        ReasoningMessageChunkEvent::new(message_id, delta).into()
    }

    /// `REASONING_END` — closes a reasoning block.
    pub fn reasoning_end(message_id: impl Into<MessageId>) -> Self {
        ReasoningEndEvent::new(message_id).into()
    }

    /// `REASONING_ENCRYPTED_VALUE` — carries an opaque reasoning blob.
    pub fn reasoning_encrypted_value(
        subtype: ReasoningEncryptedValueSubtype,
        entity_id: impl Into<String>,
        encrypted_value: impl Into<String>,
    ) -> Self {
        ReasoningEncryptedValueEvent::new(subtype, entity_id, encrypted_value).into()
    }

    /// `SUBAGENT_STARTED` — announces a subagent invocation.
    pub fn subagent_started(
        subagent_run_id: impl Into<SubagentRunId>,
        name: impl Into<String>,
    ) -> Self {
        SubagentStartedEvent::new(subagent_run_id, name).into()
    }

    /// `SUBAGENT_FINISHED` without an outcome — the legacy shape, which
    /// consumers read as success.
    pub fn subagent_finished(subagent_run_id: impl Into<SubagentRunId>) -> Self {
        SubagentFinishedEvent::new(subagent_run_id).into()
    }

    /// `SUBAGENT_FINISHED` with an explicit success outcome.
    pub fn subagent_finished_success(subagent_run_id: impl Into<SubagentRunId>) -> Self {
        SubagentFinishedEvent::new(subagent_run_id)
            .with_outcome(SubagentOutcome::Success)
            .into()
    }

    /// `SUBAGENT_FINISHED` with a suspended outcome — the subagent is waiting
    /// on the named interrupts.
    pub fn subagent_finished_suspended(
        subagent_run_id: impl Into<SubagentRunId>,
        interrupt_ids: impl Into<Vec<String>>,
    ) -> Self {
        SubagentFinishedEvent::new(subagent_run_id)
            .with_outcome(SubagentOutcome::suspended(interrupt_ids))
            .into()
    }

    /// `SUBAGENT_ERROR` — fails a subagent invocation.
    pub fn subagent_error(
        subagent_run_id: impl Into<SubagentRunId>,
        message: impl Into<String>,
    ) -> Self {
        SubagentErrorEvent::new(subagent_run_id, message).into()
    }
}
