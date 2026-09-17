//! A local conversation: independent history, state and human input over a shared transport.
//!
//! [`Thread`] owns its transport handle; dropping the agent that created it is safe.
//! It does not automatically fetch server history or synchronize other local copies.
//! Each run borrows the thread until dropped. Requests are dispatched on first poll.

use std::collections::{HashSet, VecDeque};
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::task::{Context as TaskContext, Poll};

use crate::client::{
    agent::RemoteAgent,
    apply::{
        Applier, Changed, MessageChangeKind, ReasoningChangeKind, Subagent, SubagentChangeKind,
    },
    chunks::ChunkNormalizer,
    error::{Error, Result},
    interrupts::InterruptExt,
    transport::{EventStream, Transport},
    verify::Verifier,
};
use crate::{
    Context, Event, Interrupt, Message, MessageId, ReasoningMessage, ResumeEntry, RunAgentInput,
    RunId, RunOutcome, ThreadId, Tool,
};
use futures_core::Stream;
use futures_util::{StreamExt, task::AtomicWaker};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

#[cfg(not(target_family = "wasm"))]
type Observer = Box<dyn FnMut(&Event) + Send>;
#[cfg(target_family = "wasm")]
type Observer = Box<dyn FnMut(&Event)>;
#[cfg(not(target_family = "wasm"))]
type IdGenerator = Box<dyn FnMut() -> Result<String> + Send>;
#[cfg(target_family = "wasm")]
type IdGenerator = Box<dyn FnMut() -> Result<String>>;

/// Something a view should react to.
///
/// One [`Update`] is one redraw. `S` is the caller's state type; it is
/// [`serde_json::Value`] unless a [`Thread`] is asked for something better.
#[derive(Debug)]
#[non_exhaustive]
pub enum Update<S = Value> {
    /// A message was created, appended to, or completed.
    Message(MessageUpdate),
    /// `MESSAGES_SNAPSHOT` replaced the conversation. Messages may have
    /// disappeared, so redraw all of it.
    Messages(Vec<Message>),
    /// The application state changed, and here it is in the caller's type.
    ///
    /// Carries no association with whatever was open when it arrived — a tool
    /// call, a message — because the wire carries none either. Where it lands
    /// in the stream is the only nesting there is; see the [module
    /// docs](self).
    State(S),
    /// Reasoning text arrived. Kept separate from the reply.
    Reasoning(ReasoningUpdate),
    /// A subagent was announced, resumed, finished, suspended or failed.
    ///
    /// The lifecycle only: what a subagent *says* arrives as ordinary
    /// [`Update::Message`]s and [`Update::Reasoning`]s whose messages carry
    /// its `subagent_run_id`, so a view groups by that and uses this for the
    /// group's header and status. See [`Thread::subagents`].
    Subagent(SubagentUpdate),
    /// The run paused and needs a human. Answer it with
    /// [`Thread::resume`] — one update per pending interrupt.
    Interrupt(Interrupt),
    /// Something went wrong: a malformed stream, a patch that would not apply,
    /// a transport failure, a `RUN_ERROR`.
    ///
    /// Not necessarily fatal — a run survives a patch it could not apply. When
    /// it is fatal, the matching [`Update::Done`] follows.
    Error(Error),
    /// The run ended, and how. Always the last update of a run, on every path
    /// out: the agent finishing, the agent failing, and the transport dying
    /// mid-sentence.
    Done(RunEnd),
}

/// A message that changed, and the message as it now stands.
#[derive(Clone, Debug, PartialEq)]
pub struct MessageUpdate {
    /// Index into [`Thread::messages`].
    pub index: usize,
    /// The message's id.
    pub id: MessageId,
    /// What this event did to it — the text delta, the tool call, the close.
    pub change: MessageChangeKind,
    /// The whole message, assembled so far.
    pub message: Message,
}

/// Reasoning that changed, and the reasoning as it now stands.
#[derive(Clone, Debug, PartialEq)]
pub struct ReasoningUpdate {
    /// The reasoning message's id.
    pub id: MessageId,
    /// What this event did to it.
    pub change: ReasoningChangeKind,
    /// The accumulated reasoning text.
    pub text: String,
}

