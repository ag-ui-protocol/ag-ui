//! The driver: an [`Agent`] plus a [`RunAgentInput`] in, a [`Stream`] of
//! events out.
//!
//! The stream owns the agent's future and polls it itself, so this crate needs
//! no executor of its own — no `tokio::spawn`, nothing to configure, and the
//! same code runs on wasm. Draining the stream *is* running the agent.
//!
//! ```
//! # use ag_ui::{Event, RunAgentInput, RunOutcome};
//! # use ag_ui::server::{Agent, Result, RunContext, run};
//! # use futures_util::StreamExt;
//! struct Greeter;
//!
//! impl Agent for Greeter {
//!     type State = ();
//!     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
//!         ctx.say("hello")?;
//!         Ok(RunOutcome::Success)
//!     }
//! }
//!
//! # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
//! # rt.block_on(async {
//! let events: Vec<Event> = run(Greeter, RunAgentInput::new("thread-1", "run-1"))
//!     .collect()
//!     .await;
//!
//! assert_eq!(events.first().map(Event::event_type), Some(ag_ui::EventType::RunStarted));
//! assert_eq!(events.last().map(Event::event_type), Some(ag_ui::EventType::RunFinished));
//! # });
//! ```
//!
//! # A run that outlives its response
//!
//! Draining the stream is running the agent, so the agent stops where it is
//! when the stream is dropped, and one stream has one reader. A request and
//! its response need no more. A server whose runs go on after the client
//! that started them has gone does: a second client on the same thread, a
//! client that joins a run in progress, a run that another process carries
//! on.
//!
//! Such a server stores the events and fans them out itself. Admission,
//! storage and recovery are its own. What it takes from here:
//!
//! - [`Runner::into_parts`] hands out the future that drives the agent and
//!   the receiver of what it emits. The driver goes on an executor the
//!   server chooses, and the events go to its store.
//! - [`Runner::continue_run`] drives a run that another driver began, from
//!   the events already sent: no second `RUN_STARTED`, and ordering checks
//!   that start where the run is. A server that builds its events by hand
//!   does the same with `EventVerifier::replay`, in [`verify`].
//! - [`RunProgress`] folds the events of a run so far into what the run has
//!   open, and builds the prelude a client that joins it is sent first. A
//!   client's stream has to begin with `RUN_STARTED`, so the prelude does,
//!   and it stands for the events already sent: a client is sent one or the
//!   other, never both.
//!
//! None of these spawns anything. The crate still has no executor of its
//! own.
//!
//! [`verify`]: crate::server::verify
//! [`RunProgress`]: crate::server::RunProgress

use std::future::Future;
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::{
    Event, EventType, RunAgentInput, RunErrorEvent, RunFinishedEvent, RunId, RunOutcome,
    RunStartedEvent, ThreadId, TokenUsage,
};
use futures_channel::mpsc;
use futures_core::Stream;
use futures_util::StreamExt as _;

use crate::server::agent::Agent;
use crate::server::cancel::CancellationToken;
use crate::server::context::{RunContext, Terminal, decode_state};
use crate::server::emit::{EventReceiver, EventSink};
use crate::server::error::{Error, Result, Rule, VerificationError};
use crate::server::transform::{StreamTransformer, TransformerChain};

/// Runs `agent` against `input` with no transformers and a fresh cancellation
/// token.
///
/// [`Runner`] is the same thing with knobs.
pub fn run<A: Agent>(agent: A, input: RunAgentInput) -> impl Stream<Item = Event> + Send {
    Runner::new(agent).run(input)
}

/// A configured run: the agent, its transformer chain and its cancellation
/// token.
///
/// ```
/// # use ag_ui::{RunAgentInput, RunOutcome};
/// # use ag_ui::server::{Agent, FilterToolCalls, Result, RunContext, Runner};
/// # struct MyAgent;
/// # impl Agent for MyAgent {
/// #     type State = ();
/// #     async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> { Ok(RunOutcome::Success) }
/// # }
/// let runner = Runner::new(MyAgent).transformer(FilterToolCalls::deny(["internal_debug"]));
/// let token = runner.cancellation_token();   // hand this to the transport
/// let stream = runner.run(RunAgentInput::new("thread-1", "run-1"));
/// # let _ = (token, stream);
/// ```
pub struct Runner<A> {
    agent: A,
    chain: TransformerChain,
    cancel: CancellationToken,
    echo_input: bool,
    event_buffer_capacity: Option<NonZeroUsize>,
}

