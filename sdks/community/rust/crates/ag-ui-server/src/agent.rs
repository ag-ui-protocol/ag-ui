//! Core agent abstraction for AG-UI server implementations.
//!
//! This module provides the [`Agent`] trait that server-side agent implementations
//! must implement, along with supporting types for context, health checks, and
//! request metadata.
//!
//! # Architecture
//!
//! The agent system is designed around these principles:
//!
//! 1. **Async-first**: All operations are async and return streams
//! 2. **Cancellation-aware**: Agents can be cancelled cooperatively
//! 3. **Type-safe state**: Generic over state type with sensible defaults
//! 4. **Framework-agnostic**: Core trait has no web framework dependencies
//!
//! # Example
//!
//! ```rust,no_run
//! use ag_ui_server::{Agent, AgentContext, AgentResult, RunAgentInput};
//! use ag_ui_core::event::Event;
//! use async_trait::async_trait;
//! use futures::stream::{self, BoxStream, StreamExt};
//!
//! struct EchoAgent;
//!
//! #[async_trait]
//! impl Agent for EchoAgent {
//!     type State = serde_json::Value;
//!
//!     async fn run(
//!         &self,
//!         input: RunAgentInput<Self::State>,
//!         ctx: AgentContext,
//!     ) -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> {
//!         // Implementation here
//!         # todo!()
//!     }
//! }
//! ```

use crate::error::AgentResult;
use ag_ui_core::event::Event;
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::AgentState;
use async_trait::async_trait;
use futures::stream::BoxStream;
use std::collections::HashMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Context provided to agent runs.
///
/// Contains shared resources, cancellation support, and request metadata
/// for coordinated operation across async boundaries.
///
/// # Cancellation
///
/// The context provides cooperative cancellation through [`CancellationToken`].
/// Agents should periodically check for cancellation:
///
/// ```rust,ignore
/// // Option 1: Poll-based check
/// if ctx.is_cancelled() {
///     return Err(AgentError::Aborted { reason: "client disconnect".into() });
/// }
///
/// // Option 2: Select-based (preferred for async operations)
/// tokio::select! {
///     _ = ctx.cancelled() => {
///         // Handle cancellation
///     }
///     result = some_async_operation() => {
///         // Handle result
///     }
/// }
/// ```
///
/// # Cloning
///
/// `AgentContext` is cheap to clone (uses `Arc` internally) and can be
/// passed to spawned tasks that need cancellation awareness.
#[derive(Clone)]
pub struct AgentContext {
    /// Token for cooperative cancellation.
    cancellation: CancellationToken,
    /// Request metadata (headers, remote address, etc.).
    metadata: Arc<RequestMetadata>,
}

impl AgentContext {
    /// Create a new agent context with a cancellation token and metadata.
    ///
    /// # Arguments
    ///
    /// * `cancellation` - Token for cooperative cancellation
    /// * `metadata` - Request metadata extracted from the incoming request
    #[must_use]
    pub fn new(cancellation: CancellationToken, metadata: RequestMetadata) -> Self {
        Self {
            cancellation,
            metadata: Arc::new(metadata),
        }
    }

    /// Create a new agent context with the given metadata (creates its own cancellation token).
    ///
    /// # Arguments
    ///
    /// * `metadata` - Request metadata extracted from the incoming request
    #[must_use]
    pub fn with_metadata(metadata: RequestMetadata) -> Self {
        Self {
            cancellation: CancellationToken::new(),
            metadata: Arc::new(metadata),
        }
    }

    /// Create a context with default (empty) metadata.
    ///
    /// Useful for testing or when metadata isn't relevant.
    #[must_use]
    pub fn empty() -> Self {
        Self::with_metadata(RequestMetadata::default())
    }

