#![doc = include_str!("../README.md")]
use ag_ui_core::{
    AgentState,
    event::Event,
    processing::{PROTOCOL_VERSION, ProcessingError, normalize_producer_event},
};

pub const CONTENT_TYPE: &str = "text/event-stream; charset=utf-8";
/// Includes the `data: ` prefix and terminating blank line. Override for larger
/// inline media; values are rejected rather than truncated.
pub const DEFAULT_MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_COMMENT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_event_bytes: usize,
    pub max_comment_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_event_bytes: DEFAULT_MAX_EVENT_BYTES,
            max_comment_bytes: DEFAULT_MAX_COMMENT_BYTES,
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error(transparent)]
    InvalidEvent(#[from] ProcessingError),
    #[error("encoded {kind} exceeds configured byte limit {limit}")]
    SizeLimit { kind: &'static str, limit: usize },
    #[error("event JSON serialization failed")]
    Serialization,
}
#[derive(Debug, Clone, Copy, Default)]
pub struct Encoder {
    limits: Limits,
}
impl Encoder {
    pub fn new(limits: Limits) -> Self {
        Self { limits }
    }
    pub fn limits(&self) -> Limits {
        self.limits
    }
    /// Stateless encoding preserves explicit omission of protocolVersion.
    pub fn encode<S: AgentState>(&self, event: &Event<S>) -> Result<Vec<u8>, EncodeError> {
        self.encode_payload(normalize_producer_event(event)?)
    }
    pub fn encode_string<S: AgentState>(&self, event: &Event<S>) -> Result<String, EncodeError> {
        // All output is generated from UTF-8 strings and serde_json.
        String::from_utf8(self.encode(event)?).map_err(|_| EncodeError::Serialization)
    }
    /// The supported live-producer helper declares this SDK's version on
    /// RUN_STARTED. It never copies a peer declaration or fabricates identities.
    pub fn encode_live<S: AgentState>(&self, event: &Event<S>) -> Result<Vec<u8>, EncodeError> {
        let mut value = normalize_producer_event(event)?;
        if matches!(event, Event::RunStarted(_)) {
            value["protocolVersion"] = PROTOCOL_VERSION.into();
        }
        self.encode_payload(value)
    }
    fn encode_payload(&self, value: serde_json::Value) -> Result<Vec<u8>, EncodeError> {
        use std::io::Write;
        // Writing into a capped buffer bounds output allocation even for large
        // serialized values. Nothing escapes until the whole frame succeeds.
        let mut output = CappedBuffer {
            bytes: Vec::new(),
            limit: self.limits.max_event_bytes,
            exceeded: false,
        };
        if output.write_all(b"data: ").is_err() {
            return Err(self.event_limit());
        }
        if serde_json::to_writer(&mut output, &value).is_err() {
            return Err(if output.exceeded {
                self.event_limit()
            } else {
                EncodeError::Serialization
            });
        }
        if output.write_all(b"\n\n").is_err() {
            return Err(self.event_limit());
        }
        Ok(output.bytes)
    }
    fn event_limit(&self) -> EncodeError {
        EncodeError::SizeLimit {
            kind: "event",
            limit: self.limits.max_event_bytes,
        }
    }
    /// Format UTF-8 comments using LF only. Every input line (CR, LF or CRLF)
    /// receives a comment prefix, so it cannot inject data/event/id fields.
    pub fn keepalive(&self, comment: &str) -> Result<Vec<u8>, EncodeError> {
        use std::io::Write;
        let mut output = CappedBuffer {
            bytes: Vec::new(),
            limit: self.limits.max_comment_bytes,
            exceeded: false,
        };
        let result = (|| {
            let mut rest = comment;
            loop {
                let end = rest.find(['\r', '\n']).unwrap_or(rest.len());
                output.write_all(b": ")?;
                output.write_all(&rest.as_bytes()[..end])?;
                output.write_all(b"\n")?;
                if end == rest.len() {
                    break;
                }
                let separator = if rest[end..].starts_with("\r\n") {
                    2
                } else {
                    1
                };
                rest = &rest[end + separator..];
            }
            output.write_all(b"\n")
        })();
        result.map_err(|_| EncodeError::SizeLimit {
            kind: "comment",
            limit: self.limits.max_comment_bytes,
        })?;
        Ok(output.bytes)
    }
}
struct CappedBuffer {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}
impl std::io::Write for CappedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("size limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub fn encode<S: AgentState>(event: &Event<S>) -> Result<Vec<u8>, EncodeError> {
    Encoder::default().encode(event)
}
pub fn encode_live<S: AgentState>(event: &Event<S>) -> Result<Vec<u8>, EncodeError> {
    Encoder::default().encode_live(event)
}
pub fn keepalive(comment: &str) -> Result<Vec<u8>, EncodeError> {
    Encoder::default().keepalive(comment)
}
