//! Reasoning as a message of the conversation.
//!
//! AG-UI 1.0 assembles `REASONING_MESSAGE_*` into a `reasoning`-role message
//! "in history, alongside the answer it preceded". So it is in
//! `messages()`, where it arrived; it goes back to the agent with the rest,
//! its `encryptedValue` unmodified; and `MESSAGES_SNAPSHOT` has a rule for it.
//! The span around it, `REASONING_START` to `REASONING_END`, opens no message.

#![cfg(feature = "client")]

use ag_ui::client::apply::{Applier, Changed, ReasoningChange, ReasoningChangeKind};
use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{RunEnd, Thread, ThreadSnapshot, Update};
use ag_ui::{
    ActivityMessage, AssistantMessage, Event, JsonObject, Message, ReasoningEncryptedValueSubtype,
    ReasoningMessage, Role, TextMessageRole, ToolCall,
};
use futures_util::StreamExt;
use serde_json::json;

fn reasoning(id: &str, content: &str) -> Message {
    Message::Reasoning(ReasoningMessage {
        id: id.into(),
        content: content.to_owned(),
        ..Default::default()
    })
}

fn encrypted(id: &str, content: &str, value: &str) -> Message {
    Message::Reasoning(ReasoningMessage {
        id: id.into(),
        content: content.to_owned(),
        encrypted_value: Some(value.to_owned()),
        ..Default::default()
    })
}

fn activity(id: &str) -> Message {
    Message::Activity(ActivityMessage {
        id: id.into(),
        activity_type: "search".to_owned(),
        content: JsonObject::new(),
        ..Default::default()
    })
}

fn ids(messages: &[Message]) -> Vec<&str> {
    messages
        .iter()
        .map(|message| message.id().as_str())
        .collect()
}

fn roles(messages: &[Message]) -> Vec<Role> {
    messages.iter().map(Message::role).collect()
}

fn success() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
    ]
}

/// The shape upstream streams: a span under one id around a message under
/// another, then the answer.
fn thought_then_answer() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::reasoning_start("span-1"),
        Event::reasoning_message_start("think-1"),
        Event::reasoning_message_content("think-1", "weighing "),
        Event::reasoning_message_content("think-1", "the options"),
        Event::reasoning_message_end("think-1"),
        Event::reasoning_end("span-1"),
        Event::text_message_start("answer-1", TextMessageRole::Assistant),
        Event::text_message_content("answer-1", "the answer"),
        Event::text_message_end("answer-1"),
        Event::run_finished_success("t", "r"),
    ]
}

// ---- a span and a message --------------------------------------------------

#[test]
fn a_span_opens_no_message_and_the_message_inside_it_joins_the_conversation() {
    let mut applier = Applier::new();
    let changes: Vec<Changed> = thought_then_answer()
        .iter()
        .map(|event| applier.apply(event).expect("applies"))
        .collect();

    // Two messages, the reasoning before the answer it preceded, and nothing
    // under the span's id.
    assert_eq!(
        applier.messages(),
        [
            reasoning("think-1", "weighing the options"),
            Message::assistant("answer-1", "the answer"),
        ]
    );
    assert!(applier.message(&"span-1".into()).is_none());

    // The span reports nothing, at either end.
    assert_eq!(changes[1], Changed::Nothing, "REASONING_START");
    assert_eq!(changes[6], Changed::Nothing, "REASONING_END");

    // The message reports each change once, with its place in the list.
    let thought = |kind| Changed::Reasoning(ReasoningChange::new(0, "think-1", kind));
    let content = |delta: &str| ReasoningChangeKind::Content {
        delta: delta.to_owned(),
    };
    assert_eq!(
        changes[2..6],
        [
            thought(ReasoningChangeKind::Started),
            thought(content("weighing ")),
            thought(content("the options")),
            thought(ReasoningChangeKind::Ended),
        ]
    );
}