/// A subagent that changed, and the subagent as it now stands.
#[derive(Clone, Debug, PartialEq)]
pub struct SubagentUpdate {
    /// Index into [`Thread::subagents`].
    pub index: usize,
    /// The invocation's id — what the messages it produced carry.
    pub run_id: crate::SubagentRunId,
    /// What this event did to it.
    pub change: SubagentChangeKind,
    /// The whole entry, status included.
    pub subagent: Subagent,
}

/// How the remote run ended, or how local consumption stopped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum RunEnd {
    /// The server confirmed successful completion. Local diagnostics remain separate.
    Success {
        /// Optional server result.
        result: Option<Value>,
    },
    /// The server paused for input.
    Interrupted {
        /// Current pending questions.
        interrupts: Vec<Interrupt>,
    },
    /// The server or transport failed, or its terminal event was invalid.
    Failed {
        /// Human-readable cause.
        message: String,
        /// Optional server error code.
        code: Option<String>,
    },
    /// Local consumption stopped. This does not confirm cancellation on the server.
    Aborted,
}

/// A typed view of current raw state could not be constructed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("state does not match the expected type: {message}")]
pub struct StateViewError {
    /// The deserializer's explanation.
    pub message: String,
}

/// One retained diagnostic, independent of the terminal outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunDiagnostic {
    /// A stable broad category (`state`, `protocol`, `patch`, `transport`, or `run`).
    pub kind: &'static str,
    /// Human-readable cause.
    pub message: String,
}

/// Results from the whole run, including updates consumed before `collect_report`.
#[derive(Clone, Debug, PartialEq)]
pub struct RunReport {
    /// The observed terminal outcome.
    pub end: RunEnd,
    /// Messages whose IDs were absent when this run was prepared.
    pub new_messages: Vec<Message>,
    /// Retained diagnostics, in observation order.
    pub diagnostics: Vec<RunDiagnostic>,
    /// Diagnostics beyond the configured retention limit.
    pub diagnostics_omitted: usize,
}

/// Local observation of an interrupt response submission.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResumeSubmission {
    /// The request that carried these responses.
    pub run_id: RunId,
    /// Exact answers, retained for reconciliation by the application.
    pub entries: Vec<ResumeEntry>,
    /// Whether a valid terminal response has confirmed the request.
    pub status: SubmissionStatus,
}

/// A submission is never retried automatically.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubmissionStatus {
    /// Dispatched and still being observed. Restoring this becomes `Unconfirmed`.
    InFlight,
    /// Consumption stopped without a validated success or interrupt terminal.
    Unconfirmed,
}

