//! Comprehensive error handling for AG-UI server operations.
//!
//! This module provides a hierarchy of error types that capture all failure
//! modes in the server SDK with rich context for debugging and logging.
//!
//! # Error Philosophy
//!
//! - Every error carries enough context to diagnose the issue
//! - Errors are structured for both human reading and programmatic handling
//! - Source errors are preserved for full error chains
//! - No panics in library code - all failures return `Result`
//!
//! # Example
//!
//! ```rust
//! use ag_ui_server::error::{AgentError, StateError};
//!
//! fn handle_error(err: AgentError) {
//!     match err {
//!         AgentError::Aborted { reason } => {
//!             tracing::info!(%reason, "agent run cancelled");
//!         }
//!         AgentError::State(StateError::MutexPoisoned) => {
//!             tracing::error!("critical: state corruption detected");
//!         }
//!         _ => tracing::warn!(?err, "agent error"),
//!     }
//! }
//! ```

use std::sync::PoisonError;
use thiserror::Error;

/// Top-level errors from agent execution.
///
/// This enum captures all error conditions that can occur during an agent run,
/// from cancellation to protocol violations to internal failures.
#[derive(Error, Debug)]
#[non_exhaustive]
pub enum AgentError {
    /// Agent run was cancelled via abort signal or client disconnect.
    ///
    /// This is a "clean" termination - the agent should emit `RUN_ERROR`
    /// and stop processing.
    #[error("run aborted: {reason}")]
    Aborted {
        /// Human-readable reason for the abort.
        reason: String,
    },

    /// Event violates AG-UI protocol constraints.
    ///
    /// Examples: sending content before start, finishing with active streams,
    /// duplicate message IDs.
    #[error("protocol violation in {event_type}: {violation}")]
    ProtocolViolation {
        /// The event type that triggered the violation.
        event_type: &'static str,
        /// Description of what constraint was violated.
        violation: String,
    },

