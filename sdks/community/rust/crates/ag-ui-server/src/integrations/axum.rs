//! Axum web framework integration for AG-UI agents.
//!
//! This module provides seamless integration with the [Axum](https://docs.rs/axum)
//! web framework, including:
//!
//! - SSE streaming response handler
//! - Content-type negotiation from Accept header
//! - Request body parsing for [`RunAgentInput`]
//! - Health check endpoint
//! - Router builder for easy setup
//!
//! # Quick Start
//!
//! ```rust,no_run
//! use ag_ui_server::prelude::*;
//! use ag_ui_server::integrations::axum::{AgentRouter, AgentState as AxumAgentState};
//! use axum::Router;
//! use std::sync::Arc;
//!
//! // Your agent implementation
//! struct MyAgent;
//!
//! #[async_trait]
//! impl Agent for MyAgent {
//!     type State = serde_json::Value;
//!
//!     async fn run(
//!         &self,
//!         input: RunAgentInput<Self::State>,
//!         ctx: AgentContext,
//!     ) -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> {
//!         todo!()
//!     }
//! }
//!
//! #[tokio::main]
//! async fn main() {
//!     let agent = Arc::new(MyAgent);
//!
//!     let app = Router::new()
//!         .merge(AgentRouter::new(agent).into_router());
//!
//!     // Run with axum server...
//! }
//! ```
//!
//! # Custom Routes
//!
//! You can also use the handler functions directly for custom routing:
//!
//! ```rust,no_run
//! use ag_ui_server::integrations::axum::{run_agent_handler, health_handler, AgentState};
//! use axum::{routing::{get, post}, Router};
//!
//! # struct MyAgent;
//! # use ag_ui_server::prelude::*;
//! # #[async_trait]
//! # impl Agent for MyAgent {
//! #     type State = serde_json::Value;
//! #     async fn run(&self, _: RunAgentInput<Self::State>, _: AgentContext)
//! #         -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> { todo!() }
//! # }
//! use std::sync::Arc;
//!
//! let agent = Arc::new(MyAgent);
//!
//! let app: Router = Router::new()
//!     .route("/custom/run", post(run_agent_handler::<MyAgent>))
//!     .route("/custom/health", get(health_handler::<MyAgent>))
//!     .with_state(AgentState::new(agent));
//! ```

use crate::agent::{Agent, AgentContext, HealthStatus, RequestMetadata};
use crate::encoder::EventEncoder;
use crate::error::AgentError;
use ag_ui_core::event::{BaseEvent, Event, RunErrorEvent};
use ag_ui_core::types::input::RunAgentInput;
use axum::body::Body;
use axum::extract::State;
use axum::http::header::{ACCEPT, CACHE_CONTROL, CONNECTION, CONTENT_TYPE};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

/// Create a `BaseEvent` with the current timestamp.
fn base_event_now() -> BaseEvent {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .ok();
    BaseEvent {
        timestamp,
        raw_event: None,
    }
}

/// Axum application state containing the agent.
///
/// This is the shared state passed to all handlers. It wraps your agent
/// in an `Arc` for thread-safe sharing.
pub struct AgentState<A: Agent> {
    agent: Arc<A>,
}

impl<A: Agent> Clone for AgentState<A> {
    fn clone(&self) -> Self {
        Self {
            agent: Arc::clone(&self.agent),
        }
    }
}

impl<A: Agent> AgentState<A> {
    /// Create new agent state from an Arc-wrapped agent.
    pub fn new(agent: Arc<A>) -> Self {
        Self { agent }
    }

    /// Get a reference to the agent.
    #[must_use]
    pub fn agent(&self) -> &A {
        &self.agent
    }
}

/// Router builder for AG-UI agents.
///
/// Provides a convenient way to create an Axum router with all the
/// standard AG-UI endpoints configured.
///
/// # Endpoints
///
/// - `POST /` - Run the agent (main endpoint)
/// - `GET /health` - Health check
///
/// # Example
///
/// ```rust,no_run
/// use ag_ui_server::integrations::axum::AgentRouter;
/// use std::sync::Arc;
///
/// # struct MyAgent;
/// # use ag_ui_server::prelude::*;
/// # #[async_trait]
/// # impl Agent for MyAgent {
/// #     type State = serde_json::Value;
/// #     async fn run(&self, _: RunAgentInput<Self::State>, _: AgentContext)
/// #         -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> { todo!() }
/// # }
///
/// let agent = Arc::new(MyAgent);
/// let router = AgentRouter::new(agent)
///     .with_path_prefix("/api/agent")
///     .into_router();
/// ```
pub struct AgentRouter<A: Agent> {
    agent: Arc<A>,
    path_prefix: String,
}