/// A versioned local snapshot. It contains conversation data, never a transport,
/// observer or running future. Validate it through `restore` before using it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadSnapshot {
    /// Snapshot format version (currently 1).
    pub version: u32,
    /// The remote conversation identifier.
    pub thread_id: ThreadId,
    /// Materialized conversation.
    pub messages: Vec<Message>,
    /// Current raw shared state.
    pub state: Value,
    /// Materialized reasoning, separate from the conversation.
    pub reasoning: Vec<ReasoningMessage>,
    /// Announced subagent lifecycle state.
    pub subagents: Vec<Subagent>,
    /// Questions which have not been confirmed as answered.
    pub interrupts: Vec<Interrupt>,
    /// A submitted decision whose acceptance has not been confirmed.
    pub submission: Option<ResumeSubmission>,
    /// Previously dispatched local run IDs, used to prevent reuse.
    pub run_ids: Vec<RunId>,
    /// The last locally observed termination, if any.
    pub last_run_end: Option<RunEnd>,
    /// A dispatched local run which had not ended when this snapshot was taken.
    pub active_run_id: Option<RunId>,
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
    verify: bool,
    interrupts: Vec<Interrupt>,
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
    /// The current assembled conversation.
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
    /// Materialized reasoning, separate from the conversation.
    pub fn reasoning(&self) -> &[ReasoningMessage] {
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
    /// The last observed termination. Dropping a dispatched run records `Aborted`.
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
        self.applier.push_message(message);
        Ok(())
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
    /// Retained diagnostics per run. Excess errors are still yielded as updates.
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

    /// Replace the synchronous read-only observer. Called once per decoded event,
    /// before normalization and validation. Queue slow work in the application.
    #[cfg(not(target_family = "wasm"))]
    pub fn on_event(&mut self, observer: impl FnMut(&Event) + Send + 'static) {
        self.observer = Some(Box::new(observer));
    }
    /// Replace the local read-only observer on wasm.
    #[cfg(target_family = "wasm")]
    pub fn on_event(&mut self, observer: impl FnMut(&Event) + 'static) {
        self.observer = Some(Box::new(observer));
    }

    /// Save local conversation data. Transport settings and callbacks are excluded.
    pub fn snapshot(&self) -> ThreadSnapshot {
        let mut run_ids: Vec<_> = self.run_ids.iter().cloned().collect();
        run_ids.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        ThreadSnapshot {
            version: 1,
            thread_id: self.thread_id.clone(),
            messages: self.messages().to_vec(),
            state: self.raw_state().clone(),
            reasoning: self.reasoning().to_vec(),
            subagents: self.subagents().to_vec(),
            interrupts: self.interrupts.clone(),
            submission: self.submission.clone(),
            run_ids,
            last_run_end: self.last_run_end.clone(),
            active_run_id: self.active_run_id.clone(),
        }
    }

    fn unconfirm(&mut self) {
        if let Some(submission) = &mut self.submission {
            submission.status = SubmissionStatus::Unconfirmed;
        }
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

    /// Restore local state using a new transport. No server query is performed.
    pub fn restore(transport: T, snapshot: ThreadSnapshot) -> Result<Self>
    where
        T: Transport,
    {
        Self::restore_shared(Arc::new(transport), snapshot)
    }

    pub(crate) fn restore_shared(transport: Arc<T>, mut snapshot: ThreadSnapshot) -> Result<Self> {
        validate_snapshot(&snapshot)?;
        if snapshot.active_run_id.take().is_some() {
            snapshot.last_run_end = Some(RunEnd::Aborted);
        }
        let typed = S::deserialize(&snapshot.state).map_err(Error::State)?;
        if let Some(submission) = &mut snapshot.submission {
            submission.status = SubmissionStatus::Unconfirmed;
        }
        for subagent in &mut snapshot.subagents {
            if subagent.status == crate::client::SubagentStatus::Running {
                subagent.status = crate::client::SubagentStatus::Aborted;
            }
        }
        let mut applier = Applier::new()
            .with_messages(snapshot.messages)
            .with_state(snapshot.state);
        applier.restore_auxiliary(
            snapshot.reasoning,
            snapshot.subagents,
            snapshot.interrupts.clone(),
        );
        Ok(Self {
            agent: RemoteAgent::new(transport),
            thread_id: snapshot.thread_id,
            applier,
            state: Ok(typed),
            tools: Vec::new(),
            context: Vec::new(),
            forwarded_props: Value::Null,
            verify: true,
            interrupts: snapshot.interrupts,
            submission: snapshot.submission,
            run_ids: snapshot.run_ids.into_iter().collect(),
            next_run_id: None,
            last_run_end: snapshot.last_run_end,
            active_run_id: None,
            observer: None,
            id_generator: Box::new(random_id),
            diagnostic_limit: 100,
        })
    }
}

impl<T: Transport, S> Thread<T, S> {
    /// Prepare a user turn. Pending decisions and ambiguous submissions are checked
    /// before changing history. Dispatch and history insertion occur on first poll.
    pub fn send(&mut self, text: impl Into<String>) -> Result<RunStream<'_, T, S>> {
        self.preflight(None)?;
        let id = self.fresh_id(false)?;
        self.start(Some(Message::user(id, text.into())), None)
    }
    /// Prepare a message of any role, rejecting existing IDs.
    pub fn send_message(&mut self, message: Message) -> Result<RunStream<'_, T, S>> {
        self.preflight(None)?;
        if self.applier.message(message.id()).is_some() {
            return Err(Error::Request(format!(
                "duplicate message ID {}",
                message.id()
            )));
        }
        self.start(Some(message), None)
    }
    /// Prepare a run with the existing conversation and no new message.
    pub fn run(&mut self) -> Result<RunStream<'_, T, S>> {
        self.preflight(None)?;
        self.start(None, None)
    }
    /// Answer the single outstanding interrupt. All pending IDs must be answered.
    pub fn resume(
        &mut self,
        interrupt: &Interrupt,
        payload: impl Into<Value>,
    ) -> Result<RunStream<'_, T, S>> {
        self.resume_many([interrupt.resolve(payload)])
    }
    /// Decline the single outstanding interrupt. This is not execution cancellation.
    pub fn decline(&mut self, interrupt: &Interrupt) -> Result<RunStream<'_, T, S>> {
        self.resume_many([interrupt.cancel()])
    }
    /// Answer every pending question exactly once. Expiry is checked against the
    /// stored interrupt. Response schemas are retained for the application/server
    /// to validate; this transport-neutral API does not execute arbitrary schemas.
    pub fn resume_many(
        &mut self,
        entries: impl IntoIterator<Item = ResumeEntry>,
    ) -> Result<RunStream<'_, T, S>> {
        let entries: Vec<_> = entries.into_iter().collect();
        self.preflight(Some(&entries))?;
        self.start(None, Some(entries))
    }
    fn preflight(&self, resume: Option<&[ResumeEntry]>) -> Result<()> {
        if self.thread_id.as_str().is_empty() {
            return Err(Error::Request("thread ID must not be empty".into()));
        }
        if self.submission.is_some() {
            return Err(Error::Request("an unconfirmed submission requires reconciliation with server state before another run".into()));
        }
        if let Some(id) = &self.next_run_id {
            if id.as_str().is_empty() || self.run_ids.contains(id) {
                return Err(Error::Request(format!(
                    "run ID {id} is empty or already used"
                )));
            }
        }
        match resume {
            None if !self.interrupts.is_empty() => Err(Error::Request(
                "pending interrupts must be answered with resume_many".into(),
            )),
            Some(entries) => validate_responses(&self.interrupts, entries, true),
            None => Ok(()),
        }
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
    fn start(
        &mut self,
        message: Option<Message>,
        resume: Option<Vec<ResumeEntry>>,
    ) -> Result<RunStream<'_, T, S>> {
        let run_id = match &self.next_run_id {
            Some(id) => id.clone(),
            None => RunId::new(self.fresh_id(true)?),
        };
        let initial_ids = self
            .messages()
            .iter()
            .map(|message| message.id().clone())
            .collect();
        // Activity messages describe local renderer state. Like the reference
        // client, retain them in the thread but omit them from agent requests.
        let messages = self
            .messages()
            .iter()
            .chain(message.iter())
            .filter(|message| !matches!(message, Message::Activity(_)))
            .cloned()
            .collect();
        let input = RunAgentInput {
            thread_id: self.thread_id.clone(),
            run_id,
            parent_run_id: None,
            state: self.raw_state().clone(),
            messages,
            tools: self.tools.clone(),
            context: self.context.clone(),
            forwarded_props: self.forwarded_props.clone(),
            resume,
        };
        let verifier = self.verify.then(Verifier::new);
        let request_run_id = input.run_id.clone();
        Ok(RunStream {
            request_run_id,
            thread: self,
            prepared: Some((input, message)),
            events: None,
            normalizer: ChunkNormalizer::new(),
            verifier,
            expanded: Vec::new(),
            ready: VecDeque::new(),
            done: false,
            dispatched: false,
            abort: AbortHandle::default(),
            end: None,
            diagnostics: Vec::new(),
            diagnostics_omitted: 0,
            initial_ids,
            response_ids: None,
        })
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
            verify: self.verify,
            interrupts: Vec::new(),
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

#[derive(Default)]
struct AbortState {
    aborted: AtomicBool,
    waker: AtomicWaker,
}
/// Cloneable cancellation for one local run. Wakes a pending poll and drops its
/// connection/response stream. It does not confirm remote cancellation.
#[derive(Clone, Default)]
pub struct AbortHandle {
    state: Arc<AbortState>,
}
impl std::fmt::Debug for AbortHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AbortHandle")
            .field("aborted", &self.is_aborted())
            .finish()
    }
}
impl AbortHandle {
    /// Request local cancellation and wake its consumer.
    pub fn abort(&self) {
        self.state.aborted.store(true, Ordering::Release);
        self.state.waker.wake();
    }
    /// Whether cancellation was requested.
    pub fn is_aborted(&self) -> bool {
        self.state.aborted.load(Ordering::Acquire)
    }
}

