//! Getting events from somewhere.
//!
//! Everything else in this crate is synchronous. This is the one layer that
//! talks to the outside world, and the only place `async` appears — which is
//! what lets the rest of the crate run under any executor, or none.
//!
//! [`Transport`] is deliberately small: one method that takes a
//! [`RunAgentInput`] and hands back the run's stream as the transport has it,
//! a [`TransportStream`]. That is wire JSON for anything that reads bytes, and
//! typed events for a source that never had a wire. The client reads either
//! through the same compatibility boundary. Implementations shipped here:
//!
//! - [`sse`] — the `text/event-stream` decoder every HTTP transport needs.
#![cfg_attr(
    feature = "http",
    doc = "- [`http`] *(feature `http`)* — [`HttpTransport`], backed by `reqwest`."
)]
#![cfg_attr(
    not(feature = "http"),
    doc = "- `http` *(feature `http`, off in this build)* — `HttpTransport`, backed by `reqwest`."
)]
//! - [`replay`] — [`ReplayTransport`], which serves a scripted list of events
//!   and records what was sent to it. Tests use it; so does the doc example.
//!
//! A wasm frontend, an in-process agent, a websocket, a recorded fixture: each
//! is an `impl Transport`, and nothing above this module changes.

pub mod replay;
pub mod sse;

#[cfg(feature = "http")]
pub mod http;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::{Event, RunAgentInput};
use futures_core::Stream;
use futures_util::StreamExt;
use serde_json::Value;

use crate::client::enforce::{self, CheckedStream};
use crate::client::error::{Error, Result};

pub use replay::ReplayTransport;
pub use sse::{SseDecoder, SseFrame, decode_events, decode_raw_events};

#[cfg(feature = "http")]
pub use http::{HttpTransport, HttpTransportBuilder};

/// A boxed stream of typed events, after the compatibility boundary.
///
/// `Send` everywhere except wasm, where the browser APIs a transport would be
/// built on are single-threaded and not `Send` at all. Requiring it there would
/// make the wasm case — the reason this crate abstracts the transport in the
/// first place — impossible to satisfy.
#[cfg(not(target_family = "wasm"))]
pub type EventStream = Pin<Box<dyn Stream<Item = Result<Event>> + Send>>;

/// A boxed stream of typed events, after the compatibility boundary.
#[cfg(target_family = "wasm")]
pub type EventStream = Pin<Box<dyn Stream<Item = Result<Event>>>>;

/// A boxed stream of wire JSON, before the compatibility boundary.
#[cfg(not(target_family = "wasm"))]
pub type RawEventStream = Pin<Box<dyn Stream<Item = Result<Value>> + Send>>;

/// A boxed stream of wire JSON, before the compatibility boundary.
#[cfg(target_family = "wasm")]
pub type RawEventStream = Pin<Box<dyn Stream<Item = Result<Value>>>>;

/// The future [`Transport::run`] returns: connecting, before any event arrives.
#[cfg(not(target_family = "wasm"))]
pub type TransportFuture = Pin<Box<dyn Future<Output = Result<TransportStream>> + Send>>;

/// The future [`Transport::run`] returns: connecting, before any event arrives.
#[cfg(target_family = "wasm")]
pub type TransportFuture = Pin<Box<dyn Future<Output = Result<TransportStream>>>>;

/// One run's events as a transport has them, before the client reads them.
///
/// A transport builds one of two forms and the client does the rest:
///
/// - [`json`](Self::json) — wire JSON, exactly as received. The client runs it
///   through the compatibility boundary: schema enforcement, the optional-null
///   registry and the translation of retired events. This is the form for
///   anything that reads bytes.
/// - [`typed`](Self::typed) — events built as [`Event`] in this process. They
///   are delivered as given, with no serialize, schema walk and deserialize
///   per event.
///
/// Either way the boundary's warnings reach a
/// [`Thread`](crate::client::Thread) as
/// [`Update::Warning`](crate::client::Update::Warning).
pub struct TransportStream(Source);

enum Source {
    Json(RawEventStream),
    Typed(EventStream),
}

impl std::fmt::Debug for TransportStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self.0 {
            Source::Json(_) => "TransportStream::json(..)",
            Source::Typed(_) => "TransportStream::typed(..)",
        })
    }
}