#[tokio::test]
async fn a_thread_announces_reasoning_as_reasoning_and_says_where_it_is() {
    let transport = ReplayTransport::new(thought_then_answer()).matching_requests();
    let mut thread = Thread::new(transport, "t");

    let mut heard = Vec::new();
    let mut as_messages = Vec::new();
    let mut run = thread
        .send_message(Message::user("user-1", "why?"))
        .unwrap();
    while let Some(update) = run.next().await {
        match update {
            Update::Reasoning(update) => {
                heard.push((update.index, update.id.to_string(), update.text));
            }
            Update::Message(update) => as_messages.push(update.id.to_string()),
            Update::Error(error) => panic!("{error}"),
            _ => {}
        }
    }
    let report = run.collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });

    // One update per change to the message, each with the index a view
    // looks it up by. The span's id is never announced.
    let at = |text: &str| (1, "think-1".to_owned(), text.to_owned());
    assert_eq!(
        heard,
        [
            at(""),
            at("weighing "),
            at("weighing the options"),
            at("weighing the options"),
        ]
    );
    // And never a second time as a message update.
    assert!(
        as_messages.iter().all(|id| id == "answer-1"),
        "{as_messages:?}"
    );

    let expected = [
        Message::user("user-1", "why?"),
        reasoning("think-1", "weighing the options"),
        Message::assistant("answer-1", "the answer"),
    ];
    assert_eq!(thread.messages(), expected);
    assert_eq!(report.new_messages, expected);
    assert_eq!(
        thread.reasoning().collect::<Vec<_>>(),
        [&ReasoningMessage {
            id: "think-1".into(),
            content: "weighing the options".to_owned(),
            ..Default::default()
        }]
    );
    // The one-line filter that draws the conversation without the reasoning.
    let drawn: Vec<&Message> = thread
        .messages()
        .iter()
        .filter(|message| message.role() != Role::Reasoning)
        .collect();
    assert_eq!(drawn, [&expected[0], &expected[2]]);
}

#[test]
fn an_id_names_one_message_whichever_family_opens_it() {
    // 1.0: a messageId is unique within its thread. A producer that uses one
    // id for its reasoning and for the reply that follows gets one message,
    // which the later opener continues, as the reference client gives it.
    let mut applier = Applier::new();
    for event in [
        Event::reasoning_message_start("m-1"),
        Event::reasoning_message_content("m-1", "a thought"),
        Event::reasoning_message_end("m-1"),
        Event::text_message_start("m-1", TextMessageRole::Assistant),
        Event::text_message_content("m-1", ", then the reply"),
        Event::text_message_end("m-1"),
    ] {
        applier.apply(&event).expect("applies");
    }
    assert_eq!(
        applier.messages(),
        [reasoning("m-1", "a thought, then the reply")]
    );

    // The other way round: the reply holds the id, and takes the reasoning.
    let mut applier = Applier::new().with_messages(vec![Message::assistant("m-2", "the reply")]);
    let changed = applier
        .apply(&Event::reasoning_message_content("m-2", ", then a thought"))
        .expect("applies");
    assert_eq!(
        applier.messages(),
        [Message::assistant("m-2", "the reply, then a thought")]
    );
    assert!(
        matches!(
            changed,
            Changed::Reasoning(ReasoningChange { index: 0, .. })
        ),
        "{changed:?}"
    );
    assert_eq!(applier.reasoning().count(), 0);
}

// ---- the encrypted value ---------------------------------------------------

