//! Getting events from somewhere.
//!
//! Everything else in this crate is synchronous. This is the one layer that
//! talks to the outside world, and the only place `async` appears — which is
//! what lets the rest of the crate run under any executor, or none.
//!
//! [`Transport`] is deliberately small: hand it a [`RunAgentInput`](https://docs.rs/ag-ui/0.4.2/ag_ui/input/struct.RunAgentInput.html), get back a
//! stream of [`Event`](https://docs.rs/ag-ui/0.4.2/ag_ui/event/enum.Event.html)s. Implementations shipped here:
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

use crate::client::error::Result;

pub use replay::ReplayTransport;
pub use sse::{SseDecoder, SseFrame, decode_events};

#[cfg(feature = "http")]
pub use http::{HttpTransport, HttpTransportBuilder};

/// A boxed stream of events, as a transport hands it over.
///
/// `Send` everywhere except wasm, where the browser APIs a transport would be
/// built on are single-threaded and not `Send` at all. Requiring it there would
/// make the wasm case — the reason this crate abstracts the transport in the
/// first place — impossible to satisfy.
#[cfg(not(target_family = "wasm"))]
pub type EventStream = Pin<Box<dyn Stream<Item = Result<Event>> + Send>>;

/// A boxed stream of events, as a transport hands it over.
#[cfg(target_family = "wasm")]
pub type EventStream = Pin<Box<dyn Stream<Item = Result<Event>>>>;

/// The future [`Transport::run`] returns: connecting, before any event arrives.
#[cfg(not(target_family = "wasm"))]
pub type TransportFuture = Pin<Box<dyn Future<Output = Result<EventStream>> + Send>>;

/// The future [`Transport::run`] returns: connecting, before any event arrives.
#[cfg(target_family = "wasm")]
pub type TransportFuture = Pin<Box<dyn Future<Output = Result<EventStream>>>>;

/// Somewhere an agent's events come from.
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
    /// Starts a run and connects to its event stream.
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

/// Boxes a stream into the shape [`Transport::run`] returns.
#[cfg(not(target_family = "wasm"))]
pub fn boxed_stream(stream: impl Stream<Item = Result<Event>> + Send + 'static) -> EventStream {
    Box::pin(stream)
}

/// Boxes a stream into the shape [`Transport::run`] returns.
#[cfg(target_family = "wasm")]
pub fn boxed_stream(stream: impl Stream<Item = Result<Event>> + 'static) -> EventStream {
    Box::pin(stream)
}
