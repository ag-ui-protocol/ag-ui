//! Errors raised while hosting a run.
//!
//! Everything an agent can fail with funnels through [`enum@Error`]. The run driver
//! turns whatever escapes [`Agent::run`](crate::server::Agent::run) into a `RUN_ERROR`
//! event, so an error is never a panic and never a silently truncated stream.

use std::fmt;

use crate::EventType;
use thiserror::Error;

/// Result alias used throughout this crate.
pub type Result<T, E = Error> = core::result::Result<T, E>;

/// Everything that can go wrong while hosting an AG-UI run.
///
/// The variant list is `#[non_exhaustive]`: new emitters and verification rules
/// are expected to add variants without a breaking release.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// A core protocol type rejected a value — for example an `interrupt`
    /// outcome carrying no interrupts.
    #[error(transparent)]
    Protocol(#[from] crate::Error),

    /// State, tool arguments or a tool result could not be converted to or from
    /// JSON.
    #[error("JSON conversion failed: {0}")]
    Json(#[from] serde_json::Error),

    /// The emitted event stream broke the protocol's ordering rules.
    ///
    /// Detailed ordering checks use the `verify` feature. The producer's
    /// requirement to explicitly close announced subagents is always enforced.
    #[error(transparent)]
    Verification(#[from] VerificationError),

    /// The run was cancelled — usually because the client disconnected.
    ///
    /// Every emit after cancellation fails with this, so an agent that uses `?`
    /// on its emits unwinds promptly without any cancellation code of its own.
    #[error("the run was cancelled")]
    Cancelled,

    /// The consumer dropped the event stream, so there is nowhere left to emit.
    #[error("the event stream was dropped by the consumer")]
    Disconnected,

    /// The configured event queue filled before the consumer could drain it.
    /// The stream ends with an `EVENT_BUFFER_FULL` error; the rejected event
    /// was not delivered. Reconnect/replay is the application's responsibility.
    #[error("the event buffer reached its capacity of {capacity} events")]
    EventBufferFull {
        /// Maximum queued events, excluding the reserved overflow error.
        capacity: usize,
    },

    /// The agent itself failed. Build one with [`Error::agent`].
    #[error("agent error: {0}")]
    Agent(Box<dyn std::error::Error + Send + Sync>),
}

impl Error {
    /// Wraps an arbitrary agent-side error.
    ///
    /// ```
    /// # use ag_ui::server::Error;
    /// let err = Error::agent("the weather service is down");
    /// assert_eq!(err.code(), "AGENT_ERROR");
    /// ```
    pub fn agent<E>(error: E) -> Self
    where
        E: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        Self::Agent(error.into())
    }

    /// The machine-readable code placed on the `RUN_ERROR` event.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Protocol(_) => "PROTOCOL",
            Self::Json(_) => "SERIALIZATION",
            Self::Verification(_) => "PROTOCOL_VIOLATION",
            Self::Cancelled => "CANCELLED",
            Self::Disconnected => "DISCONNECTED",
            Self::EventBufferFull { .. } => "EVENT_BUFFER_FULL",
            Self::Agent(_) => "AGENT_ERROR",
        }
    }

    /// Whether this error means the run was cancelled rather than that it
    /// failed.
    pub const fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }

    /// Whether the consumer has gone away, making further emits pointless.
    pub const fn is_disconnected(&self) -> bool {
        matches!(self, Self::Disconnected)
    }
}

/// The ordering rule an event broke.
///
/// Each variant is one check in the state machine described on
/// [`verify`](crate::server::verify).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Rule {
    /// No event may follow `RUN_FINISHED` or `RUN_ERROR`.
    RunEnded,
    /// A run starts exactly once.
    DuplicateRunStarted,
    /// A message, tool call, reasoning block or step was opened twice under the
    /// same id.
    DuplicateStart,
    /// Content or a terminator arrived for something that is not open.
    NotOpen,
    /// An event referenced an id that was never introduced.
    UnknownId,
    /// `RUN_FINISHED` arrived while something was still open.
    OpenAtFinish,
    /// The event is legal but arrived in the wrong place — a tool result before
    /// its `TOOL_CALL_END`, for instance.
    OutOfOrder,
    /// A continuation, terminator or re-open carried a `subagentRunId` that
    /// disagrees with the subagent that opened the entity — or a tool call was
    /// tagged with one subagent while its parent message belongs to another.
    OwnerMismatch,
}

impl Rule {
    /// The rule's kebab-case name, as it appears in error messages.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::RunEnded => "run-ended",
            Self::DuplicateRunStarted => "duplicate-run-started",
            Self::DuplicateStart => "duplicate-start",
            Self::NotOpen => "not-open",
            Self::UnknownId => "unknown-id",
            Self::OpenAtFinish => "open-at-finish",
            Self::OutOfOrder => "out-of-order",
            Self::OwnerMismatch => "owner-mismatch",
        }
    }

    /// The rule in one sentence, for humans reading a log.
    pub const fn describe(&self) -> &'static str {
        match self {
            Self::RunEnded => "a run emits nothing after RUN_FINISHED or RUN_ERROR",
            Self::DuplicateRunStarted => "a run emits RUN_STARTED exactly once",
            Self::DuplicateStart => "an id may only be opened once",
            Self::NotOpen => "content and terminators require a matching start",
            Self::UnknownId => "an event may only reference an id it has seen",
            Self::OpenAtFinish => "everything opened must be closed before RUN_FINISHED",
            Self::OutOfOrder => "the event arrived before the event it depends on",
            Self::OwnerMismatch => "an event names the subagent that opened its entity",
        }
    }
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One event rejected by the ordering verifier.
///
/// The message names the offending event, the rule it broke and the id
/// involved. In debug builds it also carries a dump of everything still open,
/// which is usually enough to spot the missing terminator:
///
/// ```text
/// TEXT_MESSAGE_CONTENT breaks rule `not-open` (content and terminators require
/// a matching start): message "msg-2" is not open [open: messages={"msg-1"}]
/// ```
#[derive(Debug, Error)]
#[error("{event} breaks rule `{rule}` ({}): {detail}", rule.describe())]
pub struct VerificationError {
    /// The event that was rejected.
    pub event: EventType,
    /// The rule it broke.
    pub rule: Rule,
    /// What specifically was wrong, plus — in debug builds — the open-entity
    /// dump.
    pub detail: String,
}

impl VerificationError {
    /// Builds a rejection.
    pub fn new(event: EventType, rule: Rule, detail: impl Into<String>) -> Self {
        Self {
            event,
            rule,
            detail: detail.into(),
        }
    }
}
