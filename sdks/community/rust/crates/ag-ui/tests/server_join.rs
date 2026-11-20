//! A client that joins a run in progress ends up holding what a client that
//! read the run from its first event holds.
//!
//! The joiner is this SDK's own client, both ways it is built: the chunk
//! normalizer, the verifier and the applier driven by hand, and a `Thread`
//! whose requested run id is the joined run's.

#![cfg(all(feature = "server", feature = "client"))]

use ag_ui::client::apply::Applier;
use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{ChunkNormalizer, RunEnd, Thread, Verifier};
use ag_ui::server::{OpenEntity, RunProgress};
use ag_ui::{
    AssistantMessage, Event, EventType, Interrupt, JsonObject, Message, PatchOperation,
    ReasoningMessage, RunAgentInput, RunStartedEvent, SubagentStartedEvent, TextMessageRole,
    ToolCall, ToolCallStartEvent,
};
use serde_json::json;

const THREAD: &str = "thread-1";
const RUN: &str = "run-1";

/// The conversation before the run.
fn history() -> Vec<Message> {
    vec![Message::user("u1", "Find me a flight to Lisbon.")]
}

fn call(id: &str, name: &str, parent: &str) -> Event {
    ToolCallStartEvent::new(id, name)
        .with_parent_message_id(parent)
        .into()
}