impl TransportStream {
    /// Wire JSON, one value per event, with unknown fields left in.
    ///
    /// An item that is an error ends the run. [`decode_raw_events`] produces
    /// this stream from the chunks of a `text/event-stream` body.
    ///
    /// ```
    /// use ag_ui::RunAgentInput;
    /// use ag_ui::client::transport::{Transport, TransportFuture, TransportStream};
    /// use futures_util::stream;
    /// use serde_json::{Value, json};
    ///
    /// /// A socket, a queue, a file: anything that yields JSON values.
    /// struct Frames(Vec<Value>);
    ///
    /// impl Transport for Frames {
    ///     fn run(&self, _input: RunAgentInput) -> TransportFuture {
    ///         let frames = stream::iter(self.0.clone().into_iter().map(Ok));
    ///         Box::pin(async move { Ok(TransportStream::json(frames)) })
    ///     }
    /// }
    /// # let _ = Frames(vec![json!({"type": "RUN_STARTED", "threadId": "t", "runId": "r"})]);
    /// ```
    #[cfg(not(target_family = "wasm"))]
    pub fn json(raw: impl Stream<Item = Result<Value>> + Send + 'static) -> Self {
        Self(Source::Json(Box::pin(raw)))
    }

    /// Wire JSON, one value per event, with unknown fields left in.
    #[cfg(target_family = "wasm")]
    pub fn json(raw: impl Stream<Item = Result<Value>> + 'static) -> Self {
        Self(Source::Json(Box::pin(raw)))
    }

    /// Events that were built as [`Event`] in this process and never
    /// serialized, such as the stream of an agent hosted in the same program.
    ///
    /// They are delivered as given: nothing is checked against the schema and
    /// nothing is removed, because an [`Event`] holds nothing this version
    /// does not know. What 1.0 retired is still translated as its wire form
    /// would be, so a consumer sees one contract whichever form fed it: a
    /// `THINKING_*` event, and a `binary` content part in a message snapshot,
    /// an input echo or a tool result. A newer declared protocol version is
    /// still reported. Call [`enforced`](Self::enforced) to have every event
    /// checked instead.
    ///
    #[cfg_attr(feature = "server", doc = "```")]
    #[cfg_attr(not(feature = "server"), doc = "```ignore")]
    /// use std::sync::Arc;
    ///
    /// use ag_ui::client::transport::{Transport, TransportFuture, TransportStream};
    /// use ag_ui::client::{RunEnd, Thread};
    /// use ag_ui::server::{Agent, RunContext};
    /// use ag_ui::{RunAgentInput, RunOutcome};
    /// use futures_util::StreamExt;
    ///
    /// struct Greeter;
    ///
    /// impl Agent for Greeter {
    ///     type State = ();
    ///     async fn run(&self, ctx: &mut RunContext<()>) -> ag_ui::server::Result<RunOutcome> {
    ///         ctx.say("hello")?;
    ///         Ok(RunOutcome::Success)
    ///     }
    /// }
    ///
    /// /// An agent in the same process: no wire, so no JSON.
    /// struct InProcess(Arc<Greeter>);
    ///
    /// impl Transport for InProcess {
    ///     fn run(&self, input: RunAgentInput) -> TransportFuture {
    ///         let events = ag_ui::server::run(Arc::clone(&self.0), input).map(Ok);
    ///         Box::pin(async move { Ok(TransportStream::typed(events)) })
    ///     }
    /// }
    ///
    /// # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    /// # rt.block_on(async {
    /// let mut thread = Thread::new(InProcess(Arc::new(Greeter)), "thread-1");
    /// let report = thread.send("hi").unwrap().collect_report().await;
    /// assert_eq!(report.end, RunEnd::Success { result: None });
    /// # });
    /// ```
    #[cfg(not(target_family = "wasm"))]
    pub fn typed(events: impl Stream<Item = Result<Event>> + Send + 'static) -> Self {
        Self(Source::Typed(Box::pin(events)))
    }

    /// Events that were built as [`Event`] in this process and never
    /// serialized.
    #[cfg(target_family = "wasm")]
    pub fn typed(events: impl Stream<Item = Result<Event>> + 'static) -> Self {
        Self(Source::Typed(Box::pin(events)))
    }