impl<A: Agent + 'static> AgentRouter<A> {
    /// Create a new router builder with the given agent.
    pub fn new(agent: Arc<A>) -> Self {
        Self {
            agent,
            path_prefix: String::new(),
        }
    }

    /// Set a path prefix for all routes.
    ///
    /// The prefix should start with `/` and not end with `/`.
    ///
    /// # Example
    ///
    /// ```rust,no_run
    /// # use ag_ui_server::integrations::axum::AgentRouter;
    /// # use std::sync::Arc;
    /// # struct MyAgent;
    /// # use ag_ui_server::prelude::*;
    /// # #[async_trait]
    /// # impl Agent for MyAgent {
    /// #     type State = serde_json::Value;
    /// #     async fn run(&self, _: RunAgentInput<Self::State>, _: AgentContext)
    /// #         -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> { todo!() }
    /// # }
    /// let router = AgentRouter::new(Arc::new(MyAgent))
    ///     .with_path_prefix("/api/v1/agent")
    ///     .into_router();
    /// ```
    #[must_use]
    pub fn with_path_prefix(mut self, prefix: impl Into<String>) -> Self {
        self.path_prefix = prefix.into();
        self
    }

    /// Build the Axum router with all endpoints configured.
    pub fn into_router(self) -> Router {
        let state = AgentState::new(self.agent);

        let run_path = if self.path_prefix.is_empty() {
            "/".to_string()
        } else {
            self.path_prefix.clone()
        };

        let health_path = if self.path_prefix.is_empty() {
            "/health".to_string()
        } else {
            format!("{}/health", self.path_prefix)
        };

        Router::new()
            .route(&run_path, post(run_agent_handler::<A>))
            .route(&health_path, get(health_handler::<A>))
            .with_state(state)
    }
}

/// Handler for running the agent.
///
/// This handler:
/// 1. Parses the request body as [`RunAgentInput`]
/// 2. Extracts request metadata from headers
/// 3. Creates an [`AgentContext`] with cancellation support
/// 4. Calls the agent's `run` method
/// 5. Streams events back as SSE
///
/// # Content Negotiation
///
/// The handler respects the `Accept` header for content type selection:
/// - `text/event-stream` (default) - SSE format
/// - `application/x-ag-ui-proto` - Protocol Buffers (if `proto` feature enabled)
///
/// # Panics
///
/// This function will panic if the HTTP response builder fails to construct
/// a valid response. This should not occur with valid inputs.
pub async fn run_agent_handler<A>(
    State(state): State<AgentState<A>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response
where
    A: Agent + 'static,
{
    // Parse Accept header for content negotiation
    let accept = headers
        .get(ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/event-stream");
    let encoder = EventEncoder::from_accept(accept);

    // Extract request metadata
    let metadata = RequestMetadata::from_headers(&headers);

    // Create cancellation token for cooperative shutdown
    let cancel_token = CancellationToken::new();

    // Create agent context
    let ctx = AgentContext::new(cancel_token.clone(), metadata);

    // Parse request body
    let body = request.into_body();
    let bytes = match axum::body::to_bytes(body, 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                format!("failed to read request body: {e}"),
            );
        }
    };

    let input: RunAgentInput<A::State> = match serde_json::from_slice(&bytes) {
        Ok(i) => i,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                format!("invalid request body: {e}"),
            );
        }
    };

    // Run the agent
    let event_stream = match state.agent.run(input, ctx).await {
        Ok(stream) => stream,
        Err(e) => {
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };

    // Create SSE response
    let content_type = encoder.content_type();

    let response_stream = event_stream.map(move |result| {
        match result {
            Ok(event) => match encoder.encode(&event) {
                Ok(bytes) => Ok::<_, Infallible>(bytes),
                Err(e) => {
                    // Encode error as RUN_ERROR event
                    let error_event: Event<A::State> = Event::RunError(RunErrorEvent {
                        base: base_event_now(),
                        message: format!("encoding error: {e}"),
                        code: Some("ENCODE_ERROR".to_string()),
                    });
                    match encoder.encode(&error_event) {
                        Ok(bytes) => Ok(bytes),
                        Err(_) => {
                            // Last resort: raw SSE error
                            Ok(bytes::Bytes::from(
                                "data: {\"type\":\"RUN_ERROR\",\"message\":\"encoding failed\"}\n\n",
                            ))
                        }
                    }
                }
            },
            Err(e) => {
                // Agent error - encode as RUN_ERROR
                let error_event: Event<A::State> = Event::RunError(RunErrorEvent {
                    base: base_event_now(),
                    message: e.to_string(),
                    code: Some(error_code(&e)),
                });
                match encoder.encode(&error_event) {
                    Ok(bytes) => Ok(bytes),
                    Err(_) => Ok(bytes::Bytes::from(format!(
                        "data: {{\"type\":\"RUN_ERROR\",\"message\":\"{}\"}}\n\n",
                        e.to_string().replace('"', "\\\"")
                    ))),
                }
            }
        }
    });

    let body = Body::from_stream(response_stream);

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, "no-cache")
        .header(CONNECTION, "keep-alive")
        .body(body)
        .expect("response builder should not fail with valid inputs")
}

