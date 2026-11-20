//! Two threads on one conversation, and the merge of their messages.
//!
//! One `Thread` has one request in flight. For two, an application holds two
//! threads with the same thread id and merges them once both streams have
//! ended. AG-UI 1.0 makes a message id unique within its thread
//! (`basic`, "Identifiers"), which is all the merge relies on.
//!
//! | A message | In the result |
//! | --- | --- |
//! | only this list holds | as it is, in this list's order |
//! | both hold, the copies equal | once, in the place this list gives it |
//! | both hold, the copies different | this list's copy, in the place this list gives it |
//! | only the other holds | after every message of this list, in the other's order |
//! | a tool result, of either list, whose call a message before it holds | directly behind that message, after the tool results and activity messages already behind it |
//!
//! `Thread::merge_messages_from` applies those rules to a thread, and
//! refuses what a list cannot say: another conversation, a thread that still
//! owes an answer or has a request in flight, a call answered on both.

#![cfg(feature = "client")]

use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{
    Error, MessageChangeKind, RunEnd, SubagentStatus, SubmissionStatus, Thread, Update,
    merge_messages,
};
use ag_ui::{
    ActivityMessage, AssistantMessage, Event, Interrupt, JsonObject, Message, ReasoningMessage,
    Role, TextMessageRole, ToolCall, ToolCallStartEvent,
};
use futures_util::StreamExt as _;
use serde_json::json;

const THREAD: &str = "conversation";

fn ids(messages: &[Message]) -> Vec<&str> {
    messages
        .iter()
        .map(|message| message.id().as_str())
        .collect()
}

/// The messages both copies of the conversation start from.
fn start() -> Vec<Message> {
    vec![
        Message::user("u-0", "Hello"),
        Message::assistant("a-0", "Hi"),
    ]
}

/// `start()` and what one copy added.
fn grown(added: impl IntoIterator<Item = Message>) -> Vec<Message> {
    let mut messages = start();
    messages.extend(added);
    messages
}

/// A thread at rest that holds `messages` and never sends.
fn holding(messages: Vec<Message>) -> Thread<ReplayTransport> {
    Thread::<_>::builder(ReplayTransport::new([]), THREAD)
        .messages(messages)
        .build()
        .expect("unique message ids")
}

/// An assistant message that holds these tool calls.
fn calling(id: &str, calls: &[&str]) -> Message {
    Message::Assistant(AssistantMessage {
        id: id.into(),
        tool_calls: Some(
            calls
                .iter()
                .map(|call| ToolCall::new(*call, "lookup", "{}"))
                .collect(),
        ),
        ..Default::default()
    })
}

fn activity(id: &str, percent: u32) -> Message {
    let mut content = JsonObject::new();
    content.insert("percent".into(), json!(percent));
    Message::Activity(ActivityMessage {
        id: id.into(),
        activity_type: "progress".into(),
        content,
        ..Default::default()
    })
}

fn reasoning(id: &str, text: &str) -> Message {
    Message::Reasoning(ReasoningMessage {
        id: id.into(),
        content: text.into(),
        ..Default::default()
    })
}

/// One run that replies with one assistant message.
fn reply(id: &str, text: &str) -> Vec<Event> {
    vec![
        Event::run_started(THREAD, "r"),
        Event::text_message_start(id, TextMessageRole::Assistant),
        Event::text_message_content(id, text),
        Event::text_message_end(id),
        Event::run_finished_success(THREAD, "r"),
    ]
}

/// One run that calls `call` and pauses for approval of it.
fn asks_approval(call: &str, interrupt: &str) -> Vec<Event> {
    let mut approval = Interrupt::new(interrupt, "tool_approval");
    approval.tool_call_id = Some(call.into());
    vec![
        Event::run_started(THREAD, "r"),
        ToolCallStartEvent::new(call, "transfer_funds")
            .with_parent_message_id(format!("{call}-holder"))
            .into(),
        Event::tool_call_end(call),
        Event::run_finished_interrupt(THREAD, "r", vec![approval]),
    ]
}

/// One run that leaves `call` for the application to answer.
fn leaves_call(call: &str) -> Vec<Event> {
    vec![
        Event::run_started(THREAD, "r"),
        ToolCallStartEvent::new(call, "pick_file")
            .with_parent_message_id(format!("{call}-holder"))
            .into(),
        Event::tool_call_end(call),
        Event::run_finished_success(THREAD, "r"),
    ]
}

fn script(runs: impl IntoIterator<Item = Vec<Event>>) -> ReplayTransport {
    ReplayTransport::with_runs(runs).matching_requests()
}

/// A thread that sent `text` and read the answer to the end.
async fn after(runs: impl IntoIterator<Item = Vec<Event>>, text: &str) -> Thread<ReplayTransport> {
    let mut thread = Thread::new(script(runs), THREAD);
    thread.send(text).unwrap().collect_report().await;
    thread
}

