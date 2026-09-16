//! Mounting an agent on a router.
//!
//! ```
//! use ag_ui::axum::RouterExt;
//! use axum::Router;
//! use axum::routing::get;
//! # use ag_ui::RunOutcome;
//! # use ag_ui::server::{Agent, Result, RunContext};
//! # struct CartAgent;
//! # impl Agent for CartAgent {
//! #     type State = ();
//! #     async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> { Ok(RunOutcome::Success) }
//! # }
//!
//! let app: Router = Router::new()
//!     .route("/health", get(|| async { "ok" }))
//!     .route_agui("/agent", CartAgent);
//! # let _ = app;
//! ```

use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;

use crate::server::{Agent, Runner, StreamTransformer, TransformerChain};
use axum::Router;
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;

use crate::axum::error::Error;
use crate::axum::extract::AgUiInput;
use crate::axum::respond::SseResponse;

/// Builds one transformer, once per run.
type TransformerFactory = Arc<dyn Fn(&mut TransformerChain) + Send + Sync>;

/// An agent plus the per-run settings it is served with.
///
/// [`route_agui`](RouterExt::route_agui) mounts an agent with the defaults;
/// build one of these and use [`route_agui_with`](RouterExt::route_agui_with)
/// when you want to change them.
///
/// ```
/// use ag_ui::axum::{AgentEndpoint, RouterExt};
/// use ag_ui::server::FilterToolCalls;
/// use axum::Router;
/// use std::time::Duration;
/// # use ag_ui::RunOutcome;
/// # use ag_ui::server::{Agent, Result, RunContext};
/// # struct CartAgent;
/// # impl Agent for CartAgent {
/// #     type State = ();
/// #     async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> { Ok(RunOutcome::Success) }
/// # }
///
/// let endpoint = AgentEndpoint::new(CartAgent)
///     .transformer(|| FilterToolCalls::deny(["internal_debug"]))
///     .keep_alive(Duration::from_secs(15));
///
/// let app: Router = Router::new().route_agui_with("/agent", endpoint);
/// # let _ = app;
/// ```
pub struct AgentEndpoint<A> {
    agent: Arc<A>,
    transformers: Vec<TransformerFactory>,
    echo_input: bool,
    keep_alive: Option<Duration>,
    event_buffer_capacity: Option<NonZeroUsize>,
}

impl<A> AgentEndpoint<A> {
    /// Wraps an agent with the default settings.
    pub fn new(agent: A) -> Self {
        Self {
            agent: Arc::new(agent),
            transformers: Vec::new(),
            echo_input: false,
            keep_alive: None,
            event_buffer_capacity: None,
        }
    }

    /// Appends a transformer to every run's chain.
    ///
    /// # Why a closure and not a transformer
    ///
    /// A [`StreamTransformer`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/transform/trait.StreamTransformer.html) takes `&mut self` because a useful one is a
    /// state machine — [`FilterToolCalls`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/transform/struct.FilterToolCalls.html)
    /// remembers which call ids it dropped. One instance shared across
    /// concurrent runs would leak one run's state into another, so the endpoint
    /// stores the recipe and builds a fresh chain per request.
    #[must_use]
    pub fn transformer<F, T>(mut self, factory: F) -> Self
    where
        F: Fn() -> T + Send + Sync + 'static,
        T: StreamTransformer + 'static,
    {
        self.transformers
            .push(Arc::new(move |chain: &mut TransformerChain| {
                chain.push(factory());
            }));
        self
    }

    /// Echoes the request body back on `RUN_STARTED`.
    ///
    /// See [`Runner::echo_input`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/run/struct.Runner.html#method.echo_input). Off by default — it is the largest payload
    /// in the protocol.
    #[must_use]
    pub fn echo_input(mut self, echo: bool) -> Self {
        self.echo_input = echo;
        self
    }

    /// Sends an SSE comment whenever a run produces nothing for `interval`.
    ///
    /// See [`SseResponse::keep_alive`]. Off by default.
    #[must_use]
    pub fn keep_alive(mut self, interval: Duration) -> Self {
        self.keep_alive = Some(interval);
        self
    }

    /// Limits each run's queued events. See
    /// [`Runner::event_buffer_capacity`](https://docs.rs/ag-ui/0.4.2/ag_ui/server/run/struct.Runner.html#method.event_buffer_capacity).
    /// Overflow produces an `EVENT_BUFFER_FULL` terminal error; callers using
    /// durable execution can reconnect from their application's saved state.
    #[must_use]
    pub fn event_buffer_capacity(mut self, capacity: NonZeroUsize) -> Self {
        self.event_buffer_capacity = Some(capacity);
        self
    }

