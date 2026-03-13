//! Event encoding for SSE and Protocol Buffer formats.
//!
//! This module provides encoding of AG-UI events into wire formats suitable
//! for HTTP streaming responses. The primary format is Server-Sent Events (SSE),
//! with optional Protocol Buffer support for higher throughput scenarios.
//!
//! # Content Negotiation
//!
//! The [`EventEncoder`] supports content negotiation via the Accept header:
//!
//! - `text/event-stream` (default) → SSE format
//! - `application/x-ag-ui-proto` → Protocol Buffers (requires `proto` feature)
//!
//! # Example
//!
//! ```rust
//! use ag_ui_server::encoder::{EventEncoder, ContentType};
//! use ag_ui_core::event::{Event, RunStartedEvent, BaseEvent};
//! use ag_ui_core::types::{ThreadId, RunId};
//!
//! let encoder = EventEncoder::from_accept("text/event-stream");
//!
//! let event: Event = Event::RunStarted(RunStartedEvent {
//!     base: BaseEvent { timestamp: None, raw_event: None },
//!     thread_id: ThreadId::new("thread-1"),
//!     run_id: RunId::new("run-1"),
//! });
//!
//! let bytes = encoder.encode(&event).expect("encoding failed");
//! assert!(bytes.starts_with(b"data: "));
//! assert!(bytes.ends_with(b"\n\n"));
//! ```

mod sse;

#[cfg(feature = "proto")]
mod proto;

pub use sse::encode as encode_sse;

#[cfg(feature = "proto")]
pub use proto::encode as encode_proto;

use crate::error::EncodeResult;
use ag_ui_core::event::Event;
use ag_ui_core::AgentState;
use bytes::Bytes;

/// Content types supported by the encoder.
///
/// These correspond to the MIME types used in HTTP Accept and Content-Type headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ContentType {
    /// Server-Sent Events format (`text/event-stream`).
    ///
    /// This is the default and most widely compatible format.
    /// Events are encoded as JSON with SSE framing.
    #[default]
    Sse,

    /// Protocol Buffers format (`application/x-ag-ui-proto`).
    ///
    /// Higher throughput but requires the `proto` feature and
    /// compatible client-side decoding.
    #[cfg(feature = "proto")]
    Proto,
}

impl ContentType {
    /// Parse content type from an Accept header value.
    ///
    /// Handles multiple values and quality parameters, returning the
    /// best supported content type. Defaults to SSE if no match.
    ///
    /// # Examples
    ///
    /// ```rust
    /// use ag_ui_server::encoder::ContentType;
    ///
    /// assert_eq!(ContentType::from_accept("text/event-stream"), ContentType::Sse);
    /// assert_eq!(ContentType::from_accept("*/*"), ContentType::Sse);
    /// assert_eq!(ContentType::from_accept("application/json"), ContentType::Sse); // fallback
    /// ```
    #[must_use]
    #[allow(unused_variables)]
    pub fn from_accept(accept: &str) -> Self {
        // Check for proto first (more specific)
        #[cfg(feature = "proto")]
        if accept.contains("application/x-ag-ui-proto") {
            return ContentType::Proto;
        }

        // Default to SSE for everything else
        ContentType::Sse
    }

    /// Get the MIME type string for this content type.
    ///
    /// Use this for setting the Content-Type response header.
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            ContentType::Sse => "text/event-stream",
            #[cfg(feature = "proto")]
            ContentType::Proto => "application/x-ag-ui-proto",
        }
    }

    /// Check if this content type uses binary encoding.
    #[must_use]
    pub const fn is_binary(&self) -> bool {
        match self {
            ContentType::Sse => false,
            #[cfg(feature = "proto")]
            ContentType::Proto => true,
        }
    }
}

impl std::fmt::Display for ContentType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Event encoder with content-type negotiation.
///
/// This is the main entry point for encoding events. Create an encoder
/// from an Accept header and use it to encode all events in a response.
///
/// # Example
///
/// ```rust
/// use ag_ui_server::encoder::EventEncoder;
/// use ag_ui_core::event::{Event, RunStartedEvent, BaseEvent};
/// use ag_ui_core::types::{ThreadId, RunId};
///
/// // Create from Accept header
/// let encoder = EventEncoder::from_accept("text/event-stream");
///
/// // Or create directly
/// let encoder = EventEncoder::sse();
///
/// // Get content type for response header
/// let content_type = encoder.content_type(); // "text/event-stream"
/// ```
#[derive(Debug, Clone)]
pub struct EventEncoder {
    content_type: ContentType,
}

impl EventEncoder {
    /// Create an encoder from an Accept header value.
    ///
    /// This performs content negotiation and selects the best
    /// supported format. Defaults to SSE if no match.
    #[must_use]
    pub fn from_accept(accept: &str) -> Self {
        Self {
            content_type: ContentType::from_accept(accept),
        }
    }

    /// Create an SSE encoder directly.
    #[must_use]
    pub const fn sse() -> Self {
        Self {
            content_type: ContentType::Sse,
        }
    }

