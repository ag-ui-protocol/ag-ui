//! Error and result types shared by the whole crate.

use thiserror::Error;

/// Everything that can go wrong while producing or consuming AG-UI values.
///
/// The variant list is `#[non_exhaustive]`: new transports and validation rules
/// are expected to add variants without a breaking release.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// A value could not be converted to or from its JSON wire representation.
    #[error("JSON conversion failed: {0}")]
    Json(#[from] serde_json::Error),

    /// The `type` discriminator on an event was not a known AG-UI event type.
    #[error("unknown event type: {0:?}")]
    UnknownEventType(String),

    /// Content negotiation produced no media type this build can emit.
    ///
    /// Carries the offending `Accept` header value.
    #[error("no supported media type in Accept header: {0:?}")]
    UnsupportedMediaType(String),

    /// A payload parsed as JSON but broke a rule the protocol requires and the
    /// Rust type system cannot express (for example an `interrupt` outcome that
    /// carries an empty `interrupts` array).
    #[error("protocol violation: {0}")]
    Protocol(String),

    /// A transport was requested that this build cannot serve.
    #[error("unsupported transport: {0}")]
    UnsupportedTransport(&'static str),
}

/// Result alias used throughout this crate.
pub type Result<T, E = Error> = core::result::Result<T, E>;