#[tokio::test]
async fn an_encrypted_value_goes_back_unmodified_with_every_later_run() {
    // Opaque: not a format the client may read, trim or normalise.
    let value = "  b3BhcXVl+/==\n";
    let call_value = "Y2FsbA==";
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::reasoning_start("span-1"),
            Event::reasoning_message_start("think-1"),
            Event::reasoning_message_content("think-1", "weighing the options"),
            Event::reasoning_message_end("think-1"),
            // After the message closed, where 1.0 draws it: the value names
            // a message, not an open stream.
            Event::reasoning_encrypted_value(
                ReasoningEncryptedValueSubtype::Message,
                "think-1",
                value,
            ),
            Event::reasoning_end("span-1"),
            Event::tool_call_start("call-1", "lookup"),
            Event::tool_call_args("call-1", "{}"),
            Event::tool_call_end("call-1"),
            Event::reasoning_encrypted_value(
                ReasoningEncryptedValueSubtype::ToolCall,
                "call-1",
                call_value,
            ),
            Event::tool_call_result("result-1", "call-1", "42"),
            Event::text_message_start("answer-1", TextMessageRole::Assistant),
            Event::text_message_content("answer-1", "the answer"),
            Event::text_message_end("answer-1"),
            Event::run_finished_success("t", "r"),
        ],
        success(),
        success(),
    ])
    .matching_requests();

    let mut thread = Thread::new(transport.clone(), "t");
    for (id, text) in [("user-1", "one"), ("user-2", "two")] {
        let report = thread
            .send_message(Message::user(id, text))
            .unwrap()
            .collect_report()
            .await;
        assert_eq!(report.end, RunEnd::Success { result: None });
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }

    // Stored with the message it names.
    let thought = encrypted("think-1", "weighing the options", value);
    assert_eq!(thread.messages()[1], thought);

    // A saved thread keeps it too, and the thread restored from it sends it.
    let saved = serde_json::to_string(&thread.snapshot()).unwrap();
    let mut restored =
        Thread::<_>::restore(transport.clone(), serde_json::from_str(&saved).unwrap()).unwrap();
    let report = restored
        .send_message(Message::user("user-3", "three"))
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });

    let requests = transport.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(ids(&requests[0].messages), ["user-1"]);
    let history = [
        "user-1",
        "think-1",
        "call-1-message",
        "result-1",
        "answer-1",
    ];
    assert_eq!(
        ids(&requests[1].messages),
        [&history[..], &["user-2"][..]].concat()
    );
    assert_eq!(
        ids(&requests[2].messages),
        [&history[..], &["user-2", "user-3"][..]].concat()
    );
    for request in &requests[1..] {
        // In its place, and as it was received.
        assert_eq!(request.messages[1], thought);
        let wire = serde_json::to_value(request).unwrap();
        assert_eq!(
            wire["messages"][1],
            json!({
                "role": "reasoning",
                "id": "think-1",
                "content": "weighing the options",
                "encryptedValue": value,
            })
        );
        assert_eq!(
            wire["messages"][2]["toolCalls"][0]["encryptedValue"],
            call_value
        );
    }
}

#[test]
fn an_encrypted_value_is_stored_only_where_something_can_hold_it() {
    let mut applier = Applier::new().with_messages(vec![
        activity("activity-1"),
        Message::assistant("answer-1", "the answer"),
        reasoning("think-1", "hm"),
    ]);
    let before = applier.messages().to_vec();
    let value = |id: &str| {
        Event::reasoning_encrypted_value(ReasoningEncryptedValueSubtype::Message, id, "opaque")
    };

    // An id nothing has, and an activity, which has no field for it: nothing
    // is stored, nothing is created, and the run is not failed over it.
    for id in ["nobody", "activity-1"] {
        assert_eq!(
            applier.apply(&value(id)).expect("tolerated"),
            Changed::Nothing
        );
        assert_eq!(applier.messages(), before);
    }

    // A reasoning message says so as reasoning; any other message as itself.
    assert_eq!(
        applier.apply(&value("think-1")).expect("applies"),
        Changed::Reasoning(ReasoningChange::new(
            2,
            "think-1",
            ReasoningChangeKind::EncryptedValue
        ))
    );
    assert_eq!(applier.messages()[2], encrypted("think-1", "hm", "opaque"));
    assert!(matches!(
        applier.apply(&value("answer-1")).expect("applies"),
        Changed::Message(change) if change.index == 1
    ));
}

