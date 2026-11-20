//! Several runs in sequence on one stream, at the public `Thread` boundary.
//!
//! AG-UI 1.0, `events/lifecycle`, "Several runs on one stream", and
//! `basic/run-input`: "The run it requests is the exchange's last", "The
//! requested run echoes this input's `runId`; a replayed run carries its own".
//! So a stream is the runs the producer replays, then the requested one. A
//! run after the requested one is not provided for, and is read all the same.
//!
//! | Run | Ends | The thread |
//! | --- | --- | --- |
//! | replayed | any way | accumulates what it delivered, reports it, owes nothing new |
//! | requested | success, interrupt | confirms a resume submission; pending interrupts cleared, set |
//! | requested | cancelled | settles a resume submission; pending interrupts cleared |
//! | requested | `RUN_ERROR`, cut short | leaves the submission unconfirmed and the interrupts as they were |
//! | after it | success, cancelled | pending interrupts cleared |
//! | after it | interrupt | pending interrupts set |
//! | after it | `RUN_ERROR`, cut short | pending interrupts left |
//! | after it | any `RUN_FINISHED`, a submission unconfirmed | pending interrupts left, with a warning |

#![cfg(feature = "client")]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use ag_ui::client::transport::{EventStream, Transport, TransportFuture, TransportStream};
use ag_ui::client::{
    Error, MessageChangeKind, ReasoningChangeKind, RunEnd, RunReport, RunSummary, SubmissionStatus,
    Thread, Update,
};
use ag_ui::{
    Event, Interrupt, Message, MessageId, ResumeEntry, RunAgentInput, RunFinishedEvent, RunOutcome,
    TextMessageRole, ToolCallId,
};
use futures_util::{FutureExt as _, StreamExt as _, stream};
use serde_json::json;

/// What a connection does once its events are sent.
#[derive(Clone, Copy, Debug)]
enum Then {
    /// Ends: the end of input.
    Close,
    /// Stays open and silent.
    Hang,
    /// Breaks.
    Break,
}

/// What one request is answered with.
type Reply = (Vec<Event>, Then);

/// Answers each request with the next scripted reply, ids as written.
#[derive(Clone)]
struct Wire {
    replies: Arc<Mutex<VecDeque<Reply>>>,
}

fn wire(replies: impl IntoIterator<Item = Reply>) -> Wire {
    Wire {
        replies: Arc::new(Mutex::new(replies.into_iter().collect())),
    }
}

impl Transport for Wire {
    fn run(&self, _input: RunAgentInput) -> TransportFuture {
        let (events, then) = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("the script has a reply for each request");
        let rest: EventStream = match then {
            Then::Close => Box::pin(stream::empty()),
            Then::Hang => Box::pin(stream::pending()),
            Then::Break => Box::pin(stream::iter([Err(Error::Transport(
                "connection reset".into(),
            ))])),
        };
        Box::pin(async move {
            Ok(TransportStream::typed(
                stream::iter(events.into_iter().map(Ok)).chain(rest),
            ))
        })
    }
}

/// A thread whose next request asks for run `r`, and reads `replies`.
fn reads(replies: impl IntoIterator<Item = Reply>) -> Thread<Wire> {
    let mut thread = Thread::new(wire(replies), "t");
    thread.set_next_run_id("r");
    thread
}

fn started(run: &str) -> Event {
    Event::run_started("t", run)
}
fn finished(run: &str) -> Event {
    Event::run_finished_success("t", run)
}
fn interrupted(run: &str, ids: &[&str]) -> Event {
    let interrupts: Vec<_> = ids.iter().map(|id| question(id)).collect();
    Event::run_finished_interrupt("t", run, interrupts)
}
fn cancelled(run: &str) -> Event {
    Event::RunFinished(RunFinishedEvent::new("t", run).with_outcome(RunOutcome::Cancelled))
}
fn question(id: &str) -> Interrupt {
    Interrupt::new(id, "approval")
}
fn says(id: &str, text: &str) -> [Event; 3] {
    [
        Event::text_message_start(id, TextMessageRole::Assistant),
        Event::text_message_content(id, text),
        Event::text_message_end(id),
    ]
}
/// One run that says one thing and succeeds.
fn run(id: &str, message: &str) -> Vec<Event> {
    let mut events = vec![started(id)];
    events.extend(says(message, id));
    events.push(finished(id));
    events
}
fn summary(id: &str, requested: bool) -> impl Fn(&RunSummary) -> bool {
    let id = id.to_owned();
    move |run| {
        run.run_id
            .as_ref()
            .is_some_and(|run_id| run_id.as_str() == id)
            && run.requested == requested
    }
}
fn kinds(report: &RunReport) -> Vec<&'static str> {
    report.diagnostics.iter().map(|d| d.kind).collect()
}
fn ends(report: &RunReport) -> Vec<&'static str> {
    report.runs.iter().map(|run| name(&run.end)).collect()
}
fn name(end: &RunEnd) -> &'static str {
    match end {
        RunEnd::Success { .. } => "success",
        RunEnd::SuccessWithPendingToolCalls { .. } => "pending tool calls",
        RunEnd::Interrupted { .. } => "interrupted",
        RunEnd::Failed { .. } => "failed",
        RunEnd::Cancelled => "cancelled",
        RunEnd::Aborted => "aborted",
    }
}
fn pending(thread: &Thread<Wire>) -> Vec<&str> {
    thread
        .interrupts()
        .iter()
        .map(|interrupt| interrupt.id.as_str())
        .collect()
}
fn text(thread: &Thread<Wire>) -> Vec<(&str, &str)> {
    thread
        .messages()
        .iter()
        .filter_map(|message| match message {
            Message::Assistant(assistant) => {
                Some((assistant.id.as_str(), assistant.content.as_deref()?))
            }
            _ => None,
        })
        .collect()
}

