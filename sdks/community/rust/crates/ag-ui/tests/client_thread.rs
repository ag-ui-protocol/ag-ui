//! Regression tests for public conversation contracts from an SDK consumer.
#![cfg(feature = "client")]

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::task::Poll;

use ag_ui::client::transport::{
    EventStream, ReplayTransport, Transport, TransportFuture, TransportStream,
};
use ag_ui::client::{Error, RunEnd, SubagentStatus, SubmissionStatus, Thread, Update};
use ag_ui::{Event, Interrupt, Message, ResumeEntry, RunAgentInput, TextMessageRole};
use futures_util::{
    StreamExt,
    task::{ArcWake, waker},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

fn script(events: impl IntoIterator<Item = Event>) -> ReplayTransport {
    ReplayTransport::new(events).matching_requests()
}
fn success() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
    ]
}
fn questions() -> Vec<Interrupt> {
    vec![
        Interrupt::new("first", "approval"),
        Interrupt::new("second", "approval"),
    ]
}
fn pause() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::run_finished_interrupt("t", "r", questions()),
    ]
}
fn answers() -> Vec<ResumeEntry> {
    vec![
        ResumeEntry::resolved("first", json!({"approved":true})),
        ResumeEntry::cancelled("second"),
    ]
}

#[tokio::test]
async fn a_refused_request_says_what_is_outstanding_without_its_text_being_read() {
    // Paused on two interrupts: a run that answers neither is refused.
    let mut thread = Thread::new(script(pause()), "t");
    thread.send("go").unwrap().collect_report().await;
    for refused in [thread.send("again").err(), thread.run().err()] {
        let Some(Error::PendingInterrupts(ids)) = refused else {
            panic!("{refused:?}");
        };
        assert_eq!(ids, ["first", "second"]);
    }
    assert_eq!(
        thread.send("again").unwrap_err().to_string(),
        "request rejected: pending interrupts must be answered with resume_many"
    );

    // A tool call nobody answered: every way of starting a run names it.
    let call = Message::Assistant(ag_ui::AssistantMessage {
        id: "m-1".into(),
        tool_calls: Some(vec![
            ag_ui::ToolCall::new("call-1", "pick_file", "{}"),
            ag_ui::ToolCall::new("call-2", "pick_file", "{}"),
        ]),
        ..Default::default()
    });
    let mut thread = Thread::<_>::builder(script(success()), "t")
        .messages(vec![call])
        .build()
        .unwrap();
    for refused in [
        thread.send("go").err(),
        thread.run().err(),
        thread
            .send_message(Message::tool("m-2", "call-1", "a.pdf"))
            .err(),
    ] {
        match refused {
            Some(Error::UnansweredToolCalls(ids)) => {
                assert_eq!(ids.last().map(|id| id.as_str()), Some("call-2"))
            }
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(
        thread.send("go").unwrap_err().to_string(),
        "request rejected: unanswered tool calls must be answered with tool messages, or abandoned, before another run: call-1, call-2"
    );
}

#[tokio::test]
async fn a_thread_declares_its_version_unless_its_peer_is_pinned_as_legacy() {
    let current = script(success());
    let mut thread = Thread::new(current.clone(), "t");
    thread.send("hello").unwrap().collect_report().await;
    assert_eq!(
        current.last_request().unwrap().protocol_version.as_deref(),
        Some("1.0")
    );

    let legacy = script(success());
    let mut thread = Thread::<_>::builder(legacy.clone(), "t")
        .protocol_version(None::<String>)
        .build()
        .unwrap();
    thread.send("hello").unwrap().collect_report().await;
    let request = serde_json::to_value(legacy.last_request().unwrap()).unwrap();
    assert!(request.get("protocolVersion").is_none());

    let snapshot = serde_json::to_value(thread.snapshot()).unwrap();
    assert!(snapshot.get("protocol_version").unwrap().is_null());
    let restored_transport = script(success());
    let mut restored = Thread::<_>::restore(
        restored_transport.clone(),
        serde_json::from_value(snapshot).unwrap(),
    )
    .unwrap();
    restored.send("again").unwrap().collect_report().await;
    let request = serde_json::to_value(restored_transport.last_request().unwrap()).unwrap();
    assert!(request.get("protocolVersion").is_none());

    let mut old_snapshot = serde_json::to_value(restored.snapshot()).unwrap();
    old_snapshot
        .as_object_mut()
        .unwrap()
        .remove("protocol_version");
    let current_transport = script(success());
    let mut from_old = Thread::<_>::restore(
        current_transport.clone(),
        serde_json::from_value(old_snapshot).unwrap(),
    )
    .unwrap();
    from_old.send("again").unwrap().collect_report().await;
    assert_eq!(
        current_transport
            .last_request()
            .unwrap()
            .protocol_version
            .as_deref(),
        Some("1.0")
    );
}

#[tokio::test]
async fn context_and_forwarded_props_go_with_every_run_after_they_are_set_until_replaced() {
    let transport = ReplayTransport::with_runs([success(), success(), success(), success()])
        .matching_requests();
    let mut thread = Thread::new(transport.clone(), "t");
    thread.send("before").unwrap().collect_report().await;

    let context = vec![ag_ui::Context::new("locale", "en-GB")];
    let props = json!({ "tenant": "acme" });
    thread.set_context(context.clone());
    thread.set_forwarded_props(props.clone());
    thread.send("set").unwrap().collect_report().await;
    // Not set again: a later run sends the same.
    thread.send("kept").unwrap().collect_report().await;

    thread.set_context(Vec::<ag_ui::Context>::new());
    thread.set_forwarded_props(serde_json::Value::Null);
    thread.send("cleared").unwrap().collect_report().await;

    let wire: Vec<_> = transport
        .requests()
        .iter()
        .map(|request| serde_json::to_value(request).unwrap())
        .collect();
    let [before, set, kept, cleared] = wire.as_slice() else {
        panic!("four runs, four requests: {wire:?}");
    };
    for request in [before, cleared] {
        assert_eq!(request["context"], json!([]));
        assert!(request.get("forwardedProps").is_none(), "{request}");
    }
    for request in [set, kept] {
        assert_eq!(
            request["context"],
            json!([{"description": "locale", "value": "en-GB"}])
        );
        assert_eq!(request["forwardedProps"], props);
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Counter {
    count: u32,
}

#[tokio::test]
async fn local_state_is_validated_atomically_and_remote_mismatch_invalidates_cache() {
    let transport = script([
        Event::run_started("t", "r"),
        Event::state_snapshot(json!({"count":"invalid"})),
        Event::state_snapshot(json!({"count":3})),
        Event::run_finished_success("t", "r"),
    ]);
    let mut thread = Thread::<_, Counter>::builder(transport, "t")
        .state(json!({"count":1}))
        .build()
        .unwrap();
    assert_eq!(thread.state().unwrap().count, 1);
    thread.set_state(json!({"count":2})).unwrap();
    assert!(thread.set_state(json!({"count":"invalid"})).is_err());
    assert_eq!(thread.state().unwrap().count, 2);
    assert_eq!(thread.raw_state(), &json!({"count":2}));
    let mut run = thread.send("go").unwrap();
    assert!(matches!(
        run.next().await,
        Some(Update::Error(Error::State(_)))
    ));
    assert!(
        run.thread().state().is_err(),
        "old typed values must be unavailable"
    );
    assert_eq!(run.thread().raw_state(), &json!({"count":"invalid"}));
    let report = run.collect_report().await;
    assert_eq!(
        report.diagnostics.len(),
        1,
        "partial consumption still retains errors"
    );
    assert_eq!(thread.state().unwrap().count, 3);
    assert!(
        Thread::<_, Counter>::builder(script([]), "t")
            .build()
            .is_err()
    );
}

#[tokio::test]
async fn preparing_dropping_and_aborting_before_first_poll_do_not_dispatch() {
    let transport = script(success());
    let mut thread = Thread::new(transport.clone(), "t");
    thread.set_next_run_id("reserved");
    let before = thread.snapshot();
    drop(thread.send("not sent").unwrap());
    assert_eq!(before, thread.snapshot());
    let run = thread.send("also not sent").unwrap();
    run.abort_handle().abort();
    assert_eq!(run.collect_report().await.end, RunEnd::Aborted);
    assert_eq!(before, thread.snapshot());
    assert!(transport.requests().is_empty());
    thread.send("actually sent").unwrap().collect_report().await;
    assert_eq!(transport.last_request().unwrap().run_id, "reserved");
    assert_eq!(thread.messages().len(), 1);
}

#[tokio::test]
async fn resume_preflight_requires_each_stored_pending_id_once() {
    let transport = ReplayTransport::with_runs([pause(), success()]).matching_requests();
    let mut thread = Thread::new(transport.clone(), "t");
    thread.send("review").unwrap().collect_report().await;
    let before = thread.snapshot();
    assert!(thread.send("ignore approvals").is_err());
    assert!(
        thread
            .resume_many([ResumeEntry::cancelled("first")])
            .is_err()
    );
    assert!(
        thread
            .resume_many([
                ResumeEntry::cancelled("first"),
                ResumeEntry::cancelled("first")
            ])
            .is_err()
    );
    assert!(
        thread
            .resume_many([
                ResumeEntry::cancelled("first"),
                ResumeEntry::cancelled("unknown")
            ])
            .is_err()
    );
    assert_eq!(before, thread.snapshot());
    assert_eq!(transport.requests().len(), 1);
    drop(thread.resume_many(answers()).unwrap());
    assert_eq!(before, thread.snapshot());
    let report = thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert!(matches!(report.end, RunEnd::Success { .. }));
    assert!(thread.interrupts().is_empty());
    assert!(thread.submission().is_none());
}

#[tokio::test]
async fn expiry_comes_from_stored_interrupt_not_a_forged_argument() {
    let mut interrupt = Interrupt::new("first", "approval");
    interrupt.expires_at = Some("2000-01-01T00:00:00Z".into());
    let transport = script([
        Event::run_started("t", "r"),
        Event::run_finished_interrupt("t", "r", vec![interrupt]),
    ]);
    let mut thread = Thread::new(transport, "t");
    thread.send("go").unwrap().collect_report().await;
    let forged = Interrupt::new("first", "approval");
    assert!(
        thread
            .resume(&forged, true)
            .unwrap_err()
            .to_string()
            .contains("expired")
    );
    assert_eq!(thread.interrupts().len(), 1);
}

/// What resuming an interrupt with a given `expiresAt` does.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Expiry {
    /// The value names an instant that has passed: refused before dispatch.
    Expired,
    /// It names one still to come: sent, and nothing is said.
    InTime,
    /// It names no instant the thread reads: sent, with one warning.
    Unread,
}

/// A thread paused on one interrupt with this `expiresAt`, and the transport
/// that answers one more run with success.
async fn paused_until(timestamp: &str) -> (Thread<ReplayTransport>, ReplayTransport, Interrupt) {
    let mut interrupt = Interrupt::new("first", "approval");
    interrupt.expires_at = Some(timestamp.into());
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_interrupt("t", "r", vec![interrupt.clone()]),
        ],
        success(),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport.clone(), "t");
    thread.send("go").unwrap().collect_report().await;
    (thread, transport, interrupt)
}

/// AG-UI 1.0, `basic/patterns/interrupt-resume`: "`expiresAt` is deliberately
/// format-unconstrained, so *whether* an interrupt has expired is the judging
/// consumer's own reading of it — the reference reads it as a date and treats
/// now-or-earlier as expired." And the schema: "a value that is not one
/// leaves the interrupt looking permanently unexpired."
///
/// Before, every value below that is not RFC 3339 made `resume` refuse with
/// "has an invalid expiry timestamp; it can only be declined".
#[tokio::test]
async fn an_interrupt_expires_only_by_a_value_that_names_an_instant() {
    use Expiry::{Expired, InTime, Unread};
    for (timestamp, expected) in [
        // A date and time with its offset.
        ("9999-12-31T23:59:59.999999999+09:00", InTime),
        ("2999-01-01t00:00:00.123456789z", InTime),
        ("2000-01-01T09:00:00+09:00", Expired),
        ("2000-01-01T09:00:00.123456789+09:00", Expired),
        ("1969-12-31T23:59:59.999999999Z", Expired),
        ("2016-12-31T23:59:60Z", Expired),
        ("2017-01-01T08:59:60+09:00", Expired),
        // A date alone is the start of that day in UTC, as ECMAScript and so
        // the reference client read it in every time zone.
        ("2099-01-01", InTime),
        ("2000-01-01", Expired),
        // A date and time with no offset names a different instant in each
        // zone, and the reference reads it in the viewer's: not read here,
        // even when it is past everywhere.
        ("2099-01-01T00:00:00", Unread),
        ("2000-01-01T00:00:00", Unread),
        // Not a date the thread reads at all.
        ("20990101T000000Z", Unread),
        ("4102444800000", Unread),
        ("Fri, 01 Jan 2999 00:00:00 GMT", Unread),
        ("2999-01-01T00:00:00Z trailing", Unread),
        ("2999-01-01T12:00:60Z", Unread),
        ("2000-02-30T00:00:00Z", Unread),
        ("2000-02-30", Unread),
        ("2000-1-1", Unread),
        ("not-a-timestamp", Unread),
    ] {
        let (mut thread, transport, interrupt) = paused_until(timestamp).await;
        let before = thread.snapshot();

        if expected == Expired {
            let refused = thread.resume(&interrupt, true).unwrap_err().to_string();
            assert!(refused.contains("has expired"), "{timestamp}: {refused}");
            assert_eq!(thread.snapshot(), before, "{timestamp}");
            assert_eq!(transport.requests().len(), 1, "{timestamp}");
            continue;
        }

        // Preparing the request changes nothing and sends nothing.
        drop(thread.resume(&interrupt, true).unwrap());
        assert_eq!(thread.snapshot(), before, "{timestamp}");
        assert_eq!(transport.requests().len(), 1, "{timestamp}");

        let updates: Vec<_> = thread.resume(&interrupt, true).unwrap().collect().await;
        assert!(
            matches!(
                updates.last(),
                Some(Update::Done(RunEnd::Success { result: None }))
            ),
            "{timestamp}: {updates:?}"
        );
        let warnings: Vec<_> = updates
            .iter()
            .filter_map(|update| match update {
                Update::Warning(warning) => Some(warning.as_str()),
                _ => None,
            })
            .collect();
        if expected == Unread {
            assert_eq!(
                warnings,
                [format!(
                    "interrupt \"first\" carries an expiresAt this thread does not read as a \
                     date, \"{timestamp}\": the answer is sent as in time, and the agent decides \
                     whether it is"
                )],
                "{timestamp}"
            );
            // It is the first thing the stream says, before any event.
            assert!(matches!(updates[0], Update::Warning(_)), "{timestamp}");
        } else {
            assert!(warnings.is_empty(), "{timestamp}: {warnings:?}");
        }
        let sent = transport.last_request().unwrap().resume.unwrap();
        assert_eq!(sent, [ResumeEntry::resolved("first", true)], "{timestamp}");
        assert!(thread.interrupts().is_empty(), "{timestamp}");
    }
}

#[tokio::test]
async fn declining_says_nothing_about_an_expiry_whether_it_is_read_or_not() {
    for timestamp in ["2000-01-01T00:00:00Z", "whenever"] {
        let (mut thread, _, interrupt) = paused_until(timestamp).await;
        let report = thread.decline(&interrupt).unwrap().collect_report().await;
        assert_eq!(report.end, RunEnd::Success { result: None }, "{timestamp}");
        assert!(report.diagnostics.is_empty(), "{timestamp}: {report:?}");
    }
}

#[tokio::test]
async fn lost_response_run_error_and_invalid_terminal_keep_unconfirmed_submission() {
    let error_cases = [
        vec![Event::run_started("t", "r")],
        vec![Event::run_started("t", "r"), Event::run_error("failed")],
        vec![Event::run_error("failed before the run began")],
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_success("t", "r"),
            Event::run_error("failed after reporting success"),
        ],
        vec![
            Event::run_started("t", "r"),
            Event::step_started("open"),
            Event::run_finished_success("t", "r"),
        ],
    ];
    for reply in error_cases {
        let transport = ReplayTransport::with_runs([pause(), reply]).matching_requests();
        let mut thread = Thread::new(transport.clone(), "t");
        thread.send("review").unwrap().collect_report().await;
        let report = thread
            .resume_many(answers())
            .unwrap()
            .collect_report()
            .await;
        assert!(matches!(report.end, RunEnd::Failed { .. }));
        assert_eq!(thread.interrupts(), questions());
        let submission = thread.submission().unwrap();
        assert_eq!(submission.status, SubmissionStatus::Unconfirmed);
        assert_eq!(submission.entries, answers());
        assert_eq!(submission.run_id, transport.last_request().unwrap().run_id);
        assert!(thread.resume_many(answers()).is_err());
        assert!(thread.send("retry").is_err());
        let saved = serde_json::to_string(&thread.snapshot()).unwrap();
        let mut restored =
            Thread::<_>::restore(script(success()), serde_json::from_str(&saved).unwrap()).unwrap();
        assert_eq!(restored.snapshot(), thread.snapshot());
        assert!(restored.resume_many(answers()).is_err());
    }
}