// Hand-written so that `Runner` is printable whatever the agent is: requiring
// `A: Debug` would make the bound viral through every wrapper that holds one.
impl<A> std::fmt::Debug for Runner<A> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runner")
            .field("agent", &std::any::type_name::<A>())
            .field("chain", &self.chain)
            .field("cancel", &self.cancel)
            .field("echo_input", &self.echo_input)
            .field("event_buffer_capacity", &self.event_buffer_capacity)
            .finish()
    }
}

impl<A> Runner<A> {
    /// Wraps an agent.
    pub fn new(agent: A) -> Self {
        Self {
            agent,
            chain: TransformerChain::new(),
            cancel: CancellationToken::new(),
            echo_input: false,
            event_buffer_capacity: None,
        }
    }

    /// Appends a transformer to the chain. See [`StreamTransformer`].
    #[must_use]
    pub fn transformer(mut self, transformer: impl StreamTransformer + 'static) -> Self {
        self.chain.push(transformer);
        self
    }

    /// Replaces the whole transformer chain.
    #[must_use]
    pub fn transformers(mut self, chain: TransformerChain) -> Self {
        self.chain = chain;
        self
    }

    /// Uses an existing cancellation token instead of the fresh one.
    #[must_use]
    pub fn cancellation(mut self, token: CancellationToken) -> Self {
        self.cancel = token;
        self
    }

    /// A handle on this run's cancellation, for the transport to trip when the
    /// client disconnects.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// Echoes the request back on `RUN_STARTED`, so a recorded stream replays
    /// without the original HTTP body. Off by default — it is the largest
    /// payload in the protocol.
    ///
    /// This decides only what goes on the wire. The verifier and every
    /// transformer learn the request's history either way (see
    /// [`StreamTransformer::seed`]), so a resumed run behaves the same with
    /// and without the echo.
    #[must_use]
    pub fn echo_input(mut self, echo: bool) -> Self {
        self.echo_input = echo;
        self
    }

    /// Limits queued events, including lifecycle events, after transformation.
    ///
    /// Emission is synchronous, so it cannot wait for a slow consumer. When
    /// full, the sink rejects the next event, appends one reserved `RUN_ERROR`
    /// with code `EVENT_BUFFER_FULL`, then closes the stream. Already accepted
    /// events retain their order. This terminal error bypasses transformers.
    ///
    /// The default remains unbounded. This bounds event count, not payload
    /// bytes or allocations made by an agent/transformer before emission.
    /// Applications with durable execution should reconnect from committed
    /// state; this transport failure does not decide business success.
    #[must_use]
    pub fn event_buffer_capacity(mut self, capacity: NonZeroUsize) -> Self {
        self.event_buffer_capacity = Some(capacity);
        self
    }
}

impl<A: Agent> Runner<A> {
    /// Starts the run.
    ///
    /// The returned stream emits `RUN_STARTED` first and exactly one of
    /// `RUN_FINISHED` / `RUN_ERROR` last — including when the agent body does
    /// nothing, and when it returns `Err` through a `?`.
    ///
    /// The stream yields [`Event`], not `Result<Event>`: whatever goes wrong
    /// inside a run is reported in the stream, as `RUN_ERROR`, so there is no
    /// error left for an item to carry.
    ///
    /// A panic inside the agent is not caught; it unwinds through whoever is
    /// polling the stream, as it would through any other future. Use the
    /// transport's own panic handling if you need a response body for that
    /// case.
    ///
    /// # The run lives as long as the stream
    ///
    /// The agent advances only while the stream is polled, and is dropped
    /// with it. A stream dropped before its terminal event leaves a run that
    /// stopped where it was: no `RUN_FINISHED` and no `RUN_ERROR`, for
    /// anyone. That is the right lifetime for a run that answers one
    /// request, where the response body is the stream and a client that goes
    /// away takes the run with it.
    ///
    /// It is the wrong one for a run that outlives its response. Take the
    /// halves with [`into_parts`](Self::into_parts) instead; the [module
    /// docs](self#a-run-that-outlives-its-response) say what else such a
    /// server needs.
    pub fn run(self, input: RunAgentInput) -> impl Stream<Item = Event> + Send {
        let (driver, events) = self.into_parts(input);
        RunStream {
            driver: Some(Box::pin(driver)),
            events,
        }
    }

