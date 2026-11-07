//! The AG-UI binary transport — **not implemented**.
//!
//! This module exists so that a build with the `protobuf` feature can still
//! negotiate and name the media type, and so the reason it does nothing is
//! written down next to the code rather than discovered at runtime.
//!
//! # Why there is no encoder here
//!
//! The binary transport is defined by `events.proto` in the upstream
//! `@ag-ui/proto` package. Its `Event` message is a `oneof` over **21** of the
//! protocol's **36** event types:
//!
//! `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`,
//! `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`,
//! `TOOL_CALL_CHUNK`, `STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT`,
//! `RAW`, `CUSTOM`, `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`,
//! `STEP_FINISHED`, `SUBAGENT_STARTED`, `SUBAGENT_FINISHED`, `SUBAGENT_ERROR`.
//!
//! (Upstream's own documentation says 19: the two `*_CHUNK` events have a
//! `oneof` arm but no `EventType` enum value to select it with, so they cannot
//! be encoded in practice either.)
//!
//! The other 15 have no wire representation at all: every `REASONING_*` event,
//! both `ACTIVITY_*` events, all five deprecated `THINKING_*` events, and
//! `TOOL_CALL_RESULT`. An agent that reasons, reports activities, or returns a
//! tool result — which is most of them — cannot express its stream in this
//! format. Encoding such a run would mean silently dropping events, so this
//! crate declines to encode any.
//!
//! Generating the Rust types would also mean either a `build.rs` that requires
//! `protoc` on every consumer's machine or checked-in generated code that
//! drifts from upstream. Neither is worth it for a format that cannot carry the
//! protocol.
//!
//! # What to do instead
//!
#![cfg_attr(
    feature = "sse",
    doc = "Use [`sse`](crate::encode::sse), which carries all 36 event types. Revisit"
)]
#![cfg_attr(
    not(feature = "sse"),
    doc = "Use the `sse` module — enable the `sse` feature — which carries all 36",
    doc = "event types. Revisit"
)]
//! this module when upstream `events.proto` covers the full set.

use crate::encode::{EventStreamFormatter, PROTOBUF_MEDIA_TYPE};
use crate::error::{Error, Result};
use crate::event::{Event, EventType};

/// Placeholder for the binary formatter.
///
/// [`content_type`](EventStreamFormatter::content_type) reports the negotiated
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
            "the AG-UI protobuf schema covers only 21 of 36 event types; use SSE",
        ))
    }
}

/// The event types upstream `events.proto` can represent.
///
/// Everything not listed here has no binary encoding. Useful for asserting in a
/// test that a given stream would survive the binary transport.
pub const COVERED_EVENT_TYPES: &[EventType] = &[
    EventType::TextMessageStart,
    EventType::TextMessageContent,
    EventType::TextMessageEnd,
    EventType::TextMessageChunk,
    EventType::ToolCallStart,
    EventType::ToolCallArgs,
    EventType::ToolCallEnd,
    EventType::ToolCallChunk,
    EventType::StateSnapshot,
    EventType::StateDelta,
    EventType::MessagesSnapshot,
    EventType::Raw,
    EventType::Custom,
    EventType::RunStarted,
    EventType::RunFinished,
    EventType::RunError,
    EventType::StepStarted,
    EventType::StepFinished,
    EventType::SubagentStarted,
    EventType::SubagentFinished,
    EventType::SubagentError,
];

/// Whether the binary transport can represent `event_type`.
pub fn is_covered(event_type: EventType) -> bool {
    COVERED_EVENT_TYPES.contains(&event_type)
}