#[tokio::test]
async fn a_thread_warns_once_per_run_about_an_encrypted_value_it_cannot_store() {
    use ReasoningEncryptedValueSubtype::{Message as OfMessage, ToolCall as OfToolCall};
    let run = || {
        vec![
            Event::run_started("t", "r"),
            Event::reasoning_encrypted_value(OfMessage, "nobody", "opaque"),
            Event::reasoning_encrypted_value(OfMessage, "nobody", "opaque"),
            Event::reasoning_encrypted_value(OfMessage, "activity-1", "opaque"),
            Event::reasoning_encrypted_value(OfToolCall, "no-call", "opaque"),
            // Stored, so nothing to warn about.
            Event::reasoning_encrypted_value(OfMessage, "answer-1", "opaque"),
            Event::run_finished_success("t", "r"),
        ]
    };
    let transport = ReplayTransport::with_runs([run(), run()]).matching_requests();
    let mut thread = Thread::<_>::builder(transport, "t")
        .messages(vec![
            activity("activity-1"),
            Message::assistant("answer-1", "the answer"),
        ])
        .build()
        .unwrap();

    // The second run warns again: once per text per run.
    for _ in 0..2 {
        let updates: Vec<_> = thread.run().unwrap().collect().await;
        let warnings: Vec<&str> = updates
            .iter()
            .filter_map(|update| match update {
                Update::Warning(warning) => Some(warning.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            warnings,
            [
                r#"REASONING_ENCRYPTED_VALUE for message "nobody" was dropped: the thread holds no message with that id that can store it"#,
                r#"REASONING_ENCRYPTED_VALUE for message "activity-1" was dropped: the thread holds no message with that id that can store it"#,
                r#"REASONING_ENCRYPTED_VALUE for tool call "no-call" was dropped: the thread holds no tool call with that id that can store it"#,
            ]
        );
        assert!(matches!(
            updates.last(),
            Some(Update::Done(RunEnd::Success { .. }))
        ));
    }
}

// ---- MESSAGES_SNAPSHOT -----------------------------------------------------

#[test]
fn reasoning_survives_a_snapshot_that_carries_none() {
    // Most backends never list reasoning: it exists only as streamed events.
    let mut applier = Applier::new().with_messages(vec![
        Message::user("user-1", "why?"),
        encrypted("think-1", "weighing the options", "opaque"),
        Message::assistant("answer-1", "a draft"),
    ]);

    applier
        .apply(&Event::messages_snapshot(vec![
            Message::assistant("answer-1", "the answer"),
            Message::user("user-1", "why?"),
        ]))
        .expect("applies");

    // Where it was, as it was, in the order the client had.
    assert_eq!(
        applier.messages(),
        [
            Message::user("user-1", "why?"),
            encrypted("think-1", "weighing the options", "opaque"),
            Message::assistant("answer-1", "the answer"),
        ]
    );
}

#[test]
fn a_snapshot_that_carries_reasoning_declares_the_whole_set() {
    let history = vec![
        Message::user("user-1", "why?"),
        reasoning("think-1", "first"),
        Message::assistant("answer-1", "one"),
        reasoning("think-2", "second"),
        Message::assistant("answer-2", "two"),
    ];

    // One it restates, one it leaves out: the first is replaced where the
    // client had it, the second is gone.
    let mut applier = Applier::new().with_messages(history.clone());
    applier
        .apply(&Event::messages_snapshot(vec![
            reasoning("think-2", "second, restated"),
            Message::user("user-1", "why?"),
            Message::assistant("answer-1", "one"),
            Message::assistant("answer-2", "two"),
        ]))
        .expect("applies");
    assert_eq!(
        applier.messages(),
        [
            Message::user("user-1", "why?"),
            Message::assistant("answer-1", "one"),
            reasoning("think-2", "second, restated"),
            Message::assistant("answer-2", "two"),
        ]
    );

    // A backend that restates reasoning under ids of its own: the streamed
    // copies go, so no thought is in the list twice, and the new ids are
    // appended in snapshot order.
    let mut applier = Applier::new().with_messages(history);
    applier
        .apply(&Event::messages_snapshot(vec![
            Message::user("user-1", "why?"),
            reasoning("canonical-1", "first"),
            Message::assistant("answer-1", "one"),
            reasoning("canonical-2", "second"),
            Message::assistant("answer-2", "two"),
        ]))
        .expect("applies");
    assert_eq!(
        ids(applier.messages()),
        [
            "user-1",
            "answer-1",
            "answer-2",
            "canonical-1",
            "canonical-2"
        ]
    );
}

#[test]
fn a_snapshot_that_restates_a_reasoning_message_replaces_it_whole() {
    // 1.0: the artefact rides its message. A producer that restates the
    // message without the value has withdrawn it; the client does not
    // resurrect what a snapshot removed.
    let held = || Applier::new().with_messages(vec![encrypted("think-1", "weighing", "opaque")]);

    let mut applier = held();
    applier
        .apply(&Event::messages_snapshot(vec![reasoning(
            "think-1", "weighed",
        )]))
        .expect("applies");
    assert_eq!(applier.messages(), [reasoning("think-1", "weighed")]);

    let mut applier = held();
    applier
        .apply(&Event::messages_snapshot(vec![encrypted(
            "think-1", "weighed", "opaque",
        )]))
        .expect("applies");
    assert_eq!(
        applier.messages(),
        [encrypted("think-1", "weighed", "opaque")]
    );
}

#[test]
fn a_snapshot_message_takes_the_place_of_the_one_with_its_id_whatever_the_role() {
    // Reconciliation is by id. A snapshot that carries no reasoning and no
    // activity cannot delete either, but a message it does carry still
    // replaces the local one with the same id.
    let mut applier = Applier::new().with_messages(vec![
        activity("m-1"),
        reasoning("m-2", "hm"),
        reasoning("think-1", "kept"),
        Message::assistant("answer-1", "dropped"),
    ]);

    applier
        .apply(&Event::messages_snapshot(vec![
            Message::assistant("m-2", "two"),
            Message::assistant("m-1", "one"),
        ]))
        .expect("applies");

    assert_eq!(
        applier.messages(),
        [
            Message::assistant("m-1", "one"),
            Message::assistant("m-2", "two"),
            reasoning("think-1", "kept"),
        ]
    );
}

#[tokio::test]
async fn reasoning_a_snapshot_left_alone_is_still_sent_to_the_agent() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::reasoning_message_start("think-1"),
            Event::reasoning_message_content("think-1", "weighing the options"),
            Event::reasoning_message_end("think-1"),
            Event::reasoning_encrypted_value(
                ReasoningEncryptedValueSubtype::Message,
                "think-1",
                "opaque",
            ),
            Event::text_message_start("answer-1", TextMessageRole::Assistant),
            Event::text_message_content("answer-1", "a draft"),
            Event::text_message_end("answer-1"),
            // The backend's own view of the conversation: no reasoning in it.
            Event::messages_snapshot(vec![
                Message::user("user-1", "why?"),
                Message::assistant("answer-1", "the answer"),
            ]),
            Event::run_finished_success("t", "r"),
        ],
        success(),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport.clone(), "t");
    for (id, text) in [("user-1", "why?"), ("user-2", "and then?")] {
        let report = thread
            .send_message(Message::user(id, text))
            .unwrap()
            .collect_report()
            .await;
        assert_eq!(report.end, RunEnd::Success { result: None });
    }

    assert_eq!(
        transport.last_request().unwrap().messages,
        [
            Message::user("user-1", "why?"),
            encrypted("think-1", "weighing the options", "opaque"),
            Message::assistant("answer-1", "the answer"),
            Message::user("user-2", "and then?"),
        ]
    );
}

