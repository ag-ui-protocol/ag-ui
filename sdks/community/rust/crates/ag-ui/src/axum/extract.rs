//! Reading a [`RunAgentInput`] out of the request.
//!
//! [`AgUiInput`] is a plain axum extractor, so an agent mounted by
//! [`route_agui`](crate::axum::RouterExt::route_agui) and a hand-written handler that
//! needs to look at the request first (auth, tenant routing, a
//! [`Path`](axum::extract::Path) segment naming which agent to run) parse the
//! body exactly the same way.
//!
//! ```
//! use ag_ui::axum::AgUiInput;
//! use axum::Router;
//! use axum::extract::Path;
//! use axum::routing::post;
//!
//! async fn handler(Path(agent): Path<String>, AgUiInput(input): AgUiInput) -> String {
//!     format!("{agent} runs thread {}", input.thread_id)
//! }
//!
//! let app: Router = Router::new().route("/agents/{agent}", post(handler));
//! # let _ = app;
//! ```
//!
//! Every failure is a `4xx` carrying a message that names the problem — see
//! [`Error`]. Nothing here can panic on a hostile body: the size cap is axum's
//! [`DefaultBodyLimit`](axum::extract::DefaultBodyLimit), and past that it is
//! `serde_json` on a `&[u8]`.

use crate::RunAgentInput;
use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{HeaderMap, header};

use crate::axum::error::{Error, Result};

/// The AG-UI run request, extracted from a JSON body.
///
/// Rejects with [`Error`], which renders as a `4xx` and a JSON body naming what
/// was wrong.
#[derive(Clone, Debug, PartialEq)]
pub struct AgUiInput(pub RunAgentInput);

impl AgUiInput {
    /// Unwraps the input.
    pub fn into_inner(self) -> RunAgentInput {
        self.0
    }
}

impl<S> FromRequest<S> for AgUiInput
where
    S: Send + Sync,
{
    type Rejection = Error;

    async fn from_request(request: Request, state: &S) -> Result<Self> {
        check_content_type(request.headers())?;
        // Through axum's own extractor rather than `to_bytes`, so a
        // `DefaultBodyLimit` layer the user applied still applies here.
        let bytes = Bytes::from_request(request, state)
            .await
            .map_err(|rejection| Error::Body {
                status: rejection.status(),
                message: rejection.body_text(),
            })?;
        Ok(Self(decode(&bytes)?))
    }
}

/// Parses a `RunAgentInput` from raw JSON bytes.
///
/// Before typed decoding, unknown protocol additions are removed and malformed
/// known fields are rejected against the same schema used by client streams.
///
/// The transport-free half of the extractor, for tests and for callers that
/// already hold the body.
///
/// ```
/// # use ag_ui::axum::extract::decode;
/// let input = decode(br#"{"threadId":"t","runId":"r","messages":[],"tools":[],"context":[]}"#)?;
/// assert_eq!(input.run_id.as_str(), "r");
///
/// assert!(decode(b"").is_err());
/// assert!(decode(b"{").is_err());
/// # Ok::<(), ag_ui::axum::Error>(())
/// ```
pub fn decode(body: &[u8]) -> Result<RunAgentInput> {
    // serde's message for an empty body is "EOF while parsing a value at line 1
    // column 0", which reads like a truncated payload rather than no payload.
    if body.iter().all(u8::is_ascii_whitespace) {
        return Err(Error::EmptyBody);
    }
    let value = serde_json::from_slice(body)?;
    let value =
        crate::protocol::input(value).map_err(<serde_json::Error as serde::de::Error>::custom)?;
    Ok(serde_json::from_value(value)?)
}

/// Refuses a body whose `Content-Type` claims to be something other than JSON.
///
/// An absent header passes: plenty of clients omit it, and a missing header is
/// never a browser form post — those always send one of three
/// non-JSON types, which is what makes this check a CSRF defence as well as a
/// content check.
fn check_content_type(headers: &HeaderMap) -> Result<()> {
    let Some(value) = headers.get(header::CONTENT_TYPE) else {
        return Ok(());
    };
    let found = String::from_utf8_lossy(value.as_bytes());
    if is_json(&found) {
        return Ok(());
    }
    Err(Error::ContentType {
        found: found.into_owned(),
    })
}

/// Whether a `Content-Type` value names JSON, parameters and all.
fn is_json(value: &str) -> bool {
    let essence = value.split(';').next().unwrap_or(value).trim();
    essence.eq_ignore_ascii_case("application/json")
        || essence.eq_ignore_ascii_case("text/json")
        // `application/vnd.acme+json` and friends.
        || essence
            .rsplit_once('+')
            .is_some_and(|(_, suffix)| suffix.eq_ignore_ascii_case("json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    fn headers(content_type: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            content_type.parse().expect("a valid header value"),
        );
        headers
    }

    #[test]
    fn json_content_types_are_accepted() {
        for value in [
            "application/json",
            "application/json; charset=utf-8",
            "APPLICATION/JSON",
            "text/json",
            "application/vnd.acme.run+json",
        ] {
            assert!(
                check_content_type(&headers(value)).is_ok(),
                "should accept {value:?}"
            );
        }
    }

    #[test]
    fn a_missing_content_type_is_accepted() {
        assert!(check_content_type(&HeaderMap::new()).is_ok());
    }

    #[test]
    fn a_form_post_is_refused_with_415() {
        let error = check_content_type(&headers("application/x-www-form-urlencoded"))
            .expect_err("should refuse a form body");
        assert_eq!(error.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert!(
            error.to_string().contains("x-www-form-urlencoded"),
            "{error}"
        );
    }

    #[test]
    fn a_missing_field_names_itself() {
        let error = decode(br#"{"threadId":"t","runId":"r"}"#).expect_err("should not decode");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert!(error.to_string().contains("messages"), "{error}");
    }

    #[test]
    fn whitespace_only_bodies_read_as_empty() {
        assert!(matches!(decode(b"  \n\t"), Err(Error::EmptyBody)));
    }
}
