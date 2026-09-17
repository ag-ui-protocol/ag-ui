//! Turning a run's event stream into an HTTP response.
//!
//! Two things happen here that are easy to get wrong.
//!
//! **Negotiation is a decision, not a fallback.** [`negotiate`] asks
//! [`crate::encode::media_type`](https://docs.rs/ag-ui/0.4.2/ag_ui/encode/fn.media_type.html) what to answer with and refuses the
//! request when the answer is "nothing" — a client that asked for
//! `application/xml` gets a `406`, not an SSE stream it cannot read.
//!
//! **The body owns the run.** Polling the stream *is* running the agent
//! ([`crate::server::run()`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/run/fn.run.html) has no executor of its own), so the response body and
//! the run have exactly the same lifetime. That is what makes disconnect
//! handling work: when the client goes away hyper drops the body, and the body
//! drops a guard that trips the run's [`CancellationToken`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/cancel/struct.CancellationToken.html). See
//! [`SseResponse::cancellation`].

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Duration;

use crate::encode::sse;
use crate::server::CancellationToken;
use crate::{Event, EventStreamFormatter, RunErrorEvent, SSE_MEDIA_TYPE, SseFormatter, media_type};
use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use futures_util::stream::Stream;
use tokio::time::{Instant, Sleep, sleep_until};

use crate::axum::error::{Error, Result};

/// SSE keep-alive payload: a comment line, which every conforming client
/// ignores.
const KEEP_ALIVE_FRAME: &[u8] = b":\n\n";

/// Picks the response encoding for an `Accept` header.
///
/// A missing or empty header means `*/*` and yields SSE. Anything that excludes
/// every media type this build can emit is [`Error::NotAcceptable`], which
/// renders as a `406`.
///
/// ```
/// # use ag_ui::axum::respond::negotiate;
/// assert!(negotiate(None).is_ok());
/// assert!(negotiate(Some("text/event-stream")).is_ok());
/// assert!(negotiate(Some("text/*;q=0.4, application/json")).is_ok());
/// assert!(negotiate(Some("application/xml")).is_err());
/// assert!(negotiate(Some("*/*;q=0")).is_err());
/// ```
pub fn negotiate(accept: Option<&str>) -> Result<SseFormatter> {
    let refuse = || Error::NotAcceptable {
        accept: accept.unwrap_or("*/*").to_owned(),
    };
    match media_type(accept).map_err(|_| refuse())? {
        SSE_MEDIA_TYPE => Ok(SseFormatter::new()),
        // Only reachable if this crate ever enables a core encoding it has not
        // taught this function to build. Refusing beats answering with a
        // content type whose body would be SSE.
        _ => Err(refuse()),
    }
}

/// A negotiated event-stream response, waiting for the stream to put in it.
///
/// The full manual wiring, for a handler that does its own work before starting
/// the run — [`route_agui`](crate::axum::RouterExt::route_agui) is this, with the
/// defaults filled in:
///
/// ```
/// use ag_ui::axum::SseResponse;
/// use ag_ui::{RunAgentInput, RunOutcome};
/// use ag_ui::server::{Agent, Result, RunContext, Runner};
///
/// # struct Greeter;
/// # impl Agent for Greeter {
/// #     type State = ();
/// #     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
/// #         ctx.say("hi")?;
/// #         Ok(RunOutcome::Success)
/// #     }
/// # }
/// # fn serve(accept: Option<&str>, input: RunAgentInput) -> axum::response::Result<axum::response::Response> {
/// let response = SseResponse::negotiate(accept)?;
///
/// let runner = Runner::new(Greeter);
/// // Take the token *before* `run` consumes the runner.
/// let response = response.cancellation(runner.cancellation_token());
///
/// Ok(response.stream(runner.run(input)))
/// # }
/// ```
#[derive(Clone, Debug)]
#[must_use = "an SseResponse does nothing until a stream is attached"]
pub struct SseResponse {
    formatter: SseFormatter,
    cancellation: Option<CancellationToken>,
    keep_alive: Option<Duration>,
}