    /// Returns a future that completes when cancellation is requested.
    ///
    /// This is the preferred way to handle cancellation in async code:
    ///
    /// ```rust,ignore
    /// tokio::select! {
    ///     _ = ctx.cancelled() => {
    ///         tracing::info!("agent run cancelled");
    ///         return;
    ///     }
    ///     result = long_running_operation() => {
    ///         // process result
    ///     }
    /// }
    /// ```
    pub fn cancelled(&self) -> tokio_util::sync::WaitForCancellationFuture<'_> {
        self.cancellation.cancelled()
    }

    /// Request cancellation of the agent run.
    ///
    /// This signals all holders of this context (or child tokens) that
    /// cancellation has been requested. Cancellation is cooperative -
    /// the agent must check and respond to it.
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    /// Check if cancellation has been requested.
    ///
    /// For tight loops where `select!` isn't practical:
    ///
    /// ```rust,ignore
    /// for item in items {
    ///     if ctx.is_cancelled() {
    ///         break;
    ///     }
    ///     process(item).await;
    /// }
    /// ```
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    /// Create a child cancellation token.
    ///
    /// Useful when spawning subtasks that should be cancelled when the
    /// parent is cancelled, but may also be cancelled independently.
    #[must_use]
    pub fn child_token(&self) -> CancellationToken {
        self.cancellation.child_token()
    }

    /// Access the request metadata.
    #[must_use]
    pub fn metadata(&self) -> &RequestMetadata {
        &self.metadata
    }

    /// Get a specific header value from the request.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.metadata.headers.get(name).map(String::as_str)
    }
}

impl std::fmt::Debug for AgentContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentContext")
            .field("is_cancelled", &self.is_cancelled())
            .field("metadata", &self.metadata)
            .finish_non_exhaustive()
    }
}

impl Default for AgentContext {
    fn default() -> Self {
        Self::empty()
    }
}

/// Metadata extracted from the incoming HTTP request.
///
/// This provides agents access to request-level information like headers,
/// which can be useful for authentication, tracing, or custom logic.
#[derive(Debug, Clone, Default)]
pub struct RequestMetadata {
    /// HTTP headers from the request (lowercase keys).
    pub headers: HashMap<String, String>,
    /// Remote address of the client, if available.
    pub remote_addr: Option<String>,
    /// Request ID for tracing/correlation.
    pub request_id: Option<String>,
    /// Trace ID for distributed tracing.
    pub trace_id: Option<String>,
}

impl RequestMetadata {
    /// Create new metadata with the given headers.
    #[must_use]
    pub fn with_headers(headers: HashMap<String, String>) -> Self {
        Self {
            headers,
            remote_addr: None,
            request_id: None,
            trace_id: None,
        }
    }

    /// Set the remote address.
    #[must_use]
    pub fn with_remote_addr(mut self, addr: impl Into<String>) -> Self {
        self.remote_addr = Some(addr.into());
        self
    }

    /// Set the request ID.
    #[must_use]
    pub fn with_request_id(mut self, id: impl Into<String>) -> Self {
        self.request_id = Some(id.into());
        self
    }

    /// Set the trace ID.
    #[must_use]
    pub fn with_trace_id(mut self, id: impl Into<String>) -> Self {
        self.trace_id = Some(id.into());
        self
    }

    /// Extract the Authorization header value.
    #[must_use]
    pub fn authorization(&self) -> Option<&str> {
        self.headers.get("authorization").map(String::as_str)
    }

    /// Extract the Content-Type header value.
    #[must_use]
    pub fn content_type(&self) -> Option<&str> {
        self.headers.get("content-type").map(String::as_str)
    }

    /// Extract the Accept header value.
    #[must_use]
    pub fn accept(&self) -> Option<&str> {
        self.headers.get("accept").map(String::as_str)
    }
}

/// Core trait for AG-UI agent implementations.
///
/// Implementors define the agent's behavior by producing a stream of
/// [`Event`]s in response to a [`RunAgentInput`].
///
/// # Protocol Requirements
///
/// The event stream produced by `run` must follow AG-UI protocol rules:
///
/// 1. First event should be `RUN_STARTED`
/// 2. Last event should be `RUN_FINISHED` or `RUN_ERROR`
/// 3. Message events must follow START → CONTENT* → END ordering
/// 4. Tool call events must follow START → ARGS* → END ordering
/// 5. All streams must be closed before `RUN_FINISHED`
///
/// Use the [`EventVerifier`](crate::verify::EventVerifier) from `ag-ui-client`
/// to validate your event streams during development.
///
/// # Error Handling
///
/// Agents should handle errors gracefully:
///
/// - For recoverable errors: emit `RUN_ERROR` and end the stream
/// - For stream-level errors: return `Err` in the stream items
/// - For fatal errors: return `Err` from `run` itself
///
/// # Type Parameters
///
/// * `State` - The state type this agent uses (defaults to `serde_json::Value`)
#[async_trait]
pub trait Agent: Send + Sync {
    /// The state type this agent uses.
    ///
    /// Must implement [`AgentState`] which provides serialization and cloning.
    /// Use `serde_json::Value` for dynamic state or define a custom type
    /// for type-safe state handling.
    type State: AgentState;

