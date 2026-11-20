//! The AG-UI binary transport — **not implemented**.
//!
//! This module exists so that a build with the `protobuf` feature can name the
//! media type, and so the reason it does nothing is written down next to the
//! code rather than discovered at runtime. [`ProtobufFormatter`] reports the
//! binary media type and refuses every event; negotiation never picks that
//! media type, with or without this feature.
//!
//! # Why there is no encoder here
//!
//! The binary transport is defined by `events.proto` in the upstream
//! `@ag-ui/proto` package. When this module was written, its `Event` message
//! was a `oneof` over 21 of the 36 event types this crate defines, with no
//! `REASONING_*`, `ACTIVITY_*` or `THINKING_*` event and no
//! `TOOL_CALL_RESULT`. Encoding a run would have meant silently dropping
//! events, so this crate declined to encode any.
//!
//! That reason is gone. Upstream now generates `events.proto` from the AG-UI
//! 1.0 JSON Schema, and both its `EventType` enum and its `oneof` cover all 31
//! 1.0 event types. Only the five deprecated `THINKING_*` events, which 1.0
//! retired, are absent.
//!
//! The encoder is still not written
//! ([#46](https://github.com/KimSoungRyoul/ag-ui-rust/issues/46)), for two
//! reasons:
//!
//! - Nothing would ask for it. The stock TypeScript client, `HttpAgent` in
//!   `@ag-ui/client`, sends `Accept: text/event-stream`, so a server that
//!   could encode protobuf would still not be asked to.
//! - It is a second encoding to keep in step with a generated schema, for a
//!   path nobody has asked this SDK for. Generating the Rust types means
//!   either a `build.rs` that requires `protoc` on every consumer's machine or
//!   checked-in generated code to refresh each time upstream regenerates.
//!
//! An encoder can be added behind this same feature later without a breaking
//! change.
//!
//! # What to do instead
//!
#![cfg_attr(
    feature = "sse",
    doc = "Use [`sse`](crate::encode::sse), which carries every event type this crate defines."
)]
#![cfg_attr(
    not(feature = "sse"),
    doc = "Use the `sse` module — enable the `sse` feature — which carries every event",
    doc = "type this crate defines."
)]

use crate::encode::{EventStreamFormatter, PROTOBUF_MEDIA_TYPE};
use crate::error::{Error, Result};
use crate::event::Event;

/// Placeholder for the binary formatter.
///
/// [`content_type`](EventStreamFormatter::content_type) reports the binary
/// media type, but [`encode`](EventStreamFormatter::encode) always fails with
/// [`Error::UnsupportedTransport`] — see the [module docs](self) for why.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProtobufFormatter;

impl ProtobufFormatter {
    /// Builds the placeholder formatter.
    pub const fn new() -> Self {
        Self
    }
}

impl EventStreamFormatter for ProtobufFormatter {
    fn content_type(&self) -> &'static str {
        PROTOBUF_MEDIA_TYPE
    }

    fn encode(&self, _event: &Event) -> Result<Vec<u8>> {
        Err(Error::UnsupportedTransport(
            "this crate has no AG-UI protobuf encoder; use SSE",
        ))
    }
}
