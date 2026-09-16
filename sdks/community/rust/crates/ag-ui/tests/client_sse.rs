//! The SSE decoder, against the input a network actually delivers.

// Both halves: the client decodes what `encode::sse` framed.
#![cfg(all(feature = "client", feature = "sse"))]

use ag_ui::client::transport::{SseDecoder, SseFrame, decode_events};
use ag_ui::{Event, EventType};
use futures_util::StreamExt;

/// Decodes a whole body, however it is chunked, the way a transport would.
fn decode(chunks: &[&[u8]]) -> Result<Vec<SseFrame>, ag_ui::client::Error> {
    let mut decoder = SseDecoder::new();
    let mut frames = Vec::new();
    for chunk in chunks {
        decoder.push(chunk)?;
        while let Some(frame) = decoder.next_frame()? {
            frames.push(frame);
        }
    }
    frames.extend(decoder.finish()?);
    Ok(frames)
}

fn decode_body(body: &str) -> Result<Vec<SseFrame>, ag_ui::client::Error> {
    decode(&[body.as_bytes()])
}

#[test]
fn a_data_field_spread_over_several_lines_rejoins_with_newlines() {
    let frames = decode_body("data: one\ndata: two\ndata: three\n\n").expect("decodes");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].data, "one\ntwo\nthree");
}

#[test]
fn comments_and_heartbeats_dispatch_nothing() {
    let frames = decode_body(": keep-alive\n\n:\n\ndata: real\n\n").expect("decodes");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].data, "real");
}

#[test]
fn a_body_that_ends_without_a_blank_line_still_dispatches_its_last_frame() {
    // A closed connection, or a server that forgets the terminator. Dropping
    // the frame here would lose a real event.
    let frames = decode_body("data: first\n\ndata: last").expect("decodes");
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[1].data, "last");
}

#[test]
fn every_line_ending_the_format_allows_is_accepted() {
    for body in [
        "data: a\n\ndata: b\n\n",
        "data: a\r\n\r\ndata: b\r\n\r\n",
        "data: a\r\rdata: b\r\r",
    ] {
        let frames = decode_body(body).expect("decodes");
        let payloads: Vec<&str> = frames.iter().map(|frame| frame.data.as_str()).collect();
        assert_eq!(payloads, ["a", "b"], "failed on {body:?}");
    }
}

#[test]
fn a_crlf_split_across_two_chunks_is_still_one_line_ending() {
    // The `\r` arrives at the end of one chunk and the `\n` at the start of the
    // next. Treating them as two breaks would dispatch an empty frame.
    let frames = decode(&[b"data: split\r", b"\n\r\n"]).expect("decodes");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].data, "split");
}

#[test]
fn a_multibyte_character_split_across_chunks_is_reassembled() {
    let payload = "안녕하세요 🌤".as_bytes();
    let body = [b"data: ".as_slice(), payload, b"\n\n"].concat();

    // Split in the middle of a UTF-8 sequence.
    let split = 8;
    assert!(std::str::from_utf8(&body[..split]).is_err());

    let frames = decode(&[&body[..split], &body[split..]]).expect("decodes");
    assert_eq!(frames[0].data, "안녕하세요 🌤");
}

#[test]
fn bytes_that_are_not_utf8_are_an_error() {
    let error = decode(&[b"data: \xff\xfe\n\n"]).expect_err("the format is UTF-8 only");
    assert!(
        error.to_string().contains("not UTF-8"),
        "unexpected error: {error}"
    );
}

#[test]
fn a_leading_byte_order_mark_is_stripped() {
    let frames = decode(&[b"\xef\xbb\xbfdata: hello\n\n"]).expect("decodes");
    assert_eq!(frames[0].data, "hello");
}

#[test]
fn the_space_after_the_colon_is_optional_and_only_one_is_eaten() {
    let frames = decode_body("data:tight\n\ndata:  padded\n\n").expect("decodes");
    assert_eq!(frames[0].data, "tight");
    assert_eq!(frames[1].data, " padded");
}

