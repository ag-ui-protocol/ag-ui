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

    /// A run was refused before dispatch because these tool calls have no
    /// answer in the transcript, in call order.
    ///
    /// Answer each with a tool message, or give it up with
    /// [`Thread::abandon_tool_call`](crate::client::Thread::abandon_tool_call).
    #[error(
        "request rejected: unanswered tool calls must be answered with tool messages, or abandoned, before another run: {}",
        .0.iter().map(crate::ToolCallId::as_str).collect::<Vec<_>>().join(", ")
    )]
    UnansweredToolCalls(Vec<crate::ToolCallId>),

    /// A run that answers no interrupt was refused before dispatch because
    /// the thread is paused on the interrupts with these ids.
    ///
    /// Answer them with [`Thread::resume`](crate::client::Thread::resume),
    /// [`decline`](crate::client::Thread::decline) or
    /// [`resume_many`](crate::client::Thread::resume_many).
    #[error("request rejected: pending interrupts must be answered with resume_many")]
    PendingInterrupts(Vec<String>),

    /// A saved local conversation is invalid or unsupported.
    #[error("invalid thread snapshot: {0}")]
    Snapshot(String),

    /// [`Thread::merge_messages_from`](crate::client::Thread::merge_messages_from)
    /// refused to merge two threads, and changed neither: they are different
    /// conversations, one of them still owes an answer or has a request in
    /// flight, a tool call has a result on each, or the receiving thread gave
    /// up a call the other holds a result for.
    #[error("threads not merged: {0}")]
    Merge(String),

    /// A frame's payload was not valid JSON, or not a valid [`Event`].
    ///
    /// [`Event`]: crate::event::Event
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

    /// An [`Applier`](crate::client::Applier) was handed a `*_CHUNK` or
    /// `THINKING_*` event, which it applies only in their explicit form.
    #[error("not supported by this client: {0}")]
    Unsupported(String),

    /// An RFC 6902 patch could not be applied.
    ///
    /// The client applies patches to a copy and commits the new document only
    /// after every operation succeeds.
    #[error("{target} patch failed: {message}")]
    Patch {
        /// What the patch targeted — `"state"`, or `"activity <message id>"`.
        target: String,
        /// Why it was rejected, as reported by the patch engine.
        message: String,
    },

    /// A patch document is structurally invalid, before application is attempted.
    ///
    /// A malformed JSON Pointer is a producer protocol error; unlike a valid
    /// operation targeting missing state, it cannot be retried against another
    /// state value.
    #[error("{target} patch document is invalid: {message}")]
    InvalidPatchDocument {
        /// What the patch targeted — `"state"`, or `"activity <message id>"`.
        target: String,
        /// Why the document could not be parsed.
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
        /// replaced. Reading stops after one second or when the byte limit is reached.
        body: String,
    },

    /// A successful HTTP response chose a format this transport cannot decode.
    #[error("HTTP response Content-Type must be text/event-stream; received {0}")]
    UnexpectedContentType(String),

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
