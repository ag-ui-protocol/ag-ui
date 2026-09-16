//! Server-Sent Events framing.

use crate::encode::{EventStreamFormatter, SSE_MEDIA_TYPE};
use crate::error::Result;
use crate::event::Event;

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

    /// Encodes one event as an SSE frame.
    pub fn encode_to_string(&self, event: &Event) -> Result<String> {
        Ok(frame(&serde_json::to_string(event)?))
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