fn refused(result: Result<ag_ui::client::MergeReport, Error>) -> String {
    match result {
        Err(Error::Merge(why)) => why,
        other => panic!("the merge must be refused, not {other:?}"),
    }
}

// ---- order ------------------------------------------------------------------

#[test]
fn two_copies_that_each_went_on_merge_to_the_start_then_this_one_then_the_other() {
    let ours = grown([
        Message::user("u-1", "Write the report"),
        Message::assistant("a-1", "Here it is."),
    ]);
    let theirs = grown([
        Message::user("u-2", "What time is it?"),
        Message::assistant("a-2", "Noon."),
    ]);

    let merged = merge_messages(&ours, &theirs);
    assert_eq!(ids(&merged), ["u-0", "a-0", "u-1", "a-1", "u-2", "a-2"]);
    // The same lists give the same list ...
    assert_eq!(merge_messages(&ours, &theirs), merged);
    // ... and the other way round, the other copy's additions come first.
    assert_eq!(
        ids(&merge_messages(&theirs, &ours)),
        ["u-0", "a-0", "u-2", "a-2", "u-1", "a-1"]
    );

    // Nothing of this list is changed or moved, so merging what is already
    // held, or nothing, gives the list back.
    assert_eq!(merge_messages(&merged, &theirs), merged);
    assert_eq!(merge_messages(&ours, &[]), ours);
    assert_eq!(merge_messages(&[], &theirs), theirs);
}

#[test]
fn a_thread_takes_the_messages_it_lacks_and_reports_them() {
    let mut main = holding(grown([
        Message::user("u-1", "Write the report"),
        Message::assistant("a-1", "Here it is."),
    ]));
    let mut side = holding(grown([
        Message::user("u-2", "What time is it?"),
        Message::assistant("a-2", "Noon."),
    ]));

    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.added, ["u-2", "a-2"]);
    assert!(merged.differing.is_empty());
    assert_eq!(
        ids(main.messages()),
        ["u-0", "a-0", "u-1", "a-1", "u-2", "a-2"]
    );
    // The other thread is read, not changed.
    assert_eq!(ids(side.messages()), ["u-0", "a-0", "u-2", "a-2"]);

    // A second merge finds nothing to add, and the other thread can take
    // this one's messages the same way.
    let again = main.merge_messages_from(&side).unwrap();
    assert!(again.added.is_empty() && again.differing.is_empty());
    let back = side.merge_messages_from(&main).unwrap();
    assert_eq!(back.added, ["u-1", "a-1"]);
    assert_eq!(
        ids(side.messages()),
        ["u-0", "a-0", "u-2", "a-2", "u-1", "a-1"]
    );

    // What a merged thread saves is a snapshot like any other.
    let restored = Thread::<_>::restore(ReplayTransport::new([]), main.snapshot()).unwrap();
    assert_eq!(restored.messages(), main.messages());
}

// ---- the same id on both sides ----------------------------------------------

#[tokio::test]
async fn a_message_one_thread_saw_complete_and_the_other_partly_stays_as_this_thread_has_it() {
    let transport = script([
        vec![
            Event::run_started(THREAD, "r"),
            Event::text_message_start("report", TextMessageRole::Assistant),
            Event::text_message_content("report", "Here is "),
            Event::text_message_content("report", "the whole report."),
            Event::text_message_end("report"),
            Event::run_finished_success(THREAD, "r"),
        ],
        reply("time", "Noon."),
    ]);
    let mut main = Thread::new(transport.clone(), THREAD);
    let mut long = main.send("Write the report").unwrap();
    // The second thread is made while the report is half written.
    while let Some(update) = long.next().await {
        if matches!(&update, Update::Message(update) if matches!(update.change, MessageChangeKind::Content { .. }))
        {
            break;
        }
    }
    let mut side = Thread::<_>::restore(transport, long.thread().snapshot()).unwrap();
    assert_eq!(side.messages()[1], Message::assistant("report", "Here is "));
    side.send("What time is it?")
        .unwrap()
        .collect_report()
        .await;
    long.collect_report().await;

    // The list merge keeps the copy of whichever list is given first.
    let whole = Message::assistant("report", "Here is the whole report.");
    assert_eq!(merge_messages(main.messages(), side.messages())[1], whole);
    assert_eq!(
        merge_messages(side.messages(), main.messages())[1],
        Message::assistant("report", "Here is ")
    );

    // The thread that ran the report keeps what it built, and is told which
    // message the other thread held differently.
    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.differing, ["report"]);
    assert_eq!(merged.added.len(), 2);
    assert_eq!(main.messages()[1], whole);
    assert_eq!(main.messages().len(), 4);
}

