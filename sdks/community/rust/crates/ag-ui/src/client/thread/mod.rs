//! A local conversation: independent history, state and human input over a shared transport.
//!
//! [`Thread`] owns its transport handle; dropping the agent that created it is safe.
//! It does not automatically fetch server history or synchronize other local copies.
//! Each request borrows the thread until dropped. Requests are dispatched on first poll.
//!
//! # Several runs on one stream
//!
//! A request asks for one run, and AG-UI 1.0 lets the stream that answers it
//! carry several in sequence: the runs the producer replays, then the
//! requested one, which echoes the request's run id. A [`RunStream`] reads
//! to the end of the stream. Messages accumulate and state persists across
//! the runs; each run yields one [`Update::RunEnded`], and is listed in
//! [`RunReport::runs`]; one [`Update::Done`] ends the stream.
//!
//! What a run's end means for the thread depends on where the run stands:
//!
//! | Run | Ends | The thread |
//! | --- | --- | --- |
//! | replayed, before the requested run | any way | keeps what it delivered and reports it; owes nothing new |
//! | requested | success, interrupt | confirms a resume [submission](Thread::submission); pending [interrupts](Thread::interrupts) cleared, or set |
//! | requested | cancelled | settles a resume submission; pending interrupts cleared |
//! | requested | `RUN_ERROR`, cut short | leaves a submission unconfirmed, and the interrupts as they were |
//! | after the requested run | success, cancelled | pending interrupts cleared |
//! | after the requested run | interrupt | pending interrupts set |
//! | after the requested run | `RUN_ERROR`, cut short | pending interrupts left |
//! | after the requested run, a submission unconfirmed | any `RUN_FINISHED` | pending interrupts left, with an [`Update::Warning`] |
//!
//! A requested run that ends `cancelled` took the answers of a resume and
//! reported how it ended, so the submission is settled like a confirmed one.
//! AG-UI 1.0 (`events/lifecycle`, "Cancelled runs"): "A cancelled run waits
//! for nothing. Its outcome carries no interrupts, and the next run on the
//! thread is an ordinary new run, not a resume." It did not complete, so a
//! tool call one of the answers approved is still in
//! [`Thread::unanswered_tool_calls`] when the run left it without a result.
//!
//! A `RUN_ERROR` that opens the stream belongs to no run. With nothing after
//! it, it is the requested run failing before it began, and is read as the
//! requested run above. With a run after it, it is history, like a replayed
//! run: at most one run of a stream is the requested one.
//!
//! The request went the way the last run from the requested one on ended:
//! that is [`Update::Done`], [`RunReport::end`] and [`Thread::last_run_end`].
//! 1.0 makes the requested run the last of its stream, so on a conforming
//! stream it is the requested run's end. A producer that keeps the stream
//! open may send a run after it all the same, and the agent then stands
//! where that run left it. A stream that ends without the requested run does
//! not answer the request, and fails it.
//!
//! [`Thread::unanswered_tool_calls`] reads the conversation, so a call any
//! run left without a result is owed.
//!
//! # Two runs at once
//!
//! A request borrows its thread until its stream ends, so one [`Thread`] has
//! one request in flight. A second one does not compile:
//!
//! ```compile_fail,E0499
//! use ag_ui::client::{Thread, transport::ReplayTransport};
//!
//! let mut thread = Thread::new(ReplayTransport::new([]), "thread-1");
//! let long = thread.send("Write the report").unwrap();
//! let quick = thread.send("What time is it?").unwrap(); // `thread` is still borrowed
//! drop((long, quick));
//! ```
//!
//! That is deliberate. A thread tracks what one request owes: its resume
//! submission, the interrupts it left pending, how it ended. AG-UI 1.0
//! describes a thread as runs in sequence and does not say how two runs open
//! at once reconcile their messages or the state they share.
//!
//! For a quick question while a long run works on the same conversation, use
//! two threads with the same thread id, each holding the conversation as it
//! stood, and merge their messages once both streams have ended:
//!
//! ```
//! use ag_ui::client::{RunEnd, Thread, merge_messages, transport::ReplayTransport};
//! # use ag_ui::{Event, TextMessageRole};
//! use futures_util::StreamExt;
//! # fn reply(id: &str, text: &str) -> Vec<Event> {
//! #     vec![
//! #         Event::run_started("thread-1", "run"),
//! #         Event::text_message_start(id, TextMessageRole::Assistant),
//! #         Event::text_message_content(id, text),
//! #         Event::text_message_end(id),
//! #         Event::run_finished_success("thread-1", "run"),
//! #     ]
//! # }
//! # let transport = ReplayTransport::with_runs([
//! #     reply("report", "Here is the report."),
//! #     reply("time", "It is noon."),
//! #     reply("welcome", "You are welcome."),
//! # ])
//! # .matching_requests();
//! # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
//! # rt.block_on(async {
//! let mut main = Thread::new(transport.clone(), "thread-1");
//! // A second thread on the same conversation, holding the same messages.
//! let mut side = Thread::<_>::restore(transport.clone(), main.snapshot())?;
//!
//! // The long run starts, and borrows `main` until its stream ends ...
//! let mut long = main.send("Write the report")?;
//! long.next().await;
//! // ... so the quick question goes to `side`, and is answered meanwhile.
//! let quick = side.send("What time is it?")?.collect_report().await;
//! assert_eq!(quick.end, RunEnd::Success { result: None });
//! // Both can be drawn as one list at any moment.
//! let on_screen = merge_messages(long.thread().messages(), side.messages());
//! assert_eq!(on_screen.len(), 4);
//! long.collect_report().await;
//!
//! // Both streams have ended: `main` takes the messages it lacks ...
//! let merged = main.merge_messages_from(&side)?;
//! assert_eq!(merged.added.len(), 2);
//! assert!(merged.differing.is_empty());
//! // ... and its next request carries both runs.
//! main.send("Thanks")?.collect_report().await;
//! assert_eq!(transport.last_request().unwrap().messages.len(), 5);
//! # Ok::<(), ag_ui::client::Error>(())
//! # })
//! # .unwrap();
//! ```
//!
//! Make the second thread from a [snapshot](Thread::snapshot) taken before
//! the long run is polled, as above, so that both start from the same
//! messages; with `HttpAgent` that is `agent.restore_thread(main.snapshot())`.
//! A restored thread has the defaults for what a snapshot does not hold: set
//! its tools, context and forwarded properties again. A second thread made
//! later, from `long.thread().snapshot()` while the long run is being read,
//! holds what had arrived by then. A message it holds only in part stays as
//! the thread that finished it has it, and is named in
//! [`MergeReport::differing`].
//!
//! Two things the long run had in flight then are the copy's to settle, as
//! on any restored thread. A tool call the run made and has not had the
//! result of yet is unanswered on the copy, which sends nothing until it has
//! an answer: give the call up there first, with
//! [`abandon_tool_call`](Thread::abandon_tool_call). When the long run then
//! receives the result, merging the copy into `main` leaves the copy's
//! stand-in out and names it in [`MergeReport::superseded`]. Merging `main`
//! into the copy is refused: a merge removes nothing of the thread it adds
//! to, and the copy gave the call up. And a copy
//! taken while a resume is in flight holds that
//! [submission](Thread::submission) unconfirmed, and runs and merges once
//! the application has reconciled it.
//!
//! [`Thread::merge_messages_from`] says what the merge takes, leaves and
//! refuses, and [`merge_messages`] has the rules for the list. In short:
//! messages are merged by id, this thread's copy of a message stays, and a
//! tool result is put behind the message that holds its call. State is not
//! merged. Pending interrupts, a resume submission and unanswered tool calls
//! are not carried over: a thread that has any is not merged until it has
//! settled them itself.

