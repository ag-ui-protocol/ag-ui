//! Typestate handles that make protocol misuse a compile error.
//!
//! Every streaming construct in AG-UI is bracketed: `TEXT_MESSAGE_START` …
//! `TEXT_MESSAGE_END`, `TOOL_CALL_START` … `TOOL_CALL_END`, `STEP_STARTED` …
//! `STEP_FINISHED`. Handing an agent three raw `emit` calls per construct means
//! trusting it to close what it opened, in order, on every path including the
//! early return. This module hands out RAII handles instead:
//!
//! - creating a handle emits the opening event;
//! - the handle borrows the [`RunContext`](crate::server::RunContext) mutably, so a
//!   second overlapping handle is a **borrow-check error**, not a runtime
//!   protocol violation;
//! - `Drop` emits the terminator, so forgetting `end()` — or returning `Err`
//!   through a `?` halfway through a message — still produces a well-formed
//!   stream. That includes the `?` a cancelled run unwinds through: a
//!   terminator still goes out after cancellation, when nothing else does.
//!
//! ```compile_fail,E0499
//! use ag_ui::server::RunContext;
//!
//! fn interleave(ctx: &mut RunContext<()>) {
//!     let mut first = ctx.assistant_message().unwrap();
//!     // error[E0499]: cannot borrow `*ctx` as mutable more than once at a time
//!     let mut second = ctx.assistant_message().unwrap();
//!     first.delta("a").unwrap();
//!     second.delta("b").unwrap();
//! }
//! ```
//!
//! # Why the emit path is synchronous
//!
//! `Drop` cannot be async, so a handle cannot `await` while emitting its
//! terminator. `msg.delta(text)?` therefore does not take `.await`: emitters
//! push into a channel and the transport drains it. A configured
//! [`Runner::event_buffer_capacity`](crate::server::Runner::event_buffer_capacity)
//! rejects overflow with a terminal error instead of waiting. An earlier draft
//! copied `await`-ing emitters from the TypeScript and .NET SDKs; it cannot
//! coexist with the `Drop` guarantee.
//!
//! # The escape hatch
//!
//! [`StepGuard`] dereferences to the run context — a step is a scope, and
//! everything else nests inside it. The three streaming handles deliberately do
//! not, because that is exactly what would let a second message open inside the
//! first. They expose [`emit`](MessageHandle::emit) instead, for the unordered
//! events (state, activity, custom) that may legally interleave with a message.
//!
//! # What an open handle can still reach
//!
//! A handle borrows two *fields* of the run context — the event sink and the
//! state — rather than the context itself. So the state is reachable through
//! the handle ([`state`](ToolCallHandle::state),
//! [`state_mut`](ToolCallHandle::state_mut),
//! [`publish_state`](ToolCallHandle::publish_state)) and a tool call can do its
//! work between its arguments and its result: `STATE_*` is unordered, so a
//! publish inside the brackets is a legal stream.
//!
//! Widening reach, not weakening the rule. The context stays exclusively
//! borrowed for as long as the handle lives, so a second block is still a
//! borrow-check error — including from inside an open call:
//!
//! ```compile_fail,E0499
//! use ag_ui::server::RunContext;
//!
//! fn narrate(ctx: &mut RunContext<()>) {
//!     let mut call = ctx.tool_call("search").unwrap();
//!     // error[E0499]: cannot borrow `*ctx` as mutable more than once at a time
//!     let mut message = ctx.assistant_message().unwrap();
//!     call.args("{}").unwrap();
//! }
//! ```
//!
//! # What has no handle, and why that is the answer
//!
//! Two things an agent may legitimately put on the wire are
//! [`RunContext::emit`](crate::server::RunContext::emit) territory, and the escape
//! hatch is the supported path for both rather than a gap waiting for an API.
//!
//! The `*_CHUNK` family is unbracketed by definition: a chunk carries its own
//! id and needs no start and no end, which is the point — it exists for
//! provider adapters that cannot know a message ended until the next one
//! begins. There is nothing for an RAII handle to close, and wrapping one
//! around a self-contained event would only add a way to get it wrong.
//!
//! Interleaved parallel tool calls are the other. Two open [`ToolCallHandle`]s
//! at once is a borrow-check error *by design*, so a provider streaming
//! `args(a) args(b) args(a) end(a) end(b)` cannot be mirrored handle-for-call.
//! Either accumulate each call and emit it whole once its arguments are
//! complete — the only mapping that cannot
//! splice two calls' arguments into each other — or emit the interleaving
//! yourself. The verifier keys everything by id, so it accepts the interleaved
//! stream; what it will not let you do is close a call you never opened.
//!
//! # Subagents
//!
//! [`SubagentHandle`] is a scope in the sense [`StepGuard`] is: it dereferences
//! to the run context, and everything opened through it — messages, tool
//! calls, reasoning, steps, nested subagents — comes out carrying its
//! `subagentRunId`. The attribution lives in the event sink rather than in
//! the handles, which is why a [`MessageHandle`] opened inside a subagent
//! needs no idea that it was: the sink tags every attributable event that
//! arrives untagged while a scope is open, and leaves an event the agent
//! tagged explicitly alone.
//!
//! That last clause is the concurrent case. Subagents that stream at once are
//! the parallel-tool-call situation again: two open handles is a borrow-check
//! error by design, so build each subagent's events with
//! [`Event::with_subagent_run_id`] and [`emit`](crate::server::RunContext::emit)
//! them interleaved, bracketed by [`Event::subagent_started`] and
//! [`Event::subagent_finished_success`]. The verifier keys every entity by id
//! and remembers who opened it, so the interleaving is accepted; what it will
//! not let you do is continue one subagent's message under another's tag.
//! Attribute every chunk when several subagents stream at once — a chunk
//! that names neither a message nor a subagent can only be resolved when one
//! stream is open.