#[tokio::test]
async fn a_reasoning_message_a_snapshot_removed_mid_stream_is_not_reported_as_stopped() {
    // The snapshot carries reasoning, so the one being streamed, which it
    // leaves out, is gone. There is nothing left to mark as stopped.
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        Event::reasoning_message_start("think-1"),
        Event::reasoning_message_content("think-1", "half a tho"),
        Event::messages_snapshot(vec![reasoning("canonical-1", "restated")]),
        Event::run_error("the model hung up"),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");

    let updates: Vec<_> = thread.run().unwrap().collect().await;
    let changes: Vec<&ReasoningChangeKind> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Reasoning(update) => Some(&update.change),
            _ => None,
        })
        .collect();
    assert_eq!(
        changes,
        [
            &ReasoningChangeKind::Started,
            &ReasoningChangeKind::Content {
                delta: "half a tho".to_owned()
            },
        ]
    );
    assert_eq!(thread.messages(), [reasoning("canonical-1", "restated")]);
}

#[tokio::test]
async fn a_reasoning_message_left_open_when_the_run_stops_is_reported_as_stopped() {
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        Event::reasoning_start("span-1"),
        Event::reasoning_message_start("think-1"),
        Event::reasoning_message_content("think-1", "half a tho"),
        Event::run_error("the model hung up"),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");

    let updates: Vec<_> = thread
        .send_message(Message::user("user-1", "why?"))
        .unwrap()
        .collect()
        .await;
    let stopped: Vec<_> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Reasoning(update) if update.change == ReasoningChangeKind::Aborted => {
                Some((update.index, update.id.as_str(), update.text.as_str()))
            }
            _ => None,
        })
        .collect();
    // The message, once; the span around it opened nothing to stop.
    assert_eq!(stopped, [(1, "think-1", "half a tho")]);
    // What there was of it stays in the conversation.
    assert_eq!(thread.messages()[1], reasoning("think-1", "half a tho"));
}

