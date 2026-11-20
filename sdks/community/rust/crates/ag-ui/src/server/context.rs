//! What an agent is handed for one run.

use std::collections::HashSet;
use std::future::Future;

use crate::{
    Context, Event, Message, MessageId, ResumeEntry, RunAgentInput, RunId, StepName, SubagentRunId,
    SubagentStartedEvent, TextMessageRole, ThreadId, TokenUsage, Tool, ToolCallId,
    ToolCallStartEvent,
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
    minted: Minted,
    terminal: Terminal,
}

/// How many ids of each kind a run's contexts have handed out.
///
/// An id is the run id and a counter, so a context that continues a run
/// counts on from where the earlier one stopped. A message id handed out
/// twice does not start a second message: it re-opens the first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Minted {
    messages: IdCounter,
    tool_calls: IdCounter,
    subagents: IdCounter,
}

/// The counter behind the ids of one kind.
///
/// The numbers a run already uses are not this crate's to choose. An id of
/// the shape a context hands out can come from a request, which a run
/// echoes, or from an agent that names its own ids. So the counter trusts
/// none of them to be small: it never overflows, and it never hands out a
/// number that was noted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct IdCounter {
    /// The last number handed out, or the highest that was noted.
    last: u64,
    /// Every number that was noted. Empty unless the context continues a
    /// run: nothing is noted for a run that starts here.
    taken: HashSet<u64>,
}

impl IdCounter {
    /// Records a number an id of the run already carries.
    fn note(&mut self, number: u64) {
        self.taken.insert(number);
        self.last = self.last.max(number);
    }

    /// The next number: one more than the last, and past every number that
    /// was noted.
    ///
    /// A noted number can be the largest there is. The count then starts
    /// again from 1 and passes over what was noted, where adding one more
    /// would overflow, and saturating would hand the same number out twice.
    /// The noted numbers are fewer than there are numbers, so there is
    /// always a next one.
    fn next(&mut self) -> u64 {
        loop {
            self.last = self.last.checked_add(1).unwrap_or(1);
            if !self.taken.contains(&self.last) {
                return self.last;
            }
        }
    }
}

impl Minted {
    /// Notes the ids `event` introduces, where they have the shape a context
    /// of the run `run_id` hands out, so that the context counts on past them.
    pub(crate) fn note(&mut self, run_id: &RunId, event: &Event) {
        let prefix = id_prefix(run_id);
        let past = |counter: &mut IdCounter, kind: &str, id: &str| {
            let number = id
                .strip_prefix(prefix)
                .and_then(|rest| rest.strip_prefix(kind))
                .and_then(|number| number.parse::<u64>().ok());
            if let Some(number) = number {
                counter.note(number);
            }
        };
        // Attribution needs no `SUBAGENT_STARTED`, so a subagent id is in
        // use wherever something is attributed to it.
        if let Some(id) = event.subagent_run_id() {
            past(&mut self.subagents, SUBAGENT_ID, id);
        }
        let mut message = |id: &MessageId| past(&mut self.messages, MESSAGE_ID, id);
        let mut call = |id: &ToolCallId| past(&mut self.tool_calls, TOOL_CALL_ID, id);
        let mut subagent = |id: &SubagentRunId| past(&mut self.subagents, SUBAGENT_ID, id);
        // A restated conversation uses the ids of its messages, of the calls
        // they carry and of the subagents they are attributed to, whether or
        // not an event of this run introduced them.
        let mut replayed = |messages: &[Message]| {
            for replayed in messages {
                message(replayed.id());
                replayed
                    .subagent_run_id()
                    .into_iter()
                    .for_each(&mut subagent);
                if let Message::Assistant(assistant) = replayed {
                    let calls = assistant.tool_calls.iter().flatten();
                    calls.for_each(|carried| call(&carried.id));
                }
            }
        };
        match event {
            Event::TextMessageStart(e) => message(&e.message_id),
            Event::ReasoningStart(e) => message(&e.message_id),
            Event::ReasoningMessageStart(e) => message(&e.message_id),
            Event::ActivitySnapshot(e) => message(&e.message_id),
            Event::ToolCallResult(e) => message(&e.message_id),
            Event::TextMessageChunk(e) => e.message_id.iter().for_each(message),
            Event::ReasoningMessageChunk(e) => e.message_id.iter().for_each(message),
            Event::MessagesSnapshot(e) => replayed(&e.messages),
            Event::RunStarted(e) => {
                if let Some(input) = &e.input {
                    replayed(&input.messages);
                }
            }
            Event::ToolCallStart(e) => call(&e.tool_call_id),
            Event::ToolCallChunk(e) => e.tool_call_id.iter().for_each(call),
            _ => {}
        }
    }
}