/// A lazily dispatched run. It borrows the thread until dropped. Every consumed
/// run yields one `Done`; dropping an unpolled run leaves the thread unchanged.
pub struct RunStream<'a, T, S = Value> {
    thread: &'a mut Thread<T, S>,
    prepared: Option<(RunAgentInput, Option<Message>)>,
    events: Option<EventStream>,
    normalizer: ChunkNormalizer,
    verifier: Option<Verifier>,
    expanded: Vec<Event>,
    ready: VecDeque<Update<S>>,
    done: bool,
    dispatched: bool,
    abort: AbortHandle,
    end: Option<RunEnd>,
    diagnostics: Vec<RunDiagnostic>,
    diagnostics_omitted: usize,
    initial_ids: HashSet<MessageId>,
    response_ids: Option<(ThreadId, RunId)>,
    request_run_id: RunId,
}
impl<T, S> std::fmt::Debug for RunStream<'_, T, S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunStream")
            .field("pending", &self.ready.len())
            .field("dispatched", &self.dispatched)
            .field("done", &self.done)
            .finish_non_exhaustive()
    }
}
impl<T, S> RunStream<'_, T, S> {
    /// Read-only materialized conversation while the run is borrowed.
    pub fn thread(&self) -> &Thread<T, S> {
        self.thread
    }
    /// A handle that cancels this run only.
    pub fn abort_handle(&self) -> AbortHandle {
        self.abort.clone()
    }
    /// Interrupt consumption locally.
    pub fn abort(&self) {
        self.abort.abort();
    }
    fn diagnostic(&mut self, error: Error) {
        if self.diagnostics.len() < self.thread.diagnostic_limit {
            let kind = match &error {
                Error::State(_) => "state",
                Error::Protocol(_) => "protocol",
                Error::Patch { .. } => "patch",
                Error::Run { .. } => "run",
                Error::Json(_) | Error::Decode(_) => "decode",
                _ => "transport",
            };
            self.diagnostics.push(RunDiagnostic {
                kind,
                message: error.to_string(),
            });
        } else {
            self.diagnostics_omitted += 1;
        }
        self.ready.push_back(Update::Error(error));
    }
    fn terminate(&mut self, end: RunEnd) {
        if self.done {
            return;
        }
        self.done = true;
        self.events = None;
        self.prepared = None;
        self.thread.applier.reset_streams();
        if self.dispatched {
            self.thread.last_run_end = Some(end.clone());
            self.thread.active_run_id = None;
        }
        self.end = Some(end.clone());
        self.ready.push_back(Update::Done(end));
    }
    fn stop_subagents(&mut self) {
        let (messages, reasoning) = self.thread.applier.abort_messages();
        for change in messages {
            if let Some(message) = self.thread.applier.messages().get(change.index) {
                self.ready.push_back(Update::Message(MessageUpdate {
                    index: change.index,
                    id: change.id,
                    change: change.kind,
                    message: message.clone(),
                }));
            }
        }
        for change in reasoning {
            let text = self
                .thread
                .applier
                .reasoning_text(&change.id)
                .unwrap_or_default()
                .to_owned();
            self.ready.push_back(Update::Reasoning(ReasoningUpdate {
                id: change.id,
                change: change.kind,
                text,
            }));
        }
        for change in self.thread.applier.abort_subagents() {
            let subagent = self.thread.applier.subagents()[change.index].clone();
            self.ready.push_back(Update::Subagent(SubagentUpdate {
                index: change.index,
                run_id: change.run_id,
                change: change.kind,
                subagent,
            }));
        }
    }
    fn fail(&mut self, error: Error) {
        let message = error.to_string();
        self.diagnostic(error);
        self.thread.unconfirm();
        self.stop_subagents();
        self.terminate(RunEnd::Failed {
            message,
            code: None,
        });
    }
}
impl<T, S> Drop for RunStream<'_, T, S> {
    fn drop(&mut self) {
        if self.dispatched && !self.done {
            self.thread.unconfirm();
            self.thread.applier.abort_subagents();
            self.thread.last_run_end = Some(RunEnd::Aborted);
            self.thread.active_run_id = None;
        }
    }
}

