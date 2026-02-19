//! Server-side SDK for hosting AG-UI protocol agents.
//!
//! This crate provides everything needed to build and deploy agents that
//! communicate using the AG-UI protocol. It handles event encoding, state
//! management, and integrates with popular Rust web frameworks.
//!
//! # Architecture
//!
//! The SDK is built around three core abstractions:
//!
//! 1. **[`Agent`]** trait - Define your agent logic by implementing this trait
//! 2. **[`StateManager`]** - Thread-safe state management with JSON Patch support
//! 3. **[`EventEncoder`]** - Encode events to SSE or Protocol Buffer format
//!
//! # Quick Start
//!
//! ```rust,no_run
//! use ag_ui_server::{Agent, AgentContext, AgentResult, RunAgentInput};
//! use ag_ui_core::event::Event;
//! use async_trait::async_trait;
//! use futures::stream::BoxStream;
//!
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
//!         // Your agent logic here
//!         todo!("implement agent logic")
//!     }
//! }
//! ```
//!
//! # Framework Integration
//!
//! With the `axum-integration` feature (enabled by default), you can easily
//! mount your agent as an HTTP endpoint:
//!
//! ```rust,ignore
//! use ag_ui_server::integrations::axum::{AgentRouter, agent_handler};
//! use axum::Router;
//!
//! let app = Router::new()
//!     .merge(AgentRouter::new(MyAgent).into_router());
//! ```
//!
//! # State Management
//!
//! The [`StateManager`] provides thread-safe state operations with automatic
//! delta generation using JSON Patch (RFC 6902):
//!
//! ```rust
//! use ag_ui_server::state::StateManager;
//! use serde_json::json;
//!
//! let state = StateManager::new(json!({"count": 0}));
//!
//! // Apply updates and get deltas
//! let delta = state.update(|s| {
//!     s["count"] = json!(1);
//! }).expect("update should succeed");
//!
//! // Delta contains the JSON Patch operations
//! assert!(!delta.0.is_empty());
//! ```
//!
//! # Features
//!
//! - `axum-integration` (default) - Axum web framework integration
//! - `proto` - Protocol Buffer encoding for higher throughput
//!
//! # Error Handling
//!
//! All operations use structured error types from the [`error`] module.
//! Errors carry rich context for debugging while remaining efficient.

#![warn(missing_docs)]
#![warn(clippy::all)]
#![warn(clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]

pub mod agent;
pub mod encoder;
pub mod error;
pub mod state;

#[cfg(feature = "axum-integration")]
pub mod integrations;

// Re-export core types for convenience
pub use agent::{Agent, AgentContext, DynAgent, HealthStatus, RequestMetadata};
pub use encoder::{encode_sse, ContentType, EventEncoder};
pub use error::{AgentError, AgentResult, EncodeError, EncodeResult, StateError, StateResult};
pub use state::{StateManager, StatePatch};

// Re-export the entire ag-ui-core crate for full access
pub use ag_ui_core;

// Re-export commonly used core types for convenience
pub use ag_ui_core::event::{BaseEvent, Event};
pub use ag_ui_core::types::ids::{MessageId, RunId, ThreadId};
pub use ag_ui_core::types::input::RunAgentInput;
pub use ag_ui_core::types::message::Role;
pub use ag_ui_core::AgentState;

/// Prelude module for convenient imports.
///
/// # Example
///
/// ```rust
/// use ag_ui_server::prelude::*;
/// ```
pub mod prelude {
    pub use crate::agent::{Agent, AgentContext, DynAgent, HealthStatus};
    pub use crate::encoder::{ContentType, EventEncoder};
    pub use crate::error::{AgentError, AgentResult, EncodeError, StateError};
    pub use crate::state::{StateManager, StatePatch};

    pub use ag_ui_core::event::{BaseEvent, Event};
    pub use ag_ui_core::types::ids::{MessageId, RunId, ThreadId};
    pub use ag_ui_core::types::input::RunAgentInput;
    pub use ag_ui_core::types::message::Role;
    pub use ag_ui_core::AgentState;

    pub use async_trait::async_trait;
    pub use futures::stream::BoxStream;
}

#[cfg(test)]
mod tests {
    #[test]
    fn prelude_imports_work() {
        // Verify the prelude compiles and types are accessible
        use crate::prelude::*;

        fn _assert_trait_bounds<T: Agent>() {}
        fn _assert_state_manager<S: AgentState>(_: StateManager<S>) {}
    }
}