// ---- a snapshot saved by an earlier version --------------------------------

/// What `Thread::snapshot` wrote in 0.5.0-alpha.3 for a thread that ran
/// twice: a span and a message under two ids, with an encrypted value, then a
/// span and a message under one id. Reasoning is in a list of its own, and
/// the first span left an empty entry there.
fn saved_by_alpha_3() -> serde_json::Value {
    json!({
        "version": 1,
        "thread_id": "t",
        "protocol_version": "1.0",
        "messages": [
            {"role": "user", "id": "user-1", "content": "first"},
            {"role": "assistant", "id": "answer-1", "content": "the answer"},
            {"role": "user", "id": "user-2", "content": "second"},
            {"role": "assistant", "id": "answer-2", "content": "again"}
        ],
        "state": {},
        "reasoning": [
            {"id": "span-1", "content": ""},
            {
                "id": "think-1",
                "content": "weighing the options",
                "encryptedValue": "b3BhcXVl"
            },
            {"id": "think-2", "content": "once more"}
        ],
        "subagents": [],
        "interrupts": [],
        "submission": null,
        "run_ids": ["r1", "r2"],
        "last_run_end": {"Success": {"result": null}},
        "active_run_id": null
    })
}

#[tokio::test]
async fn a_snapshot_saved_by_alpha_3_restores_with_its_reasoning_in_the_conversation() {
    let snapshot: ThreadSnapshot = serde_json::from_value(saved_by_alpha_3()).unwrap();
    let transport = ReplayTransport::with_runs([success()]).matching_requests();
    let mut thread = Thread::<_>::restore(transport.clone(), snapshot).unwrap();

    // Nothing in the old format says where a reasoning message stood, so
    // they go in front of the messages, in the order their list held them:
    // each one still before the reply it led to. The entry the span left,
    // which holds nothing, is not carried over.
    let restored = [
        encrypted("think-1", "weighing the options", "b3BhcXVl"),
        reasoning("think-2", "once more"),
        Message::user("user-1", "first"),
        Message::assistant("answer-1", "the answer"),
        Message::user("user-2", "second"),
        Message::assistant("answer-2", "again"),
    ];
    assert_eq!(thread.messages(), restored);
    assert_eq!(
        thread
            .reasoning()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["think-1", "think-2"]
    );

    // From here it is a reasoning message like any other: the next run sends
    // it, encrypted value included.
    let report = thread
        .send_message(Message::user("user-3", "third"))
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let sent = transport.last_request().unwrap().messages;
    assert_eq!(sent[..6], restored);
    assert_eq!(ids(&sent[6..]), ["user-3"]);

    // Saved again, it is the current format: one list, no second copy.
    let saved = serde_json::to_value(thread.snapshot()).unwrap();
    assert_eq!(saved["version"], 2);
    assert!(saved.get("reasoning").is_none(), "{saved}");
    assert_eq!(
        roles(&serde_json::from_value::<Vec<Message>>(saved["messages"].clone()).unwrap()),
        [
            Role::Reasoning,
            Role::Reasoning,
            Role::User,
            Role::Assistant,
            Role::User,
            Role::Assistant,
            Role::User,
        ]
    );
    let again = Thread::<_>::restore(
        ReplayTransport::new([]),
        serde_json::from_value(saved).unwrap(),
    )
    .unwrap();
    assert_eq!(again.messages(), thread.messages());
    assert_eq!(again.snapshot(), thread.snapshot());
}