/// What separates the run id from the counter in an id a context hands out.
const MESSAGE_ID: &str = "-msg-";
const TOOL_CALL_ID: &str = "-call-";
const SUBAGENT_ID: &str = "-sub-";

/// What the ids a context hands out begin with.
fn id_prefix(run_id: &RunId) -> &str {
    if run_id.is_empty() {
        "run"
    } else {
        run_id.as_str()
    }
}

/// What the agent asked the driver to put on the terminal event.
#[derive(Debug, Default)]
pub(crate) struct Terminal {
    /// `RUN_FINISHED.result`.
    pub(crate) result: Option<Value>,
    /// One entry per model call, summed per `(provider, model)` at the end.
    pub(crate) usage: Vec<TokenUsage>,
}

impl Terminal {
    /// The `usage` list for a terminal event, or `None` when nothing was
    /// reported.
    pub(crate) fn usage(&self) -> Option<Vec<TokenUsage>> {
        let usage = crate::aggregate_token_usage(&self.usage);
        (!usage.is_empty()).then_some(usage)
    }
}

impl<S: AgentState> RunContext<S> {
    /// Builds a context and the receiving half of its event stream.
    ///
    /// This is the harness for unit-testing an [`Agent`](crate::server::Agent) without
    /// the run driver: call the agent's body, then assert on
    /// [`EventReceiver::drain`]. Nothing emits `RUN_STARTED` here — that is the
    /// driver's job, and skipping it lets a test exercise one method in
    /// isolation. The ordering verifier takes the run as started.
    pub fn new(input: RunAgentInput) -> Result<(Self, EventReceiver)> {
        let (tx, rx) = mpsc::unbounded();
        let mut sink = EventSink::new(tx, TransformerChain::new(), CancellationToken::new());
        // As the driver does, so an agent that answers a call from an earlier
        // run behaves here as it will in a real one.
        sink.seed(&input.messages);
        sink.assume_run_started();
        let state = decode_state(&input.state)?;
        Ok((
            Self::from_parts(input, state, sink, Minted::default()),
            EventReceiver::new(rx),
        ))
    }

    /// Assembles a context from an already-decoded state.
    ///
    /// The run driver decodes first so that a state that does not fit `S` is
    /// reported through the sink it still owns, as a `RUN_ERROR`. `minted`
    /// is where the run's ids stand: nothing handed out yet, unless this
    /// context continues a run.
    pub(crate) fn from_parts(
        input: RunAgentInput,
        state: S,
        sink: EventSink,
        minted: Minted,
    ) -> Self {
        Self {
            input,
            state: RunState::new(state),
            sink,
            minted,
            terminal: Terminal::default(),
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

    /// A handle a transport can trip on client disconnect. The same token
    /// [`Runner::cancellation_token`](crate::server::Runner::cancellation_token)
    /// returns.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.sink.cancel_token().clone()
    }

    /// The old name of [`cancellation_token`](Self::cancellation_token).
    #[deprecated(since = "0.5.0", note = "renamed to `cancellation_token`")]
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancellation_token()
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

    /// Emits a terminator, even after cancellation. Only the scope handles
    /// call this, to close the step or subagent they opened.
    pub(crate) fn emit_forced(&mut self, event: Event) -> Result<()> {
        self.sink.emit_forced(event)
    }

    /// A fresh message id, unique within the run.
    ///
    /// Derived from the run id and a counter rather than a UUID: the protocol
    /// asks for opaque strings, this crate takes no `uuid` dependency, and a
    /// deterministic id makes a recorded stream diffable. Pass your own id to
    /// [`message_with_id`](Self::message_with_id) when you need one.
    pub fn new_message_id(&mut self) -> MessageId {
        let number = self.minted.messages.next();
        let prefix = id_prefix(&self.input.run_id);
        MessageId::new(format!("{prefix}{MESSAGE_ID}{number}"))
    }

    /// A fresh tool call id, unique within the run.
    pub fn new_tool_call_id(&mut self) -> ToolCallId {
        let number = self.minted.tool_calls.next();
        let prefix = id_prefix(&self.input.run_id);
        ToolCallId::new(format!("{prefix}{TOOL_CALL_ID}{number}"))
    }

    /// A fresh subagent invocation id, unique within the run.
    ///
    /// Derived like the others, from the run id and a counter — so, like
    /// message ids, it is unique across runs only while run ids are. A
    /// resuming run that continues a *suspended* subagent should reuse the
    /// suspended id instead — see [`subagent_with`](Self::subagent_with).
    pub fn new_subagent_run_id(&mut self) -> SubagentRunId {
        let number = self.minted.subagents.next();
        let prefix = id_prefix(&self.input.run_id);
        SubagentRunId::new(format!("{prefix}{SUBAGENT_ID}{number}"))
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
        self.tool_call_with(ToolCallStartEvent::new(id, name))
    }

    /// Opens a call from a `TOOL_CALL_START` you built — for
    /// `parentMessageId`, the assistant message that requested the call.
    ///
    /// ```
    /// # use ag_ui::{Event, RunAgentInput, ToolCallStartEvent};
    /// # use ag_ui::server::RunContext;
    /// # let (mut ctx, mut events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
    /// let message_id = ctx.say("Let me check the forecast.")?;
    ///
    /// let id = ctx.new_tool_call_id();
    /// let start = ToolCallStartEvent::new(id, "get_weather").with_parent_message_id(message_id.clone());
    /// ctx.tool_call_with(start)?.result("21 C")?;
    ///
    /// let Event::ToolCallStart(start) = &events.drain()[3] else { unreachable!() };
    /// assert_eq!(start.parent_message_id.as_ref(), Some(&message_id));
    /// # Ok::<(), ag_ui::server::Error>(())
    /// ```
    pub fn tool_call_with(&mut self, start: ToolCallStartEvent) -> Result<ToolCallHandle<'_, S>> {
        let result_message_id = self.new_message_id();
        ToolCallHandle::start(&mut self.sink, &mut self.state, start, result_message_id)
    }