/// Extract an error code from an agent error.
fn error_code(error: &AgentError) -> String {
    match error {
        AgentError::Aborted { .. } => "ABORTED".to_string(),
        AgentError::ProtocolViolation { .. } => "PROTOCOL_VIOLATION".to_string(),
        AgentError::State(_) => "STATE_ERROR".to_string(),
        AgentError::Encoding(_) => "ENCODING_ERROR".to_string(),
        AgentError::Transport(_) => "TRANSPORT_ERROR".to_string(),
        AgentError::Custom { .. } => "CUSTOM_ERROR".to_string(),
        AgentError::Internal { .. } => "INTERNAL_ERROR".to_string(),
    }
}

/// Health check response.
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    /// Health status string.
    pub status: String,
    /// Agent name.
    pub agent: String,
    /// Optional details.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// Handler for health check endpoint.
///
/// Returns the agent's health status as JSON.
pub async fn health_handler<A>(State(state): State<AgentState<A>>) -> impl IntoResponse
where
    A: Agent + 'static,
{
    match state.agent.health().await {
        Ok(status) => {
            let (status_str, details) = match status {
                HealthStatus::Healthy => ("healthy", None),
                HealthStatus::Degraded { reason } => ("degraded", Some(reason)),
                HealthStatus::Unhealthy { reason } => ("unhealthy", Some(reason)),
            };

            let response = HealthResponse {
                status: status_str.to_string(),
                agent: state.agent.name().to_string(),
                details,
            };

            let status_code = match status_str {
                "healthy" | "degraded" => StatusCode::OK,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };

            (status_code, Json(response))
        }
        Err(e) => {
            let response = HealthResponse {
                status: "error".to_string(),
                agent: state.agent.name().to_string(),
                details: Some(e.to_string()),
            };
            (StatusCode::INTERNAL_SERVER_ERROR, Json(response))
        }
    }
}

/// Create an error response with the given status code and message.
fn error_response(status: StatusCode, message: impl AsRef<str>) -> Response {
    let message = message.as_ref();
    let body = serde_json::json!({
        "error": message
    });

    let escaped = message.replace('"', "\\\"");
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_string(&body).unwrap_or_else(|_| {
            format!("{{\"error\":\"{escaped}\"}}")
        })))
        .expect("response builder should not fail with valid inputs")
}

/// Extension trait for extracting request metadata from headers.
impl RequestMetadata {
    /// Extract request metadata from Axum headers.
    #[must_use]
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let mut metadata = Self::default();

        // Extract common headers
        if let Some(auth) = headers.get("authorization") {
            if let Ok(s) = auth.to_str() {
                metadata.headers.insert("authorization".to_string(), s.to_string());
            }
        }

        if let Some(req_id) = headers.get("x-request-id") {
            if let Ok(s) = req_id.to_str() {
                metadata.request_id = Some(s.to_string());
            }
        }

        if let Some(trace) = headers.get("x-trace-id") {
            if let Ok(s) = trace.to_str() {
                metadata.trace_id = Some(s.to_string());
            }
        }

        if let Some(user_agent) = headers.get("user-agent") {
            if let Ok(s) = user_agent.to_str() {
                metadata.headers.insert("user-agent".to_string(), s.to_string());
            }
        }