impl SseResponse {
    /// Negotiates the encoding for an `Accept` header — see [`negotiate`].
    pub fn negotiate(accept: Option<&str>) -> Result<Self> {
        Ok(Self {
            formatter: self::negotiate(accept)?,
            cancellation: None,
            keep_alive: None,
        })
    }

    /// Trips `token` when the client disconnects.
    ///
    /// The token to pass is the one the run was built with —
    /// [`Runner::cancellation_token`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/run/struct.Runner.html#method.cancellation_token).
    ///
    /// # How the disconnect is noticed
    ///
    /// There is no callback to register: hyper *drops* the response body when
    /// the connection breaks, so a [`Drop`] impl on the body is the signal. The
    /// guard disarms itself when the stream ends normally, so a completed run
    /// is never reported as cancelled.
    ///
    /// Dropping the body would already stop the agent — the future lives inside
    /// the stream. The token is what reaches everything *outside* it: a
    /// spawned tool call, an in-flight model request, a lock the run holds.
    pub fn cancellation(mut self, token: CancellationToken) -> Self {
        self.cancellation = Some(token);
        self
    }

    /// Sends an SSE comment whenever the agent has produced nothing for
    /// `interval`.
    ///
    /// Off by default. Turn it on when something between the agent and the
    /// browser closes idle connections — most reverse proxies do, at 30 to 60
    /// seconds, which is well inside the time a slow first token can take.
    pub fn keep_alive(mut self, interval: Duration) -> Self {
        self.keep_alive = Some(interval);
        self
    }

    /// Attaches the run's events and builds the response.
    pub fn stream<S>(self, events: S) -> Response
    where
        S: Stream<Item = crate::server::Result<Event>> + Send + 'static,
    {
        let body = EventBody {
            // Cancel first, then drop the run: an agent whose own `Drop` looks
            // at the token sees the truth.
            guard: DisconnectGuard {
                token: self.cancellation,
                armed: true,
            },
            events: Box::pin(events),
            formatter: self.formatter,
            keep_alive: self.keep_alive.map(KeepAlive::new),
            done: false,
        };

        let mut response = Response::new(Body::from_stream(body));
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(SSE_MEDIA_TYPE),
        );
        // `no-transform` is the half that matters: a proxy that gzips this
        // stream will also buffer it, and the point of the stream is that it
        // arrives a token at a time.
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, no-transform"),
        );
        // nginx honours neither of the above for proxied responses; this is its
        // opt-out, and it is inert everywhere else.
        headers.insert(
            header::HeaderName::from_static("x-accel-buffering"),
            HeaderValue::from_static("no"),
        );
        // The body was chosen by `Accept`, so caches must key on it.
        headers.insert(header::VARY, HeaderValue::from_static("accept"));
        response
    }
}

/// The response body: SSE frames, and the run that produces them.
struct EventBody {
    /// Declared first so it drops first — see [`SseResponse::stream`].
    guard: DisconnectGuard,
    events: Pin<Box<dyn Stream<Item = crate::server::Result<Event>> + Send>>,
    formatter: SseFormatter,
    keep_alive: Option<KeepAlive>,
    done: bool,
}

impl EventBody {
    /// Encodes one event, or — if that somehow fails — an in-band report of
    /// why.
    ///
    /// Serializing an [`Event`] cannot fail today: every payload is derived
    /// `Serialize` over owned data. If a future one can, a client that receives
    /// a `RUN_ERROR` is in far better shape than one whose stream simply
    /// stopped.
    fn encode(&self, event: &Event) -> Bytes {
        match self.formatter.encode(event) {
            Ok(bytes) => Bytes::from(bytes),
            Err(error) => Bytes::from(sse::frame(
                &serde_json::json!({
                    "type": "RUN_ERROR",
                    "message": error.to_string(),
                    "code": "SERIALIZATION",
                })
                .to_string(),
            )),
        }
    }