#[tokio::test]
async fn a_message_a_snapshot_replaced_on_the_other_thread_stays_as_this_thread_has_it() {
    let edited = Message::assistant("a-0", "Hi. (edited by the agent)");
    let transport = script([vec![
        Event::run_started(THREAD, "r"),
        Event::messages_snapshot(vec![Message::user("u-0", "Hello"), edited.clone()]),
        Event::text_message_start("a-2", TextMessageRole::Assistant),
        Event::text_message_content("a-2", "Noon."),
        Event::text_message_end("a-2"),
        Event::run_finished_success(THREAD, "r"),
    ]]);
    let mut side = Thread::<_>::builder(transport, THREAD)
        .messages(start())
        .build()
        .unwrap();
    side.send("What time is it?")
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(side.messages()[1], edited);

    let mut main = holding(grown([Message::assistant("a-1", "Here it is.")]));
    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.differing, ["a-0"]);
    assert_eq!(merged.added, ["a-2"]);
    assert_eq!(main.messages()[1], Message::assistant("a-0", "Hi"));

    // Merged the other way, the edited copy is the one that stands.
    let merged = side.merge_messages_from(&main).unwrap();
    assert_eq!(merged.differing, ["a-0"]);
    assert_eq!(side.messages()[1], edited);
}

#[test]
fn a_repeated_id_within_one_list_keeps_its_first_message() {
    let ours = vec![Message::user("m", "first"), Message::user("m", "second")];
    let theirs = vec![Message::user("n", "third"), Message::user("n", "fourth")];
    assert_eq!(
        merge_messages(&ours, &theirs),
        [Message::user("m", "first"), Message::user("n", "third")]
    );
}

// ---- tool calls and their results -------------------------------------------

#[test]
fn a_call_and_its_results_added_together_stay_together() {
    let ours = grown([
        Message::user("u-1", "Write the report"),
        calling("a-1", &["c-1"]),
        Message::tool("t-1", "c-1", "figures"),
        Message::assistant("a-1b", "Here it is."),
    ]);
    let theirs = grown([
        Message::user("u-2", "What time is it?"),
        calling("a-2", &["c-2", "c-3"]),
        Message::tool("t-2", "c-2", "12:00"),
        Message::tool("t-3", "c-3", "UTC"),
        Message::assistant("a-2b", "Noon."),
    ]);
    assert_eq!(
        ids(&merge_messages(&ours, &theirs)),
        [
            "u-0", "a-0", "u-1", "a-1", "t-1", "a-1b", "u-2", "a-2", "t-2", "t-3", "a-2b"
        ]
    );
}

#[test]
fn a_result_is_placed_by_its_call_and_not_by_where_the_other_list_kept_it() {
    // The other list holds the result away from its call, after a message
    // that arrived in between. Merged, it follows the call.
    let theirs = grown([
        calling("a-2", &["c-2"]),
        Message::assistant("a-2b", "Looking it up."),
        Message::tool("t-2", "c-2", "12:00"),
    ]);
    let ours = grown([Message::assistant("a-1", "Here it is.")]);
    assert_eq!(
        ids(&merge_messages(&ours, &theirs)),
        ["u-0", "a-0", "a-1", "a-2", "t-2", "a-2b"]
    );

    // The call is held by a message of this list, which went on after it.
    let ours = grown([
        calling("a-1", &["c-1", "c-2"]),
        Message::tool("t-1", "c-1", "figures"),
        activity("progress", 50),
        Message::assistant("a-1b", "Still working."),
    ]);
    let theirs = grown([
        calling("a-1", &["c-1", "c-2"]),
        Message::tool("t-2", "c-2", "12:00"),
    ]);
    // Behind the results and the activity already behind the call, so
    // results keep the order they came in.
    assert_eq!(
        ids(&merge_messages(&ours, &theirs)),
        ["u-0", "a-0", "a-1", "t-1", "progress", "t-2", "a-1b"]
    );

    // No message holds the call: the result goes to the end like any other.
    let theirs = grown([Message::tool("t-9", "c-9", "orphan")]);
    assert_eq!(
        ids(&merge_messages(&ours, &theirs)),
        ["u-0", "a-0", "a-1", "t-1", "progress", "a-1b", "t-9"]
    );
}

