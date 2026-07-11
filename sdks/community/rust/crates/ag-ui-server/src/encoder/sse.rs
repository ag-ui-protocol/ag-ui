//! Server-Sent Events (SSE) encoder.
//!
//! Encodes AG-UI events into the SSE wire format as specified by the
//! [W3C Server-Sent Events specification](https://html.spec.whatwg.org/multipage/server-sent-events.html).
//!
//! # Format
//!
//! Each event is encoded as:
//! ```text
//! data: {"type":"EVENT_TYPE",...}\n\n
//! ```
//!
//! Multi-line data is handled by prefixing each line with `data: `.

use crate::error::{EncodeError, EncodeResult};
use ag_ui_core::event::Event;
use ag_ui_core::AgentState;
use bytes::Bytes;

/// Maximum event size (1 MB).
///
/// Events larger than this will be rejected to prevent memory issues.
const MAX_EVENT_SIZE: usize = 1024 * 1024;

/// Encode an event to SSE format.
///
/// # Format
///
/// The output format follows the SSE specification:
/// ```text
/// data: {"type":"RUN_STARTED","threadId":"...","runId":"..."}\n\n
/// ```
///
/// # Errors
///
/// Returns [`EncodeError::Json`] if JSON serialization fails.
/// Returns [`EncodeError::EventTooLarge`] if the event exceeds 1 MB.
///
/// # Example
///
/// ```rust
/// use ag_ui_server::encoder::encode_sse;
/// use ag_ui_core::event::{Event, RunStartedEvent, BaseEvent};
/// use ag_ui_core::types::{ThreadId, RunId};
///
/// let event: Event = Event::RunStarted(RunStartedEvent {
///     base: BaseEvent { timestamp: None, raw_event: None },
///     thread_id: ThreadId::new("t1"),
///     run_id: RunId::new("r1"),
/// });
///
/// let bytes = encode_sse(&event).expect("encoding failed");
/// let s = std::str::from_utf8(&bytes).unwrap();
///
/// assert!(s.starts_with("data: "));
/// assert!(s.ends_with("\n\n"));
/// ```
pub fn encode<S: AgentState>(event: &Event<S>) -> EncodeResult<Bytes> {
    let event_type = event.event_type();

    let json = serde_json::to_string(event).map_err(|e| EncodeError::Json {
        event_type: event_type_str(event_type),
        source: e,
    })?;

    // Check size limit
    if json.len() > MAX_EVENT_SIZE {
        return Err(EncodeError::EventTooLarge {
            size: json.len(),
            max: MAX_EVENT_SIZE,
        });
    }

    // SSE format: "data: {json}\n\n"
    // Pre-allocate with exact size for efficiency
    let capacity = 6 + json.len() + 2; // "data: " + json + "\n\n"
    let mut output = String::with_capacity(capacity);

    // Handle potential multi-line JSON (though serde_json::to_string produces single-line)
    // by prefixing each line with "data: "
    if json.contains('\n') {
        for line in json.lines() {
            output.push_str("data: ");
            output.push_str(line);
            output.push('\n');
        }
        output.push('\n');
    } else {
        output.push_str("data: ");
        output.push_str(&json);
        output.push_str("\n\n");
    }

    Ok(Bytes::from(output))
}