/// A thread paused on `first` and `second`, about to resume both as run `r`.
async fn paused(resumed: Reply) -> Thread<Wire> {
    let mut thread = Thread::new(
        wire([
            (
                vec![
                    started("r-paused"),
                    interrupted("r-paused", &["first", "second"]),
                ],
                Then::Close,
            ),
            resumed,
        ]),
        "t",
    );
    thread.set_next_run_id("r-paused");
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(name(&report.end), "interrupted");
    thread.set_next_run_id("r");
    thread
}
fn answers() -> Vec<ResumeEntry> {
    vec![
        ResumeEntry::resolved("first", json!({ "approved": true })),
        ResumeEntry::cancelled("second"),
    ]
}

// ---- how a stream of several runs is delivered -------------------------

#[tokio::test]
async fn every_run_ends_once_and_the_stream_ends_after_the_last() {
    let mut events = run("r-1", "m-1");
    events.extend(run("r-2", "m-2"));
    events.extend(run("r", "m-3"));
    let mut thread = reads([(events, Then::Close)]);
    let updates: Vec<_> = thread.run().unwrap().collect().await;

    // Each run's messages, then the run, in stream order; then the stream.
    let seen: Vec<String> = updates
        .iter()
        .filter_map(|update| match update {
            Update::Message(message) if message.change == MessageChangeKind::Ended => {
                Some(message.id.to_string())
            }
            Update::RunEnded(run) => Some(format!(
                "{} {} requested={}",
                run.run_id.as_ref().unwrap(),
                name(&run.end),
                run.requested
            )),
            Update::Done(end) => Some(format!("done {}", name(end))),
            _ => None,
        })
        .collect();
    assert_eq!(
        seen,
        [
            "m-1",
            "r-1 success requested=false",
            "m-2",
            "r-2 success requested=false",
            "m-3",
            "r success requested=true",
            "done success",
        ]
    );
    assert_eq!(
        text(&thread),
        [("m-1", "r-1"), ("m-2", "r-2"), ("m-3", "r")],
        "messages accumulate across runs"
    );
    assert_eq!(
        thread.last_run_end(),
        Some(&RunEnd::Success { result: None })
    );
}

#[tokio::test]
async fn the_report_lists_every_run_and_what_all_of_them_added() {
    let mut events = run("r-1", "m-1");
    events.extend(run("r", "m-2"));
    let mut thread = reads([(events, Then::Close)]);
    let report = thread.send("go").unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert!(report.diagnostics.is_empty(), "{report:?}");
    assert!(
        matches!(&report.runs[..], [replayed, requested]
            if summary("r-1", false)(replayed) && summary("r", true)(requested)),
        "{report:?}"
    );
    let added: Vec<_> = report
        .new_messages
        .iter()
        .map(|message| message.id().as_str())
        .collect();
    assert_eq!(added[1..], ["m-1", "m-2"], "after the user's own message");
}

#[tokio::test]
async fn a_stream_with_one_run_reports_it_once_before_done() {
    let mut thread = reads([(vec![started("r"), finished("r")], Then::Close)]);
    let updates: Vec<_> = thread.run().unwrap().collect().await;
    assert!(
        matches!(&updates[..], [Update::RunEnded(run), Update::Done(end)]
            if summary("r", true)(run) && run.end == *end && name(end) == "success"),
        "{updates:?}"
    );
}

#[tokio::test]
async fn a_run_is_reported_when_nothing_can_change_how_it_ended() {
    // After RUN_FINISHED a RUN_ERROR may still fail the run, so the run is
    // not reported until the stream says what follows. After RUN_ERROR
    // nothing can, and the stream itself is still open.
    let mut thread = reads([(vec![started("r-1"), finished("r-1")], Then::Hang)]);
    let mut stream = thread.run().unwrap();
    assert!(stream.next().now_or_never().is_none());
    drop(stream);

    let mut thread = thread_failing_then_hanging();
    let mut stream = thread.run().unwrap();
    assert!(matches!(
        stream.next().await,
        Some(Update::Error(Error::Run { .. }))
    ));
    assert!(
        matches!(stream.next().await, Some(Update::RunEnded(run)) if name(&run.end) == "failed")
    );
    assert!(
        stream.next().now_or_never().is_none(),
        "Done waits for the end of input: another run may follow"
    );
}
fn thread_failing_then_hanging() -> Thread<Wire> {
    reads([(
        vec![started("r"), Event::run_error("the model went away")],
        Then::Hang,
    )])
}

