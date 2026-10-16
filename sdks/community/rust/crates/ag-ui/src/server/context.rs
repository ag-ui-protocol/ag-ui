//! What an agent is handed for one run.

use std::future::Future;

use crate::{
    Context, Event, Message, MessageId, ResumeEntry, RunAgentInput, RunId, StepName, SubagentRunId,
    SubagentStartedEvent, TextMessageRole, ThreadId, Tool, ToolCallId,
};
use futures_channel::mpsc;
use futures_util::future::{Either, select};
use serde_json::Value;

use crate::server::agent::AgentState;
use crate::server::cancel::{CancellationToken, Cancelled};
use crate::server::emit::{
    EventReceiver, EventSink, MessageHandle, ReasoningHandle, StepGuard, SubagentHandle,
    ToolCallHandle,
};
use crate::server::error::{Error, Result};
use crate::server::state::RunState;
use crate::server::transform::TransformerChain;

/// The request, the state, the event sink and the cancellation flag — one
/// run's whole world.
///
/// An agent gets `&mut RunContext<S>` and emits through it. Every emitter takes
/// `&mut self`, which is what makes two overlapping messages a borrow-check
/// error rather than a protocol violation discovered by a confused frontend.
///
/// ```
/// # use ag_ui::RunAgentInput;
/// # use ag_ui::server::RunContext;
/// # let (mut ctx, _events) = RunContext::<()>::new(RunAgentInput::new("thread-1", "run-1"))?;
/// assert_eq!(ctx.thread_id().as_str(), "thread-1");
/// assert!(ctx.messages().is_empty());
///
/// let mut message = ctx.assistant_message()?;
/// message.delta("Hello")?;
/// message.end()?;
/// # Ok::<(), ag_ui::server::Error>(())
/// ```
#[derive(Debug)]
pub struct RunContext<S> {
    input: RunAgentInput,
    state: RunState<S>,
    sink: EventSink,
    next_message: u64,
    next_tool_call: u64,
    next_subagent: u64,
}

impl<S: AgentState> RunContext<S> {
    /// Builds a context and the receiving half of its event stream.
    ///
    /// This is the harness for unit-testing an [`Agent`](crate::server::Agent) without
    /// the run driver: call the agent's body, then assert on
    /// [`EventReceiver::drain`]. Nothing emits `RUN_STARTED` here — that is the
    /// driver's job, and skipping it lets a test exercise one method in
    /// isolation.
    pub fn new(input: RunAgentInput) -> Result<(Self, EventReceiver)> {
        let (tx, rx) = mpsc::unbounded();
        let sink = EventSink::new(tx, TransformerChain::new(), CancellationToken::new());
        let state = decode_state(&input.state)?;
        Ok((Self::from_parts(input, state, sink), EventReceiver::new(rx)))
    }

    /// Assembles a context from an already-decoded state.
    ///
    /// The run driver decodes first so that a state that does not fit `S` is
    /// reported through the sink it still owns, as a `RUN_ERROR`.
    pub(crate) fn from_parts(input: RunAgentInput, state: S, sink: EventSink) -> Self {
        Self {
            input,
            state: RunState::new(state),
            sink,
            next_message: 0,
            next_tool_call: 0,
            next_subagent: 0,
        }
    }

    /// The typed state, as of the last publish.
    pub fn state(&self) -> &S {
        self.state.get()
    }

    /// The typed state, mutably. Nothing is emitted until you call
    /// [`publish_state`](Self::publish_state).
    pub fn state_mut(&mut self) -> &mut S {
        self.state.get_mut()
    }

    /// Replaces the state and publishes the change.
    ///
    /// The first publish of a run is a `STATE_SNAPSHOT`; later ones are a
    /// `STATE_DELTA` unless the patch would be no smaller than the snapshot.
    /// See [`StateManager`](crate::server::StateManager).
    pub fn set_state(&mut self, state: &S) -> Result<()> {
        self.state.replace(&mut self.sink, state)
    }

    /// Mutates the state in place and publishes the change.
    ///
    /// ```
    /// # use ag_ui::RunAgentInput;
    /// # use ag_ui::server::RunContext;
    /// # use serde::{Deserialize, Serialize};
    /// #[derive(Default, Serialize, Deserialize)]
    /// struct Draft { revision: u32 }
    ///
    /// # let (mut ctx, _events) = RunContext::<Draft>::new(RunAgentInput::new("t", "r"))?;
    /// ctx.update_state(|draft| draft.revision += 1)?;
    /// assert_eq!(ctx.state().revision, 1);
    /// # Ok::<(), ag_ui::server::Error>(())
    /// ```
    pub fn update_state(&mut self, update: impl FnOnce(&mut S)) -> Result<()> {
        update(self.state.get_mut());
        self.publish_state()
    }

