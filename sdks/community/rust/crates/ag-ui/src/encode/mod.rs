//! Wire encoding for the event stream.
//!
//! [`EventStreamFormatter`] is the abstraction a transport implements.
#![cfg_attr(
    feature = "sse",
    doc = "[`sse::SseFormatter`] is the one every AG-UI implementation supports."
)]
#![cfg_attr(
    not(feature = "sse"),
    doc = "`sse::SseFormatter` is the one every AG-UI implementation supports, and the",
    doc = "`sse` feature is off in this build."
)]
//!
//! ```
//! # #[cfg(feature = "sse")] {
//! use ag_ui::{Event, EventStreamFormatter, SseFormatter};
//!
//! let formatter = SseFormatter::new();
//! let bytes = formatter.encode(&Event::text_message_end("msg-1")).unwrap();
//! assert_eq!(
//!     String::from_utf8(bytes).unwrap(),
//!     "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"msg-1\"}\n\n"
//! );
//! # }
//! ```

#[cfg(feature = "protobuf")]
pub mod protobuf;
#[cfg(feature = "sse")]
pub mod sse;

use crate::error::{Error, Result};
use crate::event::Event;

/// Media type of a Server-Sent Events stream.
pub const SSE_MEDIA_TYPE: &str = "text/event-stream";

/// Media type of the AG-UI binary stream, as defined by the upstream
/// `@ag-ui/proto` package.
pub const PROTOBUF_MEDIA_TYPE: &str = "application/vnd.ag-ui.event+proto";

#[cfg(all(feature = "sse", feature = "protobuf"))]
const SUPPORTED: &[&str] = &[SSE_MEDIA_TYPE, PROTOBUF_MEDIA_TYPE];
#[cfg(all(feature = "sse", not(feature = "protobuf")))]
const SUPPORTED: &[&str] = &[SSE_MEDIA_TYPE];
#[cfg(all(not(feature = "sse"), feature = "protobuf"))]
const SUPPORTED: &[&str] = &[PROTOBUF_MEDIA_TYPE];

/// Turns events into the bytes a transport puts on the wire.
///
/// Object-safe, so a server can pick a formatter once per connection and store
/// it as `Box<dyn EventStreamFormatter>`.
pub trait EventStreamFormatter {
    /// The `Content-Type` to answer with.
    fn content_type(&self) -> &'static str;

    /// Encodes one event, framing included.
    fn encode(&self, event: &Event) -> Result<Vec<u8>>;
}

/// The media types this build can emit, most preferred first.
pub const fn supported_media_types() -> &'static [&'static str] {
    SUPPORTED
}

/// Picks the media type to answer an `Accept` header with.
///
/// A missing or empty header is treated as `*/*`, per RFC 9110. Candidates are
/// scored by quality value; ties go to this crate's own preference order, which
/// puts SSE first because it is the interoperable default and the only fully
/// implemented transport here. That differs from the TypeScript encoder, which
/// upgrades a bare `*/*` to protobuf.
///
/// Returns [`Error::UnsupportedMediaType`] when the header excludes everything
/// this build can emit — the case that deserves a `406`.
///
/// ```
/// # use ag_ui::encode::{media_type, SSE_MEDIA_TYPE};
/// assert_eq!(media_type(None).unwrap(), SSE_MEDIA_TYPE);
/// assert_eq!(media_type(Some("text/event-stream")).unwrap(), SSE_MEDIA_TYPE);
/// assert!(media_type(Some("application/xml")).is_err());
/// ```
pub fn media_type(accept: Option<&str>) -> Result<&'static str> {
    let header = accept
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("*/*");

    let specs: Vec<AcceptSpec<'_>> = header.split(',').filter_map(AcceptSpec::parse).collect();

    let mut best: Option<(&'static str, f32)> = None;
    for candidate in SUPPORTED {
        let quality = quality_of(candidate, &specs);
        if quality > 0.0 && best.is_none_or(|(_, best_quality)| quality > best_quality) {
            best = Some((candidate, quality));
        }
    }

    best.map(|(media_type, _)| media_type)
        .ok_or_else(|| Error::UnsupportedMediaType(header.to_owned()))
}

/// One entry of an `Accept` header: a media range and its quality value.
struct AcceptSpec<'a> {
    kind: &'a str,
    subtype: &'a str,
    quality: f32,
}

impl<'a> AcceptSpec<'a> {
    fn parse(entry: &'a str) -> Option<Self> {
        let mut parts = entry.split(';');
        let (kind, subtype) = split_media_type(parts.next()?.trim())?;

        // Only `q` is read. The other parameters affect specificity in the full
        // RFC 9110 algorithm, but no media type this crate emits is
        // parameterized, so they can never change the outcome here.
        let quality = parts
            .find_map(|param| {
                let (key, value) = param.split_once('=')?;
                key.trim().eq_ignore_ascii_case("q").then_some(value)
            })
            .and_then(|value| value.trim().trim_matches('"').parse::<f32>().ok())
            .unwrap_or(1.0);

        Some(Self {
            kind,
            subtype,
            quality,
        })
    }

    /// How specifically this range names `kind`/`subtype`, or `None` when it
    /// does not match at all. Higher is more specific.
    fn specificity(&self, kind: &str, subtype: &str) -> Option<u8> {
        let mut score = 0;

        if self.kind.eq_ignore_ascii_case(kind) {
            score |= 4;
        } else if self.kind != "*" {
            return None;
        }

        if self.subtype.eq_ignore_ascii_case(subtype) {
            score |= 2;
        } else if self.subtype != "*" {
            return None;
        }

        Some(score)
    }
}

/// The quality the header assigns to `candidate`, from its most specific
/// matching range. Zero means unacceptable.
fn quality_of(candidate: &str, specs: &[AcceptSpec<'_>]) -> f32 {
    let Some((kind, subtype)) = split_media_type(candidate) else {
        return 0.0;
    };

    let mut best: Option<(u8, f32)> = None;
    for spec in specs {
        let Some(specificity) = spec.specificity(kind, subtype) else {
            continue;
        };
        if best.is_none_or(|(best_specificity, _)| specificity > best_specificity) {
            best = Some((specificity, spec.quality));
        }
    }

    best.map_or(0.0, |(_, quality)| quality)
}

/// Splits `type/subtype`, ignoring any parameters.
fn split_media_type(value: &str) -> Option<(&str, &str)> {
    let value = value.split(';').next()?.trim();
    let (kind, subtype) = value.split_once('/')?;
    (!kind.is_empty() && !subtype.is_empty()).then_some((kind, subtype))
}
