//! What can go wrong before the stream starts, and what the client sees.
//!
//! Everything here happens *before* `RUN_STARTED`. Once the SSE body is open
//! the status line is already sent, so execution failures from then on are
//! `RUN_ERROR` events inside a `200` stream — that is [`crate::server`]'s job, not this
//! module's. Independent delivery failures end the HTTP body without claiming
//! that execution failed. What is left is how a request can be refused:
//! a body that is not AG-UI JSON, and an `Accept` header this build cannot
//! satisfy.
//!
//! A refusal answers with a JSON object rather than a bare status line, because
//! the caller is a program:
//!
//! ```json
//! {"code": "INVALID_INPUT", "message": "missing field `messages` at line 1 column 34"}
//! ```

use crate::encode::supported_media_types;
use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

/// A request this endpoint refused, before any events were produced.
///
/// Implements [`IntoResponse`], so it doubles as the rejection type of
/// [`AgUiInput`](crate::axum::AgUiInput) — a handler can take
/// `Result<AgUiInput, Error>` and inspect the failure, or take `AgUiInput` and
/// let axum answer with the response below.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// The request body could not be read at all — a connection that died
    /// mid-body, or a payload over the configured
    /// [`DefaultBodyLimit`](axum::extract::DefaultBodyLimit).
    ///
    /// Carries the status axum's own extractor chose, so a body limit stays a
    /// `413` rather than being flattened into a `400`.
    #[error("{message}")]
    Body {
        /// The status to answer with.
        status: StatusCode,
        /// What axum said about it.
        message: String,
    },

    /// The `Content-Type` was set to something that is not JSON.
    ///
    /// An absent header is accepted — `curl -d` and hand-written clients often
    /// omit it. A *wrong* one is refused rather than sniffed, which also means
    /// a cross-origin HTML form (whose content type is always one of three
    /// non-JSON values it cannot override) can never reach an agent.
    #[error("expected a JSON request body, got Content-Type {found:?}")]
    ContentType {
        /// The offending header value.
        found: String,
    },

    /// The body was JSON, but not a
    /// [`RunAgentInput`](crate::input::RunAgentInput).
    ///
    /// Schema failures name the field path; malformed JSON names the offset.
    #[error("the request body is not a valid AG-UI RunAgentInput: {0}")]
    Decode(#[from] serde_json::Error),

    /// The request body was empty.
    #[error("the request body is empty; expected an AG-UI RunAgentInput object")]
    EmptyBody,

    /// Content negotiation found nothing this build can emit.
    ///
    /// See [`negotiate`](crate::axum::respond::negotiate).
    #[error(
        "cannot produce any media type this request accepts ({accept:?}); \
         this endpoint emits: {}",
        supported_media_types().join(", ")
    )]
    NotAcceptable {
        /// The `Accept` header that could not be satisfied.
        accept: String,
    },
}

impl Error {
    /// The status this error answers with.
    pub const fn status(&self) -> StatusCode {
        match self {
            Self::Body { status, .. } => *status,
            Self::ContentType { .. } => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Decode(_) | Self::EmptyBody => StatusCode::BAD_REQUEST,
            Self::NotAcceptable { .. } => StatusCode::NOT_ACCEPTABLE,
        }
    }

    /// The machine-readable code placed in the response body.
    ///
    /// Deliberately not derived from the status: a client that wants to branch
    /// should not have to distinguish two `400`s by parsing prose.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Body { .. } => "INVALID_BODY",
            Self::ContentType { .. } => "UNSUPPORTED_MEDIA_TYPE",
            Self::Decode(_) | Self::EmptyBody => "INVALID_INPUT",
            Self::NotAcceptable { .. } => "NOT_ACCEPTABLE",
        }
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let body = Json(json!({ "code": self.code(), "message": self.to_string() }));
        let mut response = (self.status(), body).into_response();
        // The answer depends on `Accept`, including when the answer is a 406.
        // Without this a shared cache can serve one client's refusal to another
        // client that would have been served happily.
        response
            .headers_mut()
            .insert(header::VARY, header::HeaderValue::from_static("accept"));
        response
    }
}

/// Result alias for this crate.
pub type Result<T, E = Error> = core::result::Result<T, E>;