    /// Execute an agent run, producing a stream of events.
    ///
    /// # Arguments
    ///
    /// * `input` - The run input containing thread ID, run ID, messages, state, and tools
    /// * `ctx` - Context for cancellation and metadata access
    ///
    /// # Returns
    ///
    /// A boxed stream of event results. The stream should be `'static` to allow
    /// for flexible usage patterns (spawning, etc.).
    ///
    /// # Errors
    ///
    /// Returns `AgentError` if the agent cannot start the run. Once the stream
    /// is returned, errors should be communicated through the stream items.
    async fn run(
        &self,
        input: RunAgentInput<Self::State>,
        ctx: AgentContext,
    ) -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>>;

    /// Optional initialization hook.
    ///
    /// Called once when the agent is first loaded. Use this for expensive
    /// setup operations like loading models, establishing connections, etc.
    ///
    /// # Errors
    ///
    /// Return an error to prevent the agent from being used. The server
    /// should log the error and potentially retry or fail startup.
    async fn init(&self) -> AgentResult<()> {
        Ok(())
    }

    /// Optional shutdown hook.
    ///
    /// Called when the server is shutting down. Use this to clean up
    /// resources, flush buffers, close connections, etc.
    async fn shutdown(&self) -> AgentResult<()> {
        Ok(())
    }

    /// Health check for load balancer probes.
    ///
    /// Override this to implement custom health checking logic, such as
    /// verifying database connections or downstream service availability.
    ///
    /// The default implementation always returns `Healthy`.
    async fn health(&self) -> AgentResult<HealthStatus> {
        Ok(HealthStatus::Healthy)
    }

    /// Agent name for logging and metrics.
    ///
    /// Override this to provide a meaningful name for your agent.
    fn name(&self) -> &'static str {
        "agent"
    }
}

/// Health check status returned by agent health checks.
///
/// Used by load balancers and orchestrators to determine if the agent
/// should receive traffic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthStatus {
    /// Agent is fully operational.
    Healthy,
    /// Agent is operational but experiencing issues.
    ///
    /// Load balancers may reduce traffic but shouldn't remove the instance.
    Degraded {
        /// Human-readable reason for degraded status.
        reason: String,
    },
    /// Agent cannot handle requests.
    ///
    /// Load balancers should stop sending traffic.
    Unhealthy {
        /// Human-readable reason for unhealthy status.
        reason: String,
    },
}

impl HealthStatus {
    /// Check if the status indicates the agent can handle requests.
    #[must_use]
    pub fn is_healthy(&self) -> bool {
        matches!(self, Self::Healthy | Self::Degraded { .. })
    }

    /// Create a degraded status with the given reason.
    pub fn degraded(reason: impl Into<String>) -> Self {
        Self::Degraded {
            reason: reason.into(),
        }
    }

    /// Create an unhealthy status with the given reason.
    pub fn unhealthy(reason: impl Into<String>) -> Self {
        Self::Unhealthy {
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for HealthStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Healthy => write!(f, "healthy"),
            Self::Degraded { reason } => write!(f, "degraded: {reason}"),
            Self::Unhealthy { reason } => write!(f, "unhealthy: {reason}"),
        }
    }
}

/// Type-erased agent wrapper for dynamic dispatch.
///
/// Useful when you need to store agents of different concrete types
/// in the same collection or pass them through non-generic interfaces.
///
/// # Example
///
/// ```rust,ignore
/// let agents: Vec<DynAgent> = vec![
///     DynAgent::new(ChatAgent::new()),
///     DynAgent::new(SearchAgent::new()),
/// ];
/// ```
pub struct DynAgent<S: AgentState = serde_json::Value> {
    inner: Box<dyn Agent<State = S> + Send + Sync>,
    name: &'static str,
}

impl<S: AgentState> DynAgent<S> {
    /// Wrap an agent for dynamic dispatch.
    pub fn new<A: Agent<State = S> + 'static>(agent: A) -> Self {
        let name = agent.name();
        Self {
            inner: Box::new(agent),
            name,
        }
    }

    /// Get the agent's name.
    #[must_use]
    pub fn name(&self) -> &'static str {
        self.name
    }
}

