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
//!     .map(|event| event.expect("the stream should not break"))
//!     .collect()
//!     .await;
//!
//! assert_eq!(events.first().map(Event::event_type), Some(ag_ui::EventType::RunStarted));
//! assert_eq!(events.last().map(Event::event_type), Some(ag_ui::EventType::RunFinished));
//! # });
//! ```

use std::future::Future;
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::{
    Event, RunAgentInput, RunErrorEvent, RunFinishedEvent, RunId, RunOutcome, RunStartedEvent,
    ThreadId,
};
use futures_channel::mpsc::{self, UnboundedReceiver};
use futures_core::Stream;
use futures_util::StreamExt as _;

use crate::server::agent::Agent;
use crate::server::cancel::CancellationToken;
use crate::server::context::{RunContext, decode_state};
use crate::server::emit::EventSink;
use crate::server::error::{Error, Result};
use crate::server::transform::{StreamTransformer, TransformerChain};

/// Runs `agent` against `input` with no transformers and a fresh cancellation
/// token.
///
/// [`Runner`] is the same thing with knobs.
pub fn run<A: Agent>(agent: A, input: RunAgentInput) -> impl Stream<Item = Result<Event>> + Send {
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
    /// A panic inside the agent is not caught; it unwinds through whoever is
    /// polling the stream, as it would through any other future. Use the
    /// transport's own panic handling if you need a response body for that
    /// case.
    pub fn run(self, input: RunAgentInput) -> impl Stream<Item = Result<Event>> + Send {
        let Self {
            agent,
            chain,
            cancel,
            echo_input,
            event_buffer_capacity,
        } = self;
        let (tx, rx) = mpsc::unbounded();
        let sink =
            EventSink::new(tx, chain, cancel).with_event_buffer_capacity(event_buffer_capacity);
        RunStream {
            driver: Some(Box::pin(drive(agent, input, sink, echo_input))),
            rx,
        }
    }
}

/// Emits `RUN_STARTED`, runs the agent, and emits the terminal event.
///
/// Takes the sink by value and only hands it to the context for the duration of
/// the agent's call: whatever happens in there, the terminal event still goes
/// through the same transformers and the same verifier.
async fn drive<A: Agent>(agent: A, input: RunAgentInput, mut sink: EventSink, echo_input: bool) {
    let thread_id = input.thread_id.clone();
    let run_id = input.run_id.clone();

    let mut started = RunStartedEvent::new(thread_id.clone(), run_id.clone());
    started.parent_run_id = input.parent_run_id.clone();
    if echo_input {
        started.input = Some(Box::new(input.clone()));
    }
    if sink.emit_forced(started.into()).is_err() {
        // Nobody is listening, or RUN_STARTED was rejected. Either way there is
        // no run to report on.
        return;
    }

    // Decoded before the match so the borrow of `input` ends here: the context
    // takes the input by value on the next line.
    let decoded = decode_state::<A::State>(&input.state);
    let outcome = match decoded {
        Ok(state) => {
            let mut ctx = RunContext::from_parts(input, state, sink);
            let outcome = agent.run(&mut ctx).await;
            if ctx.is_terminated() {
                // The agent emitted its own terminal event through `emit`.
                return;
            }
            sink = ctx.into_sink();
            outcome
        }
        Err(error) => Err(error),
    };

    terminate(&mut sink, outcome, &thread_id, &run_id);
}

/// Emits exactly one terminal event.
fn terminate(
    sink: &mut EventSink,
    outcome: Result<RunOutcome>,
    thread_id: &ThreadId,
    run_id: &RunId,
) {
    let event = match outcome {
        Ok(outcome) => match outcome.validate() {
            Ok(()) => RunFinishedEvent::new(thread_id.clone(), run_id.clone())
                .with_outcome(outcome)
                .into(),
            Err(error) => error_event(&Error::Protocol(error)),
        },
        // A deliberate stop is a closed run, provided all open entities were
        // closed. If not, the verifier rejects RUN_FINISHED and the existing
        // fallback below reports RUN_ERROR instead.
        Err(Error::Cancelled) => RunFinishedEvent::new(thread_id.clone(), run_id.clone())
            .with_outcome(RunOutcome::Cancelled)
            .into(),
        Err(error) => error_event(&error),
    };

    let Err(rejected) = sink.emit_forced(event) else {
        return;
    };
    // `RUN_FINISHED` can be rejected — by the verifier, for a message the agent
    // left open. A run that ends with no terminal event at all is worse than
    // one that ends badly, so say what went wrong instead. `RUN_ERROR` is
    // exempt from the open-at-finish rule for exactly this reason.
    if !rejected.is_disconnected() && !sink.is_terminated() {
        let _ = sink.emit_forced(error_event(&rejected));
    }
}

fn error_event(error: &Error) -> Event {
    RunErrorEvent::new(error.to_string())
        .with_code(error.code())
        .into()
}

/// The stream half: drains queued events, and polls the agent when there are
/// none.
///
/// The driver future is boxed so the stream is `Unpin` and needs no unsafe
/// projection — one allocation per run.
struct RunStream<F> {
    driver: Option<Pin<Box<F>>>,
    rx: UnboundedReceiver<Event>,
}

impl<F: Future<Output = ()>> Stream for RunStream<F> {
    type Item = Result<Event>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            // Events first: everything the agent has already emitted goes out
            // before it is polled again, which is what keeps a slow agent's
            // early output flowing.
            match this.rx.poll_next_unpin(cx) {
                Poll::Ready(Some(event)) => return Poll::Ready(Some(Ok(event))),
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

/// A run-owned source error means execution has ended. External subscriptions
/// use a separate transport path, where source errors cannot claim a run failed.
#[cfg(feature = "axum")]
pub(crate) fn terminal_error_events<S>(
    events: S,
    cancellation: Option<CancellationToken>,
) -> impl Stream<Item = Result<Event>> + Send
where
    S: Stream<Item = Result<Event>> + Send + 'static,
{
    futures_util::stream::unfold(Some(Box::pin(events)), move |events| {
        let cancellation = cancellation.clone();
        async move {
            let mut events = events?;
            match events.next().await {
                Some(Ok(event)) => Some((Ok(event), Some(events))),
                Some(Err(error)) => {
                    if let Some(token) = cancellation {
                        token.cancel();
                    }
                    drop(events);
                    let event =
                        Event::from(RunErrorEvent::new(error.to_string()).with_code(error.code()));
                    Some((Ok(event), None))
                }
                None => None,
            }
        }
    })
}