#[test]
fn a_result_follows_its_call_in_the_merged_list_whichever_list_kept_it_apart() {
    // A result that arrived after another message, kept where it arrived.
    let late = [
        calling("a-1", &["c-1"]),
        Message::assistant("a-1b", "Looking it up."),
        Message::tool("t-1", "c-1", "figures"),
    ];
    // The same messages with the result kept behind its call.
    let placed = [late[0].clone(), late[2].clone(), late[1].clone()];
    let quick = grown([Message::assistant("a-2", "Noon.")]);

    // Held by this list or by the other, either way round, the merged list
    // is the same: it does not depend on where a thread puts a late result.
    let merged = merge_messages(&grown(late.clone()), &quick);
    assert_eq!(ids(&merged), ["u-0", "a-0", "a-1", "t-1", "a-1b", "a-2"]);
    assert_eq!(merge_messages(&grown(placed.clone()), &quick), merged);
    let merged = merge_messages(&quick, &grown(late.clone()));
    assert_eq!(ids(&merged), ["u-0", "a-0", "a-2", "a-1", "t-1", "a-1b"]);
    assert_eq!(merge_messages(&quick, &grown(placed.clone())), merged);

    // A list whose results stand behind their calls comes through as it is.
    assert_eq!(merge_messages(&grown(placed.clone()), &[]), grown(placed));

    // A thread that takes another's messages holds the list the same way.
    let mut main = holding(grown(late));
    let report = main.merge_messages_from(&holding(quick)).unwrap();
    assert_eq!(report.added, ["a-2"]);
    assert_eq!(
        ids(main.messages()),
        ["u-0", "a-0", "a-1", "t-1", "a-1b", "a-2"]
    );
    assert!(main.unanswered_tool_calls().is_empty());
}

#[tokio::test]
async fn a_result_a_run_delivered_late_is_merged_behind_its_call() {
    // The agent calls a tool, says something, and only then reports the
    // result. Where a thread keeps such a result is its applier's business;
    // the merged list is the same either way.
    let mut side = after(
        [vec![
            Event::run_started(THREAD, "r"),
            ToolCallStartEvent::new("c-1", "lookup")
                .with_parent_message_id("holder")
                .into(),
            Event::tool_call_end("c-1"),
            Event::text_message_start("saying", TextMessageRole::Assistant),
            Event::text_message_content("saying", "Looking it up."),
            Event::text_message_end("saying"),
            Event::tool_call_result("t-1", "c-1", "figures"),
            Event::run_finished_success(THREAD, "r"),
        ]],
        "Look it up",
    )
    .await;
    assert_eq!(side.messages().len(), 4);
    let asked = side.messages()[0].id().to_string();

    let mut main = holding(vec![Message::assistant("a-1", "Here it is.")]);
    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.added.len(), 4);
    assert_eq!(
        ids(main.messages()),
        ["a-1", asked.as_str(), "holder", "t-1", "saying"]
    );

    // The thread that ran it holds its own messages the same way once it
    // has merged.
    let merged = side.merge_messages_from(&main).unwrap();
    assert_eq!(merged.added, ["a-1"]);
    assert_eq!(
        ids(side.messages()),
        [asked.as_str(), "holder", "t-1", "saying", "a-1"]
    );
}

#[test]
fn a_call_id_a_provider_reuses_belongs_to_the_newest_message_still_waiting_for_it() {
    // Each turn numbers its calls from zero, so two messages hold `call_0`.
    let ours = grown([
        calling("a-1", &["call_0"]),
        Message::tool("t-1", "call_0", "figures"),
    ]);
    let theirs = grown([
        calling("a-2", &["call_0"]),
        Message::tool("t-2", "call_0", "12:00"),
    ]);
    let merged = merge_messages(&ours, &theirs);
    assert_eq!(ids(&merged), ["u-0", "a-0", "a-1", "t-1", "a-2", "t-2"]);

    // Neither thread answered the other's call, so nothing is refused.
    let mut main = holding(ours);
    let report = main.merge_messages_from(&holding(theirs)).unwrap();
    assert_eq!(report.added, ["a-2", "t-2"]);
    assert_eq!(main.messages(), merged);
    assert!(main.unanswered_tool_calls().is_empty());

    // An older holder that still waits takes the result before a newer one
    // that has its own.
    let ours = vec![
        calling("a-1", &["call_0"]),
        Message::assistant("a-1b", "One moment."),
        calling("a-2", &["call_0"]),
        Message::tool("t-2", "call_0", "12:00"),
    ];
    let theirs = vec![Message::tool("t-1", "call_0", "figures")];
    assert_eq!(
        ids(&merge_messages(&ours, &theirs)),
        ["a-1", "t-1", "a-1b", "a-2", "t-2"]
    );
}

#[test]
fn a_call_both_threads_answered_is_refused_and_the_list_merge_keeps_both_results() {
    let ours = grown([
        calling("a-1", &["c-1"]),
        Message::tool("t-here", "c-1", "figures"),
        Message::assistant("a-1b", "Here it is."),
    ]);
    let theirs = grown([
        calling("a-1", &["c-1"]),
        Message::tool("t-there", "c-1", "not run"),
        Message::assistant("a-2", "Noon."),
    ]);
    // The list merge does not judge: both results, behind the call.
    assert_eq!(
        ids(&merge_messages(&ours, &theirs)),
        ["u-0", "a-0", "a-1", "t-here", "t-there", "a-1b", "a-2"]
    );

    let mut main = holding(ours.clone());
    let before = main.snapshot();
    let why = refused(main.merge_messages_from(&holding(theirs)));
    assert!(
        why.contains("c-1") && why.contains("t-here") && why.contains("t-there"),
        "{why}"
    );
    assert_eq!(main.snapshot(), before, "a refused merge changes nothing");

    // Two results the other thread itself holds for one of its calls are how
    // that thread stands, not a disagreement between the two.
    let theirs = grown([
        calling("a-2", &["c-2"]),
        Message::tool("t-2", "c-2", "12:00"),
        Message::tool("t-2-again", "c-2", "12:00"),
    ]);
    let report = main.merge_messages_from(&holding(theirs)).unwrap();
    assert_eq!(report.added, ["a-2", "t-2", "t-2-again"]);
}