#[test]
fn a_frame_with_no_data_field_dispatches_nothing() {
    let frames = decode_body("event: ping\n\nid: 7\n\n\n\ndata: real\n\n").expect("decodes");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].data, "real");
    // The fields of the undispatched frames did not leak into this one.
    assert_eq!(frames[0].event, None);
    assert_eq!(frames[0].id, None);
}

#[test]
fn the_other_fields_are_captured_and_unknown_ones_ignored() {
    let body = "event: message\nid: 42\nretry: 3000\nnonsense: ignored\nbare\ndata: payload\n\n";
    let frames = decode_body(body).expect("decodes");
    assert_eq!(frames[0].event.as_deref(), Some("message"));
    assert_eq!(frames[0].id.as_deref(), Some("42"));
    assert_eq!(frames[0].retry, Some(3000));
    assert_eq!(frames[0].data, "payload");
}

#[test]
fn an_empty_data_line_contributes_a_blank_line_to_the_payload() {
    let frames = decode_body("data: a\ndata:\ndata: b\n\n").expect("decodes");
    assert_eq!(frames[0].data, "a\n\nb");
}

#[test]
fn a_frame_that_never_ends_is_capped() {
    // A server that opens a data line and never sends a break would otherwise
    // grow this buffer until the process dies.
    let mut decoder = SseDecoder::new().with_max_frame_size(64);
    assert_eq!(decoder.max_frame_size(), 64);

    let error = decoder
        .push(&[b'x'; 128])
        .expect_err("the cap should stop this");
    assert!(
        error.to_string().contains("limit"),
        "unexpected error: {error}"
    );
}

#[test]
fn the_cap_counts_the_frame_and_not_the_chunk() {
    // A single read carrying many complete frames is ordinary — hyper hands
    // over whatever arrived, and a fast agent fills a TCP window with dozens of
    // tokens. Counting the whole read against a per-frame cap refused a server
    // that had done nothing wrong.
    let mut decoder = SseDecoder::new().with_max_frame_size(64);
    let mut body = String::new();
    for i in 0..20 {
        body.push_str(&format!(
            "data: {{\"type\":\"CUSTOM\",\"name\":\"n{i}\"}}\n\n"
        ));
    }
    assert!(body.len() > 64 * 5, "the body must dwarf the cap");

    decoder
        .push(body.as_bytes())
        .expect("a chunk of complete frames is not one oversized frame");

    let mut frames = 0;
    while decoder.next_frame().expect("decodes").is_some() {
        frames += 1;
    }
    assert_eq!(frames, 20);
}

#[test]
fn the_cap_still_stops_a_frame_built_from_many_small_data_lines() {
    // Every line is terminated, so the unterminated-tail check never fires.
    // The payload the lines accumulate into has to be capped as well, or a
    // producer that never sends a blank line grows it without bound.
    let mut decoder = SseDecoder::new().with_max_frame_size(256);
    let body = "data: xxxxxxxx\n".repeat(200);

    decoder
        .push(body.as_bytes())
        .expect("nothing here is an unterminated line, so the push is fine");
    let error = decoder
        .next_frame()
        .expect_err("the accumulated payload should hit the cap");
    // Named specifically: the push-time check would also say "limit", and it
    // saying so is the bug this pair of tests brackets.
    assert!(
        error.to_string().contains("across its data lines"),
        "unexpected error: {error}"
    );
}