/// The run's state as an open handle reaches it: `state`, `state_mut` and
/// `publish_state`, the same on [`MessageHandle`], [`ReasoningHandle`] and
/// [`ToolCallHandle`], written once.
///
/// Each handle holds the event sink and the state as two fields, so these
/// reach nothing the handle does not already hold. The handle's own words
/// come first, as the doc of the `impl` block, then where its publish lands.
macro_rules! state_access {
    ($(#[$about:meta])* $handle:ident, published $place:literal) => {
        $(#[$about])*
        impl<S: $crate::server::agent::AgentState> $handle<'_, S> {
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
            /// `STATE_SNAPSHOT` or a `STATE_DELTA`
            #[doc = concat!($place, ".")]
            ///
            /// A no-op when nothing changed since the last publish.
            pub fn publish_state(&mut self) -> $crate::server::error::Result<()> {
                self.state.publish(self.sink)
            }
        }
    };
}

mod message;
mod reasoning;
mod step;
mod subagent;
mod tool;

use std::num::NonZeroUsize;

use crate::{
    Event, Message, MessageId, RunErrorEvent, StepName, SubagentErrorEvent, SubagentRunId,
    ToolCallId,
};
use futures_channel::mpsc::{UnboundedReceiver, UnboundedSender};
use futures_core::Stream;
use futures_util::StreamExt as _;

use crate::server::cancel::CancellationToken;
use crate::server::error::{Error, Result, Rule, VerificationError};
use crate::server::state::StateManager;
use crate::server::transform::{StreamTransformer, TransformerChain};
use crate::server::verify::Verifier;

pub use message::MessageHandle;
pub use reasoning::ReasoningHandle;
pub use step::StepGuard;
pub use subagent::SubagentHandle;
pub use tool::ToolCallHandle;

/// The write end of a run's event stream: transformers, then verification,
/// then the channel.
///
/// Not public: the only way to reach one is through a
/// [`RunContext`](crate::server::RunContext) or a handle, which is what keeps the
/// ordering guarantees intact.
pub(crate) struct EventSink {
    tx: UnboundedSender<Event>,
    chain: TransformerChain,
    verifier: Verifier,
    /// The state actually queued after all transformers, not the state the
    /// producer tried to publish before a transformer rewrote it.
    state_manager: StateManager,
    cancel: CancellationToken,
    /// Whether a terminal event has gone out. Tracked here as well as in the
    /// verifier so that turning the `verify` feature off cannot put anything
    /// on the wire after it — a second `RUN_FINISHED` included.
    terminated: bool,
    /// The subagent scope in force: every attributable event emitted untagged
    /// while it is set goes out carrying it. See [`SubagentHandle`].
    attribution: Option<SubagentRunId>,
    /// What is open with no handle of this driver to close it, in the order
    /// it was opened, so a cancelled run closes the innermost first. Kept
    /// here and not read off the verifier: it has to hold with the `verify`
    /// feature off, and a subagent's lifecycle has to survive a transformer
    /// that drops it from the output.
    unclosed: Vec<Unclosed>,
    event_buffer_capacity: Option<NonZeroUsize>,
    overflowed: bool,
}

impl std::fmt::Debug for EventSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventSink")
            .field("transformers", &self.chain.len())
            .field("cancelled", &self.cancel.is_cancelled())
            .field("attribution", &self.attribution)
            .finish()
    }
}

