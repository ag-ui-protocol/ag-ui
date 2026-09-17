//! Streaming one tool call.

use crate::{Event, MessageId, ReasoningEncryptedValueSubtype, ToolCallId};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::server::agent::AgentState;
use crate::server::emit::EventSink;
use crate::server::error::Result;
use crate::server::state::RunState;

/// One open tool call.
///
/// Created by [`RunContext::tool_call`](crate::server::RunContext::tool_call).
/// `TOOL_CALL_START` has already gone out; `Drop` emits `TOOL_CALL_END`.
///
/// Arguments stream as text because providers stream them as text — a partial
/// delta is usually not valid JSON. The handle keeps what it emitted, so
/// [`parse_args`](Self::parse_args) can hand you the finished struct to execute
/// against:
///
/// ```
/// # use ag_ui::RunAgentInput;
/// # use ag_ui::server::RunContext;
/// # use serde::Deserialize;
/// #[derive(Deserialize)]
/// struct Query { city: String }
///
/// # let (mut ctx, _events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
/// let mut call = ctx.tool_call("get_weather")?;
/// call.args(r#"{"city":"#)?;          // as the provider streams them
/// call.args(r#""Seoul"}"#)?;
/// let query: Query = call.parse_args()?;
/// assert_eq!(query.city, "Seoul");
/// call.result(r#"{"tempC":21}"#)?;    // emits TOOL_CALL_END then TOOL_CALL_RESULT
/// # Ok::<(), ag_ui::server::Error>(())
/// ```
///
/// # Doing the work while the call is open
///
/// The handle borrows the run's event sink and its state, not the run context,
/// so the tool's own work belongs *between* the arguments and the result. The
/// protocol treats the `STATE_*` family as unordered, so a publish inside the
/// brackets is a legal stream — and the one that lets a client watch the call
/// land instead of seeing it land already done:
///
/// ```
/// # use ag_ui::RunAgentInput;
/// # use ag_ui::server::RunContext;
/// # use serde::{Deserialize, Serialize};
/// # use serde_json::json;
/// #[derive(Default, Serialize, Deserialize)]
/// struct Board { tasks: Vec<String> }
///
/// # let (mut ctx, _events) = RunContext::<Board>::new(RunAgentInput::new("t", "r"))?;
/// let mut call = ctx.tool_call("add_task")?;
/// call.args_json(&json!({"title": "ship it"}))?;
///
/// call.state_mut().tasks.push("ship it".to_owned());
/// call.publish_state()?;               // STATE_SNAPSHOT, with the call open
///
/// call.result_json(&json!({"ok": true}))?;
/// assert_eq!(ctx.state().tasks, ["ship it"]);
/// # Ok::<(), ag_ui::server::Error>(())
/// ```
///
/// What the handle still cannot do is open a second message, reasoning block or
/// tool call: it holds no run context to open one with, and the context it came
/// from stays borrowed until it drops.
#[derive(Debug)]
pub struct ToolCallHandle<'a, S> {
    sink: &'a mut EventSink,
    state: &'a mut RunState<S>,
    id: ToolCallId,
    result_message_id: MessageId,
    args: String,
    ended: bool,
}

impl<'a, S> ToolCallHandle<'a, S> {
    /// Emits `TOOL_CALL_START`.
    ///
    /// `result_message_id` is allocated up front so the handle can emit
    /// `TOOL_CALL_RESULT` without reaching back into the run context — which is
    /// what keeps a second overlapping handle a borrow-check error.
    pub(crate) fn start(
        sink: &'a mut EventSink,
        state: &'a mut RunState<S>,
        id: ToolCallId,
        name: &str,
        parent_message_id: Option<MessageId>,
        result_message_id: MessageId,
    ) -> Result<Self> {
        let mut start = crate::ToolCallStartEvent::new(id.clone(), name);
        start.parent_message_id = parent_message_id;
        sink.emit(start.into())?;
        Ok(Self {
            sink,
            state,
            id,
            result_message_id,
            args: String::new(),
            ended: false,
        })
    }

    /// The id every event of this call carries.
    pub fn id(&self) -> &ToolCallId {
        &self.id
    }