    /// Starts the run as its two halves: the future that drives the agent,
    /// and the receiver of what it emits.
    ///
    /// For a run that is not tied to one response. Put the driver on an
    /// executor of your choosing and send the events wherever they are
    /// stored and fanned out. The agent then advances whether or not anyone
    /// is reading, and a client that disconnects ends nothing.
    ///
    /// Everything [`run`](Self::run) promises holds for the halves:
    /// `RUN_STARTED` first, exactly one terminal event last, the transformer
    /// chain, the cancellation token, the typed emitters and the ordering
    /// checks. `run` is these two halves joined in one stream.
    ///
    /// ```
    /// # use ag_ui::{Event, EventType, RunAgentInput, RunOutcome};
    /// # use ag_ui::server::{Agent, Result, RunContext, Runner};
    /// # use futures_util::StreamExt;
    /// # struct Greeter;
    /// # impl Agent for Greeter {
    /// #     type State = ();
    /// #     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
    /// #         ctx.say("hello")?;
    /// #         Ok(RunOutcome::Success)
    /// #     }
    /// # }
    /// # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    /// # rt.block_on(async {
    /// let runner = Runner::new(Greeter);
    /// let (driver, mut events) = runner.into_parts(RunAgentInput::new("thread-1", "run-1"));
    ///
    /// // Any executor will do: the driver is a plain future.
    /// let run = tokio::spawn(driver);
    ///
    /// // Store each event, and send it to whoever is on the thread now.
    /// let mut stored = Vec::new();
    /// while let Some(event) = events.next().await {
    ///     stored.push(event);
    /// }
    /// // The receiver ended, so nothing more will arrive: stop the driver.
    /// run.abort();
    ///
    /// assert_eq!(stored.first().map(Event::event_type), Some(EventType::RunStarted));
    /// assert_eq!(stored.last().map(Event::event_type), Some(EventType::RunFinished));
    /// # });
    /// ```
    ///
    /// # What the stream did for you
    ///
    /// Three things, which are now the caller's:
    ///
    /// - **Poll the driver to completion.** The terminal event is emitted by
    ///   the driver, after the agent returns. A driver dropped earlier ends
    ///   the receiver with no terminal event.
    /// - **Drop the driver when the receiver ends.** The receiver ends when
    ///   the driver has finished, and also when a bounded queue overflows
    ///   ([`event_buffer_capacity`](Self::event_buffer_capacity)): the sink
    ///   then queues its `RUN_ERROR` and closes. An agent that ignores the
    ///   error its emit returned can go on awaiting forever, and nothing it
    ///   does after that reaches anyone.
    /// - **Keep the receiver, or cancel.** Dropping the receiver fails every
    ///   later emit with [`Error::Disconnected`], which unwinds an agent that
    ///   uses `?`. To stop a run on purpose, trip the
    ///   [`cancellation_token`](Self::cancellation_token): the run then
    ///   closes what it opened and ends with a cancelled `RUN_FINISHED`.
    ///
    /// The receiver holds one run's events for one reader. Giving them to
    /// several clients, and to one that joins later, is the application's:
    /// [`RunProgress`](crate::server::RunProgress) builds what a client that
    /// joins a run in progress is sent first.
    pub fn into_parts(
        self,
        input: RunAgentInput,
    ) -> (impl Future<Output = ()> + Send, EventReceiver) {
        let echo_input = self.echo_input;
        let (agent, sink, events) = self.split(&input.run_id);
        let opening = Opening::Start { echo_input };
        (drive(agent, input, sink, opening), events)
    }