/// One run with every kind of thing a run opens: a step, a reasoning block
/// and its message, a text message, two tool calls on that message, state,
/// and a subagent that speaks.
fn run() -> Vec<Event> {
    let writer = |event: Event| event.with_subagent_run_id("s1");
    vec![
        Event::run_started(THREAD, RUN),
        Event::state_snapshot(json!({ "step": 0 })),
        Event::step_started("plan"),
        Event::reasoning_start("r1"),
        Event::reasoning_message_start("r1"),
        Event::reasoning_message_content("r1", "The user "),
        Event::reasoning_message_content("r1", "wants a flight."),
        Event::reasoning_message_end("r1"),
        Event::reasoning_end("r1"),
        Event::text_message_start("a1", TextMessageRole::Assistant),
        Event::text_message_content("a1", "Let me "),
        Event::text_message_content("a1", "look."),
        Event::text_message_end("a1"),
        call("c1", "search", "a1"),
        Event::tool_call_args("c1", r#"{"to":"#),
        Event::tool_call_args("c1", r#""LIS"}"#),
        Event::tool_call_end("c1"),
        Event::tool_call_result("t1", "c1", "2 flights"),
        call("c2", "price", "a1"),
        Event::tool_call_args("c2", r#"{"flight":"#),
        Event::tool_call_args("c2", r#""TP1"}"#),
        Event::tool_call_end("c2"),
        Event::tool_call_result("t2", "c2", "120 EUR"),
        Event::state_delta(vec![PatchOperation::replace("/step", 1)]),
        Event::step_finished("plan"),
        Event::subagent_started("s1", "writer"),
        writer(Event::text_message_start("a2", TextMessageRole::Assistant)),
        writer(Event::text_message_content("a2", "TP1 ")),
        writer(Event::text_message_content("a2", "costs 120 EUR.")),
        writer(Event::text_message_end("a2")),
        Event::subagent_finished_success("s1"),
        Event::run_finished_success(THREAD, RUN),
    ]
}

/// The same shapes in the chunked spelling, two lanes at once: the parent's
/// and a subagent's.
fn chunked_run() -> Vec<Event> {
    let searcher = |event: Event| event.with_subagent_run_id("s1");
    let text = |id: Option<&str>, delta: &str| {
        Event::text_message_chunk(id.map(Into::into), Some(delta.to_owned()))
    };
    vec![
        Event::run_started(THREAD, RUN),
        text(Some("a1"), "Hel"),
        text(None, "lo"),
        Event::subagent_started("s1", "searcher"),
        searcher(Event::tool_call_chunk(
            Some("c1".into()),
            Some("search".into()),
            Some(r#"{"q":"#.into()),
        )),
        text(None, " there"),
        searcher(Event::tool_call_chunk(None, None, Some("1}".into()))),
        // Ends the parent's text stream and opens a reasoning one.
        Event::reasoning_message_chunk(Some("r1".into()), Some("Hm".into())),
        Event::reasoning_message_chunk(None, Some("m.".into())),
        // Ends the subagent's call.
        searcher(Event::tool_call_result("t1", "c1", "ok")),
        Event::subagent_finished_success("s1"),
        // Ends the parent's reasoning stream.
        Event::custom("note", json!(1)),
        Event::run_finished_success(THREAD, RUN),
    ]
}

/// Reads `stream` as the client pipeline does — chunks expanded, order
/// verified, events applied — into `applier`. `whole` says the stream is a
/// complete run, which is then checked to have ended as one.
fn read_into(applier: &mut Applier, stream: &[Event], whole: bool) {
    let mut normalizer = ChunkNormalizer::new();
    let mut verifier = Verifier::new();
    let mut explicit = Vec::new();
    let mut take = |explicit: &mut Vec<Event>| {
        for event in explicit.drain(..) {
            verifier
                .verify(&event)
                .unwrap_or_else(|error| panic!("{error}: {event:?}\nin {stream:#?}"));
            applier
                .apply(&event)
                .unwrap_or_else(|error| panic!("{error}: {event:?}"));
        }
    };
    for event in stream {
        normalizer
            .normalize(event.clone(), &mut explicit)
            .unwrap_or_else(|error| panic!("{error}: {event:?}"));
        take(&mut explicit);
    }
    if whole {
        normalizer.finish(&mut explicit);
        take(&mut explicit);
        verifier.finish().expect("the stream is a whole run");
    }
}

/// What a client that holds `holds` has after reading `stream`.
fn read(holds: &[Message], stream: &[Event], whole: bool) -> Applier {
    let mut applier = Applier::new().with_messages(holds.to_vec());
    read_into(&mut applier, stream, whole);
    applier
}

/// The same through a `Thread` that asks for the joined run by its id.
async fn read_as_thread(holds: &[Message], stream: Vec<Event>) -> (Vec<Message>, RunEnd) {
    let mut thread = Thread::<_>::builder(ReplayTransport::new(stream), THREAD)
        .messages(holds.to_vec())
        .build()
        .expect("the held messages have distinct ids");
    thread.set_next_run_id(RUN);
    let report = thread
        .run()
        .expect("nothing is pending")
        .collect_report()
        .await;
    assert_eq!(
        report.diagnostics,
        [],
        "the stream was read without complaint"
    );
    (thread.messages().to_vec(), report.end)
}

fn progress_after(history: &[Message], sent: &[Event]) -> RunProgress {
    let mut progress = RunProgress::new();
    progress.seed(history);
    progress
        .replay(sent)
        .expect("the events were accepted when sent");
    progress
}

/// The ids of what is open, by kind: text messages, tool calls, reasoning
/// messages.
fn open_ids(progress: &RunProgress) -> (Vec<String>, Vec<String>, Vec<String>) {
    let (mut messages, mut calls, mut reasoning) = (Vec::new(), Vec::new(), Vec::new());
    for entity in progress.open() {
        match entity {
            OpenEntity::Message { start, .. } => messages.push(start.message_id.to_string()),
            OpenEntity::ToolCall { start, .. } => calls.push(start.tool_call_id.to_string()),
            OpenEntity::ReasoningMessage { start, .. } => {
                reasoning.push(start.message_id.to_string());
            }
            _ => {}
        }
    }
    (messages, calls, reasoning)
}

/// `sent` without the events of what is still open: what a store holds that
/// keeps a message only once it is complete.
fn without_open(progress: &RunProgress, sent: &[Event]) -> Vec<Event> {
    let (messages, calls, reasoning) = open_ids(progress);
    let named = |ids: &[String], id: &str| ids.iter().any(|open| open == id);
    sent.iter()
        .filter(|event| match event {
            Event::TextMessageStart(e) => !named(&messages, &e.message_id),
            Event::TextMessageContent(e) => !named(&messages, &e.message_id),
            Event::ToolCallStart(e) => !named(&calls, &e.tool_call_id),
            Event::ToolCallArgs(e) => !named(&calls, &e.tool_call_id),
            Event::ReasoningMessageStart(e) => !named(&reasoning, &e.message_id),
            Event::ReasoningMessageContent(e) => !named(&reasoning, &e.message_id),
            _ => true,
        })
        .cloned()
        .collect()
}

/// `messages` with every open entity cut to half of what it holds: the copy
/// a store or a client has when it is behind the run.
fn an_earlier_copy(progress: &RunProgress, mut messages: Vec<Message>) -> Vec<Message> {
    let (open_messages, open_calls, open_reasoning) = open_ids(progress);
    let halve = |text: &mut String| text.truncate(text.len() / 2);
    for message in &mut messages {
        let id = message.id().to_string();
        match message {
            Message::Assistant(assistant) => {
                if open_messages.contains(&id) {
                    assistant.content.iter_mut().for_each(halve);
                }
                for call in assistant.tool_calls.iter_mut().flatten() {
                    if open_calls.contains(&call.id.to_string()) {
                        halve(&mut call.function.arguments);
                    }
                }
            }
            Message::Reasoning(reasoning) if open_reasoning.contains(&id) => {
                halve(&mut reasoning.content);
            }
            _ => {}
        }
    }
    messages
}

/// Joins `run` after its first `sent` events, with each kind of message list
/// a server may supply, and checks the joiner against a reader of the whole
/// run.
async fn join_at_every_event(run: &[Event]) {
    let history = history();
    let whole = read(&history, run, true);
    let (whole_thread, whole_end) = read_as_thread(&history, run.to_vec()).await;
    assert_eq!(whole_thread, whole.messages());
    let subagent_closes = run
        .iter()
        .position(|event| matches!(event, Event::SubagentFinished(_)))
        .expect("the run has a subagent");

    for sent in 1..=run.len() {
        let (before, rest) = run.split_at(sent);
        let progress = progress_after(&history, before);
        // The fold a server that stores events does: the applier's.
        let folded = read(&history, before, false);
        let reasoning_is_open = progress
            .open()
            .any(|entity| matches!(entity, OpenEntity::ReasoningMessage { .. }));
        let as_they_stand = folded.messages().to_vec();
        let left_out = read(&history, &without_open(&progress, before), false);
        let supplied = [
            ("as they stand", as_they_stand.clone()),
            (
                "an earlier copy",
                an_earlier_copy(&progress, as_they_stand.clone()),
            ),
            ("left out", left_out.messages().to_vec()),
        ];
        for (open_entities, messages) in supplied {
            let at = format!("joined after {sent} events, the open entities {open_entities}");
            let carries_reasoning = messages
                .iter()
                .any(|message| matches!(message, Message::Reasoning(_)));
            let prelude = progress
                .prelude()
                .messages(messages)
                .state(folded.state().clone())
                .into_events();
            assert_eq!(prelude[0].event_type(), EventType::RunStarted, "{at}");
            let stream = [prelude.as_slice(), rest].concat();

            // A client that holds nothing.
            let joined = read(&[], &stream, true);
            assert_eq!(joined.messages(), whole.messages(), "{at}");
            assert_eq!(joined.state(), whole.state(), "{at}");
            // A subagent that finished before the join is not restated, and
            // no message carries its lifecycle.
            if sent <= subagent_closes {
                assert_eq!(joined.subagents(), whole.subagents(), "{at}");
            }
            let (as_thread, end) = read_as_thread(&[], stream.clone()).await;
            assert_eq!(as_thread, whole.messages(), "{at}");
            assert_eq!(end, whole_end, "{at}");

            // A client that comes back holding a copy of its own, behind the
            // run: the snapshot replaces it. Reasoning is the exception when
            // the snapshot carries none, which has a test of its own.
            if reasoning_is_open && !carries_reasoning {
                continue;
            }
            let behind = an_earlier_copy(&progress, as_they_stand.clone());
            let rejoined = read(&behind, &stream, true);
            assert_eq!(rejoined.messages(), whole.messages(), "{at}, rejoining");
        }
    }
}

#[tokio::test]
async fn a_client_that_joins_at_any_event_ends_where_a_reader_of_the_whole_run_does() {
    join_at_every_event(&run()).await;
}

#[tokio::test]
async fn the_same_holds_for_a_run_in_the_chunked_spelling() {
    join_at_every_event(&chunked_run()).await;
}

fn sent_until(run: &[Event], last: fn(&Event) -> bool) -> &[Event] {
    let index = run.iter().position(last).expect("the run has the event");
    &run[..=index]
}

fn assistant(id: &str, content: &str, calls: Vec<ToolCall>) -> Message {
    Message::Assistant(AssistantMessage {
        id: id.into(),
        content: Some(content.to_owned()),
        tool_calls: (!calls.is_empty()).then_some(calls),
        ..Default::default()
    })
}

#[test]
fn messages_that_hold_the_open_message_and_messages_that_leave_it_out_give_one_prelude() {
    let run = run();
    let sent = sent_until(
        &run,
        |event| matches!(event, Event::TextMessageContent(e) if e.delta == "Let me "),
    );
    let progress = progress_after(&history(), sent);

    let holds_it = [history(), vec![assistant("a1", "Let me ", vec![])]].concat();
    let reopening = [
        Event::step_started("plan"),
        Event::text_message_start("a1", TextMessageRole::Assistant),
        Event::text_message_content("a1", "Let me "),
    ];

    let prelude = progress.prelude().messages(holds_it).into_events();
    // The message keeps its place and loses its text: the stream says it.
    let emptied = [history(), vec![assistant("a1", "", vec![])]].concat();
    assert_eq!(prelude[1], Event::messages_snapshot(emptied));
    assert_eq!(prelude[2..], reopening);

    let prelude = progress.prelude().messages(history()).into_events();
    assert_eq!(prelude[1], Event::messages_snapshot(history()));
    assert_eq!(prelude[2..], reopening);
}

#[test]
fn an_open_tool_call_is_restated_beside_the_text_and_the_call_that_finished() {
    let run = run();
    let sent = sent_until(
        &run,
        |event| matches!(event, Event::ToolCallArgs(e) if e.delta == r#"{"flight":"#),
    );
    let history = history();
    let progress = progress_after(&history, sent);
    let folded = read(&history, sent, false);

    let prelude = progress.prelude().messages(folded.messages()).into_events();

    let thought = Message::Reasoning(ReasoningMessage {
        id: "r1".into(),
        content: "The user wants a flight.".into(),
        ..Default::default()
    });
    let finished = ToolCall::new("c1", "search", r#"{"to":"LIS"}"#);
    let open = ToolCall::new("c2", "price", "");
    assert_eq!(
        prelude[1],
        Event::messages_snapshot(vec![
            history[0].clone(),
            thought,
            assistant("a1", "Let me look.", vec![finished, open]),
            Message::tool("t1", "c1", "2 flights"),
        ]),
        "what is closed is untouched; the open call has no arguments"
    );
    assert_eq!(
        prelude[2..],
        [
            Event::step_started("plan"),
            call("c2", "price", "a1"),
            Event::tool_call_args("c2", r#"{"flight":"#),
        ]
    );
}

#[test]
fn a_tool_call_that_awaits_its_result_is_not_reopened() {
    let run = run();
    let sent = sent_until(
        &run,
        |event| matches!(event, Event::ToolCallEnd(e) if e.tool_call_id.as_str() == "c1"),
    );
    let history = history();
    let progress = progress_after(&history, sent);
    assert!(
        !progress
            .open()
            .any(|entity| matches!(entity, OpenEntity::ToolCall { .. })),
        "a call that ended is not open"
    );

    let folded = read(&history, sent, false);
    let prelude = progress
        .prelude()
        .messages(folded.messages())
        .state(folded.state().clone())
        .into_events();
    assert_eq!(
        prelude,
        [
            Event::run_started(THREAD, RUN),
            Event::messages_snapshot(folded.messages()),
            Event::state_snapshot(json!({ "step": 0 })),
            Event::step_started("plan"),
        ],
        "the call is in the conversation, whole"
    );

    // The result arrives bare, and the client takes it.
    let stream = [prelude.as_slice(), &run[sent.len()..]].concat();
    let whole = read(&history, &run, true);
    assert_eq!(read(&[], &stream, true).messages(), whole.messages());
}

#[test]
fn an_open_reasoning_block_its_message_and_a_step_are_reopened() {
    let run = run();
    let sent = sent_until(
        &run,
        |event| matches!(event, Event::ReasoningMessageContent(e) if e.delta == "The user "),
    );
    let history = history();
    let progress = progress_after(&history, sent);
    let whole = read(&history, &run, true);
    let reopening = [
        Event::step_started("plan"),
        Event::reasoning_start("r1"),
        Event::reasoning_message_start("r1"),
        Event::reasoning_message_content("r1", "The user "),
    ];
    let joined = |prelude: &[Event]| read(&[], &[prelude, &run[sent.len()..]].concat(), true);

    // The list a server folds from its events holds the reasoning message,
    // partly written, and the snapshot holds it without its content: the
    // rule for an open text message.
    let folded = read(&history, sent, false);
    assert_eq!(folded.reasoning_text(&"r1".into()), Some("The user "));
    let prelude = progress
        .prelude()
        .messages(folded.messages())
        .state(json!({ "step": 0 }))
        .into_events();
    let emptied = Message::Reasoning(ReasoningMessage {
        id: "r1".into(),
        ..Default::default()
    });
    assert_eq!(
        prelude[1],
        Event::messages_snapshot([history.clone(), vec![emptied]].concat())
    );
    assert_eq!(prelude[3..], reopening);
    assert_eq!(joined(&prelude).messages(), whole.messages());

    // A list that leaves it out gives the same events after the snapshot.
    let prelude = progress
        .prelude()
        .messages(history.clone())
        .state(json!({ "step": 0 }))
        .into_events();
    assert_eq!(prelude[1], Event::messages_snapshot(history.clone()));
    assert_eq!(prelude[3..], reopening);
    assert_eq!(joined(&prelude).messages(), whole.messages());
}

#[test]
fn a_client_that_holds_part_of_a_reasoning_message_needs_a_snapshot_that_carries_reasoning() {
    let run = run();
    let sent = sent_until(
        &run,
        |event| matches!(event, Event::ReasoningMessageContent(e) if e.delta == "The user "),
    );
    let history = history();
    let progress = progress_after(&history, sent);
    let whole = read(&history, &run, true);
    // The client was reading, and holds less of the thought than the run
    // has produced.
    let behind = [
        history.clone(),
        vec![Message::Reasoning(ReasoningMessage {
            id: "r1".into(),
            content: "The ".into(),
            ..Default::default()
        })],
    ]
    .concat();
    let rejoined = |messages: Vec<Message>| {
        let prelude = progress
            .prelude()
            .messages(messages)
            .state(json!({ "step": 0 }))
            .into_events();
        read(
            &behind,
            &[prelude.as_slice(), &run[sent.len()..]].concat(),
            true,
        )
    };

    // A list that carries the reasoning message replaces the client's copy.
    let folded = read(&history, sent, false);
    let carried = rejoined(folded.messages().to_vec());
    assert_eq!(carried.messages(), whole.messages());

    // A list that carries no reasoning message says nothing about the
    // client's, which 1.0 has it keep. The restated content lands on the
    // copy it kept: the one case the messages have to cover themselves.
    let silent = rejoined(history.clone());
    assert_eq!(
        silent.reasoning_text(&"r1".into()),
        Some("The The user wants a flight.")
    );
}

#[test]
fn a_chunk_opened_entity_is_reopened_as_a_chunk() {
    let run = chunked_run();
    // The parent's text and the subagent's call are both open, as chunks.
    let sent = &run[..6];
    let progress = progress_after(&[], sent);
    let chunked: Vec<bool> = progress
        .open()
        .filter_map(|entity| match entity {
            OpenEntity::Message { chunked, .. } | OpenEntity::ToolCall { chunked, .. } => {
                Some(*chunked)
            }
            _ => None,
        })
        .collect();
    assert_eq!(chunked, [true, true]);

    let mut text = ag_ui::TextMessageChunkEvent::new(Some("a1".into()), Some("Hello there".into()));
    text.role = Some(TextMessageRole::Assistant);
    let search = Event::tool_call_chunk(
        Some("c1".into()),
        Some("search".into()),
        Some(r#"{"q":"#.into()),
    );
    assert_eq!(
        progress.prelude().into_events(),
        [
            Event::run_started(THREAD, RUN),
            Event::subagent_started("s1", "searcher"),
            text.into(),
            search.with_subagent_run_id("s1"),
        ]
    );
}

#[test]
fn a_message_opened_again_keeps_what_it_held_before() {
    // `a1` closed in an earlier run and this run adds to it.
    let history = vec![Message::assistant("a1", "Lisbon it is.")];
    let sent = [
        Event::run_started(THREAD, RUN),
        Event::text_message_start("a1", TextMessageRole::Assistant),
        Event::text_message_content("a1", " Booking"),
    ];
    let rest = [
        Event::text_message_content("a1", " now."),
        Event::text_message_end("a1"),
        Event::run_finished_success(THREAD, RUN),
    ];
    let progress = progress_after(&history, &sent);
    let folded = read(&history, &sent, false);
    assert_eq!(folded.text_of("a1"), Some("Lisbon it is. Booking"));

    let prelude = progress.prelude().messages(folded.messages()).into_events();
    assert_eq!(
        prelude[1],
        Event::messages_snapshot(history.clone()),
        "only what the run added since the start is taken out"
    );

    let stream = [prelude.as_slice(), rest.as_slice()].concat();
    let joined = read(&[], &stream, true);
    assert_eq!(joined.text_of("a1"), Some("Lisbon it is. Booking now."));
}

#[test]
fn a_snapshot_sent_with_a_message_open_is_where_its_content_starts_again() {
    let start = || Event::text_message_start("a1", TextMessageRole::Assistant);
    let cases = [
        // The snapshot carries the open message, rewritten: a client takes
        // the snapshot's copy and adds what follows to it. Only what followed
        // the snapshot is restated.
        (
            vec![Message::assistant("a1", "Rewritten.")],
            Some("Rewritten. More."),
            vec![
                Event::messages_snapshot(vec![Message::assistant("a1", "Rewritten.")]),
                start(),
                Event::text_message_content("a1", " More"),
            ],
        ),
        // The snapshot leaves it out: a client drops the message and what
        // follows, since a snapshot closes nothing and resurrects nothing. So
        // the joiner is given the message open, and then the snapshot that
        // drops it.
        (
            Vec::new(),
            None,
            vec![start(), Event::messages_snapshot(Vec::new())],
        ),
    ];
    for (snapshot, in_the_end, after_run_started) in cases {
        let run = [
            Event::run_started(THREAD, RUN),
            start(),
            Event::text_message_content("a1", "Hello"),
            Event::messages_snapshot(snapshot),
            Event::text_message_content("a1", " More"),
            Event::text_message_content("a1", "."),
            Event::text_message_end("a1"),
            Event::run_finished_success(THREAD, RUN),
        ];
        let whole = read(&[], &run, true);
        assert_eq!(whole.text_of("a1"), in_the_end);

        let (sent, rest) = run.split_at(5);
        let progress = progress_after(&[], sent);
        let folded = read(&[], sent, false);
        let prelude = progress.prelude().messages(folded.messages()).into_events();
        assert_eq!(prelude[1..], after_run_started);
        let joined = read(&[], &[prelude.as_slice(), rest].concat(), true);
        assert_eq!(joined.messages(), whole.messages());

        // A message list that still holds the message, from a store that
        // kept it, is no different: the message is taken out of it.
        if in_the_end.is_none() {
            let kept = [Message::assistant("a1", "Hello More")];
            let prelude = progress.prelude().messages(kept).into_events();
            assert_eq!(prelude[1..], after_run_started);
        }
    }
}

#[test]
fn a_tool_call_a_snapshot_dropped_while_open_is_dropped_on_the_joiner_too() {
    // The snapshot restates the message without the call that is streaming
    // its arguments: a client holds the message and not the call.
    let run = [
        Event::run_started(THREAD, RUN),
        Event::text_message_start("a1", TextMessageRole::Assistant),
        Event::text_message_content("a1", "Searching."),
        Event::text_message_end("a1"),
        call("c1", "search", "a1"),
        Event::tool_call_args("c1", r#"{"q":"#),
        Event::messages_snapshot(vec![Message::assistant("a1", "Searching.")]),
        Event::tool_call_args("c1", r#""rust"}"#),
        Event::tool_call_end("c1"),
        Event::run_finished_success(THREAD, RUN),
    ];
    let whole = read(&[], &run, true);
    assert_eq!(whole.messages(), [Message::assistant("a1", "Searching.")]);
    for at in 7..run.len() {
        let (sent, rest) = run.split_at(at);
        let progress = progress_after(&[], sent);
        let folded = read(&[], sent, false);
        let prelude = progress.prelude().messages(folded.messages()).into_events();
        let joined = read(&[], &[prelude.as_slice(), rest].concat(), true);
        assert_eq!(joined.messages(), whole.messages(), "joined after {at}");
    }
}

#[test]
fn a_finished_subagent_is_restated_only_as_the_parent_of_an_active_one() {
    let sent = [
        Event::run_started(THREAD, RUN),
        Event::subagent_started("lead", "lead"),
        SubagentStartedEvent::new("scout", "scout")
            .with_parent_subagent("lead")
            .into(),
        Event::subagent_started("done", "other"),
        Event::subagent_finished_success("done"),
        // A parent may finish before its child.
        Event::subagent_finished_success("lead"),
    ];
    let progress = progress_after(&[], &sent);

    let prelude = progress.prelude().into_events();
    assert_eq!(
        prelude,
        [
            sent[0].clone(),
            sent[1].clone(),
            sent[5].clone(),
            sent[2].clone(),
        ],
        "`lead` with its ending, then the scout that names it; `done` is history"
    );

    let rest = [
        Event::subagent_finished_success("scout"),
        Event::run_finished_success(THREAD, RUN),
    ];
    let joined = read(&[], &[prelude.as_slice(), rest.as_slice()].concat(), true);
    let scout = joined.subagent(&"scout".into()).expect("announced");
    assert_eq!(scout.parent_subagent_run_id, Some("lead".into()));
}

#[tokio::test]
async fn on_a_stream_of_several_runs_the_progress_is_that_of_the_run_that_is_open() {
    // One stream, two runs. The first failed with a step and a message open.
    let stream = [
        Event::run_started(THREAD, "run-0"),
        Event::step_started("plan"),
        Event::text_message_start("a0", TextMessageRole::Assistant),
        Event::text_message_content("a0", "Half a sent"),
        Event::run_error("the model went away"),
        Event::run_started(THREAD, RUN),
        Event::step_started("plan"),
        Event::text_message_start("a1", TextMessageRole::Assistant),
        Event::text_message_content("a1", "Second "),
        Event::text_message_content("a1", "try."),
        Event::text_message_end("a1"),
        Event::step_finished("plan"),
        Event::run_finished_success(THREAD, RUN),
    ];
    let whole = read(&[], &stream, true);

    // Between the runs: the first one, what it abandoned and how it ended.
    let between = progress_after(&[], &stream[..5]);
    assert!(between.has_started() && between.has_ended());
    assert_eq!(between.open().count(), 2);
    assert_eq!(between.prelude().into_events(), stream[..5]);

    // The next run starts with nothing open.
    let restarted = progress_after(&[], &stream[..6]);
    assert!(restarted.has_started() && !restarted.has_ended());
    assert_eq!(restarted.open().count(), 0);
    assert_eq!(
        restarted.prelude().into_events(),
        [Event::run_started(THREAD, RUN)]
    );

    // Joined in the second run: its `RUN_STARTED`, the conversation with
    // what the first run left in it, and what the second has open.
    let (sent, rest) = stream.split_at(9);
    let progress = progress_after(&[], sent);
    let folded = read(&[], sent, false);
    let prelude = progress.prelude().messages(folded.messages()).into_events();
    assert_eq!(
        prelude,
        [
            Event::run_started(THREAD, RUN),
            Event::messages_snapshot(vec![
                Message::assistant("a0", "Half a sent"),
                Message::assistant("a1", ""),
            ]),
            Event::step_started("plan"),
            Event::text_message_start("a1", TextMessageRole::Assistant),
            Event::text_message_content("a1", "Second "),
        ]
    );
    let joined = [prelude.as_slice(), rest].concat();
    assert_eq!(read(&[], &joined, true).messages(), whole.messages());
    let (as_thread, end) = read_as_thread(&[], joined).await;
    assert_eq!(as_thread, whole.messages());
    assert_eq!(end, RunEnd::Success { result: None });

    // Once it has ended, the prelude ends with its terminal event.
    let ended = progress_after(&[], &stream);
    assert_eq!(
        ended.prelude().into_events(),
        [
            Event::run_started(THREAD, RUN),
            Event::run_finished_success(THREAD, RUN),
        ]
    );
}

#[tokio::test]
async fn a_run_that_ended_is_joined_with_its_terminal_event() {
    let questions = vec![Interrupt::new("approve", "tool_approval")];
    let sent = [
        Event::run_started(THREAD, RUN),
        Event::text_message_start("a1", TextMessageRole::Assistant),
        Event::text_message_content("a1", "May I book it?"),
        Event::text_message_end("a1"),
        Event::run_finished_interrupt(THREAD, RUN, questions.clone()),
    ];
    let mut progress = RunProgress::new();
    assert!(!progress.has_started() && !progress.has_ended());
    assert_eq!(
        progress.prelude().messages(history()).into_events(),
        [],
        "a run that has not started has nothing to catch up on"
    );
    progress.replay(&sent[..1]).unwrap();
    assert!(progress.has_started() && !progress.has_ended());
    progress.replay(&sent[1..]).unwrap();
    assert!(progress.has_ended());

    let messages = [history(), vec![Message::assistant("a1", "May I book it?")]].concat();
    let prelude = progress.prelude().messages(messages.clone()).into_events();
    assert_eq!(
        prelude,
        [
            sent[0].clone(),
            Event::messages_snapshot(messages.clone()),
            sent[4].clone(),
        ]
    );

    // The joiner learns what the run is waiting for.
    let (held, end) = read_as_thread(&[], prelude).await;
    assert_eq!(held, messages);
    assert_eq!(
        end,
        RunEnd::Interrupted {
            interrupts: questions
        }
    );
}

#[test]
fn a_failed_run_is_joined_with_what_it_abandoned() {
    let sent = [
        Event::run_started(THREAD, RUN),
        Event::text_message_start("a1", TextMessageRole::Assistant),
        Event::text_message_content("a1", "Half a sent"),
        Event::run_error("the model went away"),
    ];
    let progress = progress_after(&[], &sent);
    assert_eq!(progress.prelude().into_events(), sent);

    // A stream that opened with RUN_ERROR never started.
    let failed = [Event::run_error("no such agent")];
    let progress = progress_after(&[], &failed);
    assert!(!progress.has_started() && progress.has_ended());
    assert_eq!(progress.prelude().into_events(), failed);
}

#[test]
fn a_client_that_holds_the_run_up_to_a_point_is_sent_each_start_alone() {
    for run in [run(), chunked_run()] {
        let history = history();
        let whole = read(&history, &run, true);
        for held in 1..run.len() {
            let (before, missed) = run.split_at(held);
            // The client read this far, and its connection dropped.
            let mut client = read(&history, before, false);

            let prelude = progress_after(&history, before)
                .prelude()
                .messages(history.clone())
                .reopen_only()
                .into_events();
            assert!(
                prelude.iter().all(|event| !matches!(
                    event,
                    Event::MessagesSnapshot(_)
                        | Event::TextMessageContent(_)
                        | Event::ToolCallArgs(_)
                        | Event::ReasoningMessageContent(_)
                )),
                "no snapshot and no content: {prelude:?}"
            );

            read_into(&mut client, &[prelude.as_slice(), missed].concat(), true);
            let at = format!("reconnected after {held} events");
            assert_eq!(client.messages(), whole.messages(), "{at}");
            assert_eq!(client.subagents(), whole.subagents(), "{at}");
            assert_eq!(client.state(), whole.state(), "{at}");
        }
    }
}

#[test]
fn nothing_is_sent_that_was_not_asked_for() {
    let mut request = RunAgentInput::new(THREAD, RUN);
    request.messages = history();
    request.state = json!({ "secret": true });
    let mut started = RunStartedEvent::new(THREAD, RUN);
    started.input = Some(Box::new(request.clone()));
    started.parent_run_id = Some("run-0".into());

    let mut metadata = JsonObject::new();
    metadata.insert("trace".into(), json!("abc"));
    let sent = [
        Event::RunStarted(started).with_raw_event(json!({ "provider": "payload" })),
        Event::state_snapshot(json!({ "step": 3 })),
        Event::text_message_start("a1", TextMessageRole::Assistant)
            .with_timestamp(17)
            .with_raw_event(json!({ "provider": "payload" })),
        Event::text_message_content("a1", "Hi").with_metadata(metadata.clone()),
    ];
    let progress = progress_after(&request.messages, &sent);

    let mut restarted = RunStartedEvent::new(THREAD, RUN);
    restarted.parent_run_id = Some("run-0".into());
    let reopened = Event::text_message_start("a1", TextMessageRole::Assistant)
        .with_timestamp(17)
        .with_metadata(metadata);
    let bare = [
        Event::RunStarted(restarted.clone()),
        reopened.clone(),
        Event::text_message_content("a1", "Hi"),
    ];
    assert_eq!(
        progress.prelude().into_events(),
        bare,
        "no input echo, no snapshot, no state, no rawEvent; the metadata so far on the start"
    );

    // Each is there once it is asked for, and the echo holds nothing of
    // what the stream restates.
    request
        .messages
        .push(Message::assistant("a1", "Hi, I am half wr"));
    let asked = progress
        .prelude()
        .echo_input(request.clone())
        .state(json!({ "step": 3 }))
        .into_events();
    let Event::RunStarted(echoed) = &asked[0] else {
        panic!("{asked:?}");
    };
    let echo = echoed.input.as_deref().expect("the echo was asked for");
    assert_eq!(echo.state, request.state);
    assert_eq!(
        echo.messages,
        [history(), vec![Message::assistant("a1", "")]].concat()
    );
    assert_eq!(asked[1], Event::state_snapshot(json!({ "step": 3 })));
    assert_eq!(asked[2..], bare[1..]);
}