    /// The id the result message will carry.
    pub fn result_message_id(&self) -> &MessageId {
        &self.result_message_id
    }

    /// Appends a fragment of the argument JSON — `TOOL_CALL_ARGS`.
    pub fn args(&mut self, delta: impl AsRef<str>) -> Result<()> {
        let delta = delta.as_ref();
        self.args.push_str(delta);
        self.sink
            .emit(Event::tool_call_args(self.id.clone(), delta))
    }

    /// Serializes `value` and emits it as the call's arguments in one delta.
    pub fn args_json<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<()> {
        self.args(serde_json::to_string(value)?)
    }

    /// The argument JSON emitted so far, unparsed.
    pub fn raw_args(&self) -> &str {
        &self.args
    }

    /// Parses everything emitted through [`args`](Self::args) into `T`.
    ///
    /// Fails while the arguments are still partial, which is the point: call it
    /// once the provider has finished streaming them.
    pub fn parse_args<T: DeserializeOwned>(&self) -> Result<T> {
        Ok(serde_json::from_str(&self.args)?)
    }

    /// Attaches the provider's opaque reasoning signature for this call —
    /// `REASONING_ENCRYPTED_VALUE`.
    pub fn encrypted_value(&mut self, value: impl Into<String>) -> Result<()> {
        self.sink.emit(Event::reasoning_encrypted_value(
            ReasoningEncryptedValueSubtype::ToolCall,
            self.id.clone(),
            value,
        ))
    }

    /// Emits an unrelated event without closing the call. See
    /// [`MessageHandle::emit`](crate::server::MessageHandle::emit).
    pub fn emit(&mut self, event: Event) -> Result<()> {
        self.sink.emit(event)
    }

    /// Emits `TOOL_CALL_END` and consumes the handle, leaving the call
    /// unanswered.
    ///
    /// Use it when the client executes the tool — a front-end tool's result
    /// arrives as a message on the next request, not from here.
    pub fn end(mut self) -> Result<()> {
        self.ended = true;
        self.sink.emit(Event::tool_call_end(self.id.clone()))
    }

    /// Emits `TOOL_CALL_END` then `TOOL_CALL_RESULT`, and consumes the handle.
    ///
    /// Returns the id of the tool message carrying the result.
    pub fn result(mut self, content: impl Into<String>) -> Result<MessageId> {
        self.ended = true;
        self.sink.emit(Event::tool_call_end(self.id.clone()))?;
        let mut result = crate::ToolCallResultEvent::new(
            self.result_message_id.clone(),
            self.id.clone(),
            content,
        );
        result.role = Some(crate::ToolResultRole::Tool);
        self.sink.emit(result.into())?;
        Ok(self.result_message_id.clone())
    }

    /// Serializes `value` and reports it as the call's result.
    pub fn result_json<T: Serialize + ?Sized>(self, value: &T) -> Result<MessageId> {
        let content = serde_json::to_string(value)?;
        self.result(content)
    }
}

/// The run's state, reachable while the call is open. Same three methods as on
/// [`RunContext`](crate::server::RunContext), forwarded — a tool that changes the state
/// is the ordinary case, and it changes it in the middle of the call.
impl<S: AgentState> ToolCallHandle<'_, S> {
    /// The typed state, as of the last publish.
    pub fn state(&self) -> &S {
        self.state.get()
    }

    /// The typed state, mutably. Nothing is emitted until you call
    /// [`publish_state`](Self::publish_state).
    pub fn state_mut(&mut self) -> &mut S {
        self.state.get_mut()
    }

    /// Publishes whatever [`state_mut`](Self::state_mut) left behind, as a
    /// `STATE_SNAPSHOT` or a `STATE_DELTA` between this call's `TOOL_CALL_START`
    /// and its `TOOL_CALL_END`.
    ///
    /// A no-op when nothing changed since the last publish.
    pub fn publish_state(&mut self) -> Result<()> {
        self.state.publish(self.sink)
    }
}

impl<S> Drop for ToolCallHandle<'_, S> {
    fn drop(&mut self) {
        if !self.ended {
            let _ = self.sink.emit(Event::tool_call_end(self.id.clone()));
        }
    }
}