/// The module docs' second thread, made while the long run waits for the
/// result of a tool the server is running. The copy owes that call, gives it
/// up, and asks its question; the long run then gets the result. Before, the
/// merge into `main` was refused for good: "tool call c-5 has a result on
/// each thread".
#[tokio::test]
async fn a_copy_made_while_a_call_was_running_gives_it_up_and_merges_into_the_thread_with_the_result()
 {
    let long_run = vec![
        Event::run_started(THREAD, "r"),
        ToolCallStartEvent::new("c-5", "build_report")
            .with_parent_message_id("a-5")
            .into(),
        Event::tool_call_end("c-5"),
        Event::tool_call_result("t-5", "c-5", "report.pdf"),
        Event::text_message_start("a-6", TextMessageRole::Assistant),
        Event::text_message_content("a-6", "Here it is."),
        Event::text_message_end("a-6"),
        Event::run_finished_success(THREAD, "r"),
    ];
    let transport = script([
        long_run,
        reply("a-side", "Noon."),
        reply("a-next", "You are welcome."),
    ]);
    let mut main = Thread::new(transport.clone(), THREAD);
    let mut long = main.send("Write the report").unwrap();
    // Read up to the end of the call: the server is running the tool.
    loop {
        match long.next().await.expect("the run goes on") {
            Update::Message(update)
                if matches!(update.change, MessageChangeKind::ToolCallEnded { .. }) =>
            {
                break;
            }
            _ => {}
        }
    }
    let mut side = Thread::<_>::restore(transport.clone(), long.thread().snapshot()).unwrap();

    // The copy owes the call, which is given up there first.
    let Err(Error::UnansweredToolCalls(owed)) = side.send("What time is it?") else {
        panic!("the copy owes c-5");
    };
    assert_eq!(owed, ["c-5"]);
    side.abandon_tool_call(&"c-5".into(), "run on the main thread")
        .unwrap();
    let stand_in = side.messages().last().unwrap().id().clone();
    let quick = side
        .send("What time is it?")
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(quick.end, RunEnd::Success { result: None });
    long.collect_report().await;

    // Saved and restored, the copy still knows its stand-in for one ...
    let saved = side.snapshot();
    assert_eq!(saved.abandoned, std::slice::from_ref(&stand_in));
    let side = Thread::<_>::restore(ReplayTransport::new([]), saved.clone()).unwrap();
    let before = main.snapshot();

    // ... so the main thread keeps its result, and takes the rest.
    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.superseded, std::slice::from_ref(&stand_in));
    assert_eq!(merged.added.len(), 2, "{merged:?}");
    assert!(merged.differing.is_empty(), "{merged:?}");
    let asked = main.messages()[0].id().to_string();
    let question = merged.added[0].to_string();
    assert_eq!(
        ids(main.messages()),
        [
            asked.as_str(),
            "a-5",
            "t-5",
            "a-6",
            question.as_str(),
            "a-side"
        ]
    );
    assert!(main.unanswered_tool_calls().is_empty());
    let report = main.send("Thanks").unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });

    // The other way round, the copy would have to drop its own stand-in:
    // refused, and it says which way to merge.
    let mut copy = Thread::<_>::restore(ReplayTransport::new([]), saved.clone()).unwrap();
    let main_before = Thread::<_>::restore(ReplayTransport::new([]), before.clone()).unwrap();
    let why = refused(copy.merge_messages_from(&main_before));
    assert_eq!(
        why,
        format!(
            "tool call c-5 was given up on this thread, with message {stand_in}, and has a \
             result on the other thread, message t-5: merge this thread into the one that \
             holds the result"
        )
    );
    assert_eq!(copy.snapshot(), saved, "a refused merge changes nothing");

    // A snapshot that does not record its stand-ins — written before the
    // record existed, or a version 1 one — counts every tool message as a
    // result, and two results stay refused.
    let mut older = serde_json::to_value(&saved).unwrap();
    older.as_object_mut().unwrap().remove("abandoned");
    let older = Thread::<_>::restore(
        ReplayTransport::new([]),
        serde_json::from_value(older).unwrap(),
    )
    .unwrap();
    let mut main = Thread::<_>::restore(ReplayTransport::new([]), before).unwrap();
    let why = refused(main.merge_messages_from(&older));
    assert!(why.contains("has a result on each thread"), "{why}");
}