impl EventSink {
    pub(crate) fn new(
        tx: UnboundedSender<Event>,
        chain: TransformerChain,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            tx,
            chain,
            verifier: Verifier::new(),
            state_manager: StateManager::new(),
            cancel,
            terminated: false,
            attribution: None,
            unclosed: Vec::new(),
            event_buffer_capacity: None,
            overflowed: false,
        }
    }

    pub(crate) fn with_event_buffer_capacity(mut self, capacity: Option<NonZeroUsize>) -> Self {
        self.event_buffer_capacity = capacity;
        self
    }

    /// Tells the verifier and the transformers the conversation the run
    /// continues — the request's `messages` — before its first event.
    ///
    /// History the consumer already holds is not streamed again, and the
    /// `RUN_STARTED` echo that could carry it is optional. Without this a
    /// resumed run answering a call the interrupted run opened would read as
    /// a result for a call that never started.
    pub(crate) fn seed(&mut self, history: &[Message]) {
        self.verifier.seed(history);
        StreamTransformer::seed(&mut self.chain, history);
    }

    /// For a sink with no run driver behind it, which would have emitted
    /// `RUN_STARTED`: lets the verifier take the agent's first event.
    pub(crate) fn assume_run_started(&mut self) {
        self.verifier.assume_opened();
    }

    /// Shows the transformers the events a run has already sent, for a sink
    /// that continues the run. They are the output of an earlier chain, not
    /// events to transform: see [`StreamTransformer::replay`].
    pub(crate) fn show_sent(&mut self, sent: &[Event]) {
        StreamTransformer::replay(&mut self.chain, sent);
    }

    /// Records an event that was already sent, without sending it again:
    /// for a sink that continues a run. The event is one an earlier driver
    /// of the run sent, or one of a run before it on the same stream.
    ///
    /// Everything [`send`](Self::send) remembers about an event it queues is
    /// remembered here: the verifier's ordering state, the state the client
    /// holds, whether the run ended. What the earlier driver left open is
    /// read off the same events, which is what a consumer saw: the subagents
    /// that are active, and every message, tool call, reasoning block,
    /// reasoning message and step that has a start and no end. An entity a
    /// `*_CHUNK` event opened is not among them. It has no end event, and
    /// the run's terminal event ends its chunk stream.
    ///
    /// The transformers are not fed the event. What was sent is their
    /// output, which [`show_sent`](Self::show_sent) lets them learn from.
    pub(crate) fn replay(&mut self, event: &Event) -> Result<()> {
        let next_state = self.state_after(event)?;
        self.verifier.observe(event)?;
        self.terminated |= matches!(event, Event::RunFinished(_) | Event::RunError(_));
        if let Some(state) = next_state {
            self.state_manager.set_published(state);
        }
        match event {
            // What was sent may hold the runs that came before the one being
            // continued. Each starts with nothing open; the state a client
            // holds carries over.
            Event::RunStarted(_) => {
                self.terminated = false;
                self.unclosed.clear();
            }
            Event::SubagentStarted(started) => self.open_subagent(&started.subagent_run_id),
            Event::SubagentFinished(finished) => self.close_subagent(&finished.subagent_run_id),
            Event::SubagentError(error) => self.close_subagent(&error.subagent_run_id),
            _ => match Unclosed::opened_by(event) {
                Some(opened) => self.unclosed.push(opened),
                None => self.unclosed.retain(|open| !open.closed_by(event)),
            },
        }
        Ok(())
    }

    fn open_subagent(&mut self, id: &SubagentRunId) {
        let active = Unclosed::Subagent(id.clone());
        if !self.unclosed.contains(&active) {
            self.unclosed.push(active);
        }
    }

    fn close_subagent(&mut self, id: &SubagentRunId) {
        self.unclosed
            .retain(|open| !matches!(open, Unclosed::Subagent(active) if active == id));
    }

    /// The state a consumer holds once it has applied `event`: `None` for an
    /// event that leaves it alone, `Some(None)` for one that leaves it
    /// unknown.
    fn state_after(&self, event: &Event) -> Result<Option<Option<serde_json::Value>>> {
        Ok(match event {
            Event::StateSnapshot(snapshot) => Some(Some(snapshot.snapshot.clone())),
            Event::StateDelta(delta) => Some(self.state_manager.after_delta(&delta.delta)?),
            _ => None,
        })
    }

    /// Emits one event, unless the run was cancelled.
    ///
    /// Failing every emit after cancellation is what makes cancellation work
    /// without any cooperation from the agent: the next `?` unwinds the run.
    /// Terminators go through [`emit_forced`](Self::emit_forced) instead, so
    /// the unwinding still closes everything the run had open.
    pub(crate) fn emit(&mut self, event: Event) -> Result<()> {
        if self.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.emit_forced(event)
    }

    /// Publishes a typed state relative to the events the client will see.
    /// A transformer may drop, insert, or rewrite state events, so the sink's
    /// own send path is the only place that advances this baseline.
    pub(crate) fn publish_state(&mut self, next: serde_json::Value) -> Result<()> {
        match self.state_manager.decide(&next)?.into_event() {
            Some(event) => self.emit(event),
            None => Ok(()),
        }
    }

    /// Emits one event even after cancellation — used for terminators: the
    /// run driver's `RUN_FINISHED` and `RUN_ERROR`, and the event each handle
    /// closes with. AG-UI 1.0 requires a cancelled run to close what it opened
    /// before the `RUN_FINISHED` that cancels it, so these must go out
    /// regardless.
    pub(crate) fn emit_forced(&mut self, mut event: Event) -> Result<()> {
        if self.overflowed {
            return Err(Error::EventBufferFull {
                capacity: self
                    .event_buffer_capacity
                    .expect("overflow requires a limit")
                    .get(),
            });
        }
        if matches!(event, Event::RunFinished(_)) {
            if let Some(open) = self.unclosed.first() {
                let detail = open.still_open();
                return Err(
                    VerificationError::new(event.event_type(), Rule::OpenAtFinish, detail).into(),
                );
            }
        }
        let lifecycle = match &event {
            Event::SubagentStarted(started) => Some((started.subagent_run_id.clone(), true)),
            Event::SubagentFinished(finished) => Some((finished.subagent_run_id.clone(), false)),
            Event::SubagentError(error) => Some((error.subagent_run_id.clone(), false)),
            _ => None,
        };
        // Attribution is applied before the transformers, so a transformer
        // sees the same tagged stream a consumer would. An event the agent
        // tagged itself keeps its tag: that is how a hand-interleaved
        // concurrent stream is written.
        if let Some(id) = &self.attribution {
            if event.event_type().is_attributable() && event.subagent_run_id().is_none() {
                event.set_subagent_run_id(id.clone());
            }
        }
        if self.chain.is_empty() {
            self.send(event)?;
        } else {
            for event in self.chain.transform(event) {
                self.send(event)?;
            }
        }
        if let Some((id, opened)) = lifecycle {
            if opened {
                self.open_subagent(&id);
            } else {
                self.close_subagent(&id);
            }
        }
        Ok(())
    }

    /// Closes what is open with no handle to close it, innermost first: a
    /// subagent with `SUBAGENT_ERROR` naming `error`, and what an earlier
    /// driver of the run left open with its end event, under the subagent
    /// that opened it.
    ///
    /// For the run driver when a run is cancelled. A dropped
    /// [`SubagentHandle`] does not invent an ending, and the schema has no
    /// cancelled outcome for a subagent; an error carrying the cancellation's
    /// code is the one ending that neither claims success nor claims the
    /// invocation is waiting. An entity inherited from an earlier driver has
    /// no handle here at all, and the agent's own end event for it fails
    /// once the run is cancelled, like any other emit.
    ///
    /// Stops at the first event that cannot be sent: whatever is left open
    /// then makes `RUN_FINISHED` fail, and the driver reports that instead.
    pub(crate) fn close_unclosed(&mut self, error: &Error) {
        for open in self.unclosed.clone().into_iter().rev() {
            if self.emit_forced(open.closing(error)).is_err() {
                return;
            }
        }
    }

    /// The subagent scope in force, if any.
    pub(crate) fn attribution(&self) -> Option<&SubagentRunId> {
        self.attribution.as_ref()
    }

    /// Replaces the subagent scope and returns the previous one, so a nested
    /// scope can restore it on close.
    pub(crate) fn set_attribution(
        &mut self,
        attribution: Option<SubagentRunId>,
    ) -> Option<SubagentRunId> {
        std::mem::replace(&mut self.attribution, attribution)
    }

    fn send(&mut self, event: Event) -> Result<()> {
        if self.tx.is_closed() {
            return Err(Error::Disconnected);
        }
        // The verifier says the same when it is compiled in. This check is
        // here so that leaving it out cannot put events past the end of a run
        // on the wire.
        if self.terminated {
            return Err(VerificationError::new(
                event.event_type(),
                Rule::RunEnded,
                "the run already ended",
            )
            .into());
        }
        if event.event_type().as_str().starts_with("THINKING_") {
            return Err(crate::Error::Protocol(
                "THINKING_* events are retired in AG-UI 1.0; emit REASONING_* events".into(),
            )
            .into());
        }
        if let Some(capacity) = self.event_buffer_capacity {
            if self.tx.len() >= capacity.get() {
                let error = Error::EventBufferFull {
                    capacity: capacity.get(),
                };
                let terminal =
                    Event::from(RunErrorEvent::new(error.to_string()).with_code(error.code()));
                self.verifier.observe(&terminal)?;
                self.tx
                    .unbounded_send(terminal)
                    .map_err(|_| Error::Disconnected)?;
                self.terminated = true;
                self.overflowed = true;
                self.tx.close_channel();
                return Err(error);
            }
        }
        let next_state = self.state_after(&event)?;
        self.verifier.observe(&event)?;
        self.terminated |= matches!(event, Event::RunFinished(_) | Event::RunError(_));
        // What an earlier driver left open is closed by whoever sends its
        // end: the agent, naming its id, or the driver for a cancelled run.
        if !self.unclosed.is_empty() {
            self.unclosed.retain(|open| !open.closed_by(&event));
        }
        self.tx
            .unbounded_send(event)
            .map_err(|_| Error::Disconnected)?;
        if let Some(state) = next_state {
            self.state_manager.set_published(state);
        }
        Ok(())
    }

    /// Whether a terminal event has already gone out.
    pub(crate) fn is_terminated(&self) -> bool {
        self.terminated
    }

    pub(crate) fn cancel_token(&self) -> &CancellationToken {
        &self.cancel
    }
}