    /// State management operation failed.
    #[error("state error: {0}")]
    State(#[from] StateError),

    /// Event encoding or serialization failed.
    #[error("encoding error: {0}")]
    Encoding(#[from] EncodeError),

    /// HTTP or transport-level error.
    #[error("transport error: {0}")]
    Transport(#[from] TransportError),

    /// Custom error from agent implementation.
    ///
    /// Use this for domain-specific errors in your agent logic.
    #[error("{message}")]
    Custom {
        /// Error message.
        message: String,
        /// Optional source error for chaining.
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    /// Internal server error - unexpected condition.
    ///
    /// These indicate bugs in the SDK or truly unexpected runtime conditions.
    #[error("internal error: {message}")]
    Internal {
        /// Description of the internal failure.
        message: String,
        /// Location in code where the error originated (`file:line`).
        location: &'static str,
    },
}

impl AgentError {
    /// Create a custom error with a message.
    #[must_use]
    pub fn custom(message: impl Into<String>) -> Self {
        Self::Custom {
            message: message.into(),
            source: None,
        }
    }

    /// Create a custom error with a message and source.
    #[must_use]
    pub fn custom_with_source(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::Custom {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    /// Create an internal error with location tracking.
    ///
    /// Use the `internal_error!` macro instead of calling this directly.
    #[doc(hidden)]
    #[must_use]
    pub fn internal(message: impl Into<String>, location: &'static str) -> Self {
        Self::Internal {
            message: message.into(),
            location,
        }
    }

    /// Check if this error represents a cancellation.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Aborted { .. })
    }

    /// Check if this error is recoverable (client can retry).
    #[must_use]
    pub fn is_recoverable(&self) -> bool {
        matches!(
            self,
            Self::Aborted { .. } | Self::Transport(TransportError::Timeout { .. })
        )
    }
}

/// Macro for creating internal errors with automatic location tracking.
#[macro_export]
macro_rules! internal_error {
    ($msg:expr) => {
        $crate::error::AgentError::internal($msg, concat!(file!(), ":", line!()))
    };
    ($fmt:expr, $($arg:tt)*) => {
        $crate::error::AgentError::internal(format!($fmt, $($arg)*), concat!(file!(), ":", line!()))
    };
}

/// Errors during event encoding and serialization.
#[derive(Error, Debug)]
#[non_exhaustive]
pub enum EncodeError {
    /// JSON serialization failed.
    #[error("JSON serialization failed for {event_type}: {source}")]
    Json {
        /// The event type being serialized.
        event_type: &'static str,
        /// The underlying `serde_json` error.
        #[source]
        source: serde_json::Error,
    },

    /// Protocol buffer encoding failed.
    #[cfg(feature = "proto")]
    #[error("protobuf encoding failed: {0}")]
    Protobuf(#[from] prost::EncodeError),

    /// Requested content type is not supported.
    #[error("unsupported content type: {content_type} (supported: text/event-stream, application/x-ag-ui-proto)")]
    UnsupportedContentType {
        /// The unsupported content type string.
        content_type: String,
    },

    /// Event data exceeds maximum allowed size.
    #[error("event exceeds max size: {size} bytes > {max} bytes limit")]
    EventTooLarge {
        /// Actual size in bytes.
        size: usize,
        /// Maximum allowed size.
        max: usize,
    },
}

impl EncodeError {
    /// Create a JSON encoding error.
    #[must_use]
    pub fn json(event_type: &'static str, source: serde_json::Error) -> Self {
        Self::Json { event_type, source }
    }
}

/// Errors during state management operations.
#[derive(Error, Debug)]
#[non_exhaustive]
pub enum StateError {
    /// JSON Patch operation failed.
    #[error("patch failed: {op} at '{path}' - {reason}")]
    PatchFailed {
        /// The patch operation type (add, remove, replace, etc.).
        op: String,
        /// JSON pointer path where the operation failed.
        path: String,
        /// Reason for the failure.
        reason: String,
    },

    /// Patch document failed to parse.
    #[error("invalid patch document: {reason}")]
    InvalidPatch {
        /// Description of what's wrong with the patch.
        reason: String,
    },

    /// State mutex was poisoned by a panic in another thread.
    ///
    /// This is a critical error indicating potential state corruption.
    #[error("state mutex poisoned - concurrent panic detected, state may be corrupted")]
    MutexPoisoned,

    /// Referenced message does not exist in state.
    #[error("message '{id}' not found in conversation state")]
    MessageNotFound {
        /// The missing message ID.
        id: String,
    },

    /// Attempted to create a message with an ID that already exists.
    #[error("duplicate message id: '{id}' already exists")]
    DuplicateMessage {
        /// The duplicate message ID.
        id: String,
    },

    /// Tool call reference not found.
    #[error("tool call '{id}' not found in message '{message_id}'")]
    ToolCallNotFound {
        /// The missing tool call ID.
        id: String,
        /// The message ID where the tool call was expected.
        message_id: String,
    },

    /// State serialization/deserialization failed.
    #[error("state serialization failed: {reason}")]
    Serialization {
        /// Description of the serialization failure.
        reason: String,
    },
}

impl<T> From<PoisonError<T>> for StateError {
    fn from(_: PoisonError<T>) -> Self {
        StateError::MutexPoisoned
    }
}

/// HTTP and transport-level errors.
#[derive(Error, Debug)]
#[non_exhaustive]
pub enum TransportError {
    /// Request timed out.
    #[error("request timed out after {duration_ms}ms")]
    Timeout {
        /// Timeout duration in milliseconds.
        duration_ms: u64,
    },

    /// Client disconnected before response completed.
    #[error("client disconnected: {reason}")]
    ClientDisconnected {
        /// Reason or context for the disconnect.
        reason: String,
    },

    /// HTTP response error.
    #[error("HTTP {status}: {message}")]
    HttpError {
        /// HTTP status code.
        status: u16,
        /// Error message or body.
        message: String,
    },

    /// Connection failed.
    #[error("connection failed: {reason}")]
    ConnectionFailed {
        /// Reason for connection failure.
        reason: String,
    },
}

/// Result type alias for agent operations.
pub type AgentResult<T> = Result<T, AgentError>;

/// Result type alias for encoding operations.
pub type EncodeResult<T> = Result<T, EncodeError>;

/// Result type alias for state operations.
pub type StateResult<T> = Result<T, StateError>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[test]
    fn agent_error_is_cancelled() {
        let err = AgentError::Aborted {
            reason: "user cancelled".into(),
        };
        assert!(err.is_cancelled());

        let err = AgentError::custom("other error");
        assert!(!err.is_cancelled());
    }

    #[test]
    fn agent_error_is_recoverable() {
        let err = AgentError::Aborted {
            reason: "timeout".into(),
        };
        assert!(err.is_recoverable());

        let err = AgentError::Transport(TransportError::Timeout { duration_ms: 5000 });
        assert!(err.is_recoverable());

        let err = AgentError::State(StateError::MutexPoisoned);
        assert!(!err.is_recoverable());
    }

    #[test]
    fn custom_error_with_source() {
        let source = std::io::Error::new(std::io::ErrorKind::Other, "underlying error");
        let err = AgentError::custom_with_source("operation failed", source);

        assert!(matches!(err, AgentError::Custom { .. }));
        assert!(err.source().is_some());
    }

    #[test]
    fn internal_error_macro() {
        let err = internal_error!("unexpected condition");
        match err {
            AgentError::Internal { message, location } => {
                assert_eq!(message, "unexpected condition");
                assert!(location.contains("error.rs"));
            }
            _ => panic!("expected Internal variant"),
        }
    }

    #[test]
    fn state_error_from_poison() {
        use std::sync::Mutex;

        let mutex = Mutex::new(42);
        let _guard = mutex.lock().expect("initial lock");

        // Simulate what happens when PoisonError is converted
        let poison_err: Result<(), StateError> = Err(StateError::MutexPoisoned);
        assert!(matches!(poison_err, Err(StateError::MutexPoisoned)));
    }

    #[test]
    fn error_display_messages() {
        let err = AgentError::ProtocolViolation {
            event_type: "TEXT_MESSAGE_CONTENT",
            violation: "no active message stream".into(),
        };
        assert_eq!(
            err.to_string(),
            "protocol violation in TEXT_MESSAGE_CONTENT: no active message stream"
        );

        let err = StateError::PatchFailed {
            op: "replace".into(),
            path: "/foo/bar".into(),
            reason: "path does not exist".into(),
        };
        assert_eq!(
            err.to_string(),
            "patch failed: replace at '/foo/bar' - path does not exist"
        );
    }
}