mod merge;
mod pending;
mod run;
mod snapshot;

pub use merge::{MergeReport, merge_messages};
pub use pending::{ResumeSubmission, SubmissionStatus};
pub use run::{
    AbortHandle, MessageUpdate, ReasoningUpdate, RunDiagnostic, RunEnd, RunReport, RunStream,
    RunSummary, SubagentUpdate, Update,
};
pub use snapshot::ThreadSnapshot;

use std::collections::HashSet;
use std::sync::Arc;

use crate::client::{
    agent::RemoteAgent,
    apply::{Applier, Subagent},
    error::{Error, Result},
    transport::Transport,
};
use crate::{
    Context, Event, Interrupt, Message, MessageId, ReasoningMessage, RunId, ThreadId, Tool,
    ToolCallId,
};
use serde::de::DeserializeOwned;
use serde_json::Value;

#[cfg(not(target_family = "wasm"))]
type Observer = Box<dyn FnMut(&Event) + Send>;
#[cfg(target_family = "wasm")]
type Observer = Box<dyn FnMut(&Event)>;
#[cfg(not(target_family = "wasm"))]
type IdGenerator = Box<dyn FnMut() -> Result<String> + Send>;
#[cfg(target_family = "wasm")]
type IdGenerator = Box<dyn FnMut() -> Result<String>>;