// ---- a run that fails does not end the stream ---------------------------

#[tokio::test]
async fn a_failed_run_keeps_what_it_delivered_and_the_next_run_starts_clean() {
    // The upstream stream `run-error-then-new-run-continues`, with a message
    // the failed run left half-written, once in each spelling.
    for chunked in [false, true] {
        let half = if chunked {
            vec![Event::text_message_chunk(
                Some(MessageId::new("m-half")),
                Some("half a sen".into()),
            )]
        } else {
            vec![
                Event::text_message_start("m-half", TextMessageRole::Assistant),
                Event::text_message_content("m-half", "half a sen"),
            ]
        };
        let mut events = vec![started("r-1"), Event::step_started("plan")];
        events.extend(half);
        events.push(Event::run_error("the model went away"));
        events.push(started("r"));
        events.push(Event::step_started("plan"));
        events.push(Event::step_finished("plan"));
        events.push(Event::text_message_chunk(
            Some(MessageId::new("m-whole")),
            Some("second run".into()),
        ));
        events.push(finished("r"));

        let mut thread = reads([(events, Then::Close)]);
        let updates: Vec<_> = thread.run().unwrap().collect().await;
        let failure = updates
            .iter()
            .position(|update| matches!(update, Update::Error(Error::Run { .. })))
            .unwrap_or_else(|| panic!("chunked {chunked}: {updates:?}"));
        // The failure, what it cut short, the run it ended.
        assert!(
            matches!(&updates[failure + 1..failure + 3], [
                Update::Message(aborted),
                Update::RunEnded(run),
            ] if aborted.change == MessageChangeKind::Aborted
                && aborted.id.as_str() == "m-half"
                && summary("r-1", false)(run)
                && name(&run.end) == "failed"),
            "chunked {chunked}: {updates:?}"
        );
        assert!(
            matches!(updates.last(), Some(Update::Done(RunEnd::Success { .. }))),
            "chunked {chunked}: {updates:?}"
        );
        let errors = updates
            .iter()
            .filter(|update| matches!(update, Update::Error(_)))
            .count();
        assert_eq!(errors, 1, "chunked {chunked}: {updates:?}");
        assert_eq!(
            text(&thread),
            [("m-half", "half a sen"), ("m-whole", "second run")],
            "chunked {chunked}"
        );
    }
}