    /// Publishes whatever [`state_mut`](Self::state_mut) left behind.
    ///
    /// A no-op when nothing changed since the last publish.
    pub fn publish_state(&mut self) -> Result<()> {
        self.state.publish(&mut self.sink)
    }
}

impl<S> RunContext<S> {
    /// The whole request, for anything the accessors do not cover.
    pub fn input(&self) -> &RunAgentInput {
        &self.input
    }

    /// The conversation this run belongs to.
    pub fn thread_id(&self) -> &ThreadId {
        &self.input.thread_id
    }

    /// This run's id.
    pub fn run_id(&self) -> &RunId {
        &self.input.run_id
    }

    /// The run that spawned this one, for nested agents.
    pub fn parent_run_id(&self) -> Option<&RunId> {
        self.input.parent_run_id.as_ref()
    }

    /// Conversation history, oldest first.
    pub fn messages(&self) -> &[Message] {
        &self.input.messages
    }

    /// What the user said last, as text.
    ///
    /// The turn an agent is almost always answering. Non-text parts of a
    /// multimodal message are dropped — see
    /// [`UserContent::to_text`](crate::message::UserContent::to_text); reach into
    /// [`RunContext::messages`] directly if the images matter.
    ///
    /// `None` when the history holds no user message at all, which is distinct
    /// from a user who sent an empty one.
    ///
    /// ```
    /// # use ag_ui::{RunAgentInput, Message};
    /// # use ag_ui::server::RunContext;
    /// let mut input = RunAgentInput::new("thread-1", "run-1");
    /// input.messages = vec![Message::user("msg-1", "add milk")];
    /// let (ctx, _events) = RunContext::<()>::new(input)?;
    ///
    /// assert_eq!(ctx.last_user_text().as_deref(), Some("add milk"));
    /// # Ok::<(), ag_ui::server::Error>(())
    /// ```
    pub fn last_user_text(&self) -> Option<String> {
        self.input
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                Message::User(user) => Some(user.content.to_text()),
                _ => None,
            })
    }

    /// Tools the client is offering for this run.
    pub fn tools(&self) -> &[Tool] {
        &self.input.tools
    }

    /// One offered tool by name.
    pub fn tool(&self, name: &str) -> Option<&Tool> {
        self.input.tools.iter().find(|tool| tool.name == name)
    }

    /// Ambient context entries.
    pub fn context(&self) -> &[Context] {
        &self.input.context
    }

    /// Arbitrary passthrough properties, opaque to the protocol.
    pub fn forwarded_props(&self) -> &Value {
        &self.input.forwarded_props
    }

    /// Answers to the interrupts a previous run paused on.
    ///
    /// Empty unless this request resumes a paused run.
    pub fn resume(&self) -> &[ResumeEntry] {
        self.input.resume.as_deref().unwrap_or_default()
    }

    /// The answer to one interrupt, by its [`Interrupt::id`].
    ///
    /// [`Interrupt::id`]: crate::outcome::Interrupt::id
    pub fn resume_for(&self, interrupt_id: &str) -> Option<&ResumeEntry> {
        self.resume()
            .iter()
            .find(|entry| entry.interrupt_id == interrupt_id)
    }

    /// Whether this request resumes a paused run.
    pub fn is_resume(&self) -> bool {
        self.input.is_resume()
    }

    /// Whether the run has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.sink.cancel_token().is_cancelled()
    }

    /// [`Error::Cancelled`] once the run is cancelled, for use with `?`.
    pub fn check_cancelled(&self) -> Result<()> {
        if self.is_cancelled() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }

    /// A handle a transport can trip on client disconnect.
    pub fn cancel_token(&self) -> CancellationToken {
        self.sink.cancel_token().clone()
    }

    /// Resolves once the run is cancelled.
    pub fn cancelled(&self) -> Cancelled {
        self.sink.cancel_token().cancelled()
    }

    /// Races `future` against cancellation, returning `None` if cancellation
    /// won.
    ///
    /// The way to make a long model call interruptible:
    ///
    /// ```
    /// # use ag_ui::RunAgentInput;
    /// # use ag_ui::server::{Error, RunContext};
    /// # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    /// # rt.block_on(async {
    /// # let (ctx, _events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
    /// let answer = ctx
    ///     .until_cancelled(async { "the model's reply" })
    ///     .await
    ///     .ok_or(Error::Cancelled)?;
    /// assert_eq!(answer, "the model's reply");
    /// # Ok::<(), Error>(())
    /// # })?;
    /// # Ok::<(), Error>(())
    /// ```
    /// Deliberately not an `async fn`: that would capture `&self` in the
    /// returned future, and a future holding a borrow of the run context is
    /// only `Send` if the context is `Sync` — which it is not, since a
    /// transformer only has to be `Send`.
    pub fn until_cancelled<F: Future>(&self, future: F) -> impl Future<Output = Option<F::Output>> {
        let cancelled = self.cancelled();
        async move {
            futures_util::pin_mut!(future, cancelled);
            match select(future, cancelled).await {
                Either::Left((output, _)) => Some(output),
                Either::Right(((), _)) => None,
            }
        }
    }

    /// Emits an event as-is — the escape hatch under the typed emitters.
    ///
    /// Everything the handles emit goes through here, so a raw event is
    /// transformed and verified like any other.
    pub fn emit(&mut self, event: Event) -> Result<()> {
        self.sink.emit(event)
    }

    /// A fresh message id, unique within the run.
    ///
    /// Derived from the run id and a counter rather than a UUID: the protocol
    /// asks for opaque strings, this crate takes no `uuid` dependency, and a
    /// deterministic id makes a recorded stream diffable. Pass your own id to
    /// [`message_with_id`](Self::message_with_id) when you need one.
    pub fn new_message_id(&mut self) -> MessageId {
        self.next_message += 1;
        MessageId::new(format!("{}-msg-{}", self.id_prefix(), self.next_message))
    }

    /// A fresh tool call id, unique within the run.
    pub fn new_tool_call_id(&mut self) -> ToolCallId {
        self.next_tool_call += 1;
        ToolCallId::new(format!("{}-call-{}", self.id_prefix(), self.next_tool_call))
    }

    /// A fresh subagent invocation id, unique within the run.
    ///
    /// Derived like the others, from the run id and a counter — so, like
    /// message ids, it is unique across runs only while run ids are. A
    /// resuming run that continues a *suspended* subagent should reuse the
    /// suspended id instead — see [`subagent_with`](Self::subagent_with).
    pub fn new_subagent_run_id(&mut self) -> SubagentRunId {
        self.next_subagent += 1;
        SubagentRunId::new(format!("{}-sub-{}", self.id_prefix(), self.next_subagent))
    }

    /// The subagent everything emitted right now is attributed to — `None`
    /// outside any [`subagent`](Self::subagent) scope.
    pub fn subagent_run_id(&self) -> Option<&SubagentRunId> {
        self.sink.attribution()
    }

    /// Replaces the attribution scope and returns the previous one. Only the
    /// subagent handle calls this, on the way in and on the way out.
    pub(crate) fn set_attribution(
        &mut self,
        attribution: Option<SubagentRunId>,
    ) -> Option<SubagentRunId> {
        self.sink.set_attribution(attribution)
    }

    /// Announces a subagent under a fresh id and scopes everything emitted
    /// through the returned handle to it. Call `finish`, `fail` or `suspend`
    /// explicitly; dropping the handle only restores the parent's attribution.
    ///
    /// `name` is the subagent's reusable type or name, for display; the id is
    /// this invocation's alone. See [`SubagentHandle`].
    pub fn subagent(&mut self, name: impl Into<String>) -> Result<SubagentHandle<'_, S>> {
        self.subagent_events(name)
    }

    /// Opens an event scope for work executed by the application or framework.
    ///
    /// Announces the invocation and attributes output to it. It does not create,
    /// schedule or execute an agent. Explicitly finish, fail or suspend the
    /// returned handle; a dropped handle never assumes success.
    pub fn subagent_events(&mut self, name: impl Into<String>) -> Result<SubagentHandle<'_, S>> {
        let id = self.new_subagent_run_id();
        self.subagent_with(SubagentStartedEvent::new(id, name))
    }

    /// The same, from an announcement you built — for a description, an
    /// explicit id, or the agents-as-tools links.
    ///
    /// A `parent_subagent_run_id` left absent is filled from the enclosing
    /// scope, so nesting needs no help. An explicit id is how a resuming run
    /// continues a subagent that suspended: announce the id the suspended
    /// invocation had, and a client transitions its group from waiting back
    /// to running rather than drawing a second one.
    ///
    /// ```
    /// # use ag_ui::{Event, EventType, RunAgentInput, SubagentStartedEvent};
    /// # use ag_ui::server::RunContext;
    /// # let (mut ctx, mut events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
    /// let mut call = ctx.tool_call("task")?;
    /// call.args(r#"{"brief":"find sources"}"#)?;
    /// let (call_id, result_id) = (call.id().clone(), call.result_message_id().clone());
    /// call.end()?;                                   // the client sees the call close…
    ///
    /// let announce = SubagentStartedEvent::new("researcher-7", "researcher")
    ///     .with_parent_tool_call(call_id.clone());
    /// let mut researcher = ctx.subagent_with(announce)?;
    /// researcher.say("Three sources found.")?;       // …then the subagent it spawned…
    /// researcher.finish()?;
    ///
    /// ctx.emit(Event::tool_call_result(result_id, call_id, "3 sources"))?;  // …then its result
    /// let types: Vec<_> = events.drain().iter().map(Event::event_type).collect();
    /// assert_eq!(types[3], EventType::SubagentStarted);
    /// assert_eq!(types[7], EventType::SubagentFinished);
    /// assert_eq!(types[8], EventType::ToolCallResult);
    /// # Ok::<(), ag_ui::server::Error>(())
    /// ```
    pub fn subagent_with(
        &mut self,
        started: SubagentStartedEvent,
    ) -> Result<SubagentHandle<'_, S>> {
        SubagentHandle::start(self, started)
    }

    fn id_prefix(&self) -> &str {
        if self.input.run_id.is_empty() {
            "run"
        } else {
            self.input.run_id.as_str()
        }
    }

    /// Opens an assistant message under a fresh id — `TEXT_MESSAGE_START`.
    pub fn assistant_message(&mut self) -> Result<MessageHandle<'_, S>> {
        self.message(TextMessageRole::Assistant)
    }

    /// Opens a message with the given role under a fresh id.
    pub fn message(&mut self, role: TextMessageRole) -> Result<MessageHandle<'_, S>> {
        let id = self.new_message_id();
        self.message_with_id(id, role)
    }

    /// Opens a message under an id you choose.
    pub fn message_with_id(
        &mut self,
        id: impl Into<MessageId>,
        role: TextMessageRole,
    ) -> Result<MessageHandle<'_, S>> {
        // Two disjoint field borrows, not a borrow of the context: the handle
        // reaches the state without being able to open a second block.
        MessageHandle::start(&mut self.sink, &mut self.state, id.into(), role)
    }

    /// Emits a whole assistant message — start, content, end — and returns its
    /// id.
    pub fn say(&mut self, text: impl Into<String>) -> Result<MessageId> {
        let mut message = self.message(TextMessageRole::Assistant)?;
        message.delta(text)?;
        let id = message.id().clone();
        message.end()?;
        Ok(id)
    }

    /// Opens a reasoning block under a fresh id — `REASONING_START`.
    pub fn reasoning(&mut self) -> Result<ReasoningHandle<'_, S>> {
        let id = self.new_message_id();
        self.reasoning_with_id(id)
    }

    /// Opens a reasoning block under an id you choose.
    pub fn reasoning_with_id(
        &mut self,
        id: impl Into<MessageId>,
    ) -> Result<ReasoningHandle<'_, S>> {
        ReasoningHandle::start(&mut self.sink, &mut self.state, id.into())
    }

    /// Emits a whole reasoning block in one call and returns its id.
    pub fn think(&mut self, text: impl Into<String>) -> Result<MessageId> {
        let mut reasoning = self.reasoning()?;
        reasoning.delta(text)?;
        let id = reasoning.id().clone();
        reasoning.end()?;
        Ok(id)
    }

    /// Opens a call to `name` under a fresh id — `TOOL_CALL_START`.
    pub fn tool_call(&mut self, name: &str) -> Result<ToolCallHandle<'_, S>> {
        let id = self.new_tool_call_id();
        self.tool_call_with_id(id, name)
    }

    /// Opens a call to `name` under an id you choose.
    pub fn tool_call_with_id(
        &mut self,
        id: impl Into<ToolCallId>,
        name: &str,
    ) -> Result<ToolCallHandle<'_, S>> {
        let id = id.into();
        let result_message_id = self.new_message_id();
        ToolCallHandle::start(
            &mut self.sink,
            &mut self.state,
            id,
            name,
            None,
            result_message_id,
        )
    }

    /// Opens a named step — `STEP_STARTED`.
    ///
    /// The returned guard dereferences to this context, and emits
    /// `STEP_FINISHED` when it drops.
    pub fn step(&mut self, name: impl Into<StepName>) -> Result<StepGuard<'_, S>> {
        StepGuard::start(self, name.into())
    }

    /// Whether a terminal event has already gone out.
    pub(crate) fn is_terminated(&self) -> bool {
        self.sink.is_terminated()
    }

    /// Recovers the sink so the run driver can emit the terminal event through
    /// the same transformers and the same verifier the agent used.
    pub(crate) fn into_sink(self) -> EventSink {
        self.sink
    }
}