impl<T: Transport, S: DeserializeOwned + Clone + Unpin> RunStream<'_, T, S> {
    /// Consume the remainder and return the entire run's outcome and diagnostics.
    pub async fn collect_report(mut self) -> RunReport {
        while self.next().await.is_some() {}
        RunReport {
            end: self
                .end
                .clone()
                .expect("a consumed stream has a terminal outcome"),
            new_messages: self
                .thread
                .messages()
                .iter()
                .filter(|message| !self.initial_ids.contains(message.id()))
                .cloned()
                .collect(),
            diagnostics: std::mem::take(&mut self.diagnostics),
            diagnostics_omitted: self.diagnostics_omitted,
        }
    }
}

impl<T, S: DeserializeOwned + Clone> RunStream<'_, T, S> {
    fn ingest(&mut self, event: Event) {
        if let Some(observer) = &mut self.thread.observer {
            observer(&event);
        }
        if matches!(event, Event::RunError(_)) {
            self.handle(event);
            return;
        }
        let mut expanded = std::mem::take(&mut self.expanded);
        expanded.clear();
        let result = self.normalizer.normalize(event, &mut expanded);
        for event in expanded.drain(..) {
            if !self.done {
                self.handle(event);
            }
        }
        self.expanded = expanded;
        if let Err(error) = result {
            self.diagnostic(error);
        }
    }
    fn handle(&mut self, event: Event) {
        // Pair the terminal with the stream's announced run even when optional
        // ordering verification is disabled. Run errors carry no IDs.
        match &event {
            Event::RunStarted(started) => {
                if started.thread_id != self.thread.thread_id
                    || started.run_id != self.request_run_id
                {
                    self.fail(Error::protocol(
                        "RUN_STARTED does not match the requested thread and run IDs",
                    ));
                    return;
                }
                self.response_ids = Some((started.thread_id.clone(), started.run_id.clone()));
            }
            Event::RunFinished(finished) => {
                if self.response_ids.as_ref()
                    != Some(&(finished.thread_id.clone(), finished.run_id.clone()))
                {
                    self.fail(Error::protocol("RUN_FINISHED does not match RUN_STARTED"));
                    return;
                }
                if let Some(RunOutcome::Interrupt { interrupts }) = &finished.outcome {
                    if let Err(error) =
                        unique(interrupts.iter().map(|i| i.id.as_str()), "interrupt")
                    {
                        self.fail(Error::protocol(error.to_string()));
                        return;
                    }
                }
            }
            _ => {}
        }
        if let Some(verifier) = &mut self.verifier {
            if let Err(error) = verifier.verify(&event) {
                if matches!(event, Event::RunFinished(_) | Event::RunError(_)) {
                    self.fail(error);
                } else {
                    self.diagnostic(error);
                }
                return;
            }
        }
        match self.thread.applier.apply(&event) {
            Ok(changed) => self.emit(changed),
            Err(error) if matches!(event, Event::RunFinished(_) | Event::RunError(_)) => {
                self.fail(error)
            }
            Err(error) => self.diagnostic(error),
        }
    }
    fn emit(&mut self, changed: Changed) {
        match changed {
            Changed::Nothing | Changed::RunStarted { .. } => {}
            Changed::Message(change) => {
                if let Some(message) = self.thread.applier.messages().get(change.index) {
                    self.ready.push_back(Update::Message(MessageUpdate {
                        index: change.index,
                        id: change.id,
                        change: change.kind,
                        message: message.clone(),
                    }));
                }
            }
            Changed::MessagesReplaced => self
                .ready
                .push_back(Update::Messages(self.thread.messages().to_vec())),
            Changed::State => match self.thread.applier.state_as::<S>() {
                Ok(state) => {
                    self.thread.state = Ok(state.clone());
                    self.ready.push_back(Update::State(state));
                }
                Err(error) => {
                    self.thread.state = Err(StateViewError {
                        message: match &error {
                            Error::State(error) => error.to_string(),
                            _ => error.to_string(),
                        },
                    });
                    self.diagnostic(error);
                }
            },
            Changed::Reasoning(change) => {
                let text = self
                    .thread
                    .applier
                    .reasoning_text(&change.id)
                    .unwrap_or_default()
                    .to_owned();
                self.ready.push_back(Update::Reasoning(ReasoningUpdate {
                    id: change.id,
                    change: change.kind,
                    text,
                }));
            }
            Changed::Subagent(change) => {
                if let Some(subagent) = self.thread.applier.subagents().get(change.index) {
                    self.ready.push_back(Update::Subagent(SubagentUpdate {
                        index: change.index,
                        run_id: change.run_id,
                        change: change.kind,
                        subagent: subagent.clone(),
                    }));
                }
            }
            Changed::RunFinished { outcome, result } => {
                self.thread.submission = None;
                match outcome {
                    RunOutcome::Success => {
                        self.thread.interrupts.clear();
                        self.terminate(RunEnd::Success { result });
                    }
                    RunOutcome::Interrupt { interrupts } => {
                        self.thread.interrupts.clone_from(&interrupts);
                        for interrupt in &interrupts {
                            self.ready.push_back(Update::Interrupt(interrupt.clone()));
                        }
                        self.terminate(RunEnd::Interrupted { interrupts });
                    }
                }
            }
            Changed::RunError { message, code } => {
                self.diagnostic(Error::Run {
                    message: message.clone(),
                    code: code.clone(),
                });
                self.thread.unconfirm();
                self.stop_subagents();
                self.terminate(RunEnd::Failed { message, code });
            }
        }
    }
}