    /// Carries on a run that another driver began: the same halves as
    /// [`into_parts`](Self::into_parts), for a run whose first events are
    /// already sent.
    ///
    /// `sent` is every event of the run that went out, in order, as stored.
    /// It may begin with the runs that came before on the same stream; the
    /// run continued is the last one it starts. `input` is the request the
    /// run is continued from: the thread and run ids of the run, the
    /// `messages` it started with, and the state as it stands now, which
    /// the agent reads as its own.
    ///
    /// The driver emits no `RUN_STARTED`, and it ends the run with exactly
    /// one terminal event, as any driver does. What it emits continues the
    /// stream that `sent` began:
    ///
    /// - the ordering checks start from where the run is, so an entity the
    ///   earlier driver left open can be continued and closed, and has to be
    ///   closed before `RUN_FINISHED`;
    /// - the first state the agent publishes is compared with the state the
    ///   events sent left a client holding, and goes out as a delta against
    ///   it;
    /// - a subagent left active is closed by the agent, or by the driver when
    ///   the run is cancelled;
    /// - the ids the context hands out count on from the ones `sent` used,
    ///   and are never one of them.
    ///
    /// The transformers start fresh. They are seeded with `input.messages`
    /// and then shown `sent` ([`StreamTransformer::replay`]), and from there
    /// they are fed what the agent emits. `sent` is the output of the earlier
    /// driver's chain, so a transformer learns from it what a consumer was
    /// sent, and not what that chain kept back:
    /// [`FilterToolCalls`](crate::server::FilterToolCalls) lets this driver
    /// finish and answer a call that was sent, and drops an event of a call
    /// it has no record of, which is what a call the earlier filter dropped
    /// looks like from here.
    ///
    /// An entity the earlier driver opened has no handle here. Continue and
    /// close it with [`RunContext::emit`], naming its id. A run that is
    /// cancelled cannot: every emit fails once the token is tripped. So the
    /// driver closes what `sent` left open before the `RUN_FINISHED` that
    /// cancels the run, innermost first and each under the subagent that
    /// opened it: a message, a tool call, a reasoning message, a reasoning
    /// block, a step. A run that is not cancelled has to close them itself,
    /// and its `RUN_FINISHED` is refused while one is open, with the
    /// `verify` feature or without.
    /// [`echo_input`](Self::echo_input) has nothing to echo on, since no
    /// `RUN_STARTED` is sent.
    ///
    /// ```
    /// # use ag_ui::{Event, EventType, RunAgentInput, RunOutcome, TextMessageRole};
    /// # use ag_ui::server::{Agent, Result, RunContext, Runner};
    /// # use futures_util::StreamExt;
    /// /// Finishes the sentence another process left open.
    /// struct Finisher;
    ///
    /// impl Agent for Finisher {
    ///     type State = ();
    ///     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
    ///         ctx.emit(Event::text_message_content("msg-1", " world"))?;
    ///         ctx.emit(Event::text_message_end("msg-1"))?;
    ///         Ok(RunOutcome::Success)
    ///     }
    /// }
    ///
    /// # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    /// # rt.block_on(async {
    /// // What the store holds of the run: the process driving it stopped here.
    /// let sent = [
    ///     Event::run_started("thread-1", "run-1"),
    ///     Event::text_message_start("msg-1", TextMessageRole::Assistant),
    ///     Event::text_message_content("msg-1", "Hello"),
    /// ];
    ///
    /// let request = RunAgentInput::new("thread-1", "run-1");
    /// let (driver, events) = Runner::new(Finisher).continue_run(request, &sent)?;
    /// tokio::spawn(driver);
    ///
    /// let rest: Vec<EventType> = events.map(|event| event.event_type()).collect().await;
    /// assert_eq!(
    ///     rest,
    ///     [
    ///         EventType::TextMessageContent,
    ///         EventType::TextMessageEnd,
    ///         EventType::RunFinished,
    ///     ]
    /// );
    /// # Ok::<(), ag_ui::server::Error>(())
    /// # })?;
    /// # Ok::<(), ag_ui::server::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// Nothing is driven and nothing is emitted when there is no run to
    /// continue:
    ///
    /// - [`Error::Verification`] when `sent` holds no `RUN_STARTED`, when
    ///   the last run it starts already ended, or, with the `verify`
    ///   feature, when an event in it breaks the ordering rules: the error
    ///   is that event's;
    /// - [`Error::Json`] when a `STATE_DELTA` in `sent` carries a patch that
    ///   is not well formed;
    /// - [`Error::Protocol`] when `input` names another thread or run than
    ///   the last `RUN_STARTED` in `sent`.
    pub fn continue_run(
        self,
        input: RunAgentInput,
        sent: &[Event],
    ) -> Result<(impl Future<Output = ()> + Send + use<A>, EventReceiver)> {
        let (agent, mut sink, events) = self.split(&input.run_id);
        // As the first driver did before its first event: a result in `sent`
        // may answer a call the request's history introduced.
        sink.seed(&input.messages);
        // Then what the first driver sent: this one finishes and answers
        // calls that one opened.
        sink.show_sent(sent);
        let mut started = None;
        let mut ended = None;
        for event in sent {
            sink.replay(event)?;
            match event {
                // The run to continue is the last one `sent` starts: the
                // ones before it are the stream's history.
                Event::RunStarted(event) => {
                    started = Some(event);
                    ended = None;
                }
                Event::RunFinished(_) | Event::RunError(_) => ended = Some(event.event_type()),
                _ => {}
            }
        }
        let nothing_to_continue = |event, rule, why: &str| {
            let detail = format!("there is no run to continue: {why}");
            Error::from(VerificationError::new(event, rule, detail))
        };
        if let Some(terminal) = ended {
            return Err(nothing_to_continue(
                terminal,
                Rule::RunEnded,
                "the run already ended",
            ));
        }
        let Some(started) = started else {
            return Err(nothing_to_continue(
                EventType::RunStarted,
                Rule::OutOfOrder,
                "no RUN_STARTED was sent",
            ));
        };
        if started.thread_id != input.thread_id || started.run_id != input.run_id {
            return Err(Error::Protocol(crate::Error::Protocol(format!(
                "the run that was started is {:?} on thread {:?}, and the input to continue it \
                 names run {:?} on thread {:?}",
                started.run_id.as_str(),
                started.thread_id.as_str(),
                input.run_id.as_str(),
                input.thread_id.as_str(),
            ))));
        }
        Ok((drive(agent, input, sink, Opening::Continue), events))
    }

