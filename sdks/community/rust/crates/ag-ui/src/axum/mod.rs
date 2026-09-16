//! Serve an [AG-UI] agent from an [axum] router.
//!
//! [`ag_ui::server`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/index.html) turns an [`Agent`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/agent/trait.Agent.html) into a
//! stream of events and stops there, on purpose: it has no executor and no web
//! framework, so it builds for wasm. This crate is the other half — the POST
//! endpoint, the `text/event-stream` body, content negotiation, and telling the
//! agent when the client hangs up. It is the only crate in the workspace that
//! depends on tokio, axum or tower.
//!
//! Mounting an agent is one line, and the router is still an ordinary router:
//!
//! ```
//! use ag_ui::axum::RouterExt;
//! use ag_ui::{RunAgentInput, RunOutcome};
//! use ag_ui::server::{Agent, Result, RunContext};
//! use axum::Router;
//! use axum::routing::get;
//!
//! struct Greeter;
//!
//! impl Agent for Greeter {
//!     type State = ();
//!
//!     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
//!         ctx.say("Hello!")?;
//!         Ok(RunOutcome::Success)
//!     }
//! }
//!
//! let app: Router = Router::new()
//!     .route("/health", get(|| async { "ok" }))
//!     .route_agui("/agent", Greeter);
//!
//! # let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
//! # rt.block_on(async {
//! # use axum::body::Body;
//! # use axum::http::Request;
//! # use tower::ServiceExt as _;
//! let request = Request::post("/agent")
//!     .header("content-type", "application/json")
//!     .body(Body::from(
//!         serde_json::to_vec(&RunAgentInput::new("thread-1", "run-1")).unwrap(),
//!     ))
//!     .unwrap();
//!
//! let response = app.oneshot(request).await.unwrap();
//! assert_eq!(response.headers()["content-type"], "text/event-stream");
//!
//! let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
//! let body = String::from_utf8(body.to_vec()).unwrap();
//! assert!(body.starts_with(r#"data: {"type":"RUN_STARTED""#), "{body}");
//! assert!(body.contains(r#""type":"TEXT_MESSAGE_CONTENT","messageId":"run-1-msg-1","delta":"Hello!""#));
//! assert!(body.trim_end().ends_with(r#""type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1","outcome":{"type":"success"}}"#));
//! # });
//! ```
//!
//! # What the endpoint answers with
//!
//! | Situation | Answer |
//! |---|---|
//! | A run, however it ends | `200`, `text/event-stream`, terminated by `RUN_FINISHED` or `RUN_ERROR` |
//! | Body is not AG-UI JSON | `400` and a JSON message naming the field |
//! | `Content-Type` is not JSON | `415` |
//! | Body over the body limit | `413` |
//! | `Accept` excludes everything this build emits | `406` |
//! | Any method but `POST` | `405`, from axum |
//!
//! A run that *fails* is still a `200`: by the time an agent can fail the
//! status line is long sent, so the failure is a `RUN_ERROR` event in a
//! well-formed stream rather than a connection that drops. This is what lets a
//! client tell "the agent errored" from "the network died".
//!
//! The one case with no good answer is a *panicking* agent. It unwinds through
//! hyper's connection task and the client sees a truncated stream, because the
//! `200` has already been sent and there is no status left to change. Return
//! [`Err`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/error/enum.Error.html#method.agent) instead; reach for
//! `tower_http::catch_panic` only for the panics you did not plan.
//!
//! # Cancellation on disconnect
//!
//! The response body owns the run — polling the stream is what runs the agent —
//! so when the client goes away, hyper drops the body and the run goes with it.
//! That much is automatic. What is not automatic is telling everything the run
//! reached *outside* itself: a spawned tool call, an in-flight model request.
//! So the body also holds a guard that trips the run's
//! [`CancellationToken`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/cancel/struct.CancellationToken.html) on drop, and disarms
//! itself if the run got to finish. An agent sees it through
//! [`RunContext::is_cancelled`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/context/struct.RunContext.html#method.is_cancelled),
//! [`until_cancelled`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/context/struct.RunContext.html#method.until_cancelled), or simply by
//! using `?` on its emits — every emit after cancellation fails.
//!
//! # Why there is no `AgUiLayer`
//!
//! A tower layer wraps a `Service`, so it sees a `Request` and a `Response` —
//! at that point the events have already been serialized into an SSE body.
//! Applying a [`StreamTransformer`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/transform/trait.StreamTransformer.html) there
//! would mean parsing the frames back into events, transforming, and
//! re-encoding: slower, lossy at the edges, and it would silently mangle the
//! body of any *other* route the layer happened to cover.
//! [`AgentEndpoint::transformer`] applies transformers where the events are
//! still typed, one chain per run. Layers you actually want — CORS, auth,
//! timeouts, tracing, compression — are the ones tower already ships, and they
//! compose with this endpoint like any other route.
//!
//! [AG-UI]: https://docs.ag-ui.com
//! [axum]: https://docs.rs/axum

pub mod error;
pub mod extract;
pub mod respond;
pub mod router;

pub use error::{Error, Result};
pub use extract::AgUiInput;
pub use respond::{SseResponse, negotiate};
pub use router::{AgentEndpoint, RouterExt};