impl<T: Transport, S: DeserializeOwned + Clone + Unpin> Stream for RunStream<'_, T, S> {
    type Item = Update<S>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        this.abort.state.waker.register(cx.waker());
        loop {
            // A terminal already applied wins over a later abort.
            if !this.done && this.abort.is_aborted() {
                if this.dispatched {
                    this.thread.unconfirm();
                    this.stop_subagents();
                }
                this.terminate(RunEnd::Aborted);
            }
            if let Some(update) = this.ready.pop_front() {
                return Poll::Ready(Some(update));
            }
            if this.done {
                return Poll::Ready(None);
            }
            if let Some((input, message)) = this.prepared.take() {
                // Expiry may have passed while the prepared stream sat unpolled.
                if let Some(entries) = &input.resume {
                    if let Err(error) = validate_responses(&this.thread.interrupts, entries, true) {
                        this.fail(error);
                        continue;
                    }
                }
                this.dispatched = true;
                this.thread.applier.reset_streams();
                this.thread.run_ids.insert(input.run_id.clone());
                this.thread.active_run_id = Some(input.run_id.clone());
                this.thread.next_run_id = None;
                if let Some(message) = message {
                    this.thread.applier.push_message(message);
                }
                if let Some(entries) = &input.resume {
                    this.thread.submission = Some(ResumeSubmission {
                        run_id: input.run_id.clone(),
                        entries: entries.clone(),
                        status: SubmissionStatus::InFlight,
                    });
                }
                this.events = Some(this.thread.agent.run_events(input));
            }
            match this
                .events
                .as_mut()
                .expect("dispatched run has a stream")
                .as_mut()
                .poll_next(cx)
            {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Some(Ok(event))) => this.ingest(event),
                Poll::Ready(Some(Err(error))) => this.fail(error),
                Poll::Ready(None) => {
                    let error = this
                        .verifier
                        .as_ref()
                        .and_then(|verifier| verifier.finish().err())
                        .unwrap_or_else(|| {
                            Error::protocol("the stream ended before RUN_FINISHED or RUN_ERROR")
                        });
                    this.fail(error);
                }
            }
        }
    }
}