    /// A fresh chain for one run.
    fn chain(&self) -> TransformerChain {
        let mut chain = TransformerChain::new();
        for factory in &self.transformers {
            factory(&mut chain);
        }
        chain
    }
}

impl<A: Agent + 'static> AgentEndpoint<A> {
    /// Serves one request: negotiate, decode, run, stream.
    ///
    /// Negotiation is reported first. A request that fails both checks has
    /// nothing in common with this endpoint at all, and saying so is more use
    /// to the caller than a note about a body that was never going to be
    /// answered.
    async fn serve(&self, headers: HeaderMap, input: Result<AgUiInput, Error>) -> Response {
        let accept = headers
            .get(header::ACCEPT)
            .map(|value| String::from_utf8_lossy(value.as_bytes()));

        let response = match SseResponse::negotiate(accept.as_deref()) {
            Ok(response) => response,
            Err(error) => return error.into_response(),
        };
        let input = match input {
            Ok(AgUiInput(input)) => input,
            Err(error) => return error.into_response(),
        };

        let mut runner = Runner::new(Arc::clone(&self.agent))
            .transformers(self.chain())
            .echo_input(self.echo_input);
        if let Some(capacity) = self.event_buffer_capacity {
            runner = runner.event_buffer_capacity(capacity);
        }

        // The token has to come off the runner before `run` consumes it.
        let mut response = response.cancellation(runner.cancellation_token());
        if let Some(interval) = self.keep_alive {
            response = response.keep_alive(interval);
        }
        response.stream(runner.run(input))
    }
}

impl<A> std::fmt::Debug for AgentEndpoint<A> {
    /// Describes the settings, not the agent: an agent holds an LLM client and
    /// a database handle, and neither is `Debug`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentEndpoint")
            .field("agent", &std::any::type_name::<A>())
            .field("transformers", &self.transformers.len())
            .field("echo_input", &self.echo_input)
            .field("keep_alive", &self.keep_alive)
            .field("event_buffer_capacity", &self.event_buffer_capacity)
            .finish()
    }
}

/// Mounts AG-UI agents on an [`axum::Router`].
///
/// # What it does to the router
///
/// `route_agui(path, agent)` is `route(path, post(handler))` and nothing else:
/// the endpoint composes with the router's other routes, with `nest`, `merge`
/// and `fallback`, and with any layer applied before or after it. A `GET` on
/// the path still gets axum's own `405`.
///
/// # The state parameter
///
/// The handler reads only the request, so it is a `Handler<_, S>` for **every**
/// router state `S`. Mounting an agent therefore places no constraint on `S`
/// beyond axum's own `Clone + Send + Sync + 'static`, and works the same in a
/// `Router<()>` and in a `Router<AppState>` — including before
/// [`with_state`](axum::Router::with_state) is called.
///
/// An agent that needs values from the router state should capture them when it
/// is constructed (`CartAgent::new(state.catalog.clone())`). Extracting `State`
/// inside the AG-UI handler would tie this crate's one-line mount to a single
/// application's state type, which is the opposite of what it is for.
pub trait RouterExt<S>: Sized {
    /// Mounts `agent` as a `POST` endpoint at `path`.
    ///
    /// The endpoint answers with `text/event-stream`, cancels the run when the
    /// client disconnects, and refuses a request it cannot answer with a `4xx`.
    #[must_use]
    fn route_agui<A>(self, path: &str, agent: A) -> Self
    where
        A: Agent + 'static,
    {
        self.route_agui_with(path, AgentEndpoint::new(agent))
    }

    /// Mounts a configured [`AgentEndpoint`] as a `POST` endpoint at `path`.
    #[must_use]
    fn route_agui_with<A>(self, path: &str, endpoint: AgentEndpoint<A>) -> Self
    where
        A: Agent + 'static;
}

impl<S> RouterExt<S> for Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn route_agui_with<A>(self, path: &str, endpoint: AgentEndpoint<A>) -> Self
    where
        A: Agent + 'static,
    {
        // One `Arc` for the endpoint, cloned per request; the agent itself is
        // never cloned. `Arc<A>: Agent` is what lets the runner take it by
        // value.
        let endpoint = Arc::new(endpoint);
        self.route(
            path,
            post(move |headers: HeaderMap, input: Result<AgUiInput, Error>| {
                let endpoint = Arc::clone(&endpoint);
                async move { endpoint.serve(headers, input).await }
            }),
        )
    }
}
