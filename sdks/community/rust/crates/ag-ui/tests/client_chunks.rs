//! Chunk normalization, and the edge cases that make it fiddly.

#![cfg(feature = "client")]

use ag_ui::client::apply::Applier;
use ag_ui::client::{ChunkNormalizer, normalize_all, verify_all};
use ag_ui::{
    Event, EventType, MessageId, TextMessageChunkEvent, TextMessageRole, ToolCallChunkEvent,
    ToolCallId,
};

fn types(events: &[Event]) -> Vec<EventType> {
    events.iter().map(Event::event_type).collect()
}

fn text_chunk(id: Option<&str>, delta: Option<&str>) -> Event {
    Event::text_message_chunk(
        id.map(MessageId::new),
        delta.map(std::borrow::ToOwned::to_owned),
    )
}

fn tool_chunk(id: Option<&str>, name: Option<&str>, delta: Option<&str>) -> Event {
    Event::tool_call_chunk(
        id.map(ToolCallId::new),
        name.map(std::borrow::ToOwned::to_owned),
        delta.map(std::borrow::ToOwned::to_owned),
    )
}

#[test]
fn a_chunk_stream_that_never_terminates_is_closed_at_the_end_of_the_stream() {
    // The last message of a run has nothing after it to imply its end, so the
    // end of the transport stream is what closes it.
    let events = normalize_all([
        text_chunk(Some("msg-1"), Some("Hel")),
        text_chunk(None, Some("lo")),
        text_chunk(None, Some("!")),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageContent,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
        ]
    );

    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.text_of("msg-1"), Some("Hello!"));
}

#[test]
fn a_chunk_with_no_preceding_id_is_a_protocol_error() {
    let error = normalize_all([text_chunk(None, Some("orphan"))])
        .expect_err("there is no message to attach the text to");
    assert!(
        error.to_string().contains("no messageId"),
        "unexpected error: {error}"
    );

    let error = normalize_all([tool_chunk(None, None, Some("{}"))])
        .expect_err("there is no call to attach the arguments to");
    assert!(
        error.to_string().contains("no toolCallId"),
        "unexpected error: {error}"
    );
}

#[test]
fn a_tool_call_chunk_that_opens_a_call_must_name_the_tool() {
    // Without a name there is nothing to put in TOOL_CALL_START, and inventing
    // one would silently call the wrong tool.
    let error = normalize_all([tool_chunk(Some("call-1"), None, Some("{}"))])
        .expect_err("a call has to be named");
    assert!(
        error.to_string().contains("without a toolCallName"),
        "unexpected error: {error}"
    );
}

#[test]
fn interleaved_chunk_streams_close_each_other() {
    // Two messages, alternating. Each switch ends the message before it — that
    // is the only signal the format gives.
    let events = normalize_all([
        text_chunk(Some("msg-1"), Some("a1")),
        text_chunk(Some("msg-2"), Some("b1")),
        text_chunk(None, Some("b2")),
        text_chunk(Some("msg-1"), Some("a2")),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::TextMessageStart,   // msg-1
            EventType::TextMessageContent, // a1
            EventType::TextMessageEnd,     // msg-1
            EventType::TextMessageStart,   // msg-2
            EventType::TextMessageContent, // b1
            EventType::TextMessageContent, // b2 — bare chunk continues msg-2
            EventType::TextMessageEnd,     // msg-2
            EventType::TextMessageStart,   // msg-1 again
            EventType::TextMessageContent, // a2
            EventType::TextMessageEnd,     // msg-1
        ]
    );

    // Re-opening a known id appends rather than duplicating the message.
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.messages().len(), 2);
    assert_eq!(applier.text_of("msg-1"), Some("a1a2"));
    assert_eq!(applier.text_of("msg-2"), Some("b1b2"));
}