#[test]
fn many_frames_in_one_chunk_all_come_back_out() {
    // The other half of the cursor arrangement: reading through a large chunk
    // one line at a time has to leave the frames intact and in order. That the
    // reading does not recopy the remainder as it goes is asserted in the
    // decoder's own unit tests, where the cursor is visible.
    let mut body = String::new();
    for i in 0..2_000 {
        body.push_str(&format!(
            "data: {{\"type\":\"CUSTOM\",\"name\":\"n{i}\"}}\n\n"
        ));
    }

    let mut decoder = SseDecoder::new();
    decoder.push(body.as_bytes()).expect("pushes");
    let mut decoded = Vec::new();
    while let Some(frame) = decoder.next_frame().expect("decodes") {
        decoded.push(frame.data);
    }

    assert_eq!(decoded.len(), 2_000);
    assert_eq!(decoded[0], r#"{"type":"CUSTOM","name":"n0"}"#);
    assert_eq!(decoded[1_999], r#"{"type":"CUSTOM","name":"n1999"}"#);
}

#[test]
fn a_payload_with_embedded_newlines_and_blank_lines_round_trips() {
    // The encoder in ag-ui-core writes one `data:` line per line of payload.
    // This is the other half of that contract: what goes in comes out, byte for
    // byte, blank lines included.
    let payload = "{\n\n  \"deliberately\": \"multi-line\",\n\n  \"blank\": true\n}";
    let body = ag_ui::encode::sse::frame(payload);

    let frames = decode_body(&body).expect("decodes");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].data, payload);
}

#[test]
fn an_event_is_parsed_out_of_a_frame() {
    let body = ag_ui::encode::sse::frame(
        &serde_json::to_string(&Event::run_started("thread-1", "run-1")).expect("serializes"),
    );
    let frames = decode_body(&body).expect("decodes");
    let event = frames
        .into_iter()
        .next()
        .expect("one frame")
        .into_event()
        .expect("parses");
    assert_eq!(event.event_type(), EventType::RunStarted);
}

#[test]
fn a_frame_that_is_not_an_event_is_an_error_not_a_panic() {
    let frames = decode_body("data: {\"type\":\"NOT_AN_EVENT\"}\n\n").expect("decodes");
    assert!(frames[0].clone().into_event().is_err());

    let frames = decode_body("data: not json at all\n\n").expect("decodes");
    assert!(frames[0].clone().into_event().is_err());
}

// ---- the stream adapter ------------------------------------------------

/// Turns a list of byte chunks into the shape a transport body has.
fn body_stream(
    chunks: Vec<&'static [u8]>,
) -> impl futures_util::Stream<Item = Result<&'static [u8], std::io::Error>> {
    futures_util::stream::iter(chunks.into_iter().map(Ok))
}

#[tokio::test]
async fn a_byte_stream_decodes_into_events_however_it_is_chunked() {
    // Frame boundaries fall in the middle of chunks, mid-JSON, and mid-word.
    let events: Vec<_> = decode_events(body_stream(vec![
        b": warming up\n\ndata: {\"type\":\"RUN_START",
        b"ED\",\"threadId\":\"t\",\"runId\":\"r\"}\n\ndata: {\"type\":\"TEXT_MESSA",
        b"GE_CHUNK\",\"messageId\":\"m\",\"delta\":\"hi\"}\n\n",
        b"data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t\",\"runId\":\"r\"}",
    ]))
    .collect()
    .await;

    let types: Vec<EventType> = events
        .into_iter()
        .map(|event| event.expect("decodes").event_type())
        .collect();
    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageChunk,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn one_unparseable_frame_does_not_silence_the_rest_of_the_run() {
    let events: Vec<_> = decode_events(body_stream(vec![
        b"data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t\",\"runId\":\"r\"}\n\n",
        b"data: {\"type\":\"WHAT_IS_THIS\"}\n\n",
        b"data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t\",\"runId\":\"r\"}\n\n",
    ]))
    .collect()
    .await;

    assert_eq!(events.len(), 3);
    assert!(events[0].is_ok());
    assert!(events[1].is_err());
    assert!(events[2].is_ok());
}

#[tokio::test]
async fn a_broken_connection_ends_the_stream_with_a_transport_error() {
    let chunks = futures_util::stream::iter(vec![
        Ok(b"data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t\",\"runId\":\"r\"}\n\n".as_slice()),
        Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        )),
    ]);

    let events: Vec<_> = decode_events(chunks).collect().await;
    assert_eq!(events.len(), 2);
    assert!(events[0].is_ok());
    let error = events[1].as_ref().expect_err("the reset should surface");
    assert!(
        error.to_string().contains("connection reset"),
        "unexpected error: {error}"
    );
}