/// Convert `EventType` to a static string for error messages.
fn event_type_str(event_type: ag_ui_core::event::EventType) -> &'static str {
    use ag_ui_core::event::EventType;
    match event_type {
        EventType::TextMessageStart => "TEXT_MESSAGE_START",
        EventType::TextMessageContent => "TEXT_MESSAGE_CONTENT",
        EventType::TextMessageEnd => "TEXT_MESSAGE_END",
        EventType::TextMessageChunk => "TEXT_MESSAGE_CHUNK",
        EventType::ThinkingTextMessageStart => "THINKING_TEXT_MESSAGE_START",
        EventType::ThinkingTextMessageContent => "THINKING_TEXT_MESSAGE_CONTENT",
        EventType::ThinkingTextMessageEnd => "THINKING_TEXT_MESSAGE_END",
        EventType::ToolCallStart => "TOOL_CALL_START",
        EventType::ToolCallArgs => "TOOL_CALL_ARGS",
        EventType::ToolCallEnd => "TOOL_CALL_END",
        EventType::ToolCallChunk => "TOOL_CALL_CHUNK",
        EventType::ToolCallResult => "TOOL_CALL_RESULT",
        EventType::ThinkingStart => "THINKING_START",
        EventType::ThinkingEnd => "THINKING_END",
        EventType::StateSnapshot => "STATE_SNAPSHOT",
        EventType::StateDelta => "STATE_DELTA",
        EventType::MessagesSnapshot => "MESSAGES_SNAPSHOT",
        EventType::Raw => "RAW",
        EventType::Custom => "CUSTOM",
        EventType::RunStarted => "RUN_STARTED",
        EventType::RunFinished => "RUN_FINISHED",
        EventType::RunError => "RUN_ERROR",
        EventType::StepStarted => "STEP_STARTED",
        EventType::StepFinished => "STEP_FINISHED",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ag_ui_core::event::{
        BaseEvent, CustomEvent, RunErrorEvent, RunFinishedEvent, RunStartedEvent,
        StateSnapshotEvent, TextMessageContentEvent, TextMessageEndEvent, TextMessageStartEvent,
    };
    use ag_ui_core::types::{MessageId, Role, RunId, ThreadId};

    fn base() -> BaseEvent {
        BaseEvent {
            timestamp: None,
            raw_event: None,
        }
    }

    #[test]
    fn encode_run_started() {
        let event: Event = Event::RunStarted(RunStartedEvent {
            base: base(),
            thread_id: ThreadId::new("thread-123"),
            run_id: RunId::new("run-456"),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        assert!(s.starts_with("data: "));
        assert!(s.ends_with("\n\n"));
        assert!(s.contains("\"type\":\"RUN_STARTED\""));
    }

    #[test]
    fn encode_run_finished() {
        let event: Event = Event::RunFinished(RunFinishedEvent {
            base: base(),
            thread_id: ThreadId::new("t1"),
            run_id: RunId::new("r1"),
            result: Some(serde_json::json!({"answer": 42})),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        assert!(s.contains("RUN_FINISHED"));
        assert!(s.contains("\"answer\":42"));
    }

    #[test]
    fn encode_run_error() {
        let event: Event = Event::RunError(RunErrorEvent {
            base: base(),
            message: "something went wrong".to_string(),
            code: Some("ERR_001".to_string()),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        assert!(s.contains("RUN_ERROR"));
        assert!(s.contains("something went wrong"));
        assert!(s.contains("ERR_001"));
    }

    #[test]
    fn encode_text_message_flow() {
        let start: Event = Event::TextMessageStart(TextMessageStartEvent {
            base: base(),
            message_id: MessageId::new("msg-1"),
            role: Role::Assistant,
        });

        let content: Event = Event::TextMessageContent(TextMessageContentEvent {
            base: base(),
            message_id: MessageId::new("msg-1"),
            delta: "Hello, world!".to_string(),
        });

        let end: Event = Event::TextMessageEnd(TextMessageEndEvent {
            base: base(),
            message_id: MessageId::new("msg-1"),
        });

        for event in [start, content, end] {
            let bytes = encode(&event).expect("encoding should succeed");
            let s = std::str::from_utf8(&bytes).expect("valid UTF-8");
            assert!(s.starts_with("data: "));
            assert!(s.ends_with("\n\n"));
        }
    }

    #[test]
    fn encode_state_snapshot() {
        let event: Event = Event::StateSnapshot(StateSnapshotEvent {
            base: base(),
            snapshot: serde_json::json!({
                "count": 42,
                "items": ["a", "b", "c"]
            }),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        assert!(s.contains("STATE_SNAPSHOT"));
        assert!(s.contains("\"count\":42"));
    }

    #[test]
    fn encode_custom_event() {
        let event: Event = Event::Custom(CustomEvent {
            base: base(),
            name: "my_custom_event".to_string(),
            value: serde_json::json!({"foo": "bar"}),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        assert!(s.contains("CUSTOM"));
        assert!(s.contains("my_custom_event"));
    }

    #[test]
    fn encode_with_timestamp() {
        let event: Event = Event::RunStarted(RunStartedEvent {
            base: BaseEvent {
                timestamp: Some(1234567890.123),
                raw_event: None,
            },
            thread_id: ThreadId::new("t1"),
            run_id: RunId::new("r1"),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        assert!(s.contains("1234567890.123"));
    }

    #[test]
    fn encode_unicode_content() {
        let event: Event = Event::TextMessageContent(TextMessageContentEvent {
            base: base(),
            message_id: MessageId::new("msg-1"),
            delta: "Hello, 世界! 🌍".to_string(),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        // Unicode should be preserved (either raw or escaped)
        assert!(s.contains("世界") || s.contains("\\u"));
        assert!(s.contains("🌍") || s.contains("\\u"));
    }

    #[test]
    fn encode_special_characters() {
        let event: Event = Event::TextMessageContent(TextMessageContentEvent {
            base: base(),
            message_id: MessageId::new("msg-1"),
            delta: "Line1\nLine2\tTabbed\"Quoted\"".to_string(),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        // JSON should escape special characters
        assert!(s.contains("\\n") || s.contains("\\t") || s.contains("\\\""));
    }

    #[test]
    fn encode_empty_delta() {
        // Empty delta is technically valid at the encoding layer
        // (validation happens elsewhere)
        let event: Event = Event::TextMessageContent(TextMessageContentEvent {
            base: base(),
            message_id: MessageId::new("msg-1"),
            delta: "".to_string(),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        assert!(s.contains("\"delta\":\"\""));
    }

    #[test]
    fn sse_format_correct() {
        let event: Event = Event::RunStarted(RunStartedEvent {
            base: base(),
            thread_id: ThreadId::new("t1"),
            run_id: RunId::new("r1"),
        });

        let bytes = encode(&event).expect("encoding should succeed");
        let s = std::str::from_utf8(&bytes).expect("valid UTF-8");

        // Verify exact SSE format
        assert!(s.starts_with("data: {"));
        assert!(s.ends_with("}\n\n"));

        // Should be parseable as JSON after removing SSE framing
        let json_str = s.trim_start_matches("data: ").trim_end();
        let _: serde_json::Value =
            serde_json::from_str(json_str).expect("should be valid JSON");
    }
}