#[test]
fn a_tool_call_chunk_closes_an_open_text_chunk_stream() {
    let events = normalize_all([
        text_chunk(Some("msg-1"), Some("Checking")),
        tool_chunk(Some("call-1"), Some("get_weather"), Some(r#"{"city":"#)),
        tool_chunk(None, None, Some(r#""Seoul"}"#)),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
        ]
    );

    // And what comes out is a stream the verifier accepts.
    let mut run = vec![Event::run_started("thread-1", "run-1")];
    run.extend(events);
    run.push(Event::run_finished_success("thread-1", "run-1"));
    verify_all(&run).expect("normalized chunks should be a valid stream");
}

#[test]
fn the_run_ending_closes_an_open_chunk_stream_before_it() {
    let events = normalize_all([
        Event::run_started("thread-1", "run-1"),
        text_chunk(Some("msg-1"), Some("Done.")),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
}

#[test]
fn an_explicit_end_is_not_duplicated() {
    // A producer that opens with a chunk and closes explicitly gets exactly one
    // TEXT_MESSAGE_END.
    let events = normalize_all([
        text_chunk(Some("msg-1"), Some("Hi")),
        Event::text_message_end("msg-1"),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
        ]
    );
}

#[test]
fn an_explicit_message_absorbs_a_following_bare_chunk() {
    // Deliberately more tolerant than upstream. `transformChunks` tracks only
    // the streams it opened itself — an explicit TEXT_MESSAGE_START never sets
    // its `mode` — so upstream throws "First TEXT_MESSAGE_CHUNK must have a
    // messageId" here. There is exactly one message open and the chunk can only
    // mean that one, so accepting is the interoperable reading.
    let events = normalize_all([
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Hel"),
        text_chunk(None, Some("lo")),
        Event::text_message_end("msg-1"),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
        ]
    );

    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.text_of("msg-1"), Some("Hello"));
}

#[test]
fn events_between_chunks_do_not_split_the_message() {
    // A producer that streams chunks may well publish state between two
    // fragments of one message. Ending the message there would be wrong.
    //
    // Upstream's `transformChunks` does end it: every event outside its
    // passthrough list runs `closePendingEvent()` first, so a STATE_SNAPSHOT
    // between two fragments closes the message and the next fragment re-opens
    // it. The assembled message is the same either way — see
    // `splitting_a_message_on_an_intervening_event_assembles_the_same_text` —
    // but ours does not fire a spurious "message complete" at the halfway
    // point, and a *bare* fragment after the intervening event still lands in
    // the right message rather than throwing.
    let events = normalize_all([
        text_chunk(Some("msg-1"), Some("Hel")),
        Event::state_snapshot(serde_json::json!({ "progress": 0.5 })),
        text_chunk(None, Some("lo")),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::StateSnapshot,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
        ]
    );
}

#[test]
fn splitting_a_message_on_an_intervening_event_assembles_the_same_text() {
    // The stream upstream's transform would have produced for the fixture in
    // the test above, written out by hand. Applying it has to land in the same
    // place as applying ours, or the two SDKs disagree about what the user
    // said — which is the part that actually has to interoperate.
    let upstream = [
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Hel"),
        Event::text_message_end("msg-1"),
        Event::state_snapshot(serde_json::json!({ "progress": 0.5 })),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "lo"),
        Event::text_message_end("msg-1"),
    ];
    let ours = normalize_all([
        text_chunk(Some("msg-1"), Some("Hel")),
        Event::state_snapshot(serde_json::json!({ "progress": 0.5 })),
        text_chunk(Some("msg-1"), Some("lo")),
    ])
    .expect("normalizes");

    let assemble = |events: &[Event]| {
        let mut applier = Applier::new();
        for event in events {
            applier.apply(event).expect("applies");
        }
        (
            applier.messages().len(),
            applier.text_of("msg-1").map(str::to_owned),
        )
    };

    assert_eq!(assemble(&upstream), (1, Some("Hello".to_owned())));
    assert_eq!(assemble(&ours), assemble(&upstream));
}

#[test]
fn two_messages_and_two_calls_interleaved_expand_exactly_as_upstream_does() {
    // The fixture from upstream's `chunks/__tests__/transform.test.ts`,
    // "should handle interleaved chunks with different message and tool call
    // IDs", down to its counts: re-opening an id the stream has already closed
    // is a *new* bracket, not a continuation, so six starts, six ends, six
    // payloads and the terminal event — nineteen events.
    let events = normalize_all([
        // Upstream's fixture starts at the first chunk; a real stream has to
        // open, and the verification below needs it to.
        Event::run_started("thread-1", "run-1"),
        text_chunk(Some("msg-1"), Some("First message part 1")),
        tool_chunk(Some("tool-1"), Some("firstTool"), Some(r#"{"arg1":"#)),
        text_chunk(Some("msg-1"), Some("First message part 2")),
        text_chunk(Some("msg-2"), Some("Second message")),
        tool_chunk(Some("tool-2"), Some("secondTool"), Some(r#"{"arg2":"#)),
        tool_chunk(Some("tool-1"), Some("firstTool"), Some(r#""more"}"#)),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .expect("normalizes");

    let count = |kind: EventType| types(&events).iter().filter(|t| **t == kind).count();
    assert_eq!(count(EventType::TextMessageStart), 3);
    assert_eq!(count(EventType::TextMessageEnd), 3);
    assert_eq!(count(EventType::TextMessageContent), 3);
    assert_eq!(count(EventType::ToolCallStart), 3);
    assert_eq!(count(EventType::ToolCallEnd), 3);
    assert_eq!(count(EventType::ToolCallArgs), 3);
    assert_eq!(count(EventType::RunFinished), 1);
    assert_eq!(events.len(), 20, "upstream's nineteen, plus RUN_STARTED");

    // The terminator for the last call goes out *before* RUN_FINISHED, so the
    // stream a verifier sees never has a call open at the end.
    assert_eq!(
        types(&events)[18..],
        [EventType::ToolCallEnd, EventType::RunFinished]
    );
    verify_all(&events).expect("the expansion should be a valid stream");
}

#[test]
fn events_outside_the_protocols_ordering_never_close_a_chunk_stream() {
    // Upstream returns `[event]` for exactly RAW, ACTIVITY_SNAPSHOT,
    // ACTIVITY_DELTA and REASONING_ENCRYPTED_VALUE — the only four that skip
    // `closePendingEvent()`. Ours must not close on them either.
    let events = normalize_all([
        text_chunk(Some("msg-1"), Some("Hel")),
        Event::raw(serde_json::json!({ "provider": "anything" })),
        Event::activity_snapshot("act-1", "web_search", serde_json::Map::new()),
        text_chunk(Some("msg-1"), Some("lo")),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::Raw,
            EventType::ActivitySnapshot,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
        ]
    );
}

#[test]
fn a_chunk_carries_its_role_and_name_onto_the_synthesized_start() {
    let chunk = Event::TextMessageChunk(TextMessageChunkEvent {
        message_id: Some(MessageId::new("msg-1")),
        role: Some(TextMessageRole::User),
        delta: Some("typed by a human".into()),
        name: Some("ada".into()),
        ..TextMessageChunkEvent::default()
    });

    let events = normalize_all([chunk]).expect("normalizes");
    let Event::TextMessageStart(start) = &events[0] else {
        panic!("expected a start event");
    };
    assert_eq!(start.role, TextMessageRole::User);
    assert_eq!(start.name.as_deref(), Some("ada"));

    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.messages()[0].role(), ag_ui::Role::User);
}

#[test]
fn a_tool_chunk_carries_its_parent_message_onto_the_synthesized_start() {
    let chunk = Event::ToolCallChunk(ToolCallChunkEvent {
        tool_call_id: Some(ToolCallId::new("call-1")),
        tool_call_name: Some("get_weather".into()),
        parent_message_id: Some(MessageId::new("msg-1")),
        delta: Some("{}".into()),
        ..ToolCallChunkEvent::default()
    });

    let events = normalize_all([chunk]).expect("normalizes");
    let Event::ToolCallStart(start) = &events[0] else {
        panic!("expected a tool call start");
    };
    assert_eq!(
        start.parent_message_id.as_ref().map(|id| id.as_str()),
        Some("msg-1")
    );
}

#[test]
fn reasoning_chunks_normalize_the_same_way() {
    let events = normalize_all([
        Event::reasoning_message_chunk(Some(MessageId::new("r-1")), Some("Think".into())),
        Event::reasoning_message_chunk(None, Some("ing".into())),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::ReasoningMessageStart,
            EventType::ReasoningMessageContent,
            EventType::ReasoningMessageContent,
            EventType::ReasoningMessageEnd,
        ]
    );

    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.reasoning_text(&"r-1".into()), Some("Thinking"));
}

#[test]
fn a_chunk_with_no_delta_still_opens_its_message() {
    let events = normalize_all([text_chunk(Some("msg-1"), None)]).expect("normalizes");
    assert_eq!(
        types(&events),
        [EventType::TextMessageStart, EventType::TextMessageEnd]
    );
}

#[test]
fn the_normalizer_reports_whether_a_stream_is_open() {
    let mut normalizer = ChunkNormalizer::new();
    let mut out = Vec::new();

    assert!(!normalizer.is_open());
    normalizer
        .normalize(text_chunk(Some("msg-1"), Some("Hi")), &mut out)
        .expect("normalizes");
    assert!(normalizer.is_open());

    normalizer.finish(&mut out);
    assert!(!normalizer.is_open());
    assert_eq!(
        out.last().map(Event::event_type),
        Some(EventType::TextMessageEnd)
    );
}

#[test]
fn the_applier_also_assembles_raw_chunks_on_its_own() {
    // Normalization is the recommended path, but an applier driven straight
    // from a raw stream must not silently drop the payload.
    let mut applier = Applier::new();
    for event in [
        text_chunk(Some("msg-1"), Some("Hel")),
        text_chunk(None, Some("lo")),
        tool_chunk(Some("call-1"), Some("t"), Some("{}")),
    ] {
        applier.apply(&event).expect("applies");
    }

    assert_eq!(applier.text_of("msg-1"), Some("Hello"));
    let ag_ui::Message::Assistant(assistant) = &applier.messages()[1] else {
        panic!("expected the tool call's message");
    };
    assert_eq!(
        assistant.tool_calls.as_ref().expect("calls")[0]
            .function
            .arguments,
        "{}"
    );
}

#[test]
fn a_tool_result_closes_the_chunk_streamed_call_it_answers() {
    // A chunk-streamed call has no `TOOL_CALL_END` of its own, so the result
    // is the first event that says the call is over. Until this was handled the
    // synthesized end came out *after* the result — a stream both verifiers
    // reject, and whose `TOOL_CALL_RESULT` a `Thread` then discards.
    let events = normalize_all([
        Event::run_started("t", "r"),
        tool_chunk(Some("call-1"), Some("search"), Some("{}")),
        Event::tool_call_result("msg-1", "call-1", "sunny"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::RunFinished,
        ]
    );
    verify_all(&events).expect("the normalized stream should verify");
}

#[test]
fn parallel_chunk_streamed_calls_each_close_before_their_own_result() {
    // What a provider adapter actually emits when the model asks for three
    // tools at once: the calls stream one after another, and the results come
    // back in whatever order the tools finished — here, not the order asked.
    // Every call must be closed before the first result, and each `TOOL_CALL_END`
    // must precede the result that answers it.
    let events = normalize_all([
        Event::run_started("t", "r"),
        tool_chunk(Some("call-1"), Some("search"), Some(r#"{"q":"#)),
        tool_chunk(None, None, Some(r#""seoul"}"#)),
        tool_chunk(Some("call-2"), Some("lookup"), Some("{}")),
        Event::tool_call_result("msg-1", "call-1", "sunny"),
        tool_chunk(Some("call-3"), Some("geocode"), Some("{}")),
        Event::tool_call_result("msg-2", "call-3", "37.5"),
        Event::tool_call_result("msg-3", "call-2", "found"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::ToolCallStart,  // call-1
            EventType::ToolCallArgs,   // {"q":
            EventType::ToolCallArgs,   // "seoul"}
            EventType::ToolCallEnd,    // call-1, closed by call-2 opening
            EventType::ToolCallStart,  // call-2
            EventType::ToolCallArgs,   // {}
            EventType::ToolCallEnd,    // call-2, closed by call-1's result
            EventType::ToolCallResult, // call-1
            EventType::ToolCallStart,  // call-3
            EventType::ToolCallArgs,   // {}
            EventType::ToolCallEnd,    // call-3, closed by its own result
            EventType::ToolCallResult, // call-3
            EventType::ToolCallResult, // call-2
            EventType::RunFinished,
        ]
    );
    verify_all(&events).expect("the normalized stream should verify");

    // The ordering, per call, spelled out: an assertion on the type sequence
    // alone would still pass if the ends came out against the wrong ids.
    for id in ["call-1", "call-2", "call-3"] {
        let end = events
            .iter()
            .position(|event| matches!(event, Event::ToolCallEnd(e) if e.tool_call_id == id))
            .unwrap_or_else(|| panic!("{id} was never closed"));
        let result = events
            .iter()
            .position(|event| matches!(event, Event::ToolCallResult(e) if e.tool_call_id == id))
            .unwrap_or_else(|| panic!("{id} got no result"));
        assert!(
            end < result,
            "{id} was closed at {end}, after its result at {result}"
        );
    }

    // And the arguments survived being split across two chunks.
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    let ag_ui::Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("expected the first call's message");
    };
    assert_eq!(
        assistant.tool_calls.as_ref().expect("calls")[0]
            .function
            .arguments,
        r#"{"q":"seoul"}"#
    );
}

#[test]
fn a_tool_result_closes_a_chunk_streamed_message_too() {
    // The other stream a result can arrive underneath: it may not interleave
    // with an open message either.
    let events = normalize_all([
        Event::run_started("t", "r"),
        Event::tool_call_start("call-1", "search"),
        Event::tool_call_end("call-1"),
        text_chunk(Some("msg-1"), Some("looking")),
        Event::tool_call_result("msg-2", "call-1", "sunny"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallEnd,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::ToolCallResult,
            EventType::RunFinished,
        ]
    );
    verify_all(&events).expect("the normalized stream should verify");
}

#[test]
fn a_tool_result_for_an_explicitly_ended_call_adds_no_terminator() {
    // Nothing is owed when the producer closed the call itself, so the result
    // must not grow a second `TOOL_CALL_END`.
    let events = normalize_all([
        Event::run_started("t", "r"),
        Event::tool_call_start("call-1", "search"),
        Event::tool_call_args("call-1", "{}"),
        Event::tool_call_end("call-1"),
        Event::tool_call_result("msg-1", "call-1", "sunny"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalizes");

    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::ToolCallResult,
            EventType::RunFinished,
        ]
    );
    verify_all(&events).expect("the normalized stream should verify");
}

// ---- subagents ------------------------------------------------------------

#[test]
fn concurrent_subagents_chunk_streams_resolve_within_their_own_stream() {
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let events = normalize_all([
        Event::run_started("t", "r"),
        Event::subagent_started("s1", "researcher"),
        Event::subagent_started("s2", "researcher"),
        tagged(text_chunk(Some("m1"), Some("A ")), "s1"),
        tagged(text_chunk(Some("m2"), Some("B ")), "s2"),
        tagged(text_chunk(None, Some("one")), "s1"),
        tagged(text_chunk(None, Some("two")), "s2"),
        Event::subagent_finished_success("s1"),
        Event::subagent_finished_success("s2"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalizes");

    // Each stream's start and end carry its owner, and neither closed the other.
    let starts: Vec<_> = events
        .iter()
        .filter(|e| e.event_type() == EventType::TextMessageStart)
        .map(|e| e.subagent_run_id().map(|id| id.as_str()))
        .collect();
    assert_eq!(starts, [Some("s1"), Some("s2")]);
    let ends: Vec<_> = events
        .iter()
        .filter(|e| e.event_type() == EventType::TextMessageEnd)
        .map(|e| e.subagent_run_id().map(|id| id.as_str()))
        .collect();
    assert_eq!(ends.len(), 2);
    assert!(ends.contains(&Some("s1")) && ends.contains(&Some("s2")));
    verify_all(&events).expect("the normalized stream should verify");

    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.text_of("m1"), Some("A one"));
    assert_eq!(applier.text_of("m2"), Some("B two"));
}

#[test]
fn an_untagged_chunk_continues_the_parents_stream_or_the_only_one() {
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);

    // The sole open stream belongs to a subagent: an untagged chunk continues it.
    let events = normalize_all([
        tagged(text_chunk(Some("m1"), Some("Hel")), "s1"),
        text_chunk(None, Some("lo")),
    ])
    .expect("normalizes");
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.text_of("m1"), Some("Hello"));

    // The parent's stream wins over a subagent's when both are open.
    let events = normalize_all([
        tagged(text_chunk(Some("m1"), Some("theirs ")), "s1"),
        text_chunk(Some("m2"), Some("mine ")),
        text_chunk(None, Some("too")),
    ])
    .expect("normalizes");
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.text_of("m2"), Some("mine too"));
    assert_eq!(applier.text_of("m1"), Some("theirs "));
}

#[test]
fn an_untagged_chunk_with_several_subagent_streams_open_is_refused() {
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let error = normalize_all([
        tagged(text_chunk(Some("m1"), Some("A")), "s1"),
        tagged(text_chunk(Some("m2"), Some("B")), "s2"),
        text_chunk(None, Some("?")),
    ])
    .expect_err("nothing to resolve the chunk against");
    assert!(error.to_string().contains("several subagents"), "{error}");

    let error = normalize_all([
        tagged(text_chunk(Some("m1"), Some("A")), "s1"),
        tagged(text_chunk(None, Some("?")), "s3"),
    ])
    .expect_err("s3 has nothing open");
    assert!(
        error.to_string().contains("\"s3\" has no message open"),
        "{error}"
    );
}

#[test]
fn a_subagents_tool_result_closes_only_its_own_stream() {
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    let events = normalize_all([
        Event::run_started("t", "r"),
        text_chunk(Some("m1"), Some("parent narrating")),
        tagged(tool_chunk(Some("call-1"), Some("search"), Some("{}")), "s1"),
        tagged(Event::tool_call_result("m2", "call-1", "hit"), "s1"),
        text_chunk(None, Some(" still")),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalizes");
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(
        applier.text_of("m1"),
        Some("parent narrating still"),
        "the subagent's result did not end the parent's message"
    );
    verify_all(&events).expect("the normalized stream should verify");
}

#[test]
fn a_tagged_chunk_naming_another_owners_open_stream_is_a_verifier_complaint_not_a_crossed_message()
{
    let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
    // s2 continues m1, which s1 opened by chunk and never closed.
    let events = normalize_all([
        Event::run_started("t", "r"),
        tagged(text_chunk(Some("m1"), Some("A")), "s1"),
        tagged(text_chunk(Some("m1"), Some("B")), "s2"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalization does not judge ownership");

    // The normalizer took the tag at its word — a second start for m1 under
    // s2 — and the verifier is where that is a complaint.
    let error = verify_all(&events).expect_err("m1 belongs to s1");
    assert!(error.to_string().contains("m1"), "{error}");

    // An untagged result for a subagent's call closes that call's stream and
    // the parent's open message — the result is the parent's — but not the
    // subagent's other stream.
    let events = normalize_all([
        Event::run_started("t", "r"),
        tagged(tool_chunk(Some("c1"), Some("search"), Some("{}")), "s1"),
        // One stream per owner: s1's text closes its call.
        tagged(text_chunk(Some("m1"), Some("child says")), "s1"),
        text_chunk(Some("m2"), Some("parent says")),
        Event::tool_call_result("m3", "c1", "hit"),
        tagged(text_chunk(None, Some(" more")), "s1"),
        Event::run_finished_success("t", "r"),
    ])
    .expect("normalizes");
    let mut applier = Applier::new();
    for event in &events {
        applier.apply(event).expect("applies");
    }
    assert_eq!(applier.text_of("m1"), Some("child says more"));
    assert_eq!(applier.text_of("m2"), Some("parent says"));
    verify_all(&events).expect("the normalized stream should verify");
}
