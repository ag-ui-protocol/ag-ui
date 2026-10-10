//! A whole run, applied: start, text deltas, a tool call, state, finish.

#![cfg(feature = "client")]

use ag_ui::client::apply::{
    Applier, Changed, MessageChangeKind, ReasoningChange, ReasoningChangeKind,
};
use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{RunEnd, Thread, Update, verify_all};
use ag_ui::{
    ActivityMessage, Event, JsonObject, Message, PatchOperation, ReasoningEncryptedValueSubtype,
    TextMessageRole, ToolCallId,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;

/// The scripted run every test in this file drives.
fn scripted_run() -> Vec<Event> {
    vec![
        Event::run_started("thread-1", "run-1"),
        Event::step_started("plan"),
        Event::reasoning_start("reason-1"),
        Event::reasoning_message_start("reason-1"),
        Event::reasoning_message_content("reason-1", "The user wants the weather. "),
        Event::reasoning_message_content("reason-1", "I should call the tool."),
        Event::reasoning_message_end("reason-1"),
        Event::reasoning_end("reason-1"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Let me "),
        Event::text_message_content("msg-1", "check."),
        Event::text_message_end("msg-1"),
        Event::tool_call_start("call-1", "get_weather"),
        Event::tool_call_args("call-1", r#"{"city":"#),
        Event::tool_call_args("call-1", r#""Seoul"}"#),
        Event::tool_call_end("call-1"),
        Event::tool_call_result("msg-2", "call-1", r#"{"temp":21}"#),
        Event::state_snapshot(json!({ "city": "Seoul" })),
        Event::state_delta(vec![
            PatchOperation::add("/temperature", json!(21)),
            PatchOperation::replace("/city", json!("Seoul, KR")),
        ]),
        Event::step_finished("plan"),
        Event::run_finished_success("thread-1", "run-1"),
    ]
}

#[test]
fn a_whole_run_assembles_into_messages_and_state() {
    let mut applier = Applier::new();
    for event in scripted_run() {
        applier.apply(&event).expect("every event should apply");
    }

    // Three messages: the reply, the message the parentless tool call opened,
    // and the tool's result. Reasoning is not among them.
    assert_eq!(applier.messages().len(), 3);

    let Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("the first message should be the assistant's");
    };
    assert_eq!(assistant.id, "msg-1");
    assert_eq!(assistant.content.as_deref(), Some("Let me check."));

    // A tool call with no parent message hangs off a message of its own, named
    // after the call because that is the only id available.
    let Message::Assistant(with_call) = &applier.messages()[1] else {
        panic!("the tool call should have opened an assistant message");
    };
    assert_eq!(with_call.id, "call-1-message");
    let calls = with_call.tool_calls.as_ref().expect("tool calls");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call-1");
    assert_eq!(calls[0].function.name, "get_weather");
    assert_eq!(calls[0].function.arguments, r#"{"city":"Seoul"}"#);

    let Message::Tool(result) = &applier.messages()[2] else {
        panic!("the result should be a tool message");
    };
    assert_eq!(result.id, "msg-2");
    assert_eq!(result.tool_call_id, "call-1");
    assert_eq!(result.content.as_text(), Some(r#"{"temp":21}"#));

    assert_eq!(
        applier.state(),
        &json!({ "city": "Seoul, KR", "temperature": 21 })
    );

    assert_eq!(
        applier.reasoning_text(&"reason-1".into()),
        Some("The user wants the weather. I should call the tool.")
    );
    assert_eq!(applier.thread_id().map(|id| id.as_str()), Some("thread-1"));
    assert_eq!(applier.run_id().map(|id| id.as_str()), Some("run-1"));
    assert!(applier.interrupts().is_empty());
}

#[test]
fn the_scripted_run_is_a_valid_stream() {
    verify_all(&scripted_run()).expect("the fixture should not violate the protocol");
}

#[test]
fn a_tool_result_appends_a_tool_message_when_its_id_is_new() {
    let mut applier = Applier::new();
    applier
        .apply(&Event::tool_call_result("msg-9", "call-9", "42"))
        .expect("a result for an unseen call still records the message");

    let Message::Tool(tool) = &applier.messages()[0] else {
        panic!("expected a tool message");
    };
    assert_eq!(tool.id, "msg-9");
    assert_eq!(tool.tool_call_id, "call-9");
    assert_eq!(tool.content.as_text(), Some("42"));
}

#[test]
fn a_tool_call_attaches_to_its_parent_message_when_it_names_one() {
    let mut applier = Applier::new();
    let events = [
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Checking."),
        Event::text_message_end("msg-1"),
        Event::ToolCallStart(ag_ui::ToolCallStartEvent {
            parent_message_id: Some("msg-1".into()),
            ..ag_ui::ToolCallStartEvent::new("call-1", "get_weather")
        }),
    ];
    for event in events {
        applier.apply(&event).expect("applies");
    }

    assert_eq!(applier.messages().len(), 1);
    let Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("expected an assistant message");
    };
    assert_eq!(assistant.content.as_deref(), Some("Checking."));
    assert_eq!(assistant.tool_calls.as_ref().expect("calls").len(), 1);
}

#[test]
fn applying_reports_exactly_what_changed() {
    let mut applier = Applier::new();

    let started = applier
        .apply(&Event::text_message_start(
            "msg-1",
            TextMessageRole::Assistant,
        ))
        .expect("applies");
    assert!(matches!(
        started,
        Changed::Message(change)
            if change.index == 0 && change.kind == MessageChangeKind::Started
    ));

    let content = applier
        .apply(&Event::text_message_content("msg-1", "Hi"))
        .expect("applies");
    let Changed::Message(change) = content else {
        panic!("expected a message change");
    };
    assert_eq!(
        change.kind,
        MessageChangeKind::Content { delta: "Hi".into() }
    );
    assert_eq!(change.id, "msg-1");

    // Steps and passthrough events change nothing a view would redraw.
    assert_eq!(
        applier.apply(&Event::step_started("s")).expect("applies"),
        Changed::Nothing
    );
    assert_eq!(
        applier
            .apply(&Event::custom("anything", json!(1)))
            .expect("applies"),
        Changed::Nothing
    );
}

#[test]
fn a_messages_snapshot_drops_the_turns_it_leaves_out() {
    let mut applier = Applier::new();
    for event in scripted_run() {
        applier.apply(&event).expect("applies");
    }

    let replaced = applier
        .apply(&Event::messages_snapshot(vec![Message::assistant(
            "summary-1",
            "Earlier turns, summarized.",
        )]))
        .expect("applies");

    assert_eq!(replaced, Changed::MessagesReplaced);
    assert_eq!(applier.messages().len(), 1);
    assert_eq!(
        applier.text_of("summary-1"),
        Some("Earlier turns, summarized.")
    );
    // The messages the snapshot dropped are gone from the index too.
    assert!(applier.message(&"msg-1".into()).is_none());
}

#[test]
fn a_messages_snapshot_keeps_activity_the_backend_does_not_track() {
    // Upstream `client/src/apply/default.ts`, MESSAGES_SNAPSHOT: activity
    // messages never travel back to the backend — `prepareRunAgentInput` strips
    // them from `RunAgentInput` — so a backend that does not track them cannot
    // put them in the snapshot, and dropping the local copies would delete a
    // pane of the UI on every summarization.
    let mut applier = Applier::new();
    applier.push_message(Message::Activity(ActivityMessage {
        id: "act-1".into(),
        activity_type: "web_search".into(),
        content: json!({ "query": "weather" })
            .as_object()
            .expect("an object")
            .clone(),
        ..Default::default()
    }));
    applier.push_message(Message::assistant("msg-1", "Checking."));

    applier
        .apply(&Event::messages_snapshot(vec![Message::assistant(
            "msg-1", "Checked.",
        )]))
        .expect("applies");

    let ids: Vec<&str> = applier.messages().iter().map(|m| m.id().as_str()).collect();
    assert_eq!(
        ids,
        ["act-1", "msg-1"],
        "a snapshot carrying no activity leaves the local activity alone"
    );
    assert_eq!(applier.text_of("msg-1"), Some("Checked."));
}

#[test]
fn a_messages_snapshot_that_carries_activity_owns_the_activity_set() {
    // The other half of the same upstream rule: once a snapshot carries any
    // activity, the backend is declaring the complete activity set, so one it
    // leaves out has been deleted. Without this the local copy is undeletable.
    let mut applier = Applier::new();
    for id in ["act-1", "act-2"] {
        applier.push_message(Message::Activity(ActivityMessage {
            id: id.into(),
            activity_type: "web_search".into(),
            content: JsonObject::new(),
            ..Default::default()
        }));
    }

    applier
        .apply(&Event::messages_snapshot(vec![Message::Activity(
            ActivityMessage {
                id: "act-2".into(),
                activity_type: "web_search".into(),
                content: JsonObject::new(),
                ..Default::default()
            },
        )]))
        .expect("applies");

    let ids: Vec<&str> = applier.messages().iter().map(|m| m.id().as_str()).collect();
    assert_eq!(ids, ["act-2"]);
}

#[test]
fn a_messages_snapshot_keeps_the_order_the_client_already_had() {
    // Upstream rebuilds the list by filtering the *local* one and appending
    // whatever the snapshot adds, so a backend that reorders its own history
    // does not reshuffle the transcript under the user.
    let mut applier = Applier::new();
    applier.push_message(Message::assistant("msg-1", "first"));
    applier.push_message(Message::assistant("msg-2", "second"));

    applier
        .apply(&Event::messages_snapshot(vec![
            Message::assistant("msg-2", "second"),
            Message::assistant("msg-1", "first"),
            Message::assistant("msg-3", "third"),
        ]))
        .expect("applies");

    let ids: Vec<&str> = applier.messages().iter().map(|m| m.id().as_str()).collect();
    assert_eq!(ids, ["msg-1", "msg-2", "msg-3"]);
    // And the index still points at the right rows after the rebuild.
    assert_eq!(applier.text_of("msg-3"), Some("third"));
}

#[tokio::test]
async fn a_bare_run_error_over_open_entities_ends_the_run_without_a_protocol_complaint() {
    // The shape a peer server actually sends when an agent blows up: no
    // terminators for anything it had open, just RUN_ERROR. Upstream's verifier
    // allows it explicitly — `client/src/verify/verify.ts`, `case
    // EventType.RUN_ERROR: // RUN_ERROR can happen at any time` — and the
    // Python integrations yield exactly this out of an `except` block. A
    // message, a chunk-streamed call and a step are all left hanging here.
    let transport = ReplayTransport::new(vec![
        Event::run_started("thread-1", "run-1"),
        Event::step_started("plan"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "half a sen"),
        Event::tool_call_chunk(
            Some(ToolCallId::new("call-1")),
            Some("get_weather".into()),
            Some(r#"{"city":"#.into()),
        ),
        Event::run_error("the model hung up"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");

    let updates: Vec<_> = thread.send("what is the weather?").unwrap().collect().await;
    let complaints: Vec<String> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect();

    // Exactly one error, and it is the agent's — not an ordering complaint
    // about the message and call the failure abandoned.
    assert_eq!(complaints.len(), 1, "{complaints:?}");
    assert!(
        complaints[0].contains("the model hung up"),
        "{complaints:?}"
    );

    let Some(Update::Done(RunEnd::Failed { message, .. })) = updates.last() else {
        panic!("the run should end as failed: {updates:?}");
    };
    assert!(message.contains("the model hung up"), "{message}");

    // The half-finished text still assembled, so a UI can show what there was.
    assert_eq!(thread.applier().text_of("msg-1"), Some("half a sen"));
}

#[test]
fn an_encrypted_reasoning_blob_attaches_to_its_entity() {
    let mut applier = Applier::new();
    for event in [
        Event::reasoning_message_start("reason-1"),
        Event::reasoning_message_content("reason-1", "…"),
        Event::tool_call_start("call-1", "get_weather"),
    ] {
        applier.apply(&event).expect("applies");
    }

    applier
        .apply(&Event::reasoning_encrypted_value(
            ReasoningEncryptedValueSubtype::Message,
            "reason-1",
            "opaque-blob",
        ))
        .expect("applies");
    applier
        .apply(&Event::reasoning_encrypted_value(
            ReasoningEncryptedValueSubtype::ToolCall,
            "call-1",
            "call-blob",
        ))
        .expect("applies");

    assert_eq!(
        applier.reasoning()[0].encrypted_value.as_deref(),
        Some("opaque-blob")
    );
    let Message::Assistant(assistant) = &applier.messages()[0] else {
        panic!("expected an assistant message");
    };
    let call = &assistant.tool_calls.as_ref().expect("calls")[0];
    assert_eq!(call.encrypted_value.as_deref(), Some("call-blob"));
}

/// One reasoning change, short enough to compare a whole run against.
fn thought(id: &str, kind: ReasoningChangeKind) -> Changed {
    Changed::Reasoning(ReasoningChange {
        id: id.into(),
        kind,
    })
}

/// `ctx.think()` on the server emits `REASONING_MESSAGE_END` *and*
/// `REASONING_END`, and opens with the matching pair — four events bracketing
/// one thought. The applier reports the lifecycle rather than the framing, so a
/// consumer that draws a finished thought draws it once.
#[test]
fn a_thought_starts_and_ends_once_however_it_is_bracketed() {
    let mut applier = Applier::new();
    let changes: Vec<Changed> = [
        Event::reasoning_start("reason-1"),
        Event::reasoning_message_start("reason-1"),
        Event::reasoning_message_content("reason-1", "hmm"),
        Event::reasoning_message_end("reason-1"),
        Event::reasoning_end("reason-1"),
    ]
    .iter()
    .map(|event| applier.apply(event).expect("applies"))
    .collect();

    assert_eq!(
        changes,
        [
            thought("reason-1", ReasoningChangeKind::Started),
            Changed::Nothing,
            thought(
                "reason-1",
                ReasoningChangeKind::Content {
                    delta: "hmm".to_owned()
                }
            ),
            thought("reason-1", ReasoningChangeKind::Ended),
            Changed::Nothing,
        ]
    );
    assert_eq!(applier.reasoning_text(&"reason-1".into()), Some("hmm"));
}

/// The other half of that: collapsing the duplicate must not collapse two
/// *different* thoughts. A block holding two messages ends three things — each
/// message, then the block — and every one of them is somebody's redraw.
#[test]
fn every_reasoning_message_in_a_block_ends_on_its_own() {
    let mut applier = Applier::new();
    let changes: Vec<Changed> = [
        Event::reasoning_start("block-1"),
        Event::reasoning_message_start("msg-1"),
        Event::reasoning_message_content("msg-1", "first"),
        Event::reasoning_message_end("msg-1"),
        Event::reasoning_message_start("msg-2"),
        Event::reasoning_message_content("msg-2", "second"),
        Event::reasoning_message_end("msg-2"),
        Event::reasoning_end("block-1"),
    ]
    .iter()
    .map(|event| applier.apply(event).expect("applies"))
    .collect();

    let endings: Vec<&Changed> = changes
        .iter()
        .filter(|changed| {
            matches!(
                changed,
                Changed::Reasoning(ReasoningChange {
                    kind: ReasoningChangeKind::Ended,
                    ..
                })
            )
        })
        .collect();
    assert_eq!(
        endings,
        [
            &thought("msg-1", ReasoningChangeKind::Ended),
            &thought("msg-2", ReasoningChangeKind::Ended),
            &thought("block-1", ReasoningChangeKind::Ended),
        ]
    );
    assert_eq!(applier.reasoning_text(&"msg-2".into()), Some("second"));
}

#[test]
fn an_activity_snapshot_becomes_a_message_and_a_delta_patches_it() {
    let mut applier = Applier::new();
    let mut content = ag_ui::JsonObject::new();
    content.insert("query".into(), json!("weather"));
    content.insert("status".into(), json!("running"));

    applier
        .apply(&Event::activity_snapshot("act-1", "web_search", content))
        .expect("applies");
    applier
        .apply(&Event::activity_delta(
            "act-1",
            "web_search",
            vec![PatchOperation::replace("/status", json!("done"))],
        ))
        .expect("applies");

    let Message::Activity(activity) = &applier.messages()[0] else {
        panic!("expected an activity message");
    };
    assert_eq!(activity.activity_type, "web_search");
    assert_eq!(activity.content["status"], json!("done"));
    assert_eq!(activity.content["query"], json!("weather"));
}

/// The typed state a client would declare.
///
/// `temperature` is optional because the agent publishes the city first and the
/// temperature in a later delta: a strict field would make the intermediate
/// state fail to deserialize, which the thread reports as an error. See
/// `state.rs` for that path.
#[derive(Debug, Deserialize, Clone, PartialEq)]
struct Weather {
    city: String,
    #[serde(default)]
    temperature: Option<i64>,
}

/// What a consumer of [`Thread`] actually sees for one thought: opened once,
/// two deltas, closed once. The scripted run brackets it with all four
/// `REASONING_*` events, as `ctx.think()` does.
#[tokio::test]
async fn a_thread_reports_one_ending_per_thought() {
    let transport = ReplayTransport::new(scripted_run()).matching_requests();
    let mut thread = Thread::<_, Weather>::builder(transport, "thread-1")
        .state(json!({"city": "", "temperature": 0}))
        .build()
        .unwrap();

    let mut reasoning = Vec::new();
    let mut run = thread.send("what is the weather in Seoul?").unwrap();
    while let Some(update) = run.next().await {
        if let Update::Reasoning(update) = update {
            reasoning.push((update.id.as_str().to_owned(), update.change));
        }
    }
    drop(run);

    assert_eq!(
        reasoning,
        [
            ("reason-1".to_owned(), ReasoningChangeKind::Started),
            (
                "reason-1".to_owned(),
                ReasoningChangeKind::Content {
                    delta: "The user wants the weather. ".to_owned()
                }
            ),
            (
                "reason-1".to_owned(),
                ReasoningChangeKind::Content {
                    delta: "I should call the tool.".to_owned()
                }
            ),
            ("reason-1".to_owned(), ReasoningChangeKind::Ended),
        ]
    );
}

#[tokio::test]
async fn a_thread_yields_updates_and_keeps_the_conversation() {
    let transport = ReplayTransport::new(scripted_run()).matching_requests();
    let mut thread = Thread::<_, Weather>::builder(transport.clone(), "thread-1")
        .state(json!({"city": "", "temperature": 0}))
        .build()
        .unwrap();

    let mut messages = 0;
    let mut reasoning = 0;
    let mut state = None;
    let mut ended = None;
    let mut errors = Vec::new();

    let mut run = thread.send("what is the weather in Seoul?").unwrap();
    while let Some(update) = run.next().await {
        match update {
            Update::Message(_) => messages += 1,
            Update::Reasoning(_) => reasoning += 1,
            Update::State(value) => state = Some(value),
            Update::Done(end) => ended = Some(end),
            Update::Error(error) => errors.push(error.to_string()),
            _ => {}
        }
    }
    drop(run);

    assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    assert!(matches!(ended, Some(RunEnd::Success { .. })));
    assert!(messages > 0);
    assert!(reasoning > 0);

    // The typed state is the last one that deserialized.
    assert_eq!(
        state,
        Some(Weather {
            city: "Seoul, KR".into(),
            temperature: Some(21),
        })
    );
    assert_eq!(Some(thread.state().unwrap()), state.as_ref());

    // The user's turn plus the three messages the agent produced.
    assert_eq!(thread.messages().len(), 4);
    assert_eq!(thread.messages()[0].role(), ag_ui::Role::User);

    // And the request carried the user's message.
    let request = transport.last_request().expect("one request");
    assert_eq!(request.thread_id, "thread-1");
    assert!(!request.run_id.as_str().is_empty());
    assert_eq!(request.messages.len(), 1);
}

#[tokio::test]
async fn a_chunk_streamed_tool_call_keeps_its_result_in_the_conversation() {
    // The whole cost of the normalizer letting a result overtake the
    // `TOOL_CALL_END` it owes: the verifier rejects the out-of-order result,
    // a rejected event is not applied, and the tool message is gone from the
    // conversation the next run carries — with the run still reported a
    // success. This is the normal path for every chunk-streaming adapter.
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::tool_call_chunk(
                Some(ToolCallId::new("call-1")),
                Some("get_weather".into()),
                Some(r#"{"city":"Seoul"}"#.into()),
            ),
            Event::tool_call_result("msg-2", "call-1", r#"{"temp":21}"#),
            Event::run_finished_success("thread-1", "run-1"),
        ],
        vec![
            Event::run_started("thread-1", "run-2"),
            Event::run_finished_success("thread-1", "run-2"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport.clone(), "thread-1");

    let updates: Vec<_> = thread.send("what is the weather?").unwrap().collect().await;
    let errors: Vec<_> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .collect();
    assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    assert!(matches!(
        updates.last(),
        Some(Update::Done(RunEnd::Success { .. }))
    ));

    // The user's turn, the message the call hangs off, and the result.
    assert_eq!(thread.messages().len(), 3);
    let Some(Message::Tool(result)) = thread.messages().last() else {
        panic!(
            "the tool result should be in the conversation: {:?}",
            thread.messages()
        );
    };
    assert_eq!(result.tool_call_id, "call-1");
    assert_eq!(result.content.as_text(), Some(r#"{"temp":21}"#));

    // And the next run carries it, which is what lets the model see its own
    // tool's answer.
    let mut second = thread.send("and tomorrow?").unwrap();
    while second.next().await.is_some() {}
    drop(second);
    let request = transport.last_request().expect("a second request");
    assert!(
        request
            .messages
            .iter()
            .any(|message| matches!(message, Message::Tool(tool) if tool.tool_call_id == "call-1")),
        "the tool result should be sent back to the agent: {:?}",
        request.messages
    );
}

#[tokio::test]
async fn a_second_run_carries_the_first_run_s_history_and_state() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::text_message_start("msg-1", TextMessageRole::Assistant),
            Event::text_message_content("msg-1", "First."),
            Event::text_message_end("msg-1"),
            Event::state_snapshot(json!({ "turn": 1 })),
            Event::run_finished_success("thread-1", "run-1"),
        ],
        vec![
            Event::run_started("thread-1", "run-2"),
            Event::text_message_start("msg-2", TextMessageRole::Assistant),
            Event::text_message_content("msg-2", "Second."),
            Event::text_message_end("msg-2"),
            Event::run_finished_success("thread-1", "run-2"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport.clone(), "thread-1");

    let mut first = thread.send("one").unwrap();
    while first.next().await.is_some() {}
    drop(first);

    let mut second = thread.send("two").unwrap();
    while second.next().await.is_some() {}
    drop(second);

    let requests = transport.requests();
    assert_eq!(requests.len(), 2);
    // user, assistant, user
    assert_eq!(requests[1].messages.len(), 3);
    assert_eq!(requests[1].state, json!({ "turn": 1 }));
    assert_ne!(requests[1].run_id, requests[0].run_id);
    assert!(requests[1].resume.is_none());

    assert_eq!(thread.messages().len(), 4);
}

#[tokio::test]
async fn a_run_error_ends_the_stream_with_the_failure() {
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::RunError(ag_ui::RunErrorEvent::new("model unavailable").with_code("503")),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");

    let updates: Vec<_> = thread.send("hi").unwrap().collect().await;
    let last = updates.last().expect("at least one update");
    assert!(matches!(
        last,
        Update::Done(RunEnd::Failed { message, code })
            if message == "model unavailable" && code.as_deref() == Some("503")
    ));
    assert!(
        updates
            .iter()
            .any(|update| matches!(update, Update::Error(_)))
    );
}

#[tokio::test]
async fn a_truncated_stream_is_reported_rather_than_looking_like_a_short_answer() {
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
        Event::text_message_content("msg-1", "Half a sen"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");

    let updates: Vec<_> = thread.send("hi").unwrap().collect().await;
    let complaint = updates
        .iter()
        .filter_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .next()
        .expect("a truncated stream should be reported");
    assert!(
        complaint.contains("ended before RUN_FINISHED"),
        "unexpected error: {complaint}"
    );
    // What did arrive is still there.
    assert_eq!(thread.applier().text_of("msg-1"), Some("Half a sen"));

    // And the run said it was over. A view that re-enables its input on `Done`
    // was otherwise left disabled by a dropped connection — the commonest way
    // a run fails, and the one nobody sees in a test against a scripted
    // transport that always plays to the end.
    let Some(Update::Done(RunEnd::Failed { message, .. })) = updates.last() else {
        panic!("a truncated run must still end with Done: {updates:?}");
    };
    assert!(message.contains("ended before RUN_FINISHED"), "{message}");
}

#[tokio::test]
async fn a_truncated_stream_marks_the_message_aborted() {
    // The local view must stop its typing indicator without claiming successful completion.
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::text_message_chunk(
            Some(ag_ui::MessageId::new("msg-1")),
            Some("Half a sen".into()),
        ),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");

    let updates: Vec<_> = thread.send("hi").unwrap().collect().await;
    assert!(
        updates.iter().any(|update| matches!(
            update,
            Update::Message(message) if message.change == MessageChangeKind::Aborted
        )),
        "the streamed message should have been closed: {updates:?}"
    );
    assert!(matches!(updates.last(), Some(Update::Done(_))));
}

#[tokio::test]
async fn a_transport_that_breaks_mid_run_still_ends_the_run() {
    // The replay script runs out, so the second run's transport fails to
    // connect: an error item in the stream rather than a truncated body.
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport, "thread-1");
    thread.send("hi").unwrap().collect::<Vec<_>>().await;

    let updates: Vec<_> = thread.send("again").unwrap().collect().await;
    assert!(
        updates
            .iter()
            .any(|update| matches!(update, Update::Error(_))),
        "the transport failure should be reported: {updates:?}"
    );
    let Some(Update::Done(RunEnd::Failed { message, .. })) = updates.last() else {
        panic!("a broken transport must still end the run: {updates:?}");
    };
    assert!(!message.is_empty(), "the failure should say something");
}

#[tokio::test]
async fn a_truncated_stream_ends_the_run_even_with_verification_off() {
    // With no verifier there is nothing to notice the truncation, but the run
    // is over either way and a caller that is never told waits forever.
    // Verification off buys a producer's quirks, not silence about a dead run:
    // `RunEnd::Failed` promises the matching `Update::Error` came first, and
    // that has to hold on this path too.
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::text_message_start("msg-1", TextMessageRole::Assistant),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::builder(transport, "thread-1")
        .verify(false)
        .build()
        .unwrap();

    let updates: Vec<_> = thread.send("hi").unwrap().collect().await;
    let complaint = updates
        .iter()
        .find_map(|update| match update {
            Update::Error(error) => Some(error.to_string()),
            _ => None,
        })
        .expect("the truncation should be reported without a verifier too");
    assert!(
        complaint.contains("ended before RUN_FINISHED"),
        "unexpected error: {complaint}"
    );
    let Some(Update::Done(RunEnd::Failed { message, .. })) = updates.last() else {
        panic!("a truncated run must still end with Done: {updates:?}");
    };
    assert_eq!(message, &complaint, "the two should say the same thing");
}

#[tokio::test]
async fn a_thread_can_be_seeded_with_history_and_run_without_a_new_message() {
    let transport = ReplayTransport::new([
        Event::run_started("thread-1", "run-1"),
        Event::run_finished_success("thread-1", "run-1"),
    ])
    .matching_requests();
    let mut thread = Thread::<_>::builder(transport.clone(), "thread-1")
        .messages(vec![
            Message::user("u-1", "earlier"),
            Message::assistant("a-1", "earlier reply"),
        ])
        .state(json!({ "seeded": true }))
        .build()
        .unwrap();

    thread
        .push_message(Message::tool("t-1", "call-1", "42"))
        .unwrap();
    let mut run = thread.run().unwrap();
    while run.next().await.is_some() {}
    drop(run);

    let request = transport.last_request().expect("one request");
    assert_eq!(request.messages.len(), 3);
    assert_eq!(request.state, json!({ "seeded": true }));
}

#[test]
fn a_tool_call_argument_delta_for_an_unknown_call_is_an_error() {
    let mut applier = Applier::new();
    let error = applier
        .apply(&Event::tool_call_args(ToolCallId::new("nope"), "{}"))
        .expect_err("there is nowhere to put the arguments");
    assert!(error.to_string().contains("unknown tool call"));
}