        metadata
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentContext;
    use crate::error::AgentResult;
    use ag_ui_core::event::{BaseEvent, RunFinishedEvent, RunStartedEvent};
    use ag_ui_core::types::{RunId, ThreadId};
    use async_trait::async_trait;
    use axum::body::to_bytes;
    use axum::http::Request;
    use futures::stream::{self, BoxStream};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tower::ServiceExt;

    fn test_base_event() -> BaseEvent {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .ok();
        BaseEvent {
            timestamp,
            raw_event: None,
        }
    }

    // Test agent implementation
    struct TestAgent;

    #[async_trait]
    impl Agent for TestAgent {
        type State = serde_json::Value;

        async fn run(
            &self,
            input: RunAgentInput<Self::State>,
            _ctx: AgentContext,
        ) -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> {
            let thread_id = input.thread_id;
            let run_id = input.run_id;

            let events = vec![
                Ok(Event::RunStarted(RunStartedEvent {
                    base: test_base_event(),
                    thread_id: thread_id.clone(),
                    run_id: run_id.clone(),
                })),
                Ok(Event::RunFinished(RunFinishedEvent {
                    base: test_base_event(),
                    thread_id,
                    run_id,
                    result: Some(serde_json::json!({"status": "ok"})),
                })),
            ];

            Ok(Box::pin(stream::iter(events)))
        }

        fn name(&self) -> &'static str {
            "test-agent"
        }
    }

    #[tokio::test]
    async fn agent_router_health_endpoint() {
        let agent = Arc::new(TestAgent);
        let app = AgentRouter::new(agent).into_router();

        let response = app
            .oneshot(Request::get("/health").body(Body::empty()).expect("request should build"))
            .await
            .expect("response should be ok");

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), 1024 * 1024).await.expect("body should read");
        let health: HealthResponse = serde_json::from_slice(&body).expect("should parse as health response");

        assert_eq!(health.status, "healthy");
        assert_eq!(health.agent, "test-agent");
    }

    #[tokio::test]
    async fn agent_router_run_endpoint() {
        let agent = Arc::new(TestAgent);
        let app = AgentRouter::new(agent).into_router();

        let input = RunAgentInput::<serde_json::Value> {
            thread_id: ThreadId::new("test-thread"),
            run_id: RunId::new("test-run"),
            messages: Vec::new(),
            tools: Vec::new(),
            context: Vec::new(),
            forwarded_props: serde_json::Value::Null,
            state: serde_json::Value::Null,
        };

        let body = serde_json::to_string(&input).expect("input should serialize");

        let response = app
            .oneshot(
                Request::post("/")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request should build"),
            )
            .await
            .expect("response should be ok");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).expect("should have content-type").to_str().expect("content-type should be valid string"),
            "text/event-stream"
        );

        let body = to_bytes(response.into_body(), 1024 * 1024).await.expect("body should read");
        let body_str = String::from_utf8_lossy(&body);

        assert!(body_str.contains("RUN_STARTED"));
        assert!(body_str.contains("RUN_FINISHED"));
    }

    #[tokio::test]
    async fn agent_router_with_prefix() {
        let agent = Arc::new(TestAgent);
        let app = AgentRouter::new(agent)
            .with_path_prefix("/api/agent")
            .into_router();

        let response = app
            .oneshot(
                Request::get("/api/agent/health")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("response should be ok");

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn request_metadata_from_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer token".parse().expect("header value should parse"));
        headers.insert("x-request-id", "req-123".parse().expect("header value should parse"));
        headers.insert("x-trace-id", "trace-456".parse().expect("header value should parse"));
        headers.insert("user-agent", "test-client/1.0".parse().expect("header value should parse"));

        let metadata = RequestMetadata::from_headers(&headers);

        assert_eq!(metadata.request_id, Some("req-123".to_string()));
        assert_eq!(metadata.trace_id, Some("trace-456".to_string()));
        assert_eq!(
            metadata.headers.get("authorization"),
            Some(&"Bearer token".to_string())
        );
        assert_eq!(
            metadata.headers.get("user-agent"),
            Some(&"test-client/1.0".to_string())
        );
    }

    #[tokio::test]
    async fn run_handler_invalid_json() {
        let agent = Arc::new(TestAgent);
        let app = AgentRouter::new(agent).into_router();

        let response = app
            .oneshot(
                Request::post("/")
                    .header("content-type", "application/json")
                    .body(Body::from("not valid json"))
                    .expect("request should build"),
            )
            .await
            .expect("response should be ok");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