#[async_trait]
impl<S: AgentState> Agent for DynAgent<S> {
    type State = S;

    async fn run(
        &self,
        input: RunAgentInput<Self::State>,
        ctx: AgentContext,
    ) -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> {
        self.inner.run(input, ctx).await
    }

    async fn init(&self) -> AgentResult<()> {
        self.inner.init().await
    }

    async fn shutdown(&self) -> AgentResult<()> {
        self.inner.shutdown().await
    }

    async fn health(&self) -> AgentResult<HealthStatus> {
        self.inner.health().await
    }

    fn name(&self) -> &'static str {
        self.name
    }
}

impl<S: AgentState> std::fmt::Debug for DynAgent<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DynAgent")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AgentError;
    use ag_ui_core::types::{RunId, ThreadId};
    use futures::stream::{self, StreamExt};

    struct TestAgent {
        should_fail: bool,
    }

    #[async_trait]
    impl Agent for TestAgent {
        type State = serde_json::Value;

        async fn run(
            &self,
            _input: RunAgentInput<Self::State>,
            _ctx: AgentContext,
        ) -> AgentResult<BoxStream<'static, AgentResult<Event<Self::State>>>> {
            if self.should_fail {
                return Err(AgentError::custom("test failure"));
            }
            Ok(stream::empty().boxed())
        }

        fn name(&self) -> &'static str {
            "test-agent"
        }
    }

    #[tokio::test]
    async fn context_cancellation() {
        let ctx = AgentContext::empty();
        assert!(!ctx.is_cancelled());

        ctx.cancel();
        assert!(ctx.is_cancelled());
    }

    #[tokio::test]
    async fn context_child_token() {
        let ctx = AgentContext::empty();
        let child = ctx.child_token();

        assert!(!child.is_cancelled());
        ctx.cancel();
        assert!(child.is_cancelled());
    }

    #[tokio::test]
    async fn context_metadata_access() {
        let mut headers = HashMap::new();
        headers.insert("authorization".to_string(), "Bearer token123".to_string());
        headers.insert("x-custom".to_string(), "value".to_string());

        let metadata = RequestMetadata::with_headers(headers)
            .with_remote_addr("192.168.1.1")
            .with_request_id("req-123");

        let ctx = AgentContext::with_metadata(metadata);

        assert_eq!(ctx.header("authorization"), Some("Bearer token123"));
        assert_eq!(ctx.header("x-custom"), Some("value"));
        assert_eq!(ctx.header("nonexistent"), None);
        assert_eq!(ctx.metadata().remote_addr, Some("192.168.1.1".to_string()));
        assert_eq!(ctx.metadata().authorization(), Some("Bearer token123"));
    }

    #[tokio::test]
    async fn health_status_display() {
        assert_eq!(HealthStatus::Healthy.to_string(), "healthy");
        assert_eq!(
            HealthStatus::degraded("high latency").to_string(),
            "degraded: high latency"
        );
        assert_eq!(
            HealthStatus::unhealthy("database down").to_string(),
            "unhealthy: database down"
        );
    }

    #[tokio::test]
    async fn health_status_is_healthy() {
        assert!(HealthStatus::Healthy.is_healthy());
        assert!(HealthStatus::degraded("minor issue").is_healthy());
        assert!(!HealthStatus::unhealthy("critical").is_healthy());
    }

    #[tokio::test]
    async fn dyn_agent_wrapper() {
        let agent = DynAgent::new(TestAgent { should_fail: false });
        assert_eq!(agent.name(), "test-agent");

        let ctx = AgentContext::empty();
        let input = RunAgentInput {
            thread_id: ThreadId::new("thread-1"),
            run_id: RunId::new("run-1"),
            state: serde_json::Value::Null,
            messages: vec![],
            tools: vec![],
            context: vec![],
            forwarded_props: serde_json::Value::Null,
        };

        let result = agent.run(input, ctx).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn agent_error_propagation() {
        let agent = TestAgent { should_fail: true };
        let ctx = AgentContext::empty();
        let input = RunAgentInput {
            thread_id: ThreadId::new("thread-1"),
            run_id: RunId::new("run-1"),
            state: serde_json::Value::Null,
            messages: vec![],
            tools: vec![],
            context: vec![],
            forwarded_props: serde_json::Value::Null,
        };

        let result = agent.run(input, ctx).await;
        assert!(result.is_err());
    }
}