/// Something a run has open that no handle of its driver will close.
///
/// A subagent that is active: a dropped [`SubagentHandle`] invents no ending
/// for it. And, in a sink that continues a run, what the earlier driver left
/// open, each with the subagent that opened it: the handle that would have
/// closed it went with that driver.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Unclosed {
    Subagent(SubagentRunId),
    Message(MessageId, Option<SubagentRunId>),
    ToolCall(ToolCallId, Option<SubagentRunId>),
    ReasoningMessage(MessageId, Option<SubagentRunId>),
    ReasoningBlock(MessageId, Option<SubagentRunId>),
    Step(StepName, Option<SubagentRunId>),
}

impl Unclosed {
    /// What an event that was already sent opened, when it is something an
    /// end event closes. A subagent is not: its lifecycle is followed apart.
    fn opened_by(event: &Event) -> Option<Self> {
        Some(match event {
            Event::TextMessageStart(e) => {
                Self::Message(e.message_id.clone(), e.subagent_run_id.clone())
            }
            Event::ToolCallStart(e) => {
                Self::ToolCall(e.tool_call_id.clone(), e.subagent_run_id.clone())
            }
            Event::ReasoningMessageStart(e) => {
                Self::ReasoningMessage(e.message_id.clone(), e.subagent_run_id.clone())
            }
            Event::ReasoningStart(e) => {
                Self::ReasoningBlock(e.message_id.clone(), e.subagent_run_id.clone())
            }
            Event::StepStarted(e) => Self::Step(e.step_name.clone(), e.subagent_run_id.clone()),
            _ => return None,
        })
    }