#[test]
fn a_stand_in_gives_way_only_to_an_answer_and_only_by_its_record() {
    // A tool message with an error is a result like any other unless the
    // thread made it a stand-in.
    let ours = grown([
        calling("a-1", &["c-1"]),
        Message::tool("t-here", "c-1", "figures"),
    ]);
    let failed = |id: &str| {
        let Message::Tool(mut answer) = Message::tool(id, "c-1", "not run") else {
            unreachable!()
        };
        answer.error = Some("not run".into());
        Message::Tool(answer)
    };
    let mut main = holding(ours.clone());
    let why = refused(main.merge_messages_from(&holding(grown([
        calling("a-1", &["c-1"]),
        failed("t-there"),
    ]))));
    assert!(why.contains("has a result on each thread"), "{why}");

    // Given up on both: this thread's stand-in stands, and the other's gives
    // way to it.
    let gave_up = || {
        let mut thread = holding(grown([calling("a-1", &["c-1"])]));
        thread.abandon_tool_call(&"c-1".into(), "not run").unwrap();
        thread
    };
    let mut main = gave_up();
    let side = gave_up();
    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.superseded, [side.messages()[3].id().clone()]);
    assert!(merged.added.is_empty());
    assert_eq!(main.messages().len(), 4);

    // A stand-in for a call this thread never answered is added, and stays
    // a stand-in here.
    let mut main = holding(grown([calling("a-1", &["c-1"])]));
    main.push_message(Message::tool("t-here", "c-1", "figures"))
        .unwrap();
    let mut empty = holding(start());
    let merged = empty.merge_messages_from(&side).unwrap();
    assert_eq!(merged.added.len(), 2);
    assert!(merged.superseded.is_empty());
    assert_eq!(
        empty.snapshot().abandoned,
        [side.messages()[3].id().clone()]
    );
    let merged = main.merge_messages_from(&empty).unwrap();
    assert_eq!(merged.superseded, [side.messages()[3].id().clone()]);
}

// ---- reasoning and activity -------------------------------------------------

#[tokio::test]
async fn reasoning_and_activity_messages_are_merged_like_any_other() {
    let transport = script([reply("a-3", "You are welcome.")]);
    let mut main = Thread::<_>::builder(transport.clone(), THREAD)
        .messages(grown([
            reasoning("r-1", "A long report is wanted."),
            activity("progress", 100),
            Message::assistant("a-1", "Here it is."),
        ]))
        .build()
        .unwrap();
    let side = holding(grown([
        reasoning("r-2", "They only want the time."),
        activity("progress", 10),
        activity("clock", 100),
        Message::assistant("a-2", "Noon."),
    ]));

    let merged = main.merge_messages_from(&side).unwrap();
    // Each reasoning message stays in front of the reply it led to. The
    // activity both hold keeps this thread's content.
    assert_eq!(
        ids(main.messages()),
        [
            "u-0", "a-0", "r-1", "progress", "a-1", "r-2", "clock", "a-2"
        ]
    );
    assert_eq!(merged.added, ["r-2", "clock", "a-2"]);
    assert_eq!(merged.differing, ["progress"]);
    assert_eq!(main.messages()[3], activity("progress", 100));
    assert_eq!(main.reasoning().count(), 2);

    // The next request sends the reasoning of both runs and no activity.
    main.send("Thanks").unwrap().collect_report().await;
    let sent = transport.last_request().unwrap().messages;
    let roles: Vec<_> = sent.iter().map(Message::role).collect();
    assert_eq!(
        roles,
        [
            Role::User,
            Role::Assistant,
            Role::Reasoning,
            Role::Assistant,
            Role::Reasoning,
            Role::Assistant,
            Role::User
        ]
    );
}

// ---- what is not merged -----------------------------------------------------

#[tokio::test]
async fn state_stays_with_each_thread_until_the_application_sets_it() {
    let transport = script([reply("a-3", "You are welcome.")]);
    let mut main = Thread::<_>::builder(transport.clone(), THREAD)
        .messages(grown([Message::assistant("a-1", "Here it is.")]))
        .state(json!({"report": "ready"}))
        .build()
        .unwrap();
    let side = Thread::<_>::builder(ReplayTransport::new([]), THREAD)
        .messages(grown([Message::assistant("a-2", "Noon.")]))
        .state(json!({"clock": "noon"}))
        .build()
        .unwrap();

    let _ = main.merge_messages_from(&side).unwrap();
    assert_eq!(main.raw_state(), &json!({"report": "ready"}));
    assert_eq!(side.raw_state(), &json!({"clock": "noon"}));

    // Which state the next run starts from is the application's decision.
    let mut state = main.raw_state().clone();
    state["clock"] = side.raw_state()["clock"].clone();
    main.set_state(state).unwrap();
    main.send("Thanks").unwrap().collect_report().await;
    assert_eq!(
        transport.last_request().unwrap().state,
        json!({"report": "ready", "clock": "noon"})
    );
}

