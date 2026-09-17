//! SSE framing and `Accept` negotiation.

#![cfg(feature = "sse")]

use ag_ui::encode::sse::frame;
use ag_ui::*;
use serde_json::json;

#[test]
fn an_event_is_framed_as_a_single_data_block() {
    let formatter = SseFormatter::new();
    let encoded = formatter
        .encode_to_string(&Event::text_message_end("msg-1"))
        .unwrap();

    assert_eq!(
        encoded,
        "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"msg-1\"}\n\n"
    );
    assert_eq!(
        formatter.encode(&Event::text_message_end("msg-1")).unwrap(),
        encoded.into_bytes()
    );
    assert_eq!(formatter.content_type(), SSE_MEDIA_TYPE);
    assert_eq!(SSE_MEDIA_TYPE, "text/event-stream");
}

#[test]
fn a_newline_inside_a_payload_never_breaks_the_frame() {
    // serde_json escapes control characters, so the newline stays inside the
    // JSON string and the frame remains one line. Anything else would truncate
    // the event at the line break.
    let formatter = SseFormatter::new();
    let encoded = formatter
        .encode_to_string(&Event::text_message_content("msg-1", "line one\nline two"))
        .unwrap();

    assert_eq!(
        encoded,
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg-1\",\"delta\":\"line one\\nline two\"}\n\n"
    );
    assert_eq!(encoded.matches("data: ").count(), 1);
    assert!(encoded.ends_with("\n\n"));

    // And the delta survives the round-trip with its newline intact.
    let payload = encoded
        .trim_end_matches('\n')
        .strip_prefix("data: ")
        .unwrap();
    let back: Event = serde_json::from_str(payload).unwrap();
    let Event::TextMessageContent(content) = back else {
        panic!("wrong variant");
    };
    assert_eq!(content.delta, "line one\nline two");
}

#[test]
fn a_multi_line_payload_becomes_one_data_line_per_line() {
    assert_eq!(frame("one\ntwo"), "data: one\ndata: two\n\n");
    assert_eq!(frame("one\r\ntwo"), "data: one\ndata: two\n\n");
    assert_eq!(frame("one\rtwo"), "data: one\ndata: two\n\n");
    // A trailing break is a real empty line: the decoder strips exactly one.
    assert_eq!(frame("one\n"), "data: one\ndata: \n\n");
    assert_eq!(frame("one"), "data: one\n\n");
    assert_eq!(frame(""), "data: \n\n");
}

#[test]
fn a_whole_run_encodes_to_a_stream() {
    let formatter = SseFormatter::new();
    let run = [
        Event::run_started("thread-1", "run-1"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Hello"),
        Event::text_message_end("msg-1"),
        Event::run_finished_success("thread-1", "run-1"),
    ];

    let body: String = run
        .iter()
        .map(|event| formatter.encode_to_string(event).unwrap())
        .collect();

    assert_eq!(body.matches("\n\n").count(), run.len());

    let decoded: Vec<Event> = body
        .split("\n\n")
        .filter(|frame| !frame.is_empty())
        .map(|frame| serde_json::from_str(frame.strip_prefix("data: ").unwrap()).unwrap())
        .collect();
    assert_eq!(decoded, run);
}

#[test]
fn a_formatter_can_be_used_behind_a_trait_object() {
    let formatter: Box<dyn EventStreamFormatter> = Box::new(SseFormatter::new());
    assert_eq!(formatter.content_type(), SSE_MEDIA_TYPE);
    assert!(
        formatter
            .encode(&Event::custom("ping", json!(null)))
            .is_ok()
    );
}

#[test]
fn accept_negotiation_defaults_to_sse() {
    assert_eq!(media_type(None).unwrap(), SSE_MEDIA_TYPE);
    assert_eq!(media_type(Some("")).unwrap(), SSE_MEDIA_TYPE);
    assert_eq!(media_type(Some("*/*")).unwrap(), SSE_MEDIA_TYPE);
    assert_eq!(media_type(Some("text/*")).unwrap(), SSE_MEDIA_TYPE);
    assert_eq!(
        media_type(Some("text/event-stream")).unwrap(),
        SSE_MEDIA_TYPE
    );
    assert_eq!(
        media_type(Some("text/html;q=0.9, text/event-stream;q=1.0")).unwrap(),
        SSE_MEDIA_TYPE
    );
    assert!(supported_media_types().contains(&SSE_MEDIA_TYPE));
}

#[test]
fn accept_negotiation_rejects_a_header_it_cannot_satisfy() {
    assert!(matches!(
        media_type(Some("application/xml")),
        Err(Error::UnsupportedMediaType(header)) if header == "application/xml"
    ));
    // An explicit q=0 excludes a type even when a wildcard would have matched.
    assert!(media_type(Some("text/event-stream;q=0")).is_err());
}

#[cfg(feature = "protobuf")]
mod binary {
    use super::*;
    use ag_ui::encode::protobuf::{COVERED_EVENT_TYPES, is_covered};

    #[test]
    fn an_explicit_protobuf_accept_wins() {
        assert_eq!(
            media_type(Some(PROTOBUF_MEDIA_TYPE)).unwrap(),
            PROTOBUF_MEDIA_TYPE
        );
        assert_eq!(
            media_type(Some(
                "text/event-stream;q=0.5, application/vnd.ag-ui.event+proto"
            ))
            .unwrap(),
            PROTOBUF_MEDIA_TYPE
        );
        // A bare wildcard still picks SSE: it is the only implemented transport.
        assert_eq!(media_type(Some("*/*")).unwrap(), SSE_MEDIA_TYPE);
    }

    #[test]
    fn the_binary_formatter_refuses_rather_than_dropping_events() {
        let formatter = ProtobufFormatter::new();
        assert_eq!(formatter.content_type(), PROTOBUF_MEDIA_TYPE);
        assert!(matches!(
            formatter.encode(&Event::text_message_end("msg-1")),
            Err(Error::UnsupportedTransport(_))
        ));
    }

    #[test]
    fn the_upstream_proto_covers_only_twenty_one_of_the_thirty_six_events() {
        assert_eq!(COVERED_EVENT_TYPES.len(), 21);
        assert_eq!(EventType::ALL.len(), 36);
        assert!(is_covered(EventType::TextMessageStart));
        assert!(is_covered(EventType::SubagentStarted));
        // The reason the binary path is a stub.
        assert!(!is_covered(EventType::ToolCallResult));
        assert!(!is_covered(EventType::ReasoningMessageContent));
        assert!(!is_covered(EventType::ActivitySnapshot));
        assert!(!is_covered(EventType::ThinkingStart));
    }
}