/// A typed view of current raw state could not be constructed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("state does not match the expected type: {message}")]
pub struct StateViewError {
    /// The deserializer's explanation.
    pub message: String,
}

/// One local conversation with an agent. `T` only supplies communication.
/// `S` is the current state view, defaulting to JSON.
pub struct Thread<T, S = Value> {
    agent: RemoteAgent<Arc<T>>,
    thread_id: ThreadId,
    applier: Applier,
    state: core::result::Result<S, StateViewError>,
    tools: Vec<Tool>,
    context: Vec<Context>,
    forwarded_props: Value,
    protocol_version: Option<String>,
    verify: bool,
    interrupts: Vec<Interrupt>,
    decided_interrupt_tool_call_ids: HashSet<ToolCallId>,
    /// The tool messages `abandon_tool_call` made, by id: stand-ins for a
    /// result, which a merge tells from one by this record and not by what
    /// the message says.
    abandoned: HashSet<MessageId>,
    submission: Option<ResumeSubmission>,
    run_ids: HashSet<RunId>,
    next_run_id: Option<RunId>,
    last_run_end: Option<RunEnd>,
    active_run_id: Option<RunId>,
    observer: Option<Observer>,
    id_generator: IdGenerator,
    diagnostic_limit: usize,
}

impl<T, S: std::fmt::Debug> std::fmt::Debug for Thread<T, S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Thread")
            .field("thread_id", &self.thread_id)
            .field("state", &self.state)
            .field("messages", &self.messages())
            .field("interrupts", &self.interrupts)
            .finish_non_exhaustive()
    }
}

impl<T: Transport> Thread<T> {
    /// Creates an empty JSON conversation. No request is sent.
    pub fn new(transport: T, thread_id: impl Into<ThreadId>) -> Self {
        Self::from_shared(Arc::new(transport), thread_id)
    }

    pub(crate) fn from_shared(transport: Arc<T>, thread_id: impl Into<ThreadId>) -> Self {
        ThreadBuilder::from_shared(transport, thread_id)
            .build()
            .expect("an empty JSON object always deserializes to Value")
    }
}