    /// Sets the run's return value: the `result` of `RUN_FINISHED`.
    ///
    /// The driver writes it when the run finishes, whatever the outcome. A run
    /// that ends in `RUN_ERROR` has no result. `Value::Null` clears it.
    pub fn set_result(&mut self, result: impl Into<Value>) {
        let result = result.into();
        self.terminal.result = (!result.is_null()).then_some(result);
    }

    /// Records the token usage of one model call.
    ///
    /// The driver sums the entries per `(provider, model)` and reports them as
    /// `usage` on the terminal event, `RUN_FINISHED` or `RUN_ERROR`. An entry
    /// with no counts is ignored.
    pub fn add_usage(&mut self, usage: TokenUsage) {
        if usage.has_counts() {
            self.terminal.usage.push(usage);
        }
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
    /// the same transformers and the same verifier the agent used, with what
    /// the agent asked to have written on it.
    pub(crate) fn into_parts(self) -> (EventSink, Terminal) {
        (self.sink, self.terminal)
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
    fn a_counter_counts_on_from_the_highest_number_noted() {
        let mut counter = IdCounter::default();
        assert_eq!([counter.next(), counter.next()], [1, 2]);

        let mut counter = IdCounter::default();
        for noted in [3, 1, 7] {
            counter.note(noted);
        }
        assert_eq!([counter.next(), counter.next()], [8, 9]);
    }

    #[test]
    fn a_counter_never_overflows_and_never_repeats_a_number_that_was_noted() {
        // The largest number there is cannot be counted past. The count
        // starts again from 1, over what is in use.
        let mut counter = IdCounter::default();
        for noted in [1, 2, 4, u64::MAX] {
            counter.note(noted);
        }
        assert_eq!([counter.next(), counter.next(), counter.next()], [3, 5, 6]);

        // One short of it: the largest number is handed out, once, and the
        // count starts again after it.
        let mut counter = IdCounter::default();
        counter.note(1);
        counter.note(u64::MAX - 1);
        assert_eq!([counter.next(), counter.next()], [u64::MAX, 2]);
    }

    #[test]
    fn only_an_id_of_the_shape_a_context_hands_out_is_noted() {
        let run_id = RunId::new("run-7");
        let mut minted = Minted::default();
        for id in [
            "run-7-msg-12",
            "run-7-msg-twelve",
            "run-7-msg-",
            "run-7-msg-99999999999999999999",
            "run-8-msg-40",
            "msg-40",
        ] {
            let start = Event::text_message_start(id, TextMessageRole::Assistant);
            minted.note(&run_id, &start);
        }
        assert_eq!(minted.messages.next(), 13);
        assert_eq!(minted.tool_calls.next(), 1);
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
        ctx.cancellation_token().cancel();
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