#[tokio::test]
async fn valid_interrupt_terminal_replaces_previous_pending() {
    let next = vec![Interrupt::new("next", "question")];
    let transport = ReplayTransport::with_runs([
        pause(),
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_interrupt("t", "r", next.clone()),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    thread.run().unwrap().collect_report().await;
    thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(thread.interrupts(), next);
    assert!(thread.submission().is_none());
}

#[tokio::test]
async fn a_terminal_for_another_request_never_confirms_submission_even_without_verifier() {
    let transport = ReplayTransport::with_runs([
        pause(),
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_success("t", "wrong"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    thread.set_verify(false);
    thread.run().unwrap().collect_report().await;
    let report = thread
        .resume_many(answers())
        .unwrap()
        .collect_report()
        .await;
    assert!(matches!(report.end, RunEnd::Failed { .. }));
    assert_eq!(
        thread.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );

    // A stream that carries another run only is a replay with nothing after
    // it: it is read, and it does not answer the request.
    let other = vec![
        Event::run_started("t", "another-request"),
        Event::run_finished_success("t", "another-request"),
    ];
    let mut wrong = Thread::new(ReplayTransport::with_runs([pause(), other]), "t");
    wrong.set_verify(false);
    wrong.set_next_run_id("r");
    wrong.run().unwrap().collect_report().await;
    wrong.set_next_run_id("actual-request");
    let report = wrong.resume_many(answers()).unwrap().collect_report().await;
    assert!(matches!(report.end, RunEnd::Failed { .. }), "{report:?}");
    assert_eq!(report.diagnostics.len(), 1, "{report:?}");
    assert!(
        report.diagnostics[0].message.contains(
            r#"without the requested run: no RUN_STARTED carried run ID "actual-request""#
        ),
        "{report:?}"
    );
    assert_eq!(report.runs.len(), 1);
    assert!(!report.runs[0].requested);
    assert_eq!(report.runs[0].end, RunEnd::Success { result: None });
    assert_eq!(
        wrong.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );
    assert_eq!(wrong.interrupts().len(), answers().len());

    // Another thread's run is not read at all.
    let mut wrong = Thread::new(ReplayTransport::new(success()), "another-thread");
    wrong.set_next_run_id("r");
    let report = wrong.send("wrong response").unwrap().collect_report().await;
    assert!(
        report.diagnostics[0]
            .message
            .contains("does not match the requested thread ID"),
        "{report:?}"
    );
    assert!(report.runs.is_empty());
}

#[tokio::test]
async fn observer_sees_raw_events_once_and_report_keeps_bounded_diagnostics_after_partial_read() {
    let transport = script([
        Event::run_started("t", "r"),
        Event::custom("progress", json!(50)),
        Event::step_started("work"),
        Event::step_finished("work"),
        Event::text_message_chunk(Some("reply".into()), Some("Hello".into())),
        Event::state_delta(vec![ag_ui::PatchOperation::replace("/missing", json!(1))]),
        Event::state_delta(vec![ag_ui::PatchOperation::replace("/missing", json!(2))]),
        Event::state_delta(vec![ag_ui::PatchOperation::replace("/missing", json!(3))]),
        Event::run_finished_success("t", "r"),
    ]);
    let mut thread = Thread::new(transport, "t");
    thread.set_diagnostic_limit(2);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let events = observed.clone();
    thread.on_event(move |event| events.lock().unwrap().push(event.event_type()));
    let mut run = thread.send("go").unwrap();
    assert!(matches!(run.next().await, Some(Update::Message(_))));
    let report = run.collect_report().await;
    assert!(matches!(report.end, RunEnd::Success { .. }));
    assert_eq!(report.diagnostics.len(), 2);
    assert_eq!(report.diagnostics_omitted, 1);
    assert_eq!(report.new_messages.len(), 2);
    let events = observed.lock().unwrap();
    assert_eq!(events.len(), 9);
    assert!(events.contains(&ag_ui::EventType::Custom));
    assert!(events.contains(&ag_ui::EventType::TextMessageChunk));
    assert!(!events.contains(&ag_ui::EventType::TextMessageStart));
}

#[derive(Clone)]
struct PendingTransport {
    dropped: Arc<AtomicUsize>,
    connecting: bool,
}
struct DropCounter(Arc<AtomicUsize>);
impl Drop for DropCounter {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
impl Transport for PendingTransport {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        let guard = DropCounter(self.dropped.clone());
        if self.connecting {
            Box::pin(async move {
                let _guard = guard;
                std::future::pending().await
            })
        } else {
            Box::pin(async move {
                let start = Event::run_started(input.thread_id, input.run_id);
                Ok(TransportStream::typed(
                    futures_util::stream::iter([Ok(start)]).chain(futures_util::stream::poll_fn(
                        move |_| {
                            let _ = &guard;
                            Poll::Pending
                        },
                    )),
                ))
            })
        }
    }
}
#[derive(Default)]
struct WakeCount(AtomicUsize);
impl ArcWake for WakeCount {
    fn wake_by_ref(this: &Arc<Self>) {
        this.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn abort_wakes_pending_connect_and_stream_drops_resources_and_yields_one_terminal() {
    use futures_util::Stream;
    for connecting in [true, false] {
        let dropped = Arc::new(AtomicUsize::new(0));
        let transport = PendingTransport {
            dropped: dropped.clone(),
            connecting,
        };
        let mut thread = Thread::new(transport, "t");
        let mut run = thread.send("go").unwrap();
        let abort = run.abort_handle();
        let wake = Arc::new(WakeCount::default());
        let waker = waker(wake.clone());
        let mut cx = std::task::Context::from_waker(&waker);
        assert!(std::pin::Pin::new(&mut run).poll_next(&mut cx).is_pending());
        abort.abort();
        assert!(wake.0.load(Ordering::SeqCst) > 0);
        let updates: Vec<_> = run.collect().await;
        assert_eq!(
            updates
                .iter()
                .filter(|u| matches!(u, Update::Done(_)))
                .count(),
            1
        );
        assert!(matches!(
            updates.last(),
            Some(Update::Done(RunEnd::Aborted))
        ));
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(thread.last_run_end(), Some(&RunEnd::Aborted));
    }
}

#[tokio::test]
async fn terminal_application_wins_late_abort_and_old_handle_cannot_cancel_next_run() {
    let transport = ReplayTransport::with_runs([success(), success()]).matching_requests();
    let mut thread = Thread::new(transport, "t");
    let mut run = thread.send("first").unwrap();
    let abort = run.abort_handle();
    assert!(matches!(
        run.next().await,
        Some(Update::RunEnded(run)) if run.requested && matches!(run.end, RunEnd::Success { .. })
    ));
    assert!(matches!(
        run.next().await,
        Some(Update::Done(RunEnd::Success { .. }))
    ));
    abort.abort();
    assert!(matches!(
        run.collect_report().await.end,
        RunEnd::Success { .. }
    ));
    abort.abort();
    assert!(matches!(
        thread.send("second").unwrap().collect_report().await.end,
        RunEnd::Success { .. }
    ));
}

/// Reports success, then fails the connection or holds it open.
struct AfterSuccess {
    connection_fails: bool,
}
impl Transport for AfterSuccess {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        let events = [
            Ok(Event::run_started(
                input.thread_id.clone(),
                input.run_id.clone(),
            )),
            Ok(Event::run_finished_success(input.thread_id, input.run_id)),
        ];
        let rest: EventStream = if self.connection_fails {
            Box::pin(futures_util::stream::iter([Err(Error::Transport(
                "connection reset".into(),
            ))]))
        } else {
            Box::pin(futures_util::stream::pending())
        };
        Box::pin(async move {
            Ok(TransportStream::typed(
                futures_util::stream::iter(events).chain(rest),
            ))
        })
    }
}

#[tokio::test]
async fn a_reported_success_waits_for_the_stream_and_outlives_a_local_stop() {
    use futures_util::FutureExt;
    // A RUN_ERROR may still follow RUN_FINISHED, so the run is not over until
    // the stream is. Stopping locally in that window keeps the outcome the
    // server already reported, as stopping after `Done` does.
    for drop_it in [false, true] {
        let mut thread = Thread::new(
            AfterSuccess {
                connection_fails: false,
            },
            "t",
        );
        let mut run = thread.send("go").unwrap();
        assert!(
            run.next().now_or_never().is_none(),
            "the run's end before the stream said what follows it"
        );
        if !drop_it {
            run.abort();
            assert!(matches!(
                run.next().await,
                Some(Update::RunEnded(run)) if matches!(run.end, RunEnd::Success { .. })
            ));
            assert!(matches!(
                run.next().await,
                Some(Update::Done(RunEnd::Success { .. }))
            ));
            assert!(run.next().await.is_none());
        }
        drop(run);
        assert!(
            matches!(thread.last_run_end(), Some(RunEnd::Success { .. })),
            "{:?}",
            thread.last_run_end()
        );
    }

    // A connection that breaks after the run closed truncates nothing: the
    // break is reported, and the run keeps its outcome.
    let mut thread = Thread::new(
        AfterSuccess {
            connection_fails: true,
        },
        "t",
    );
    let report = thread.send("go").unwrap().collect_report().await;
    assert!(matches!(report.end, RunEnd::Success { .. }), "{report:?}");
    assert_eq!(report.diagnostics.len(), 1, "{report:?}");
    assert_eq!(report.diagnostics[0].kind, "transport");
}

#[tokio::test]
async fn dropping_dispatched_resume_and_restoring_inflight_snapshot_remain_unconfirmed() {
    let transport = ReplayTransport::with_runs([
        pause(),
        vec![
            Event::run_started("t", "r"),
            Event::custom("received", json!(true)),
            Event::text_message_start("partial", TextMessageRole::Assistant),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    thread.run().unwrap().collect_report().await;
    let mut run = thread.resume_many(answers()).unwrap();
    assert!(matches!(run.next().await, Some(Update::Message(_))));
    assert_eq!(
        run.thread().submission().unwrap().status,
        SubmissionStatus::InFlight
    );
    let snapshot = run.thread().snapshot();
    drop(run);
    assert_eq!(
        thread.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );
    assert_eq!(thread.last_run_end(), Some(&RunEnd::Aborted));
    let restored = Thread::<_>::restore(script(success()), snapshot).unwrap();
    assert_eq!(
        restored.submission().unwrap().status,
        SubmissionStatus::Unconfirmed
    );
}

#[tokio::test]
async fn restored_ids_are_never_reused_and_malformed_snapshots_are_rejected() {
    let transport = script(success());
    let mut ids = ["old-message", "new-message", "new-run"].into_iter();
    let mut thread = Thread::<_>::builder(transport.clone(), "t")
        .messages(vec![Message::user("old-message", "saved")])
        .id_generator(move || ids.next().unwrap().into())
        .build()
        .unwrap();
    thread.send("next").unwrap().collect_report().await;
    assert_eq!(
        transport.last_request().unwrap().messages[1].id(),
        "new-message"
    );
    let snapshot = thread.snapshot();
    let mut restored = Thread::<_>::restore(script(success()), snapshot.clone()).unwrap();
    restored.set_next_run_id("new-run");
    assert!(restored.send("collision").is_err());
    assert_eq!(restored.messages(), thread.messages());
    let mut bad = snapshot.clone();
    bad.version = 3;
    assert!(Thread::<_>::restore(script([]), bad).is_err());
    let mut bad = snapshot.clone();
    bad.messages.push(bad.messages[0].clone());
    assert!(Thread::<_>::restore(script([]), bad).is_err());
    let mut bad = snapshot;
    bad.run_ids.push(bad.run_ids[0].clone());
    assert!(Thread::<_>::restore(script([]), bad).is_err());
}

#[tokio::test]
async fn run_error_marks_open_subagents_aborted_without_inventing_business_failure() {
    let transport = script([
        Event::run_started("t", "r"),
        Event::subagent_started("child", "research"),
        Event::run_error("parent failed"),
    ]);
    let mut thread = Thread::new(transport, "t");
    thread.run().unwrap().collect_report().await;
    assert_eq!(thread.subagents()[0].status, SubagentStatus::Aborted);
    let restored = Thread::<_>::restore(script([]), thread.snapshot()).unwrap();
    assert_eq!(restored.subagents(), thread.subagents());
}

#[cfg(feature = "http")]
#[test]
fn http_agent_threads_own_connections_and_keep_conversations_independent() {
    let agent = ag_ui::client::HttpAgent::new("https://example.com/agent").unwrap();
    let mut first = agent.thread("first");
    let second = agent.thread("second");
    let typed = agent
        .thread_with_state("typed", Counter { count: 4 })
        .unwrap();
    drop(agent);
    first.set_state(json!({"independent":true})).unwrap();
    first.push_message(Message::user("m", "hello")).unwrap();
    assert_eq!(second.raw_state(), &json!({}));
    assert!(second.messages().is_empty());
    assert_eq!(typed.state().unwrap().count, 4);
    fn assert_send<T: Send>(_: T) {}
    assert_send(first.send("owned").unwrap());
}

#[tokio::test]
async fn restoring_a_live_non_resume_run_records_local_abortion() {
    let transport = script([
        Event::run_started("t", "r"),
        Event::text_message_start("partial", TextMessageRole::Assistant),
    ]);
    let mut thread = Thread::new(transport, "t");
    let mut run = thread.send("go").unwrap();
    run.next().await.unwrap();
    let snapshot = run.thread().snapshot();
    assert!(snapshot.active_run_id.is_some());
    let restored = Thread::<_>::restore(script([]), snapshot).unwrap();
    assert_eq!(restored.last_run_end(), Some(&RunEnd::Aborted));
    assert!(restored.snapshot().active_run_id.is_none());
}

#[tokio::test]
#[allow(deprecated)]
async fn restored_legacy_reasoning_ids_do_not_overwrite_saved_reasoning() {
    let first = script([
        Event::run_started("t", "r"),
        Event::thinking_start(None),
        Event::thinking_text_message_content("original"),
        Event::thinking_end(),
        Event::run_finished_success("t", "r"),
    ]);
    let mut thread = Thread::new(first, "t");
    thread.run().unwrap().collect_report().await;
    let transport = script([
        Event::run_started("t", "r"),
        Event::thinking_start(None),
        Event::thinking_text_message_content("next"),
        Event::thinking_end(),
        Event::run_finished_success("t", "r"),
    ]);
    let mut restored = Thread::<_>::restore(transport, thread.snapshot()).unwrap();
    restored.run().unwrap().collect_report().await;
    let reasoning: Vec<_> = restored.reasoning().collect();
    assert_eq!(reasoning.len(), 2);
    assert_ne!(reasoning[0].id, reasoning[1].id);
    assert_eq!(reasoning[0].content, "original");
    assert_eq!(reasoning[1].content, "next");
}

#[tokio::test]
async fn activity_is_local_ui_state_while_raw_requests_remain_literal() {
    // Reference: official TS AbstractAgent.prepareRunAgentInput filters
    // message.role !== "activity" (commit 747933694b05676203da7d5bb8d8e50432e59b75).
    let activity = Message::Activity(ag_ui::ActivityMessage {
        id: "progress".into(),
        activity_type: "progress".into(),
        content: json!({"percent": 50}).as_object().unwrap().clone(),
        ..Default::default()
    });
    let transport = ReplayTransport::with_runs([success(), success()]).matching_requests();
    let mut thread = Thread::new(transport.clone(), "t");
    thread.push_message(activity.clone()).unwrap();
    thread.send("next turn").unwrap().collect_report().await;
    assert_eq!(transport.requests()[0].messages.len(), 1);
    assert!(matches!(
        transport.requests()[0].messages[0],
        Message::User(_)
    ));
    assert_eq!(thread.messages()[0], activity);
    let restored = Thread::<_>::restore(script([]), thread.snapshot()).unwrap();
    assert_eq!(restored.messages()[0], activity);

    // Raw transport callers choose their complete request payload themselves.
    let raw = ag_ui::client::RemoteAgent::new(transport.clone());
    let input = ag_ui::client::RunParams::new("t", "raw").message(activity.clone());
    raw.run_events(input).collect::<Vec<_>>().await;
    assert_eq!(transport.requests()[1].messages, vec![activity]);
}

#[tokio::test]
async fn dropping_a_run_clears_open_text_and_reasoning_even_without_subagents() {
    let transport = script([
        Event::run_started("t", "r"),
        Event::text_message_start("partial-text", TextMessageRole::Assistant),
        Event::reasoning_message_start("partial-reason"),
    ]);
    let mut thread = Thread::new(transport, "t");
    let mut run = thread.send("go").unwrap();
    assert!(matches!(run.next().await, Some(Update::Message(_))));
    assert!(matches!(run.next().await, Some(Update::Reasoning(_))));
    drop(run);
    assert!(thread.subagents().is_empty());
    let mut observed = thread.applier().clone();
    assert!(
        observed
            .apply(&Event::text_message_chunk(
                None,
                Some("must not append".into())
            ))
            .is_err()
    );
    let chunk = ag_ui::ReasoningMessageChunkEvent {
        delta: Some("must not append".into()),
        ..Default::default()
    };
    assert!(
        observed
            .apply(&Event::ReasoningMessageChunk(chunk))
            .is_err()
    );
    assert_eq!(thread.last_run_end(), Some(&RunEnd::Aborted));
    assert!(thread.snapshot().active_run_id.is_none());
}