    /// Whether `event` is the end event of this.
    fn closed_by(&self, event: &Event) -> bool {
        match (self, event) {
            (Self::Message(id, _), Event::TextMessageEnd(e)) => id == &e.message_id,
            (Self::ToolCall(id, _), Event::ToolCallEnd(e)) => id == &e.tool_call_id,
            (Self::ReasoningMessage(id, _), Event::ReasoningMessageEnd(e)) => id == &e.message_id,
            (Self::ReasoningBlock(id, _), Event::ReasoningEnd(e)) => id == &e.message_id,
            // A step is its owner's: a subagent and its parent may each run
            // one of the same name.
            (Self::Step(name, owner), Event::StepFinished(e)) => {
                name == &e.step_name && owner == &e.subagent_run_id
            }
            _ => false,
        }
    }

    /// The event that closes it in a run that stops because of `error`.
    fn closing(&self, error: &Error) -> Event {
        let (mut end, owner) = match self {
            Self::Subagent(id) => {
                let stopped = SubagentErrorEvent::new(id.clone(), error.to_string());
                return stopped.with_code(error.code()).into();
            }
            Self::Message(id, owner) => (Event::text_message_end(id.clone()), owner),
            Self::ToolCall(id, owner) => (Event::tool_call_end(id.clone()), owner),
            Self::ReasoningMessage(id, owner) => (Event::reasoning_message_end(id.clone()), owner),
            Self::ReasoningBlock(id, owner) => (Event::reasoning_end(id.clone()), owner),
            Self::Step(name, owner) => (Event::step_finished(name.clone()), owner),
        };
        if let Some(owner) = owner {
            end.set_subagent_run_id(owner.clone());
        }
        end
    }