    /// The agent, the write end of its event stream and the read end.
    fn split(self, run_id: &RunId) -> (A, EventSink, EventReceiver) {
        let Self {
            agent,
            chain,
            cancel,
            echo_input: _,
            event_buffer_capacity,
        } = self;
        let (tx, rx) = mpsc::unbounded();
        let sink = EventSink::new(run_id.clone(), tx, chain, cancel)
            .with_event_buffer_capacity(event_buffer_capacity);
        (agent, sink, EventReceiver::new(rx))
    }
}

/// How a driver opens its part of the run.
enum Opening {
    /// With `RUN_STARTED`: the run begins here.
    Start { echo_input: bool },
    /// With nothing: an earlier driver began the run, and the sink already
    /// holds what it sent.
    Continue,
}

/// Opens the run, runs the agent, and emits the terminal event.
///
/// Takes the sink by value and only hands it to the context for the duration of
/// the agent's call: whatever happens in there, the terminal event still goes
/// through the same transformers and the same verifier.
async fn drive<A: Agent>(agent: A, input: RunAgentInput, mut sink: EventSink, opening: Opening) {
    let thread_id = input.thread_id.clone();
    let run_id = input.run_id.clone();

    if let Opening::Start { echo_input } = opening {
        // Seed history whether or not the client asked for an input echo.
        sink.seed(&input.messages);
        let mut started = RunStartedEvent::new(thread_id.clone(), run_id.clone());
        started.parent_run_id = input.parent_run_id.clone();
        if echo_input {
            started.input = Some(Box::new(input.clone()));
        }
        if sink.emit_forced(started.into()).is_err() {
            return;
        }
    }

    // Decoded before the match so the borrow of `input` ends here: the context
    // takes the input by value on the next line.
    let decoded = decode_state::<A::State>(&input.state);
    let (outcome, terminal) = match decoded {
        Ok(state) => {
            let mut ctx = RunContext::from_parts(input, state, sink);
            let outcome = agent.run(&mut ctx).await;
            if ctx.is_terminated() {
                // The agent emitted its own terminal event through `emit`.
                return;
            }
            let terminal;
            (sink, terminal) = ctx.into_parts();
            (outcome, terminal)
        }
        Err(error) => (Err(error), Terminal::default()),
    };

    terminate(&mut sink, outcome, terminal, &thread_id, &run_id);
}