#[tokio::test]
async fn a_thread_paused_on_an_interrupt_is_merged_once_the_interrupt_is_answered_there() {
    let transport = script([asks_approval("c-1", "i-1"), reply("a-2", "Transferred.")]);
    let mut side = Thread::new(transport, THREAD);
    side.send("Send the money").unwrap().collect_report().await;
    assert_eq!(side.interrupts().len(), 1);
    let mut main = holding(vec![Message::assistant("a-1", "Here it is.")]);
    let before = main.snapshot();

    let why = refused(main.merge_messages_from(&side));
    assert!(
        why.contains("the other thread is paused on interrupts i-1"),
        "{why}"
    );
    // The same from the paused thread's side: it does not take another
    // thread's turns between its question and the answer.
    let why = refused(side.merge_messages_from(&main));
    assert!(
        why.contains("this thread is paused on interrupts i-1"),
        "{why}"
    );
    assert_eq!(main.snapshot(), before);

    // Answered where it was asked, the interrupt is gone ...
    let pending = side.interrupts()[0].clone();
    let report = side
        .resume(&pending, json!({"approved": true}))
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });

    // ... and the call it decided stays decided on the thread that takes it:
    // the merged thread owes nothing and can send.
    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.added.len(), 3);
    assert!(main.unanswered_tool_calls().is_empty());
    assert!(main.send("Thanks").is_ok());

    // The list alone does not say the call was decided, which is why the
    // thread is what gets merged.
    let from_list = holding(merge_messages(&[], side.messages()));
    assert_eq!(from_list.unanswered_tool_calls(), ["c-1"]);
}

#[tokio::test]
async fn a_thread_with_an_unanswered_tool_call_is_merged_once_the_call_is_answered_there() {
    let mut side = after([leaves_call("c-1")], "Attach the file").await;
    assert_eq!(side.unanswered_tool_calls(), ["c-1"]);
    let mut main = holding(vec![Message::assistant("a-1", "Here it is.")]);

    let why = refused(main.merge_messages_from(&side));
    assert!(
        why.contains("the other thread has unanswered tool calls c-1"),
        "{why}"
    );
    let why = refused(side.merge_messages_from(&main));
    assert!(
        why.contains("this thread has unanswered tool calls c-1"),
        "{why}"
    );

    side.push_message(Message::tool("t-1", "c-1", "report.pdf"))
        .unwrap();
    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.added.len(), 3);
    // The call and its answer are together in the merged thread.
    let at = main
        .messages()
        .iter()
        .position(|message| message.id() == "c-1-holder")
        .unwrap();
    assert_eq!(main.messages()[at + 1].id(), "t-1");
    assert!(main.unanswered_tool_calls().is_empty());
}

#[tokio::test]
async fn a_thread_with_an_unconfirmed_submission_or_a_request_in_flight_is_not_merged() {
    // The resume is dispatched and its stream breaks: nothing confirmed it.
    let transport = script([asks_approval("c-1", "i-1")]);
    let mut side = Thread::new(transport, THREAD);
    side.send("Send the money").unwrap().collect_report().await;
    let pending = side.interrupts()[0].clone();
    side.resume(&pending, json!({"approved": true}))
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(
        side.submission().map(|submission| &submission.status),
        Some(&SubmissionStatus::Unconfirmed)
    );
    let mut main = holding(vec![Message::assistant("a-1", "Here it is.")]);
    let why = refused(main.merge_messages_from(&side));
    assert!(
        why.contains("the other thread holds an unconfirmed resume submission"),
        "{why}"
    );

    // A thread whose stream is still being read is reachable through
    // `RunStream::thread`, and is refused until the stream has ended.
    let mut busy = Thread::new(script([reply("a-2", "Noon.")]), THREAD);
    let mut run = busy.send("What time is it?").unwrap();
    run.next().await;
    let why = refused(main.merge_messages_from(run.thread()));
    assert!(
        why.contains("the other thread has a request in flight"),
        "{why}"
    );
    // A view of both is the list merge's job, and it does not mind.
    assert_eq!(
        merge_messages(main.messages(), run.thread().messages()).len(),
        3
    );
    run.collect_report().await;
    let merged = main.merge_messages_from(&busy).unwrap();
    assert_eq!(merged.added.len(), 2);
}

#[test]
fn threads_of_different_conversations_are_not_merged() {
    let mut main = holding(start());
    let other = Thread::<_>::builder(ReplayTransport::new([]), "another conversation")
        .messages(vec![Message::user("u-9", "Unrelated")])
        .build()
        .unwrap();
    let why = refused(main.merge_messages_from(&other));
    assert!(
        why.contains("another conversation") && why.contains(THREAD),
        "{why}"
    );
    assert_eq!(ids(main.messages()), ["u-0", "a-0"]);
}