impl<T, S> Thread<T, S> {
    /// Configures a conversation and validates its initial typed state at `build`.
    pub fn builder(transport: T, thread_id: impl Into<ThreadId>) -> ThreadBuilder<T, S>
    where
        T: Transport,
    {
        ThreadBuilder::new(transport, thread_id)
    }
    /// The remote conversation identifier.
    pub fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }
    /// The current assembled conversation, reasoning and activity messages
    /// included. A run sends all of it but the activity messages.
    ///
    /// To draw the conversation without the agent's reasoning, leave that
    /// role out: `messages().iter().filter(|m| m.role() != Role::Reasoning)`.
    pub fn messages(&self) -> &[Message] {
        self.applier.messages()
    }
    /// The current typed view. A remote type mismatch invalidates the old view.
    pub fn state(&self) -> core::result::Result<&S, StateViewError> {
        self.state.as_ref().map_err(Clone::clone)
    }
    /// The latest raw state, even when it does not fit `S`.
    pub fn raw_state(&self) -> &Value {
        self.applier.state()
    }
    /// The reasoning messages in [`messages`](Self::messages), oldest first:
    /// a view over that list, for a UI that draws reasoning in a pane of its
    /// own.
    pub fn reasoning(&self) -> impl Iterator<Item = &ReasoningMessage> {
        self.applier.reasoning()
    }
    /// Pending human input. Dispatching a response does not remove it.
    pub fn interrupts(&self) -> &[Interrupt] {
        &self.interrupts
    }
    /// Unconfirmed or currently in-flight response submission.
    pub fn submission(&self) -> Option<&ResumeSubmission> {
        self.submission.as_ref()
    }
    /// Announced subagents across runs.
    pub fn subagents(&self) -> &[Subagent] {
        self.applier.subagents()
    }
    /// Find a subagent by invocation ID.
    pub fn subagent(&self, id: &crate::SubagentRunId) -> Option<&Subagent> {
        self.applier.subagent(id)
    }
    /// The current materialized protocol data.
    pub fn applier(&self) -> &Applier {
        &self.applier
    }
    /// The low-level agent using the same owned transport handle.
    pub fn agent(&self) -> &RemoteAgent<Arc<T>> {
        &self.agent
    }
    /// How the last request went: what its stream's [`Update::Done`] carried.
    /// Dropping a dispatched request before its stream ends records `Aborted`,
    /// unless the last run from the requested one on had already ended: that
    /// ending stays.
    pub fn last_run_end(&self) -> Option<&RunEnd> {
        self.last_run_end.as_ref()
    }
    /// Append a client-owned message, rejecting an ID already in the transcript.
    pub fn push_message(&mut self, message: Message) -> Result<()> {
        if self.applier.message(message.id()).is_some() {
            return Err(Error::Request(format!(
                "duplicate message ID {}",
                message.id()
            )));
        }
        self.append_local_message(message);
        Ok(())
    }
    fn append_local_message(&mut self, message: Message) {
        if let Message::Assistant(assistant) = &message {
            for call in assistant.tool_calls.iter().flatten() {
                self.decided_interrupt_tool_call_ids.remove(&call.id);
            }
        }
        self.applier.push_message(message);
    }
    /// Tools offered on subsequent runs. AG-UI does not discover tools.
    pub fn set_tools(&mut self, tools: impl Into<Vec<Tool>>) {
        self.tools = tools.into();
    }
    /// Context sent on subsequent runs.
    pub fn set_context(&mut self, context: impl Into<Vec<Context>>) {
        self.context = context.into();
    }
    /// Passthrough request properties supplied by the application.
    pub fn set_forwarded_props(&mut self, props: impl Into<Value>) {
        self.forwarded_props = props.into();
    }
    /// Configure protocol ordering verification. Identity and resume safety checks stay enabled.
    pub fn set_verify(&mut self, verify: bool) {
        self.verify = verify;
    }
    /// Retained diagnostics per request. Excess errors are still yielded as updates.
    pub fn set_diagnostic_limit(&mut self, limit: usize) {
        self.diagnostic_limit = limit;
    }
    /// Reserve an explicit run ID. Reuse is rejected during request preflight.
    pub fn set_next_run_id(&mut self, id: impl Into<RunId>) {
        self.next_run_id = Some(id.into());
    }
    /// Remove the event observer.
    pub fn clear_event_observer(&mut self) {
        self.observer = None;
    }

    /// Replace the synchronous read-only observer. Called once per checked
    /// event, before chunk normalization and ordering verification. Queue slow
    /// work in the application.
    #[cfg(not(target_family = "wasm"))]
    pub fn on_event(&mut self, observer: impl FnMut(&Event) + Send + 'static) {
        self.observer = Some(Box::new(observer));
    }
    /// Replace the local read-only observer on wasm.
    #[cfg(target_family = "wasm")]
    pub fn on_event(&mut self, observer: impl FnMut(&Event) + 'static) {
        self.observer = Some(Box::new(observer));
    }
}