#[test]
fn a_version_1_reasoning_entry_does_not_displace_a_message_with_its_id() {
    // An id names one message. A version 1 thread could hold the same id in
    // both lists: a MESSAGES_SNAPSHOT restated the reasoning into `messages`,
    // or the producer used one id for a reply and its reasoning.
    let mut saved = saved_by_alpha_3();
    saved["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({"role": "reasoning", "id": "think-2", "content": "once more, restated"}));
    saved["reasoning"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "answer-1", "content": "a thought under the reply's id"}));

    let thread = Thread::<_>::restore(
        ReplayTransport::new([]),
        serde_json::from_value(saved).unwrap(),
    )
    .unwrap();

    assert_eq!(
        thread.messages(),
        [
            encrypted("think-1", "weighing the options", "b3BhcXVl"),
            Message::user("user-1", "first"),
            Message::assistant("answer-1", "the answer"),
            Message::user("user-2", "second"),
            Message::assistant("answer-2", "again"),
            reasoning("think-2", "once more, restated"),
        ]
    );
}

#[test]
fn a_snapshot_is_refused_when_its_version_and_its_reasoning_list_disagree() {
    let restore = |saved: serde_json::Value| {
        Thread::<_>::restore(
            ReplayTransport::new([]),
            serde_json::from_value(saved).unwrap(),
        )
        .map(|thread| thread.messages().len())
        .map_err(|error| error.to_string())
    };

    // The current version holds reasoning in `messages` only.
    let mut current = saved_by_alpha_3();
    current["version"] = json!(2);
    assert_eq!(
        restore(current.clone()),
        Err(
            "invalid thread snapshot: a version 2 snapshot holds reasoning in `messages`, so \
             `reasoning` must be empty"
                .to_owned()
        )
    );
    current.as_object_mut().unwrap().remove("reasoning");
    assert_eq!(restore(current), Ok(4));

    // Version 1 is still held to what alpha.3 checked.
    let mut repeated = saved_by_alpha_3();
    repeated["reasoning"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "think-1", "content": "again"}));
    assert_eq!(
        restore(repeated),
        Err("invalid thread snapshot: reasoning ID \"think-1\" is held more than once".to_owned())
    );

    let mut newer = saved_by_alpha_3();
    newer["version"] = json!(3);
    assert_eq!(
        restore(newer),
        Err("invalid thread snapshot: unsupported version 3".to_owned())
    );
}

// ---- history the application supplies ----------------------------------------

#[tokio::test]
async fn reasoning_in_the_history_a_thread_is_built_with_is_sent_too() {
    let history = vec![
        Message::user("user-1", "why?"),
        encrypted("think-1", "weighing the options", "opaque"),
        Message::Assistant(AssistantMessage {
            id: "answer-1".into(),
            content: Some("the answer".to_owned()),
            tool_calls: Some(vec![ToolCall::new("call-1", "lookup", "{}")]),
            ..Default::default()
        }),
        Message::tool("result-1", "call-1", "42"),
        activity("activity-1"),
    ];
    let transport = ReplayTransport::with_runs([success()]).matching_requests();
    let mut thread = Thread::<_>::builder(transport.clone(), "t")
        .messages(history.clone())
        .build()
        .unwrap();
    thread
        .send_message(Message::user("user-2", "and then?"))
        .unwrap()
        .collect_report()
        .await;

    // Everything but the activity, which is the only role left out.
    let sent = transport.last_request().unwrap().messages;
    assert_eq!(sent[..4], history[..4]);
    assert_eq!(ids(&sent[4..]), ["user-2"]);
}