/// Emits exactly one terminal event, carrying the result and usage the agent
/// reported through its context.
fn terminate(
    sink: &mut EventSink,
    outcome: Result<RunOutcome>,
    terminal: Terminal,
    thread_id: &ThreadId,
    run_id: &RunId,
) {
    // AG-UI 1.0, "Cancelled runs": a cancelled run closes what it opened
    // before the RUN_FINISHED that cancels it. The handles closed theirs on
    // the way out. Two things have no handle to close them. A subagent the
    // agent left active has no ending to infer, so the driver reports it as
    // stopped by the cancellation. And what an earlier driver of the run
    // left open is this run's to close, which its agent no longer can: an
    // emit after cancellation fails.
    if matches!(outcome, Ok(RunOutcome::Cancelled) | Err(Error::Cancelled)) {
        sink.close_unclosed(&Error::Cancelled);
    }
    let usage = terminal.usage();
    let finished = |outcome| {
        let mut finished =
            RunFinishedEvent::new(thread_id.clone(), run_id.clone()).with_outcome(outcome);
        finished.result = terminal.result.clone();
        finished.usage = usage.clone();
        Event::from(finished)
    };
    let event = match outcome {
        Ok(outcome) => match outcome.validate() {
            Ok(()) => finished(outcome),
            Err(error) => error_event(&Error::Protocol(error), usage.clone()),
        },
        // A deliberate stop is a closed run, provided all open entities were
        // closed. If a raw emit left one open, the verifier rejects
        // RUN_FINISHED and the fallback below reports RUN_ERROR instead.
        Err(Error::Cancelled) => finished(RunOutcome::Cancelled),
        Err(error) => error_event(&error, usage.clone()),
    };

    if let Err(rejected) = sink.emit_forced(event) {
        if rejected.is_disconnected() || sink.is_terminated() {
            return;
        }
        // Preserve the transformer's opportunity to redact or reclassify the error.
        let _ = sink.emit_forced(error_event(&rejected, usage));
    }
    if !sink.is_terminated() {
        // A transformer may have dropped or replaced every terminal event.
        // Only this fixed diagnostic bypasses the chain. Original payloads,
        // including usage, may have been filtered intentionally.
        let error = RunErrorEvent::new("the transformer chain did not deliver a terminal event")
            .with_code("PROTOCOL_VIOLATION");
        let _ = sink.send(error.into());
    }
}

fn error_event(error: &Error, usage: Option<Vec<TokenUsage>>) -> Event {
    let mut event = RunErrorEvent::new(error.to_string()).with_code(error.code());
    event.usage = usage;
    event.into()
}

/// The stream half: drains queued events, and polls the agent when there are
/// none.
///
/// The driver future is boxed so the stream is `Unpin` and needs no unsafe
/// projection — one allocation per run.
struct RunStream<F> {
    driver: Option<Pin<Box<F>>>,
    events: EventReceiver,
}

impl<F: Future<Output = ()>> Stream for RunStream<F> {
    type Item = Event;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            // Events first: everything the agent has already emitted goes out
            // before it is polled again, which is what keeps a slow agent's
            // early output flowing.
            match this.events.poll_next_unpin(cx) {
                Poll::Ready(Some(event)) => return Poll::Ready(Some(event)),
                // The driver dropped its sender, or overflow closed the queue.
                Poll::Ready(None) => {
                    // Overflow closes the queue even if an agent ignored its
                    // emit error and then awaited forever.
                    this.driver = None;
                    return Poll::Ready(None);
                }
                Poll::Pending => {}
            }

            let Some(driver) = this.driver.as_mut() else {
                return Poll::Pending;
            };
            match driver.as_mut().poll(cx) {
                // Dropping the future drops the sink, which closes the channel
                // once the events still queued behind it have been drained.
                Poll::Ready(()) => this.driver = None,
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// A run-owned source error means execution has ended, so it becomes the
/// run's `RUN_ERROR` and nothing after it is read. External subscriptions use
/// a separate transport path, where source errors cannot claim a run failed.
#[cfg(feature = "axum")]
pub(crate) fn terminal_error_events<S>(
    events: S,
    cancellation: Option<CancellationToken>,
) -> impl Stream<Item = Event> + Send
where
    S: Stream<Item = Result<Event>> + Send + 'static,
{
    futures_util::stream::unfold(Some(Box::pin(events)), move |events| {
        let cancellation = cancellation.clone();
        async move {
            let mut events = events?;
            match events.next().await {
                Some(Ok(event)) => Some((event, Some(events))),
                Some(Err(error)) => {
                    if let Some(token) = cancellation {
                        token.cancel();
                    }
                    drop(events);
                    let event =
                        Event::from(RunErrorEvent::new(error.to_string()).with_code(error.code()));
                    Some((event, None))
                }
                None => None,
            }
        }
    })
}