impl<T, S: DeserializeOwned> Thread<T, S> {
    /// Validates local JSON before atomically replacing both raw and typed state.
    pub fn set_state(&mut self, state: impl Into<Value>) -> Result<()> {
        let state = state.into();
        let typed = S::deserialize(&state).map_err(Error::State)?;
        self.applier.set_state(state);
        self.state = Ok(typed);
        Ok(())
    }
}

impl<T: Transport, S> Thread<T, S> {
    /// Prepare a user turn. Pending decisions and ambiguous submissions are checked
    /// before changing history. Dispatch and history insertion occur on first poll.
    ///
    /// # Errors
    ///
    /// Like [`send_message`](Self::send_message), [`run`](Self::run) and
    /// [`resume_many`](Self::resume_many), this refuses a request the
    /// conversation is not ready for, before anything is sent:
    /// [`Error::UnansweredToolCalls`] names the tool calls still awaiting a
    /// result, [`Error::PendingInterrupts`] the interrupts still awaiting an
    /// answer, and [`Error::Request`] says why in any other case.
    pub fn send(&mut self, text: impl Into<String>) -> Result<RunStream<'_, T, S>> {
        self.preflight(None, None)?;
        let id = self.fresh_id(false)?;
        self.start(Some(Message::user(id, text.into())), None)
    }
    /// Prepare a message of any role, rejecting existing IDs.
    pub fn send_message(&mut self, message: Message) -> Result<RunStream<'_, T, S>> {
        if self.applier.message(message.id()).is_some() {
            return Err(Error::Request(format!(
                "duplicate message ID {}",
                message.id()
            )));
        }
        self.preflight(None, Some(&message))?;
        self.start(Some(message), None)
    }
    /// Prepare a run with the existing conversation and no new message.
    pub fn run(&mut self) -> Result<RunStream<'_, T, S>> {
        self.preflight(None, None)?;
        self.start(None, None)
    }
    fn fresh_id(&mut self, run: bool) -> Result<String> {
        for _ in 0..64 {
            let id = (self.id_generator)()?;
            let exists = if run {
                self.run_ids.contains(&RunId::new(&id))
            } else {
                self.applier.message(&MessageId::new(&id)).is_some()
            };
            if !id.is_empty() && !exists {
                return Ok(id);
            }
        }
        Err(Error::Request(
            "ID generator repeatedly returned empty or existing IDs".into(),
        ))
    }
}

