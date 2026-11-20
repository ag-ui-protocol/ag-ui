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
/// was wrong. The decoding warnings are discarded; a handler that wants them
/// takes the body as [`Bytes`] and calls [`decode_with_warnings`].
///
/// # The `Content-Type` is required
///
/// The request must say its body is JSON: `application/json`, `text/json` or
/// a `+json` type, parameters allowed. Anything else is refused with `415`,
/// and so is a request with no `Content-Type` at all — an unlabelled body is
/// not assumed to be JSON.
///
/// Requiring a JSON media type has a second effect: a browser will not send
/// such a request from another origin without a CORS preflight, so whether a
/// page elsewhere can start a run is up to your CORS policy. That is all it
/// does. It is not authentication, and an endpoint that relies on cookies
/// still needs its own CSRF protection.
///
/// For clients that send no header and cannot be changed,
/// [`AgentEndpoint::allow_missing_content_type`](crate::axum::AgentEndpoint::allow_missing_content_type)
/// accepts an unlabelled body on a mounted endpoint. A hand-written handler
/// opts out the same way by taking [`Bytes`] and calling [`decode`] itself.
/// Either way, the effect above no longer holds.
#[derive(Clone, Debug, PartialEq)]
pub struct AgUiInput(pub RunAgentInput);

impl AgUiInput {
    /// Unwraps the input.
    pub fn into_inner(self) -> RunAgentInput {
        self.0
    }

    /// The extractor, with the one choice an endpoint can make about it:
    /// whether a request with no `Content-Type` is read as JSON. Keeps the
    /// decoding warnings, which the mounted endpoint hands to its hook.
    pub(crate) async fn read<S>(
        request: Request,
        state: &S,
        allow_missing_content_type: bool,
    ) -> Result<(Self, Vec<String>)>
    where
        S: Send + Sync,
    {
        check_content_type(request.headers(), allow_missing_content_type)?;
        // Through axum's own extractor rather than `to_bytes`, so a
        // `DefaultBodyLimit` layer the user applied still applies here.
        let bytes = Bytes::from_request(request, state)
            .await
            .map_err(|rejection| Error::Body {
                status: rejection.status(),
                message: rejection.body_text(),
            })?;
        let (input, warnings) = decode_with_warnings(&bytes)?;
        Ok((Self(input), warnings))
    }
}

impl<S> FromRequest<S> for AgUiInput
where
    S: Send + Sync,
{
    type Rejection = Error;

    async fn from_request(request: Request, state: &S) -> Result<Self> {
        let (input, _warnings) = Self::read(request, state, false).await?;
        Ok(input)
    }
}

/// Parses a `RunAgentInput` from raw JSON bytes.
///
/// Before typed decoding, unknown protocol additions are removed and malformed
/// known fields are rejected against the same schema used by client streams.
/// What was removed is discarded; [`decode_with_warnings`] returns it.
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
    decode_with_warnings(body).map(|(input, _warnings)| input)
}

/// [`decode`], also returning a warning for each thing it removed or read as
/// omitted: an unrecognised field or enum member, a deprecated optional
/// `null`. Each quotes at most 64 characters of the body, with control
/// characters escaped. Nothing in this crate prints them; where they go is the
/// caller's choice.
///
/// ```
/// # use ag_ui::axum::extract::decode_with_warnings;
/// let (input, warnings) = decode_with_warnings(
///     br#"{"threadId":"t","runId":"r","messages":[],"somethingNewer":1}"#,
/// )?;
/// assert_eq!(input.run_id.as_str(), "r");
/// assert_eq!(warnings, ["unrecognised property at /somethingNewer"]);
/// # Ok::<(), ag_ui::axum::Error>(())
/// ```
pub fn decode_with_warnings(body: &[u8]) -> Result<(RunAgentInput, Vec<String>)> {
    // serde's message for an empty body is "EOF while parsing a value at line 1
    // column 0", which reads like a truncated payload rather than no payload.
    if body.iter().all(u8::is_ascii_whitespace) {
        return Err(Error::EmptyBody);
    }
    let value = serde_json::from_slice(body)?;
    let mut warnings = Vec::new();
    let value = crate::protocol::input(value, &mut warnings)
        .map_err(<serde_json::Error as serde::de::Error>::custom)?;
    Ok((serde_json::from_value(value)?, warnings))
}

/// Refuses a body that does not say it is JSON.
///
/// An absent header is refused unless `allow_missing` says otherwise: RFC 9110
/// lets a recipient treat an unlabelled body as `application/octet-stream`,
/// and that is not something this endpoint reads. See [`AgUiInput`] for what
/// requiring the header does and does not buy.
fn check_content_type(headers: &HeaderMap, allow_missing: bool) -> Result<()> {
    let Some(value) = headers.get(header::CONTENT_TYPE) else {
        return if allow_missing {
            Ok(())
        } else {
            Err(Error::MissingContentType)
        };
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
            for allow_missing in [false, true] {
                assert!(
                    check_content_type(&headers(value), allow_missing).is_ok(),
                    "should accept {value:?}"
                );
            }
        }
    }

    #[test]
    fn a_missing_content_type_is_refused_with_415() {
        let error = check_content_type(&HeaderMap::new(), false)
            .expect_err("an unlabelled body is not assumed to be JSON");
        assert!(matches!(error, Error::MissingContentType), "{error}");
        assert_eq!(error.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(error.code(), "UNSUPPORTED_MEDIA_TYPE");
    }

    #[test]
    fn a_missing_content_type_passes_only_when_allowed() {
        assert!(check_content_type(&HeaderMap::new(), true).is_ok());
    }

    #[test]
    fn a_form_post_is_refused_with_415() {
        for allow_missing in [false, true] {
            let error =
                check_content_type(&headers("application/x-www-form-urlencoded"), allow_missing)
                    .expect_err("should refuse a form body");
            assert_eq!(error.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
            assert!(
                error.to_string().contains("x-www-form-urlencoded"),
                "{error}"
            );
        }
    }

    #[test]
    fn a_media_type_that_only_mentions_json_is_refused() {
        for value in [
            "text/plain; application/json",
            "text/plain;charset=application/json",
            "application/json, text/plain",
            "application/jsonx",
            "",
        ] {
            assert!(
                check_content_type(&headers(value), true).is_err(),
                "should refuse {value:?}"
            );
        }
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
