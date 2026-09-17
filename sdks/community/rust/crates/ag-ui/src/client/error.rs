//! Errors this crate can produce.

use thiserror::Error;

/// Everything that can go wrong while consuming an AG-UI stream.
///
/// The variant list is `#[non_exhaustive]`: new transports and validation rules
/// are expected to add variants without a breaking release.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// A local request failed before dispatch.
    #[error("request rejected: {0}")]
    Request(String),

    /// A saved local conversation is invalid or unsupported.
    #[error("invalid thread snapshot: {0}")]
    Snapshot(String),

    /// A frame's payload was not valid JSON, or not a valid [`Event`].
    ///
    /// [`Event`]: https://docs.rs/ag-ui/0.4.2/ag_ui/event/enum.Event.html
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// An error raised by the core protocol types.
    ///
    /// Core's *protocol* violations do not arrive here: they are flattened into
    /// [`Error::Protocol`] so that every rule a stream can break has one shape.
    #[error(transparent)]
    Core(crate::Error),

    /// The bytes were not well-formed `text/event-stream`.
    #[error("SSE decode error: {0}")]
    Decode(String),

    /// The stream parsed, but broke a rule the protocol requires — a content
    /// event with no open message, a chunk with no id to attach to, events
    /// after the run finished.
    #[error("protocol violation: {0}")]
    Protocol(String),

    /// An RFC 6902 patch could not be applied.
    ///
    /// The target document is left exactly as it was: [`json_patch::patch`]
    /// rolls back the operations it had already applied, so a rejected patch
    /// never leaves half-mutated state behind.
    #[error("{target} patch failed: {message}")]
    Patch {
        /// What the patch targeted — `"state"`, or `"activity <message id>"`.
        target: String,
        /// Why it was rejected, as reported by the patch engine.
        message: String,
    },

    /// The application state did not deserialize into the caller's type.
    ///
    /// The raw JSON state is still updated and correct; only the typed view is
    /// unavailable.
    #[error("state does not match the expected type: {0}")]
    State(#[source] serde_json::Error),

    /// The agent reported `RUN_ERROR`.
    #[error("run failed: {message}")]
    Run {
        /// What went wrong, for a human.
        message: String,
        /// The machine-readable code, when the agent sent one.
        code: Option<String>,
    },

    /// The server answered with a status outside 2xx.
    #[error("HTTP {status}: {body}")]
    Http {
        /// The status code.
        status: u16,
        /// Up to 2 KiB of response bytes, decoded as UTF-8 with invalid sequences
        /// replaced. The response is dropped once the byte limit is reached.
        body: String,
    },

    /// The transport failed — a connection reset, a DNS failure, a closed
    /// channel. Carries the underlying error.
    #[error("transport error: {0}")]
    Transport(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// A transport was configured with something it cannot use: an unparseable
    /// URL, an invalid header name.
    #[error("invalid client configuration: {0}")]
    Config(String),
}

impl From<crate::Error> for Error {
    fn from(error: crate::Error) -> Self {
        match error {
            // A rule broken by the stream is a protocol violation whichever
            // crate noticed it; a caller matching on `Protocol` should not have
            // to know that `RunOutcome::validate` lives in core.
            crate::Error::Protocol(message) => Self::Protocol(message),
            other => Self::Core(other),
        }
    }
}

impl Error {
    /// Wraps any error as a [`Error::Transport`].
    ///
    /// Transports for exotic runtimes have their own error types; this is how
    /// they enter this crate's error enum without a variant of their own.
    pub fn transport(error: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::Transport(Box::new(error))
    }

    /// Builds a [`Error::Protocol`] from anything printable.
    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol(message.into())
    }

    /// Builds a [`Error::Decode`] from anything printable.
    pub(crate) fn decode(message: impl Into<String>) -> Self {
        Self::Decode(message.into())
    }
}

/// Result alias used throughout this crate.
pub type Result<T, E = Error> = core::result::Result<T, E>;