/// Configures a thread. `build` checks history IDs and typed initial state.
pub struct ThreadBuilder<T, S = Value> {
    transport: Arc<T>,
    thread_id: ThreadId,
    messages: Vec<Message>,
    state: Value,
    tools: Vec<Tool>,
    context: Vec<Context>,
    forwarded_props: Value,
    protocol_version: Option<String>,
    verify: bool,
    diagnostic_limit: usize,
    id_generator: IdGenerator,
    marker: std::marker::PhantomData<fn() -> S>,
}
impl<T, S> std::fmt::Debug for ThreadBuilder<T, S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThreadBuilder")
            .field("thread_id", &self.thread_id)
            .finish_non_exhaustive()
    }
}
impl<T, S> ThreadBuilder<T, S> {
    /// Configure a thread using any transport.
    pub fn new(transport: T, thread_id: impl Into<ThreadId>) -> Self
    where
        T: Transport,
    {
        Self::from_shared(Arc::new(transport), thread_id)
    }
    pub(crate) fn from_shared(transport: Arc<T>, thread_id: impl Into<ThreadId>) -> Self {
        Self {
            transport,
            thread_id: thread_id.into(),
            messages: Vec::new(),
            state: serde_json::json!({}),
            tools: Vec::new(),
            context: Vec::new(),
            forwarded_props: Value::Null,
            protocol_version: Some(crate::input::PROTOCOL_VERSION.to_owned()),
            verify: true,
            diagnostic_limit: 100,
            id_generator: Box::new(random_id),
            marker: std::marker::PhantomData,
        }
    }
    /// Existing conversation, checked for duplicate IDs at build time.
    #[must_use]
    pub fn messages(mut self, messages: impl Into<Vec<Message>>) -> Self {
        self.messages = messages.into();
        self
    }
    /// Initial JSON, deserialized to `S` at build time.
    #[must_use]
    pub fn state(mut self, state: impl Into<Value>) -> Self {
        self.state = state.into();
        self
    }
    /// Tools offered on each run.
    #[must_use]
    pub fn tools(mut self, tools: impl Into<Vec<Tool>>) -> Self {
        self.tools = tools.into();
        self
    }
    /// Ambient context supplied on each run.
    #[must_use]
    pub fn context(mut self, context: impl Into<Vec<Context>>) -> Self {
        self.context = context.into();
        self
    }
    /// Application-specific request properties.
    #[must_use]
    pub fn forwarded_props(mut self, props: impl Into<Value>) -> Self {
        self.forwarded_props = props.into();
        self
    }
    /// Declares this SDK's version in each request. Use `None` only for a
    /// known legacy peer whose request parser predates `protocolVersion`.
    #[must_use]
    pub fn protocol_version(mut self, version: Option<String>) -> Self {
        self.protocol_version = version;
        self
    }
    /// Toggle optional protocol ordering verification.
    #[must_use]
    pub fn verify(mut self, verify: bool) -> Self {
        self.verify = verify;
        self
    }
    /// Maximum diagnostics retained in each report (default 100).
    #[must_use]
    pub fn diagnostic_limit(mut self, limit: usize) -> Self {
        self.diagnostic_limit = limit;
        self
    }
    /// Inject deterministic IDs for tests. Empty or duplicate IDs are retried up to 64 times.
    #[cfg(not(target_family = "wasm"))]
    #[must_use]
    pub fn id_generator(mut self, mut generator: impl FnMut() -> String + Send + 'static) -> Self {
        self.id_generator = Box::new(move || Ok(generator()));
        self
    }
    /// Inject a local deterministic ID generator on wasm.
    #[cfg(target_family = "wasm")]
    #[must_use]
    pub fn id_generator(mut self, mut generator: impl FnMut() -> String + 'static) -> Self {
        self.id_generator = Box::new(move || Ok(generator()));
        self
    }
    /// Validate state and history, then construct the conversation.
    pub fn build(self) -> Result<Thread<T, S>>
    where
        S: DeserializeOwned,
    {
        unique(
            self.messages.iter().map(|message| message.id().as_str()),
            "message",
        )?;
        let state = S::deserialize(&self.state).map_err(Error::State)?;
        Ok(Thread {
            agent: RemoteAgent::new(self.transport),
            thread_id: self.thread_id,
            applier: Applier::new()
                .with_messages(self.messages)
                .with_state(self.state),
            state: Ok(state),
            tools: self.tools,
            context: self.context,
            forwarded_props: self.forwarded_props,
            protocol_version: self.protocol_version,
            verify: self.verify,
            interrupts: Vec::new(),
            decided_interrupt_tool_call_ids: HashSet::new(),
            abandoned: HashSet::new(),
            submission: None,
            run_ids: HashSet::new(),
            next_run_id: None,
            last_run_end: None,
            active_run_id: None,
            observer: None,
            id_generator: self.id_generator,
            diagnostic_limit: self.diagnostic_limit,
        })
    }
}

pub(crate) fn random_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| Error::Config(format!("could not obtain ID entropy: {error}")))?;
    use std::fmt::Write;
    let mut id = String::with_capacity(32);
    for byte in bytes {
        write!(id, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(id)
}

/// Rejects a list that holds an id twice.
///
/// Not an empty id: AG-UI 1.0 makes every identifier an opaque string and
/// its schema sets no minimum length, so the empty string is an id like any
/// other, and a run may leave one.
fn unique<'a>(ids: impl IntoIterator<Item = &'a str>, label: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(Error::Snapshot(format!(
                "{label} ID {id:?} is held more than once"
            )));
        }
    }
    Ok(())
}