    /// Create a Protocol Buffer encoder directly.
    #[cfg(feature = "proto")]
    #[must_use]
    pub const fn proto() -> Self {
        Self {
            content_type: ContentType::Proto,
        }
    }

    /// Get the content type for response headers.
    #[must_use]
    pub const fn content_type(&self) -> &'static str {
        self.content_type.as_str()
    }

    /// Get the content type enum.
    #[must_use]
    pub const fn content_type_enum(&self) -> ContentType {
        self.content_type
    }

    /// Encode an event to bytes.
    ///
    /// # Errors
    ///
    /// Returns [`EncodeError`] if:
    /// - JSON serialization fails (for SSE)
    /// - Protobuf encoding fails (for Proto)
    /// - Event data exceeds size limits
    pub fn encode<S: AgentState>(&self, event: &Event<S>) -> EncodeResult<Bytes> {
        match self.content_type {
            ContentType::Sse => sse::encode(event),
            #[cfg(feature = "proto")]
            ContentType::Proto => proto::encode(event),
        }
    }

    /// Encode multiple events efficiently.
    ///
    /// For SSE, this concatenates the encoded events.
    /// For Proto, this may use a more efficient batch encoding.
    ///
    /// # Errors
    ///
    /// Returns the first encoding error encountered.
    pub fn encode_batch<S: AgentState>(&self, events: &[Event<S>]) -> EncodeResult<Bytes> {
        match self.content_type {
            ContentType::Sse => {
                let mut buffer = Vec::with_capacity(events.len() * 256);
                for event in events {
                    let encoded = sse::encode(event)?;
                    buffer.extend_from_slice(&encoded);
                }
                Ok(Bytes::from(buffer))
            }
            #[cfg(feature = "proto")]
            ContentType::Proto => {
                // For proto, we could implement batch encoding
                // For now, just concatenate
                let mut buffer = Vec::with_capacity(events.len() * 128);
                for event in events {
                    let encoded = proto::encode(event)?;
                    buffer.extend_from_slice(&encoded);
                }
                Ok(Bytes::from(buffer))
            }
        }
    }
}

impl Default for EventEncoder {
    fn default() -> Self {
        Self::sse()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ag_ui_core::event::{BaseEvent, RunFinishedEvent, RunStartedEvent};
    use ag_ui_core::types::{RunId, ThreadId};

    fn make_run_started() -> Event<serde_json::Value> {
        Event::RunStarted(RunStartedEvent {
            base: BaseEvent {
                timestamp: None,
                raw_event: None,
            },
            thread_id: ThreadId::new("thread-1"),
            run_id: RunId::new("run-1"),
        })
    }

    fn make_run_finished() -> Event<serde_json::Value> {
        Event::RunFinished(RunFinishedEvent {
            base: BaseEvent {
                timestamp: None,
                raw_event: None,
            },
            thread_id: ThreadId::new("thread-1"),
            run_id: RunId::new("run-1"),
            result: None,
        })
    }

    #[test]
    fn content_type_from_accept_sse() {
        assert_eq!(
            ContentType::from_accept("text/event-stream"),
            ContentType::Sse
        );
        assert_eq!(ContentType::from_accept("*/*"), ContentType::Sse);
        assert_eq!(
            ContentType::from_accept("text/html, text/event-stream"),
            ContentType::Sse
        );
    }

    #[test]
    fn content_type_default_fallback() {
        assert_eq!(
            ContentType::from_accept("application/json"),
            ContentType::Sse
        );
        assert_eq!(ContentType::from_accept(""), ContentType::Sse);
    }

    #[test]
    fn content_type_as_str() {
        assert_eq!(ContentType::Sse.as_str(), "text/event-stream");
    }

    #[test]
    fn content_type_is_binary() {
        assert!(!ContentType::Sse.is_binary());
    }

    #[test]
    fn encoder_from_accept() {
        let encoder = EventEncoder::from_accept("text/event-stream");
        assert_eq!(encoder.content_type(), "text/event-stream");
    }

    #[test]
    fn encoder_encode_sse() {
        let encoder = EventEncoder::sse();
        let event = make_run_started();
        let bytes = encoder.encode(&event).expect("encoding should succeed");

        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");
        assert!(s.starts_with("data: "));
        assert!(s.ends_with("\n\n"));
        assert!(s.contains("RUN_STARTED"));
    }

    #[test]
    fn encoder_encode_batch() {
        let encoder = EventEncoder::sse();
        let events = vec![make_run_started(), make_run_finished()];
        let bytes = encoder
            .encode_batch(&events)
            .expect("batch encoding should succeed");

        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");
        assert!(s.contains("RUN_STARTED"));
        assert!(s.contains("RUN_FINISHED"));

        // Should have two events, each ending with \n\n
        assert_eq!(s.matches("\n\n").count(), 2);
    }

    #[test]
    fn encoder_default_is_sse() {
        let encoder = EventEncoder::default();
        assert_eq!(encoder.content_type(), "text/event-stream");
    }
}