fn random_id() -> Result<String> {
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

fn unique<'a>(ids: impl IntoIterator<Item = &'a str>, label: &str) -> Result<()> {
    let mut seen = HashSet::new();
    for id in ids {
        if id.is_empty() || !seen.insert(id) {
            return Err(Error::Snapshot(format!(
                "{label} ID {id:?} is empty or duplicated"
            )));
        }
    }
    Ok(())
}

fn validate_responses(pending: &[Interrupt], entries: &[ResumeEntry], expiry: bool) -> Result<()> {
    if pending.is_empty() {
        return Err(Error::Request("there are no pending interrupts".into()));
    }
    let mut seen = HashSet::new();
    for entry in entries {
        if !seen.insert(&entry.interrupt_id) {
            return Err(Error::Request(format!(
                "duplicate interrupt ID {}",
                entry.interrupt_id
            )));
        }
        let interrupt = pending
            .iter()
            .find(|interrupt| interrupt.id == entry.interrupt_id)
            .ok_or_else(|| {
                Error::Request(format!("unknown interrupt ID {}", entry.interrupt_id))
            })?;
        if expiry {
            if let Some(timestamp) = &interrupt.expires_at {
                let expires = chrono::DateTime::parse_from_rfc3339(timestamp).map_err(|_| {
                    Error::Request(format!(
                        "interrupt {} has an invalid expiry timestamp",
                        interrupt.id
                    ))
                })?;
                // RFC 3339 leap seconds can only end a UTC month.
                if expires.timestamp_subsec_nanos() >= 1_000_000_000 {
                    let utc_date = expires.naive_utc().date();
                    let ends_month = utc_date
                        .succ_opt()
                        .is_some_and(|next| chrono::Datelike::day(&next) == 1);
                    if expires.timestamp().rem_euclid(86_400) != 86_399 || !ends_month {
                        return Err(Error::Request(format!(
                            "interrupt {} has an invalid expiry timestamp",
                            interrupt.id
                        )));
                    }
                }
                // Preserve the previous parser's leap-second clamp and full year range.
                let expires_nanos = i128::from(expires.timestamp()) * 1_000_000_000
                    + i128::from(expires.timestamp_subsec_nanos().min(999_999_999));
                if expires_nanos <= now_unix_nanos() {
                    return Err(Error::Request(format!(
                        "interrupt {} has expired",
                        interrupt.id
                    )));
                }
            }
        }
    }
    if seen.len() != pending.len() {
        return Err(Error::Request(
            "every pending interrupt must be answered exactly once".into(),
        ));
    }
    Ok(())
}