/// Reads `RunAgentInput::state` as `S`.
///
/// An absent state — JSON `null`, or the empty object clients send for "no
/// state yet" — becomes `S::default()` rather than a deserialization error, so
/// a stateless agent (`State = ()`) works against every client.
pub(crate) fn decode_state<S: AgentState>(value: &Value) -> Result<S> {
    let empty = value.is_null() || value.as_object().is_some_and(serde_json::Map::is_empty);
    if empty {
        return Ok(S::default());
    }
    Ok(serde_json::from_value(value.clone())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Counter {
        clicks: u32,
    }

    fn context<S: AgentState>(input: RunAgentInput) -> (RunContext<S>, EventReceiver) {
        RunContext::new(input).expect("state should decode")
    }

    #[test]
    fn ids_are_derived_from_the_run_id() {
        let (mut ctx, _events) = context::<()>(RunAgentInput::new("t", "run-7"));
        assert_eq!(ctx.new_message_id().as_str(), "run-7-msg-1");
        assert_eq!(ctx.new_message_id().as_str(), "run-7-msg-2");
        assert_eq!(ctx.new_tool_call_id().as_str(), "run-7-call-1");
    }

    #[test]
    fn the_last_user_turn_is_the_one_returned_and_absence_is_not_emptiness() {
        let (ctx, _events) = context::<()>(RunAgentInput::new("t", "r"));
        assert_eq!(ctx.last_user_text(), None, "no user message is not \"\"");

        let mut input = RunAgentInput::new("t", "r");
        input.messages = vec![
            Message::user("m-1", "add milk"),
            Message::assistant("m-2", "milk it is"),
            Message::user("m-3", "and bread"),
        ];
        let (ctx, _events) = context::<()>(input);
        assert_eq!(ctx.last_user_text().as_deref(), Some("and bread"));
    }

    #[test]
    fn an_empty_state_object_decodes_to_the_default() {
        let mut input = RunAgentInput::new("t", "r");
        input.state = json!({});
        let (ctx, _events) = context::<Counter>(input);
        assert_eq!(ctx.state(), &Counter::default());
    }

    #[test]
    fn typed_state_comes_from_the_input() {
        let mut input = RunAgentInput::new("t", "r");
        input.state = json!({"clicks": 3});
        let (ctx, _events) = context::<Counter>(input);
        assert_eq!(ctx.state().clicks, 3);
    }

    #[test]
    fn a_state_that_does_not_fit_is_an_error() {
        let mut input = RunAgentInput::new("t", "r");
        input.state = json!({"clicks": "three"});
        let error = RunContext::<Counter>::new(input).expect_err("should not decode");
        assert!(matches!(error, Error::Json(_)), "{error}");
    }

    #[test]
    fn resume_entries_are_addressable_by_interrupt_id() {
        let mut input = RunAgentInput::new("t", "r");
        input.resume = Some(vec![ResumeEntry::resolved("i-1", json!(true))]);
        let (ctx, _events) = context::<()>(input);
        assert!(ctx.is_resume());
        assert_eq!(ctx.resume().len(), 1);
        assert!(ctx.resume_for("i-1").is_some());
        assert!(ctx.resume_for("i-2").is_none());
    }

    #[test]
    fn a_cancelled_run_fails_every_emit() {
        let (mut ctx, _events) = context::<()>(RunAgentInput::new("t", "r"));
        ctx.cancel_token().cancel();
        assert!(ctx.is_cancelled());
        let error = ctx.say("too late").expect_err("emit should fail");
        assert!(error.is_cancelled(), "{error}");
    }

    #[test]
    fn a_dropped_receiver_disconnects_the_run() {
        let (mut ctx, events) = context::<()>(RunAgentInput::new("t", "r"));
        drop(events);
        let error = ctx.say("nobody home").expect_err("emit should fail");
        assert!(error.is_disconnected(), "{error}");
    }
}