    /// Marks the run finished: no further polling, and no cancellation on drop.
    fn finish(&mut self) {
        self.done = true;
        self.guard.disarm();
    }

    fn reset_keep_alive(&mut self) {
        if let Some(keep_alive) = self.keep_alive.as_mut() {
            keep_alive.reset();
        }
    }

    /// What to return when the agent has nothing yet.
    fn poll_idle(&mut self, cx: &mut Context<'_>) -> Poll<Option<Result<Bytes, Infallible>>> {
        let Some(keep_alive) = self.keep_alive.as_mut() else {
            return Poll::Pending;
        };
        ready!(keep_alive.poll_tick(cx));
        Poll::Ready(Some(Ok(Bytes::from_static(KEEP_ALIVE_FRAME))))
    }
}

impl Stream for EventBody {
    type Item = Result<Bytes, Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.done {
            return Poll::Ready(None);
        }

        match this.events.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(event))) => {
                this.reset_keep_alive();
                Poll::Ready(Some(Ok(this.encode(&event))))
            }
            // The run driver reports agent failures as `RUN_ERROR` events
            // itself, so this is the event *channel* failing. Say so in the
            // stream and end it there — the alternative is a body that stops
            // with no terminal event, which reads as a network fault.
            Poll::Ready(Some(Err(error))) => {
                this.finish();
                let event =
                    Event::from(RunErrorEvent::new(error.to_string()).with_code(error.code()));
                Poll::Ready(Some(Ok(this.encode(&event))))
            }
            Poll::Ready(None) => {
                this.finish();
                Poll::Ready(None)
            }
            Poll::Pending => this.poll_idle(cx),
        }
    }
}

/// Trips a run's cancellation token unless the run got to finish.
struct DisconnectGuard {
    token: Option<CancellationToken>,
    armed: bool,
}

impl DisconnectGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for DisconnectGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(token) = &self.token {
            token.cancel();
        }
    }
}

/// The idle timer behind [`SseResponse::keep_alive`].
///
/// The timer is created on the first idle poll rather than with the response:
/// a `Sleep` has to be built inside a tokio runtime, and starting it when the
/// agent first goes quiet is also the deadline that was wanted.
struct KeepAlive {
    interval: Duration,
    sleep: Option<Pin<Box<Sleep>>>,
}

impl KeepAlive {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            sleep: None,
        }
    }

    /// Resolves once a whole `interval` has passed with no event, then rearms.
    fn poll_tick(&mut self, cx: &mut Context<'_>) -> Poll<()> {
        let interval = self.interval;
        let sleep = self
            .sleep
            .get_or_insert_with(|| Box::pin(sleep_until(Instant::now() + interval)));
        ready!(sleep.as_mut().poll(cx));
        self.reset();
        Poll::Ready(())
    }

    /// Pushes the deadline back. A no-op before the first idle poll, when there
    /// is no deadline yet.
    fn reset(&mut self) {
        let deadline = Instant::now() + self.interval;
        if let Some(sleep) = self.sleep.as_mut() {
            sleep.as_mut().reset(deadline);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    #[test]
    fn a_refused_accept_is_a_406() {
        let error = negotiate(Some("application/xml")).expect_err("should refuse");
        assert_eq!(error.status(), StatusCode::NOT_ACCEPTABLE);
        assert_eq!(
            error.into_response().status(),
            StatusCode::NOT_ACCEPTABLE,
            "the rendered response should carry the status too"
        );
    }

    #[test]
    fn a_quality_of_zero_is_a_refusal() {
        assert!(negotiate(Some("text/event-stream;q=0")).is_err());
    }

    #[test]
    fn an_empty_accept_header_means_anything() {
        assert!(negotiate(Some("")).is_ok());
        assert!(negotiate(Some("   ")).is_ok());
    }

    #[test]
    fn the_message_names_what_the_endpoint_can_emit() {
        let error = negotiate(Some("application/xml")).expect_err("should refuse");
        assert!(error.to_string().contains(SSE_MEDIA_TYPE), "{error}");
    }
}