fn validate_snapshot(snapshot: &ThreadSnapshot) -> Result<()> {
    if snapshot.version != 1 {
        return Err(Error::Snapshot(format!(
            "unsupported version {}",
            snapshot.version
        )));
    }
    if snapshot.thread_id.as_str().is_empty() {
        return Err(Error::Snapshot("empty thread ID".into()));
    }
    unique(
        snapshot
            .messages
            .iter()
            .map(|message| message.id().as_str()),
        "message",
    )?;
    unique(
        snapshot.reasoning.iter().map(|message| message.id.as_str()),
        "reasoning",
    )?;
    unique(
        snapshot
            .subagents
            .iter()
            .map(|subagent| subagent.run_id.as_str()),
        "subagent",
    )?;
    unique(
        snapshot
            .interrupts
            .iter()
            .map(|interrupt| interrupt.id.as_str()),
        "interrupt",
    )?;
    unique(snapshot.run_ids.iter().map(|id| id.as_str()), "run")?;
    if let Some(id) = &snapshot.active_run_id {
        if !snapshot.run_ids.contains(id) {
            return Err(Error::Snapshot(
                "active run refers to an unknown run ID".into(),
            ));
        }
    }
    for subagent in &snapshot.subagents {
        let mut seen = HashSet::from([subagent.run_id.as_str()]);
        let mut parent = subagent.parent_subagent_run_id.as_ref();
        while let Some(id) = parent {
            if !seen.insert(id.as_str()) {
                return Err(Error::Snapshot("cyclic subagent ancestry".into()));
            }
            let ancestor = snapshot
                .subagents
                .iter()
                .find(|subagent| &subagent.run_id == id)
                .ok_or_else(|| Error::Snapshot(format!("unknown parent subagent {id}")))?;
            parent = ancestor.parent_subagent_run_id.as_ref();
        }
    }
    if let Some(submission) = &snapshot.submission {
        if submission.status == SubmissionStatus::InFlight
            && snapshot.active_run_id.as_ref() != Some(&submission.run_id)
        {
            return Err(Error::Snapshot(
                "in-flight submission must reference the active run".into(),
            ));
        }
        if !snapshot.run_ids.contains(&submission.run_id) {
            return Err(Error::Snapshot(
                "submission refers to an unknown run ID".into(),
            ));
        }
        validate_responses(&snapshot.interrupts, &submission.entries, false)
            .map_err(|error| Error::Snapshot(error.to_string()))?;
    }
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn now_unix_nanos() -> i128 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    }
}
#[cfg(target_family = "wasm")]
fn now_unix_nanos() -> i128 {
    (js_sys::Date::now() * 1_000_000.0) as i128
}