    /// What a `RUN_FINISHED` that is refused because of it says.
    fn still_open(&self) -> String {
        match self {
            Self::Subagent(id) => {
                format!("subagent '{id}' requires an explicit finish, fail or suspend")
            }
            Self::Message(id, _) => format!("message {:?} is still open", id.as_str()),
            Self::ToolCall(id, _) => format!("tool call {:?} is still open", id.as_str()),
            Self::ReasoningMessage(id, _) => {
                format!("reasoning message {:?} is still open", id.as_str())
            }
            Self::ReasoningBlock(id, _) => {
                format!("reasoning block {:?} is still open", id.as_str())
            }
            Self::Step(name, None) => format!("step {:?} is still open", name.as_str()),
            Self::Step(name, Some(owner)) => format!(
                "step {:?} is still open under subagent {:?}",
                name.as_str(),
                owner.as_str()
            ),
        }
    }
}

/// The read end of a run's event stream.
///
/// Yielded by [`RunContext::new`](crate::server::RunContext::new) for agents under
/// test, and by [`Runner::into_parts`](crate::server::Runner::into_parts) and
/// [`Runner::continue_run`](crate::server::Runner::continue_run) for a run
/// that is driven apart from whoever reads it. Transports that answer one
/// request get a [`Stream`] from [`Runner::run`](crate::server::Runner::run)
/// instead.
///
/// It is a [`Stream`] of the run's events, and it ends when the driver has
/// finished or dropped, or when a bounded queue overflowed.
#[derive(Debug)]
pub struct EventReceiver {
    rx: UnboundedReceiver<Event>,
}

impl EventReceiver {
    pub(crate) fn new(rx: UnboundedReceiver<Event>) -> Self {
        Self { rx }
    }

    /// Takes every event emitted so far without waiting.
    ///
    /// The emit path is synchronous, so after calling an agent's code
    /// everything it emitted is already queued. That makes this the whole
    /// assertion story for a unit test:
    ///
    /// ```
    /// # use ag_ui::{Event, RunAgentInput, TextMessageRole};
    /// # use ag_ui::server::RunContext;
    /// let (mut ctx, mut events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
    /// ctx.say("hello")?;
    /// assert_eq!(events.drain(), vec![
    ///     Event::text_message_start("r-msg-1", TextMessageRole::Assistant),
    ///     Event::text_message_content("r-msg-1", "hello"),
    ///     Event::text_message_end("r-msg-1"),
    /// ]);
    /// # Ok::<(), ag_ui::server::Error>(())
    /// ```
    pub fn drain(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        while let Ok(event) = self.rx.try_recv() {
            events.push(event);
        }
        events
    }

    /// Closes the channel, so the next emit fails with
    /// [`Error::Disconnected`].
    ///
    /// Unlike dropping the receiver, this keeps what was already emitted: a
    /// consumer that stops accepting events can still read the ones queued.
    ///
    /// ```
    /// # use ag_ui::RunAgentInput;
    /// # use ag_ui::server::RunContext;
    /// let (mut ctx, mut events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
    /// ctx.say("before")?;
    ///
    /// events.close();
    /// assert!(ctx.say("after").is_err_and(|error| error.is_disconnected()));
    /// assert_eq!(events.drain().len(), 3);
    /// # Ok::<(), ag_ui::server::Error>(())
    /// ```
    ///
    /// [`Error::Disconnected`]: crate::server::Error::Disconnected
    pub fn close(&mut self) {
        self.rx.close();
    }
}

impl Stream for EventReceiver {
    type Item = Event;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Event>> {
        self.rx.poll_next_unpin(cx)
    }
}