#[tokio::test]
async fn reasoning_accumulates_across_runs_and_ends_with_the_run_that_left_it_open() {
    // A reasoning message is a message of the conversation, so one run's
    // stays when the next begins; one a failed run left open is over.
    let replayed = vec![
        started("r-1"),
        Event::reasoning_message_start("think-1"),
        Event::reasoning_message_content("think-1", "first thought"),
        Event::reasoning_message_end("think-1"),
        finished("r-1"),
        started("r-2"),
        Event::reasoning_message_start("think-2"),
        Event::reasoning_message_content("think-2", "half a thou"),
        Event::run_error("the model went away"),
        started("r"),
    ];
    let mut events = replayed.clone();
    events.extend(says("m-1", "the answer"));
    events.push(finished("r"));
    let mut thread = reads([(events, Then::Close)]);
    let updates: Vec<_> = thread.run().unwrap().collect().await;
    let failure = updates
        .iter()
        .position(|update| matches!(update, Update::Error(Error::Run { .. })))
        .unwrap_or_else(|| panic!("{updates:?}"));
    assert!(
        matches!(&updates[failure + 1..failure + 3], [
            Update::Reasoning(aborted),
            Update::RunEnded(run),
        ] if aborted.change == ReasoningChangeKind::Aborted
            && aborted.id.as_str() == "think-2"
            && aborted.index == 1
            && aborted.text == "half a thou"
            && summary("r-2", false)(run)),
        "{updates:?}"
    );
    assert!(
        matches!(updates.last(), Some(Update::Done(RunEnd::Success { .. }))),
        "{updates:?}"
    );
    let held: Vec<_> = thread
        .messages()
        .iter()
        .map(|message| {
            (
                message.id().as_str(),
                matches!(message, Message::Reasoning(_)),
            )
        })
        .collect();
    assert_eq!(
        held,
        [("think-1", true), ("think-2", true), ("m-1", false)],
        "reasoning and replies accumulate in stream order"
    );

    // The run after the failed one cannot continue its reasoning message.
    let mut events = replayed;
    events.push(Event::reasoning_message_content("think-2", "ght"));
    let mut thread = reads([(events, Then::Close)]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(name(&report.end), "failed");
    assert!(
        report
            .diagnostics
            .last()
            .is_some_and(|diagnostic| diagnostic.message.contains("which is not open")),
        "{report:?}"
    );
    assert_eq!(thread.applier().text_of("think-2"), Some("half a thou"));
}

#[tokio::test]
async fn a_stream_that_opens_with_run_error_may_go_on_to_the_requested_run() {
    let mut events = vec![Event::run_error("the agent was unreachable")];
    events.extend(run("r", "m-1"));
    let mut thread = reads([(events, Then::Close)]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(kinds(&report), ["run"]);
    // The failure has no run id. A run followed it, so it was not the
    // requested run failing before it began: one run answers a request.
    assert!(
        matches!(&report.runs[..], [failed, requested]
            if failed.run_id.is_none() && !failed.requested && name(&failed.end) == "failed"
                && summary("r", true)(requested)),
        "{report:?}"
    );
}

#[tokio::test]
async fn a_failure_that_opens_the_stream_is_the_requested_run_only_when_no_run_follows() {
    // Alone, it is the requested run failing before it began, and it is
    // reported when the stream ends: until then a run may still follow.
    let mut thread = reads([(vec![Event::run_error("unreachable")], Then::Close)]);
    let updates: Vec<_> = thread.run().unwrap().collect().await;
    assert!(
        matches!(
            &updates[..],
            [Update::Error(_), Update::RunEnded(failed), Update::Done(RunEnd::Failed { message, .. })]
                if failed.run_id.is_none() && failed.requested && message == "unreachable"
        ),
        "{updates:?}"
    );

    // Followed by runs none of which is the requested one, it is history
    // like them, and the request was not answered.
    let mut events = vec![Event::run_error("unreachable")];
    events.extend(run("historical", "m-1"));
    let mut thread = reads([(events, Then::Close)]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(name(&report.end), "failed");
    assert_eq!(kinds(&report), ["run", "protocol"]);
    assert!(
        report.runs.iter().all(|run| !run.requested),
        "{:?}",
        report.runs
    );
    assert_eq!(ends(&report), ["failed", "success"]);
}

#[tokio::test]
async fn a_failure_that_opens_the_stream_does_not_unconfirm_a_resume_the_next_run_confirms() {
    // The submission is in flight until the requested run says how it went.
    // Before: it went unconfirmed at the leading RUN_ERROR and was confirmed
    // by the run after it, and both were reported as the requested run.
    let events = vec![Event::run_error("not yet"), started("r")];
    let mut thread = paused((events, Then::Hang)).await;
    let mut stream = thread.resume_many(answers()).unwrap();
    let mut updates = Vec::new();
    while let Some(update) = stream.next().now_or_never().flatten() {
        updates.push(update);
    }
    assert!(
        matches!(
            &updates[..],
            [Update::Error(_), Update::RunEnded(failed)] if !failed.requested
        ),
        "{updates:?}"
    );
    assert_eq!(
        stream.thread().submission().unwrap().status,
        SubmissionStatus::InFlight
    );
    drop(stream);

    let events = vec![Event::run_error("not yet"), started("r"), finished("r")];
    let mut thread = paused((events, Then::Close)).await;
    let report = thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let requested: Vec<_> = report.runs.iter().map(|run| run.requested).collect();
    assert_eq!(requested, [false, true], "{:?}", report.runs);
    assert!(thread.submission().is_none());
    assert!(thread.interrupts().is_empty());

    // With nothing after it, the failure is the resume failing before it
    // began: nothing confirmed the submission.
    let mut thread = paused((vec![Event::run_error("not yet")], Then::Close)).await;
    let report = thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(name(&report.end), "failed");
    assert_eq!(
        thread.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );
    assert_eq!(pending(&thread), ["first", "second"]);
}

// ---- which run answers the request --------------------------------------

#[tokio::test]
async fn a_replayed_run_is_not_held_to_the_requests_run_id() {
    // Before: `RUN_STARTED does not match the requested thread and run IDs`
    // on the first event.
    let mut events = run("historical", "m-1");
    events.extend(run("r", "m-2"));
    let mut thread = reads([(events, Then::Close)]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert!(report.diagnostics.is_empty(), "{report:?}");
}

#[tokio::test]
async fn a_stream_without_the_requested_run_does_not_answer_the_request() {
    // Every run on it was another one: read, and the request unanswered.
    let mut thread = reads([(run("historical", "m-1"), Then::Close)]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(name(&report.end), "failed");
    assert_eq!(kinds(&report), ["protocol"]);
    assert!(
        report.diagnostics[0].message.contains(
            r#"the stream ended without the requested run: no RUN_STARTED carried run ID "r""#
        ),
        "{report:?}"
    );
    assert_eq!(ends(&report), ["success"]);
    assert_eq!(text(&thread), [("m-1", "historical")]);

    // Cut short inside a replayed run, that is what is said, once.
    let mut thread = reads([(vec![started("historical")], Then::Close)]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(kinds(&report), ["protocol"]);
    assert!(
        report.diagnostics[0]
            .message
            .contains("ended before RUN_FINISHED or RUN_ERROR"),
        "{report:?}"
    );
    assert_eq!(ends(&report), ["failed"]);
}

#[tokio::test]
async fn each_run_closes_with_its_own_ids() {
    for verify in [true, false] {
        // The second run closed with the first run's id.
        let mut thread = reads([(
            vec![
                started("r-1"),
                finished("r-1"),
                started("r"),
                finished("r-1"),
            ],
            Then::Close,
        )]);
        thread.set_verify(verify);
        let report = thread.run().unwrap().collect_report().await;
        assert_eq!(name(&report.end), "failed", "verify {verify}");
        assert!(
            report.diagnostics[0]
                .message
                .contains("RUN_FINISHED does not match RUN_STARTED"),
            "verify {verify}: {report:?}"
        );
        assert_eq!(ends(&report), ["success", "failed"], "verify {verify}");
    }
}

#[tokio::test]
async fn a_run_for_another_thread_is_rejected_wherever_it_arrives() {
    let mut thread = reads([(
        vec![
            started("r"),
            finished("r"),
            Event::run_started("another-thread", "r-2"),
        ],
        Then::Close,
    )]);
    let report = thread.run().unwrap().collect_report().await;
    // The requested run had ended, and a RUN_STARTED after it settles that.
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(ends(&report), ["success"]);
    assert_eq!(kinds(&report), ["protocol"]);
    assert!(
        report.diagnostics[0]
            .message
            .contains("does not match the requested thread ID"),
        "{report:?}"
    );
}

// ---- what the thread owes -----------------------------------------------

#[tokio::test]
async fn a_replayed_run_changes_nothing_the_thread_owes() {
    // A resume is in flight. Ahead of the requested run the producer replays
    // one run that succeeded and one that paused on something else.
    let mut replay = run("r-1", "m-1");
    replay.extend([started("r-2"), interrupted("r-2", &["old"])]);
    let mut events = replay.clone();
    events.push(started("r"));
    let mut thread = paused((events, Then::Hang)).await;
    let mut stream = thread.resume_many(answers()).unwrap();
    let mut updates = Vec::new();
    while let Some(update) = stream.next().now_or_never().flatten() {
        updates.push(update);
    }
    assert!(
        !updates
            .iter()
            .any(|update| matches!(update, Update::Interrupt(_))),
        "a replayed interrupt is history: {updates:?}"
    );
    let replayed: Vec<_> = updates
        .iter()
        .filter_map(|update| match update {
            Update::RunEnded(run) => Some(name(&run.end)),
            _ => None,
        })
        .collect();
    assert_eq!(replayed, ["success", "interrupted"]);

    // Neither confirmed the submission nor touched what it answers, so a
    // snapshot taken here restores.
    let during = stream.thread();
    assert_eq!(
        during.submission().unwrap().status,
        SubmissionStatus::InFlight
    );
    assert_eq!(pending(during), ["first", "second"]);
    let snapshot = during.snapshot();
    let restored = Thread::<_>::restore(wire([]), snapshot).expect("the snapshot restores");
    assert_eq!(
        restored.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );
    assert_eq!(pending(&restored), ["first", "second"]);

    // Stopped before the requested run ended: nothing confirmed it.
    stream.abort();
    let report = stream.collect_report().await;
    assert_eq!(report.end, RunEnd::Aborted);
    assert_eq!(ends(&report), ["success", "interrupted", "aborted"]);
    assert_eq!(
        thread.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );
    assert_eq!(pending(&thread), ["first", "second"]);

    // The same replay, and then the requested run answers.
    let mut events = replay;
    events.extend([started("r"), finished("r")]);
    let mut thread = paused((events, Then::Close)).await;
    let report = thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert!(report.diagnostics.is_empty(), "{report:?}");
    assert!(thread.submission().is_none());
    assert!(thread.interrupts().is_empty());
}

#[tokio::test]
async fn a_replay_that_never_reaches_the_requested_run_confirms_nothing() {
    // The stream ends cleanly after a replayed success. A reader that took
    // the last RUN_FINISHED for the answer would call the resume accepted.
    let mut thread = paused((run("r-1", "m-1"), Then::Close)).await;
    let report = thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(name(&report.end), "failed");
    assert_eq!(kinds(&report), ["protocol"]);
    assert_eq!(
        thread.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );
    assert_eq!(pending(&thread), ["first", "second"]);
}

#[tokio::test]
async fn a_run_after_the_requested_one_decides_what_the_thread_owes() {
    // (the requested run's end, the later run's events, the request's end,
    // what is pending afterwards, every interrupt announced on the way)
    type Case = (
        Event,
        Vec<Event>,
        &'static str,
        Vec<&'static str>,
        Vec<&'static str>,
    );
    let cases: Vec<Case> = vec![
        (
            finished("r"),
            vec![started("r-2"), interrupted("r-2", &["i-2"])],
            "interrupted",
            vec!["i-2"],
            vec!["i-2"],
        ),
        (
            interrupted("r", &["i-1"]),
            vec![started("r-2"), finished("r-2")],
            "success",
            vec![],
            vec!["i-1"],
        ),
        (
            interrupted("r", &["i-1"]),
            vec![started("r-2"), cancelled("r-2")],
            "cancelled",
            vec![],
            vec!["i-1"],
        ),
        (
            interrupted("r", &["i-1"]),
            vec![started("r-2"), interrupted("r-2", &["i-2", "i-3"])],
            "interrupted",
            vec!["i-2", "i-3"],
            vec!["i-1", "i-2", "i-3"],
        ),
        // A run that fails, or is cut short, leaves what was pending.
        (
            interrupted("r", &["i-1"]),
            vec![started("r-2"), Event::run_error("failed")],
            "failed",
            vec!["i-1"],
            vec!["i-1"],
        ),
        (
            interrupted("r", &["i-1"]),
            vec![started("r-2")],
            "failed",
            vec!["i-1"],
            vec!["i-1"],
        ),
        // And so does a late failure of the run that would have cleared it.
        (
            interrupted("r", &["i-1"]),
            vec![started("r-2"), finished("r-2"), Event::run_error("late")],
            "failed",
            vec!["i-1"],
            vec!["i-1"],
        ),
    ];
    for (requested, later, end, owed, announced) in cases {
        let mut events = vec![started("r"), requested];
        events.extend(later);
        let mut thread = reads([(events.clone(), Then::Close)]);
        let updates: Vec<_> = thread.run().unwrap().collect().await;
        let Some(Update::Done(done)) = updates.last() else {
            panic!("{events:?}: {updates:?}");
        };
        assert_eq!(name(done), end, "{events:?}");
        assert_eq!(pending(&thread), owed, "{events:?}");
        assert_eq!(thread.last_run_end(), Some(done), "{events:?}");
        // Every interrupt that became pending was announced, in order: the
        // requested run's, then the later run's in its place.
        let said: Vec<_> = updates
            .iter()
            .filter_map(|update| match update {
                Update::Interrupt(interrupt) => Some(interrupt.id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(said, announced, "{events:?}");
        // The requested run was reported as the one asked for, and first.
        assert!(
            matches!(
                updates.iter().find(|update| matches!(update, Update::RunEnded(_))),
                Some(Update::RunEnded(run)) if summary("r", true)(run)
            ),
            "{events:?}: {updates:?}"
        );
    }
}

#[tokio::test]
async fn the_thread_moves_on_from_where_the_last_run_left_it() {
    // The later run paused: the next request has to answer it.
    let mut thread = Thread::new(
        wire([
            (
                vec![
                    started("r"),
                    finished("r"),
                    started("r-2"),
                    interrupted("r-2", &["i-2"]),
                ],
                Then::Close,
            ),
            (vec![started("r-3"), finished("r-3")], Then::Close),
        ]),
        "t",
    );
    thread.set_next_run_id("r");
    thread.run().unwrap().collect_report().await;
    assert!(matches!(
        thread.send("next"),
        Err(Error::PendingInterrupts(ids)) if ids == ["i-2"]
    ));
    let question = thread.interrupts()[0].clone();
    thread.set_next_run_id("r-3");
    let report = thread
        .resume(&question, true)
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert!(thread.interrupts().is_empty());

    // The later run named the calls it left for the application.
    let pending_calls = Event::RunFinished(
        RunFinishedEvent::new("t", "r-2")
            .with_outcome(RunOutcome::success_with_pending_tool_calls(["call-1"])),
    );
    let mut thread = thread_with_later_run(vec![
        started("r-2"),
        Event::tool_call_start("call-1", "pick_file"),
        Event::tool_call_end("call-1"),
        pending_calls,
    ]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(name(&report.end), "pending tool calls");
    assert_eq!(thread.unanswered_tool_calls(), ["call-1"]);
}
fn thread_with_later_run(later: Vec<Event>) -> Thread<Wire> {
    let mut events = vec![started("r"), finished("r")];
    events.extend(later);
    reads([(events, Then::Close)])
}

#[tokio::test]
async fn a_later_run_leaves_the_interrupts_an_unconfirmed_submission_answers() {
    // The requested run was a resume and failed, so nothing says whether the
    // agent took the answers. The submission stays until the application
    // reconciles it, and its entries answer exactly the pending interrupts,
    // so a run after it does not replace them. That is said, once, for that
    // run.
    let failed = || vec![started("r"), Event::run_error("failed")];
    let cases: Vec<(Vec<Event>, Vec<Event>, &str, &str)> = vec![
        (
            failed(),
            vec![started("r-2"), interrupted("r-2", &["other"])],
            "interrupted",
            "`interrupt`",
        ),
        (
            failed(),
            vec![started("r-2"), finished("r-2")],
            "success",
            "`success`",
        ),
        (
            failed(),
            vec![started("r-2"), cancelled("r-2")],
            "cancelled",
            "`cancelled`",
        ),
    ];
    for (requested, later, end, outcome) in cases {
        let mut events = requested;
        events.extend(later);
        let mut thread = paused((events.clone(), Then::Close)).await;
        let updates: Vec<_> = thread.resume_many(answers()).unwrap().collect().await;
        assert!(
            matches!(updates.last(), Some(Update::Done(done)) if name(done) == end),
            "{events:?}: {updates:?}"
        );
        assert_eq!(pending(&thread), ["first", "second"], "{events:?}");
        assert_eq!(
            thread.submission().unwrap().status,
            SubmissionStatus::Unconfirmed,
            "{events:?}"
        );
        assert!(
            !updates
                .iter()
                .any(|update| matches!(update, Update::Interrupt(_))),
            "{events:?}: {updates:?}"
        );
        let warnings: Vec<_> = updates
            .iter()
            .filter_map(|update| match update {
                Update::Warning(warning) => Some(warning.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            matches!(warnings[..], [warning]
                if warning.contains(r#"run "r-2""#)
                    && warning.contains(outcome)
                    && warning.contains("until the application reconciles it")),
            "{events:?}: {warnings:?}"
        );
        // The thread is still one a snapshot can carry.
        let restored =
            Thread::<_>::restore(wire([]), thread.snapshot()).expect("the snapshot restores");
        assert_eq!(pending(&restored), ["first", "second"], "{events:?}");
        assert!(thread.send("next").is_err(), "{events:?}");
    }

    // The requested run's own ending is not a later run's: nothing is said.
    let mut thread = paused((failed(), Then::Close)).await;
    let report = thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(name(&report.end), "failed");
    assert_eq!(kinds(&report), ["run"], "{report:?}");
    assert_eq!(pending(&thread), ["first", "second"]);
}

#[tokio::test]
async fn a_cancelled_resume_is_settled_so_a_run_after_it_moves_the_thread_on() {
    // 1.0, "Cancelled runs": "A cancelled run waits for nothing. Its outcome
    // carries no interrupts, and the next run on the thread is an ordinary
    // new run, not a resume." The requested run reported RUN_FINISHED, so
    // the submission is settled, and a run after it is read like any other.
    let cases: Vec<(Vec<Event>, &str, Vec<&str>)> = vec![
        (vec![], "cancelled", vec![]),
        (
            vec![started("r-2"), interrupted("r-2", &["other"])],
            "interrupted",
            vec!["other"],
        ),
        (vec![started("r-2"), cancelled("r-2")], "cancelled", vec![]),
    ];
    for (later, end, owed) in cases {
        let mut events = vec![started("r"), cancelled("r")];
        events.extend(later);
        let mut thread = paused((events.clone(), Then::Close)).await;
        let report = thread
            .resume_many(answers())
            .unwrap()
            .collect_report()
            .await;
        assert_eq!(name(&report.end), end, "{events:?}");
        assert!(report.diagnostics.is_empty(), "{events:?}: {report:?}");
        assert_eq!(thread.submission(), None, "{events:?}");
        assert_eq!(pending(&thread), owed, "{events:?}");
        Thread::<_>::restore(wire([]), thread.snapshot()).expect("the snapshot restores");
    }
}

#[tokio::test]
async fn a_call_any_run_left_unanswered_is_owed() {
    // A replayed run that failed left a call behind; the requested run made
    // one and answered it.
    let mut thread = reads([(
        vec![
            started("r-1"),
            Event::tool_call_start("c-1", "lookup"),
            Event::run_error("failed"),
            started("r"),
            Event::tool_call_start("c-2", "lookup"),
            Event::tool_call_end("c-2"),
            Event::tool_call_result("m-result", "c-2", "done"),
            finished("r"),
        ],
        Then::Close,
    )]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(thread.unanswered_tool_calls(), ["c-1"]);
    assert!(thread.send("next").is_err());
    thread
        .abandon_tool_call(
            &ToolCallId::new("c-1"),
            "not run: the run that made it failed",
        )
        .unwrap();
    assert!(thread.unanswered_tool_calls().is_empty());

    // A call one run made is answered by a result in the run after it.
    let mut thread = reads([(
        vec![
            started("r-1"),
            Event::tool_call_start("c-1", "lookup"),
            Event::tool_call_end("c-1"),
            finished("r-1"),
            started("r"),
            Event::tool_call_result("m-result", "c-1", "done"),
            finished("r"),
        ],
        Then::Close,
    )]);
    let report = thread.run().unwrap().collect_report().await;
    assert!(report.diagnostics.is_empty(), "{report:?}");
    assert!(thread.unanswered_tool_calls().is_empty());
}

// ---- stopping mid-way ----------------------------------------------------

#[tokio::test]
async fn stopping_mid_way_reports_the_last_run_from_the_requested_one_on() {
    let failed = RunEnd::Failed {
        message: "the model went away".into(),
        code: None,
    };
    // (events before the connection goes quiet, the request's end, each run)
    let cases: Vec<(Vec<Event>, RunEnd, Vec<&str>)> = vec![
        // Inside the requested run, after a replayed one.
        (
            [run("r-1", "m-1"), vec![started("r")]].concat(),
            RunEnd::Aborted,
            vec!["success", "aborted"],
        ),
        // After a replayed run that reported how it ended: it keeps that,
        // and the request has no answer.
        (run("r-1", "m-1"), RunEnd::Aborted, vec!["success"]),
        // After the requested run reported how it ended: it keeps that.
        (
            run("r", "m-1"),
            RunEnd::Success { result: None },
            vec!["success"],
        ),
        // Inside a run after the requested one.
        (
            [run("r", "m-1"), vec![started("r-2")]].concat(),
            RunEnd::Aborted,
            vec!["success", "aborted"],
        ),
        // After the requested run failed: a terminal applied wins.
        (
            vec![started("r"), Event::run_error("the model went away")],
            failed,
            vec!["failed"],
        ),
    ];
    for (events, end, runs) in cases {
        for drop_it in [false, true] {
            let mut thread = reads([(events.clone(), Then::Hang)]);
            let mut stream = thread.run().unwrap();
            while stream.next().now_or_never().flatten().is_some() {}
            if drop_it {
                drop(stream);
            } else {
                stream.abort();
                let report = stream.collect_report().await;
                assert_eq!(report.end, end, "{events:?}");
                assert_eq!(ends(&report), runs, "{events:?}");
            }
            assert_eq!(
                thread.last_run_end(),
                Some(&end),
                "drop {drop_it}: {events:?}"
            );
            assert!(thread.snapshot().active_run_id.is_none());
        }
    }
}

#[tokio::test]
async fn a_message_open_when_reading_stops_is_reported_aborted_in_any_run() {
    let mut events = run("r", "m-1");
    events.extend([
        started("r-2"),
        Event::text_message_start("m-open", TextMessageRole::Assistant),
        Event::text_message_content("m-open", "half a sen"),
    ]);
    let mut thread = reads([(events, Then::Hang)]);
    let mut stream = thread.run().unwrap();
    while stream.next().now_or_never().flatten().is_some() {}
    stream.abort();
    let updates: Vec<_> = stream.collect().await;
    assert!(
        matches!(&updates[..], [Update::Message(aborted), Update::RunEnded(run), Update::Done(RunEnd::Aborted)]
            if aborted.change == MessageChangeKind::Aborted
                && aborted.id.as_str() == "m-open"
                && summary("r-2", false)(run)),
        "{updates:?}"
    );
}

#[tokio::test]
async fn a_broken_connection_fails_the_run_it_interrupts_and_no_other() {
    // Before the requested run arrived: the replayed run keeps its ending,
    // and the request fails.
    let mut thread = reads([(run("r-1", "m-1"), Then::Break)]);
    let report = thread.run().unwrap().collect_report().await;
    assert!(
        matches!(&report.end, RunEnd::Failed { message, .. } if message.contains("connection reset")),
        "{report:?}"
    );
    assert_eq!(kinds(&report), ["transport"]);
    assert_eq!(ends(&report), ["success"]);

    // After the requested run failed: its failure is the request's.
    let mut thread = reads([(
        vec![started("r"), Event::run_error("the model went away")],
        Then::Break,
    )]);
    let report = thread.run().unwrap().collect_report().await;
    assert!(
        matches!(&report.end, RunEnd::Failed { message, .. } if message == "the model went away"),
        "{report:?}"
    );
    assert_eq!(kinds(&report), ["run", "transport"]);

    // Inside a run after the requested one: that run is the last.
    let mut thread = reads([(
        [run("r", "m-1"), vec![started("r-2")]].concat(),
        Then::Break,
    )]);
    let report = thread.run().unwrap().collect_report().await;
    assert!(
        matches!(&report.end, RunEnd::Failed { message, .. } if message.contains("connection reset")),
        "{report:?}"
    );
    assert_eq!(ends(&report), ["success", "failed"]);
}

// ---- without ordering verification --------------------------------------

#[tokio::test]
async fn runs_are_paired_without_ordering_verification() {
    let unverified = |events: Vec<Event>| {
        let mut thread = reads([(events, Then::Close)]);
        thread.set_verify(false);
        thread
    };

    // A RUN_STARTED inside a run that has not ended is another run nested in
    // it, and there is no pairing a terminal event with either.
    let mut thread = unverified(vec![started("r-1"), started("r"), finished("r")]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(name(&report.end), "failed");
    assert!(
        report.diagnostics[0]
            .message
            .contains("RUN_STARTED arrived while a run was still active"),
        "{report:?}"
    );

    // The same run announced twice is let through, as it always was.
    let mut thread = unverified(vec![started("r"), started("r"), finished("r")]);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(ends(&report), ["success"]);

    // A terminal for a run that already failed closes nothing.
    let mut thread = unverified(vec![
        started("r"),
        Event::run_error("failed"),
        finished("r"),
    ]);
    let report = thread.run().unwrap().collect_report().await;
    assert!(
        report.diagnostics[1]
            .message
            .contains("RUN_FINISHED does not match RUN_STARTED"),
        "{report:?}"
    );

    // What arrives between two runs is applied, as it was after one.
    let mut events = run("r-1", "m-1");
    events.extend(says("m-between", "between runs"));
    events.extend(run("r", "m-2"));
    let mut thread = unverified(events);
    let report = thread.run().unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert!(report.diagnostics.is_empty(), "{report:?}");
    assert_eq!(
        text(&thread),
        [("m-1", "r-1"), ("m-between", "between runs"), ("m-2", "r")]
    );
}