// ---- what travels with the messages -----------------------------------------

#[tokio::test]
async fn the_merged_thread_sends_both_runs_and_refuses_a_run_id_either_thread_used() {
    let transport = script([
        reply("a-1", "Here it is."),
        reply("a-2", "Noon."),
        reply("a-3", "You are welcome."),
    ]);
    let mut main = Thread::<_>::builder(transport.clone(), THREAD)
        .messages(start())
        .build()
        .unwrap();
    let mut side = Thread::<_>::restore(transport.clone(), main.snapshot()).unwrap();
    main.set_next_run_id("run-long");
    side.set_next_run_id("run-quick");
    main.send_message(Message::user("u-1", "Write the report"))
        .unwrap()
        .collect_report()
        .await;
    side.send_message(Message::user("u-2", "What time is it?"))
        .unwrap()
        .collect_report()
        .await;

    let merged = main.merge_messages_from(&side).unwrap();
    assert_eq!(merged.added, ["u-2", "a-2"]);

    // A run id is used once on a conversation, whichever thread used it.
    main.set_next_run_id("run-quick");
    let error = main.send("Thanks").unwrap_err();
    assert!(error.to_string().contains("already used"), "{error}");

    main.set_next_run_id("run-thanks");
    let report = main
        .send_message(Message::user("u-3", "Thanks"))
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(ids(&report.new_messages), ["u-3", "a-3"]);
    let sent = transport.last_request().unwrap();
    assert_eq!(
        ids(&sent.messages),
        ["u-0", "a-0", "u-1", "a-1", "u-2", "a-2", "u-3"]
    );
}

#[tokio::test]
async fn the_subagents_the_other_thread_lists_come_with_its_messages() {
    let side = after(
        [vec![
            Event::run_started(THREAD, "r"),
            Event::subagent_started("sub-1", "clock"),
            Event::text_message_start("a-2", TextMessageRole::Assistant)
                .with_subagent_run_id("sub-1"),
            Event::text_message_content("a-2", "Noon.").with_subagent_run_id("sub-1"),
            Event::text_message_end("a-2").with_subagent_run_id("sub-1"),
            Event::subagent_finished_success("sub-1"),
            Event::run_finished_success(THREAD, "r"),
        ]],
        "What time is it?",
    )
    .await;
    assert_eq!(side.subagents().len(), 1);

    let mut main = holding(vec![Message::assistant("a-1", "Here it is.")]);
    let _ = main.merge_messages_from(&side).unwrap();
    // The message says which subagent wrote it, and the thread can say what
    // that subagent is.
    let written_by = main.messages()[2].subagent_run_id().expect("attributed");
    let subagent = main.subagent(written_by).expect("listed after the merge");
    assert_eq!(subagent.name, "clock");
    assert_eq!(subagent.status, SubagentStatus::Finished { result: None });

    // Listed once, however often the threads are merged.
    let _ = main.merge_messages_from(&side).unwrap();
    assert_eq!(main.subagents().len(), 1);
}

#[tokio::test]
async fn an_interrupts_decision_goes_with_the_call_it_decided() {
    // On this thread `call_0` was approved through an interrupt, so no tool
    // message answers it and the thread records it as decided.
    let transport = script([asks_approval("call_0", "i-1"), reply("a-1", "Transferred.")]);
    let mut decided = Thread::new(transport, THREAD);
    decided
        .send("Send the money")
        .unwrap()
        .collect_report()
        .await;
    let pending = decided.interrupts()[0].clone();
    decided
        .resume(&pending, json!({"approved": true}))
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(
        decided.snapshot().decided_interrupt_tool_call_ids,
        ["call_0"]
    );

    // A thread that takes those messages takes the decision with the call.
    let mut main = holding(vec![Message::assistant("a-0", "Hi")]);
    let _ = main.merge_messages_from(&decided).unwrap();
    assert_eq!(main.snapshot().decided_interrupt_tool_call_ids, ["call_0"]);
    assert!(main.unanswered_tool_calls().is_empty());

    // The other way round: a later turn whose provider numbered its call
    // `call_0` again, and a tool message answers that one. Added to the
    // thread that holds the decision, it is the newest `call_0`, and no
    // interrupt decided it.
    let later = holding(vec![
        calling("a-2", &["call_0"]),
        Message::tool("t-2", "call_0", "12:00"),
    ]);
    let _ = decided.merge_messages_from(&later).unwrap();
    assert!(
        decided
            .snapshot()
            .decided_interrupt_tool_call_ids
            .is_empty()
    );
    assert!(decided.unanswered_tool_calls().is_empty());
}
