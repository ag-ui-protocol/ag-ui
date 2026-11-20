//! Server-Sent Events framing.

use crate::encode::{EventStreamFormatter, SSE_MEDIA_TYPE};
use crate::error::Result;
use crate::event::Event;

/// A data event or an SSE transport comment.
///
/// Comments are independent of the AG-UI event lifecycle. They can carry
/// replay boundaries without manufacturing a protocol event. Each line is
/// escaped as a comment by the SDK, so input cannot inject a data frame.
#[derive(Clone, Debug, PartialEq)]
pub enum SseFrame<E = Event> {
    /// One serializable value. Standard live producers use `Event` and its
    /// `metadata` field. Other representations are a host compatibility choice,
    /// not an extension of the protocol schema.
    Event(E),
    /// A comment ignored by standard SSE event consumers.
    Comment(String),
}

impl<E> SseFrame<E> {
    /// Creates a data frame without serializing it yet.
    pub fn event(event: E) -> Self {
        Self::Event(event)
    }
    /// Creates an SSE comment; the SDK handles multiline framing.
    pub fn comment(comment: impl Into<String>) -> Self {
        Self::Comment(comment.into())
    }
}

/// Encodes events as `text/event-stream` frames.
///
/// Each event becomes a single `data:` block holding its JSON, exactly as the
/// TypeScript SDK writes it:
///
/// ```text
/// data: {"type":"TEXT_MESSAGE_END","messageId":"msg-1"}
///
/// ```
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SseFormatter;

impl SseFormatter {
    /// Builds a formatter. It holds no state.
    pub const fn new() -> Self {
        Self
    }

    /// Lower-level encoding for supplied serializable values, including
    /// compatibility replay representations.
    ///
    /// This does not validate or extend the AG-UI schema. Standard producers
    /// use [`Event`] and its `metadata` field for application metadata.
    pub fn encode_serializable(&self, event: &impl serde::Serialize) -> Result<String> {
        Ok(frame(&self.event_json(event)?))
    }

    /// Encodes a value or comment without depending on an HTTP framework.
    pub fn encode_frame<E: serde::Serialize>(&self, value: &SseFrame<E>) -> Result<String> {
        match value {
            SseFrame::Event(event) => self.encode_serializable(event),
            SseFrame::Comment(text) => Ok(comment(text)),
        }
    }

    // Axum adds its own SSE framing, so its adapter consumes JSON only.
    pub(crate) fn event_json(&self, event: &impl serde::Serialize) -> Result<String> {
        Ok(serde_json::to_string(event)?)
    }

    /// Encodes one event as an SSE frame.
    pub fn encode_to_string(&self, event: &Event) -> Result<String> {
        self.encode_serializable(event)
    }
}

impl EventStreamFormatter for SseFormatter {
    fn content_type(&self) -> &'static str {
        SSE_MEDIA_TYPE
    }

    fn encode(&self, event: &Event) -> Result<Vec<u8>> {
        Ok(self.encode_to_string(event)?.into_bytes())
    }
}

/// Wraps an arbitrary payload in an SSE `data:` block.
///
/// A payload containing line breaks becomes one `data:` line per line, which is
/// what the SSE decoder rejoins with `\n`; a payload with none becomes a single
/// line. Serialized JSON is always single-line — `serde_json` escapes control
/// characters — so this only matters for callers that frame something else, but
/// getting it wrong would silently truncate an event at the first newline.
///
/// ```
/// # use ag_ui::encode::sse::frame;
/// assert_eq!(frame("one\ntwo"), "data: one\ndata: two\n\n");
/// ```
pub fn frame(payload: &str) -> String {
    let mut out = String::with_capacity(payload.len() + 8);
    let mut rest = payload;

    loop {
        match rest.find(['\r', '\n']) {
            Some(index) => {
                out.push_str("data: ");
                out.push_str(&rest[..index]);
                out.push('\n');
                // A CRLF is one break, not two.
                let width = if rest[index..].starts_with("\r\n") {
                    2
                } else {
                    1
                };
                rest = &rest[index + width..];
            }
            None => {
                out.push_str("data: ");
                out.push_str(rest);
                out.push('\n');
                break;
            }
        }
    }

    out.push('\n');
    out
}

/// Encodes an SSE comment, prefixing every line to prevent frame injection.
pub fn comment(payload: &str) -> String {
    let mut output = String::with_capacity(payload.len() + 4);
    for line in comment_lines(payload) {
        output.push_str(": ");
        output.push_str(line);
        output.push('\n');
    }
    output.push('\n');
    output
}

/// CRLF is one boundary; lone CR/LF and a trailing empty line are preserved.
pub(crate) fn comment_lines(payload: &str) -> impl Iterator<Item = &str> {
    let mut rest = Some(payload);
    std::iter::from_fn(move || {
        let value = rest.take()?;
        match value.find(['\r', '\n']) {
            Some(index) => {
                let width = if value[index..].starts_with("\r\n") {
                    2
                } else {
                    1
                };
                rest = Some(&value[index + width..]);
                Some(&value[..index])
            }
            None => Some(value),
        }
    })
}