    /// Has typed events read the way a peer's are: each is serialized and goes
    /// through the whole compatibility boundary. Wire JSON is left as it is.
    ///
    /// For a typed source that stands in for a remote agent, where the test is
    /// what a client makes of the bytes. [`ReplayTransport`] does this.
    #[must_use]
    pub fn enforced(self) -> Self {
        Self(Source::Json(self.into_json()))
    }

    /// The run as wire JSON, before the boundary: what a proxy or a recorder
    /// forwards. Typed events are serialized.
    pub fn into_json(self) -> RawEventStream {
        match self.0 {
            Source::Json(raw) => raw,
            Source::Typed(events) => Box::pin(events.map(|event| {
                event.and_then(|event| {
                    serde_json::to_value(event).map_err(|error| Error::Protocol(error.to_string()))
                })
            })),
        }
    }

    /// The run as typed events, after the boundary, handing each of its
    /// warnings to `on_warning`. See [`enforce_events`] for what a warning is.
    pub fn into_events<F>(self, on_warning: F) -> impl Stream<Item = Result<Event>>
    where
        F: FnMut(String),
    {
        enforce::unchecked(self.into_checked(), on_warning)
    }

    /// The run after the boundary, with its warnings left in the stream.
    pub(crate) fn into_checked(self) -> CheckedStream {
        match self.0 {
            Source::Json(raw) => Box::pin(enforce::checked(raw)),
            Source::Typed(events) => Box::pin(enforce::typed(events)),
        }
    }
}

/// Somewhere an agent's events come from.
///
/// One method. A transport does not decode, check or translate anything: it
/// connects and returns the stream in the form it has it, and the client
/// applies the compatibility boundary. See [`TransportStream`] for the two
/// forms.
///
/// # Why the future is `'static`
///
/// A transport is usually held inside a [`Thread`](crate::client::Thread), which
/// mutates its own state as events arrive. If the returned future borrowed the
/// transport, that borrow would live as long as the run and the thread could
/// not touch itself while streaming. So `run` clones what it needs —
/// `reqwest::Client` is explicitly designed for exactly that — and the future
/// stands alone.
pub trait Transport {
    /// Starts a run and connects to its stream.
    ///
    /// Failing to connect is an error from the future; failing mid-stream is an
    /// error item in the stream.
    fn run(&self, input: RunAgentInput) -> TransportFuture;
}

impl<T: Transport + ?Sized> Transport for &T {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        (**self).run(input)
    }
}

impl<T: Transport + ?Sized> Transport for Box<T> {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        (**self).run(input)
    }
}

impl<T: Transport + ?Sized> Transport for Arc<T> {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        (**self).run(input)
    }
}

/// Runs raw wire events through the compatibility and enforcement boundary
/// every transport shares, handing each of its warnings to `on_warning`.
///
/// This is the boundary a [`Thread`](crate::client::Thread) applies to
/// [`TransportStream::json`], for code that reads wire JSON without one.
///
/// A warning says what the boundary removed or translated on the way: an
/// unrecognised field, enum member or event, a retired `THINKING_*` event, a
/// deprecated optional `null`, a newer declared protocol version. It arrives
/// before the event it concerns, and a text already handed on in the same run
/// is not handed on again. [`decode_events`] and
/// [`RemoteAgent::run_events`](crate::client::RemoteAgent::run_events) apply
/// the same boundary and discard them; a [`Thread`](crate::client::Thread)
/// yields them as [`Update::Warning`](crate::client::Update::Warning). Nothing
/// in this crate prints them.
///
/// ```
/// use ag_ui::client::transport::{decode_raw_events, enforce_events};
/// use futures_util::{StreamExt, stream};
///
/// # futures_util::FutureExt::now_or_never(async {
/// let body = "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t\",\"runId\":\"r\",\"extra\":1}\n\n";
/// let chunks = stream::iter([Ok::<_, std::io::Error>(body.as_bytes())]);
/// let mut warnings = Vec::new();
/// let events: Vec<_> = enforce_events(decode_raw_events(chunks), |warning| warnings.push(warning))
///     .collect()
///     .await;
/// assert!(events[0].is_ok());
/// assert_eq!(warnings, ["unrecognised property at /extra"]);
/// # }).unwrap();
/// ```
pub fn enforce_events<S, F>(raw: S, on_warning: F) -> impl Stream<Item = Result<Event>>
where
    S: Stream<Item = Result<Value>>,
    F: FnMut(String),
{
    enforce::events(raw, on_warning)
}
