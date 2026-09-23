//! Turning a run's event stream into an HTTP response.
//!
//! Two things happen here that are easy to get wrong.
//!
//! **Negotiation is a decision, not a fallback.** [`negotiate`] asks
//! [`crate::encode::media_type`] what to answer with and refuses the
//! request when the answer is "nothing" — a client that asked for
//! `application/xml` gets a `406`, not an SSE stream it cannot read.
//!
//! **The body owns its input stream.** For [`crate::server::Runner`], polling
//! that stream *is* running the agent
//! ([`crate::server::run()`] has no executor of its own), so the response body and
//! the run have exactly the same lifetime. That is what makes disconnect
//! handling work: when the client goes away hyper drops the body, and the body
//! drops a guard that trips the run's [`CancellationToken`]. See
//! [`SseResponse::cancellation`]. An externally owned durable run can instead
//! pass a subscription to [`SseResponse::stream_frames`] and omit cancellation;
//! dropping the response then detaches the subscription, leaving execution to
//! its owner.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use crate::encode::sse;
use crate::server::CancellationToken;
use crate::{Event, SSE_MEDIA_TYPE, SseFormatter, media_type};
use axum::body::Body;
use axum::http::{HeaderValue, header};
use axum::response::sse::{Event as HttpEvent, KeepAlive};
use axum::response::{IntoResponse, Response, Sse};
use futures_util::stream::{Stream, StreamExt};
use serde::Serialize;

use crate::axum::error::{Error, Result};

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

pub use crate::encode::sse::SseFrame;

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
    /// [`crate::server::Runner::cancellation_token`].
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

    /// Attaches a run-owned event stream and builds the response.
    ///
    /// Preserves the native runner contract: a source error terminates this run
    /// and is reported as `RUN_ERROR`. For a subscription whose transport can
    /// fail independently of execution, use [`Self::stream_frames`] instead.
    pub fn stream<S>(self, events: S) -> Response
    where
        S: Stream<Item = crate::server::Result<Event>> + Send + 'static,
    {
        let events = crate::server::run::terminal_error_events(events, self.cancellation.clone());
        self.stream_frames(events.map(|event| event.map(SseFrame::Event)))
    }

    /// Optional lower-level SSE transport for supplied values and comments.
    /// The source may use its own error type; no SDK hosting error is required.
    /// Use `Ok::<_, std::convert::Infallible>(frame)` for an infallible source.
    ///
    /// Serialization is not protocol validation or a schema extension. New
    /// producers use standard `Event` values and `metadata`; a host can supply
    /// its own compatibility representation when replaying older data.
    ///
    /// Source and serialization failures become response-body errors and stop
    /// polling. They never manufacture `RUN_ERROR`: the producer owns the run
    /// lifecycle, which may outlive this subscription.
    ///
    /// For externally owned runs, omit `cancellation`: dropping this response
    /// detaches its subscription. An explicitly supplied token is cancelled
    /// on disconnect or transport failure, never on clean EOF.
    pub fn stream_frames<S, E, StreamError>(self, frames: S) -> Response
    where
        S: Stream<Item = std::result::Result<SseFrame<E>, StreamError>> + Send + 'static,
        E: Serialize + Send + 'static,
        StreamError: Send + 'static,
    {
        let events = HttpEvents {
            guard: DisconnectGuard {
                token: self.cancellation,
                armed: true,
            },
            events: Some(Box::pin(frames)),
            formatter: self.formatter,
        };
        // Axum owns framing, body polling and keep-alive. Construct its timer
        // only when the body is polled, so building a response needs no runtime.
        let body = Body::from_stream(
            futures_util::stream::once(async move {
                let sse = Sse::new(events);
                let response = match self.keep_alive {
                    Some(interval) => sse
                        .keep_alive(KeepAlive::new().interval(interval))
                        .into_response(),
                    None => sse.into_response(),
                };
                response.into_body().into_data_stream()
            })
            .flatten(),
        );
        let mut response = Response::new(body);
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(SSE_MEDIA_TYPE),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, no-transform"),
        );
        headers.insert(
            header::HeaderName::from_static("x-accel-buffering"),
            HeaderValue::from_static("no"),
        );
        headers.insert(header::VARY, HeaderValue::from_static("accept"));
        response
    }
}

type EventFrames<E, StreamError> =
    Pin<Box<dyn Stream<Item = std::result::Result<SseFrame<E>, StreamError>> + Send>>;

/// Converts typed SDK values into Axum SSE items. It owns no run lifecycle.
struct HttpEvents<E, StreamError> {
    // Cancel before dropping the input stream, including before its first poll.
    guard: DisconnectGuard,
    events: Option<EventFrames<E, StreamError>>,
    formatter: SseFormatter,
}

impl<E: Serialize, StreamError> HttpEvents<E, StreamError> {
    fn encode(&self, frame: SseFrame<E>) -> std::result::Result<HttpEvent, io::Error> {
        match frame {
            SseFrame::Event(event) => self
                .formatter
                .event_json(&event)
                .map(|json| HttpEvent::default().data(json))
                .map_err(|_| io::Error::other("SSE event serialization failed")),
            SseFrame::Comment(comment) => Ok(sse::comment_lines(&comment)
                .fold(HttpEvent::default(), |event, line| event.comment(line))),
        }
    }

    fn finish(&mut self) {
        self.guard.armed = false;
        self.events = None;
    }

    fn fail(&mut self) {
        if let Some(token) = &self.guard.token {
            token.cancel();
        }
        self.finish();
    }
}

impl<E: Serialize, StreamError> Stream for HttpEvents<E, StreamError> {
    type Item = std::result::Result<HttpEvent, io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let Some(events) = this.events.as_mut() else {
            return Poll::Ready(None);
        };
        match events.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                let encoded = this.encode(frame);
                if encoded.is_err() {
                    this.fail();
                }
                Poll::Ready(Some(encoded))
            }
            Poll::Ready(Some(Err(_))) => {
                this.fail();
                Poll::Ready(Some(Err(io::Error::other("SSE source stream failed"))))
            }
            Poll::Ready(None) => {
                this.finish();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Only an explicitly supplied token can tie disconnection to execution.
struct DisconnectGuard {
    token: Option<CancellationToken>,
    armed: bool,
}

impl Drop for DisconnectGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(token) = &self.token {
                token.cancel();
            }
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
