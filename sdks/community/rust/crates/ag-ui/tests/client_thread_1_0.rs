//! AG-UI 1.0 stream outcomes at the public Thread boundary.

#![cfg(feature = "client")]

use std::sync::{Arc, Mutex};

use ag_ui::client::transport::{ReplayTransport, Transport, TransportFuture, TransportStream};
use ag_ui::client::{Error, InterruptExt, RunEnd, Thread, Update};
use ag_ui::{
    Event, Interrupt, Message, ResumeEntry, RunAgentInput, RunErrorEvent, RunFinishedEvent,
    RunOutcome, TextMessageRole, ToolCallId, ToolContent,
};
use futures_util::{FutureExt as _, StreamExt as _};
use serde_json::{Value, json};

fn official_stream(text: &str) -> (String, Vec<Event>) {
    let fixture: Value = serde_json::from_str(text).expect("official fixture is JSON");
    let events: Vec<Event> =
        serde_json::from_value(fixture["stream"].clone()).expect("official events decode");
    let Event::RunStarted(first) = &events[0] else {
        panic!("official fixture starts a run");
    };
    (first.thread_id.as_str().to_owned(), events)
}

#[tokio::test]
async fn official_fatal_streams_end_the_thread_run_at_the_first_violation() {
    for (fixture, expected) in [
        (
            include_str!(
                "../../../../../../spec/1.0/conformance/streams/first-chunk-missing-id-fatal.json"
            ),
            "messageId",
        ),
        (
            include_str!(
                "../../../../../../spec/1.0/conformance/streams/step-finished-without-start-fatal.json"
            ),
            "never started",
        ),
        (
            include_str!(
                "../../../../../../spec/1.0/conformance/streams/content-without-start-fatal.json"
            ),
            "is not open",
        ),
    ] {
        let (thread_id, events) = official_stream(fixture);
        let mut thread = Thread::new(ReplayTransport::new(events).matching_requests(), thread_id);
        let updates: Vec<_> = thread.send("go").expect("request accepted").collect().await;
        // The error, then the run it ended, then the stream.
        let [
            ..,
            Update::Error(error),
            Update::RunEnded(run),
            Update::Done(end),
        ] = &updates[..]
        else {
            panic!("{expected}: a fatal error must precede the endings: {updates:?}");
        };
        assert!(error.to_string().contains(expected), "{error}");
        assert!(matches!(end, RunEnd::Failed { .. }), "{expected}: {end:?}");
        assert!(run.requested, "{expected}: {run:?}");
        assert_eq!(&run.end, end, "{expected}");
        assert_eq!(
            thread.messages().len(),
            1,
            "a rejected event must not add a message"
        );
    }
}

#[tokio::test]
async fn a_stream_that_opens_with_run_error_ends_with_the_servers_failure() {
    // The upstream stream `run-error-first-run-continues`: a run that failed
    // before it began. The failure is the server's, message and code, and
    // nothing presents it as a protocol violation.
    let failed = Event::RunError(
        RunErrorEvent::new("run-error-first: the agent was unreachable").with_code("UNAVAILABLE"),
    );
    let mut thread = Thread::new(ReplayTransport::new([failed]).matching_requests(), "t");
    let report = thread.send("go").unwrap().collect_report().await;
    let expected = RunEnd::Failed {
        message: "run-error-first: the agent was unreachable".into(),
        code: Some("UNAVAILABLE".into()),
    };
    assert_eq!(report.end, expected);
    assert_eq!(thread.last_run_end(), Some(&expected));
    let kinds: Vec<_> = report.diagnostics.iter().map(|d| d.kind).collect();
    assert_eq!(kinds, ["run"], "{:?}", report.diagnostics);
}

#[tokio::test]
async fn a_run_error_after_run_finished_fails_the_run() {
    // The upstream stream `late-run-error-after-finished-run-continues`. The
    // thread reads past RUN_FINISHED to the end of the stream, verifying or
    // not, and a late RUN_ERROR turns the reported success into a failure.
    for verify in [true, false] {
        let transport = ReplayTransport::new([
            Event::run_started("t", "r"),
            Event::text_message_start("late-m-1", TextMessageRole::Assistant),
            Event::text_message_content("late-m-1", "delivered before the failure"),
            Event::text_message_end("late-m-1"),
            Event::run_finished_success("t", "r"),
            Event::run_error("late-run-error: the transport failed while flushing"),
        ])
        .matching_requests();
        let mut thread = Thread::<_>::builder(transport, "t")
            .verify(verify)
            .build()
            .unwrap();
        let updates: Vec<_> = thread.send("go").unwrap().collect().await;
        let expected = RunEnd::Failed {
            message: "late-run-error: the transport failed while flushing".into(),
            code: None,
        };
        assert!(
            matches!(updates.last(), Some(Update::Done(end)) if *end == expected),
            "verify {verify}: {updates:?}"
        );
        let errors: Vec<_> = updates
            .iter()
            .filter_map(|update| match update {
                Update::Error(error) => Some(error),
                _ => None,
            })
            .collect();
        assert!(
            matches!(errors[..], [Error::Run { .. }]),
            "verify {verify}: {errors:?}"
        );
        assert_eq!(thread.last_run_end(), Some(&expected));
        // Everything delivered before the failure stays delivered.
        assert_eq!(
            thread.applier().text_of("late-m-1"),
            Some("delivered before the failure")
        );
    }
}

#[tokio::test]
async fn a_late_run_error_withdraws_the_outcome_it_follows() {
    // The interrupts a RUN_FINISHED reported belong to a run that then failed:
    // nothing is pending, and nothing is announced.
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        Event::run_finished_interrupt("t", "r", vec![Interrupt::new("approval", "approval")]),
        Event::run_error("failed after pausing"),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    let updates: Vec<_> = thread.send("go").unwrap().collect().await;
    assert!(
        !updates
            .iter()
            .any(|update| matches!(update, Update::Interrupt(_))),
        "{updates:?}"
    );
    assert!(
        matches!(updates.last(), Some(Update::Done(RunEnd::Failed { .. }))),
        "{updates:?}"
    );
    assert!(thread.interrupts().is_empty());
    assert!(thread.applier().interrupts().is_empty());
}

#[tokio::test]
async fn a_run_started_inside_an_active_run_is_reported_as_nested() {
    // The upstream stream `nested-run-started-fatal`. The second RUN_STARTED
    // names another run, and the complaint is the nesting, not the id.
    for run_id in ["r", "r-2"] {
        let transport = ReplayTransport::new([
            Event::run_started("t", "r"),
            Event::run_started("t", run_id),
        ])
        .matching_requests();
        let mut thread = Thread::new(transport, "t");
        let report = thread.send("go").unwrap().collect_report().await;
        assert!(matches!(report.end, RunEnd::Failed { .. }), "{report:?}");
        assert_eq!(report.diagnostics.len(), 1, "{report:?}");
        assert_eq!(report.diagnostics[0].kind, "protocol");
        assert!(
            report.diagnostics[0]
                .message
                .contains("RUN_STARTED arrived while a run was still active"),
            "{run_id}: {report:?}"
        );
        // One run was being read, and the nested one never became a second.
        assert_eq!(report.runs.len(), 1, "{run_id}: {report:?}");
    }

    // Ordering verification off leaves the pairing of runs, which still
    // fails a run that opens inside another.
    let transport =
        ReplayTransport::new([Event::run_started("t", "r"), Event::run_started("t", "r-2")])
            .matching_requests();
    let mut thread = Thread::<_>::builder(transport, "t")
        .verify(false)
        .build()
        .unwrap();
    let report = thread.send("go").unwrap().collect_report().await;
    assert!(
        report.diagnostics[0]
            .message
            .contains("RUN_STARTED arrived while a run was still active"),
        "{report:?}"
    );
}

#[tokio::test]
async fn events_outside_the_run_fail_the_thread_run() {
    // Nothing but RUN_STARTED or RUN_ERROR may open a stream, RAW and CUSTOM
    // included; nothing but RUN_ERROR may follow RUN_FINISHED — the upstream
    // stream `event-after-run-finished-fatal`.
    for (events, expected) in [
        (
            vec![
                Event::raw(json!({ "provider": "openai" })),
                Event::run_started("t", "r"),
                Event::run_finished_success("t", "r"),
            ],
            "before RUN_STARTED",
        ),
        (
            vec![
                Event::custom("early", json!(1)),
                Event::run_started("t", "r"),
                Event::run_finished_success("t", "r"),
            ],
            "before RUN_STARTED",
        ),
        (
            vec![
                Event::run_started("t", "r"),
                Event::run_finished_success("t", "r"),
                Event::text_message_start("after-m-1", TextMessageRole::Assistant),
            ],
            "already finished",
        ),
    ] {
        let mut thread = Thread::new(ReplayTransport::new(events).matching_requests(), "t");
        let report = thread.send("go").unwrap().collect_report().await;
        assert!(
            matches!(report.end, RunEnd::Failed { .. }),
            "{expected}: {report:?}"
        );
        assert_eq!(report.diagnostics.len(), 1, "{expected}: {report:?}");
        assert_eq!(report.diagnostics[0].kind, "protocol");
        assert!(
            report.diagnostics[0].message.contains(expected),
            "{expected}: {report:?}"
        );
        assert_eq!(
            thread.messages().len(),
            1,
            "a rejected event must not add a message"
        );
    }
}

#[tokio::test]
async fn official_unappliable_state_delta_is_a_diagnostic_and_keeps_the_prior_state() {
    let (thread_id, events) = official_stream(include_str!(
        "../../../../../../spec/1.0/conformance/streams/state-delta-unappliable-warns-and-keeps.json"
    ));
    let mut thread = Thread::new(ReplayTransport::new(events).matching_requests(), thread_id);
    let report = thread.send("go").unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(report.diagnostics.len(), 1);
    assert_eq!(report.diagnostics[0].kind, "patch");
    assert_eq!(thread.raw_state(), &json!({"plan": {"status": "open"}}));
}

#[tokio::test]
async fn an_official_malformed_patch_pointer_fails_the_thread_run() {
    let invalid: Event = serde_json::from_str(include_str!(
        "../../../../../../spec/1.0/fixtures/StateDeltaEvent/invalid/patch-pointer-without-leading-slash.json"
    ))
    .expect("the loose Rust patch type can represent the malformed pointer");
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        invalid,
        Event::run_finished_success("t", "r"),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    let report = thread.send("go").unwrap().collect_report().await;
    assert!(matches!(report.end, RunEnd::Failed { .. }));
    assert_eq!(report.diagnostics.len(), 1);
    assert_eq!(report.diagnostics[0].kind, "protocol");
    assert_eq!(thread.raw_state(), &json!({}));
}

#[tokio::test]
async fn official_remote_cancelled_outcome_is_distinct_from_local_abort() {
    let (thread_id, events) = official_stream(include_str!(
        "../../../../../../spec/1.0/conformance/streams/run-finished-cancelled-outcome-accepted.json"
    ));
    let mut thread = Thread::new(ReplayTransport::new(events).matching_requests(), thread_id);
    let report = thread.send("go").unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Cancelled);
    assert!(report.diagnostics.is_empty());
    assert_eq!(thread.last_run_end(), Some(&RunEnd::Cancelled));
    assert_eq!(
        thread.applier().text_of("run-finished-cancelled-m-1"),
        Some("delivered before the stop")
    );
}

/// AG-UI 1.0, `events/lifecycle`, "Cancelled runs": "A cancelled run waits
/// for nothing. Its outcome carries no interrupts, and the next run on the
/// thread is an ordinary new run, not a resume." The reference client clears
/// its pending interrupts on a `RUN_FINISHED` whose outcome is not an
/// interrupt, cancelled included.
#[tokio::test]
async fn a_resume_whose_run_is_cancelled_settles_the_submission_and_waits_for_nothing() {
    let question = Interrupt::new("approval", "tool_approval");
    let cancelled =
        Event::RunFinished(RunFinishedEvent::new("t", "r").with_outcome(RunOutcome::Cancelled));
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_interrupt("t", "r", vec![question.clone()]),
        ],
        vec![Event::run_started("t", "r"), cancelled],
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_success("t", "r"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::new(transport.clone(), "t");
    thread.send("go").unwrap().collect_report().await;
    let pending = thread.interrupts()[0].clone();
    let report = thread
        .resume(&pending, true)
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Cancelled);
    assert!(report.diagnostics.is_empty(), "{report:?}");
    // The run that took the answers reported how it ended, so nothing is
    // left to reconcile, and nothing is left to answer.
    assert_eq!(thread.submission(), None);
    assert!(thread.interrupts().is_empty());
    // An interrupt that is no longer pending cannot be answered again ...
    assert!(thread.decline(&pending).is_err());
    // ... and the next run is an ordinary new one.
    let report = thread.send("again").unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(transport.last_request().unwrap().resume, None);
}

#[tokio::test]
async fn pending_frontend_tool_calls_are_visible_in_the_run_report_and_thread() {
    let finished = Event::RunFinished(
        RunFinishedEvent::new("t", "r")
            .with_outcome(RunOutcome::success_with_pending_tool_calls(["call-1"])),
    );
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        Event::tool_call_start("call-1", "lookup"),
        Event::tool_call_args("call-1", "{}"),
        Event::tool_call_end("call-1"),
        finished,
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    let report = thread.send("go").unwrap().collect_report().await;
    let expected = RunEnd::SuccessWithPendingToolCalls {
        result: None,
        pending_tool_call_ids: vec![ToolCallId::new("call-1")],
    };
    assert_eq!(report.end, expected);
    assert_eq!(thread.last_run_end(), Some(&expected));
    assert!(report.diagnostics.is_empty());
}

#[tokio::test]
async fn every_declared_frontend_call_must_be_answered_before_the_next_run() {
    let first = vec![
        Event::run_started("t", "r1"),
        Event::tool_call_start("call-1", "lookup"),
        Event::tool_call_end("call-1"),
        Event::tool_call_start("call-2", "lookup"),
        Event::tool_call_end("call-2"),
        Event::RunFinished(RunFinishedEvent::new("t", "r1").with_outcome(
            RunOutcome::success_with_pending_tool_calls(["call-1", "call-2"]),
        )),
    ];
    let transport = ReplayTransport::with_runs([
        first,
        vec![
            Event::run_started("t", "r2"),
            Event::run_finished_success("t", "r2"),
        ],
    ])
    .matching_requests();
    let inspect = transport.clone();
    let mut thread = Thread::new(transport, "t");
    assert!(matches!(
        thread.send("first").unwrap().collect_report().await.end,
        RunEnd::SuccessWithPendingToolCalls { .. }
    ));

    let before = thread.messages().len();
    let error = thread.send("too soon").expect_err("calls need answers");
    assert!(error.to_string().contains("call-1"), "{error}");
    assert!(error.to_string().contains("call-2"), "{error}");
    assert_eq!(thread.messages().len(), before);
    assert_eq!(inspect.requests().len(), 1);

    thread
        .push_message(Message::tool("answer-1", "call-1", "done"))
        .unwrap();
    let error = thread
        .send("still too soon")
        .expect_err("second call is pending");
    assert!(error.to_string().contains("call-2"), "{error}");
    assert_eq!(inspect.requests().len(), 1);

    thread
        .push_message(Message::tool("answer-2", "call-2", "done"))
        .unwrap();
    assert_eq!(
        thread.send("continue").unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
    let requests = inspect.requests();
    assert_eq!(requests.len(), 2);
    assert!(matches!(
        requests[1].messages.last(),
        Some(Message::User(_))
    ));
    assert!(requests[1].messages.iter().any(
        |message| matches!(message, Message::Tool(tool) if tool.tool_call_id.as_str() == "call-1")
    ));
    assert!(requests[1].messages.iter().any(
        |message| matches!(message, Message::Tool(tool) if tool.tool_call_id.as_str() == "call-2")
    ));
}

#[tokio::test]
async fn unanswered_calls_are_derived_when_success_omits_pending_ids() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r1"),
            Event::tool_call_start("call-1", "lookup"),
            Event::tool_call_end("call-1"),
            Event::run_finished_success("t", "r1"),
        ],
        vec![
            Event::run_started("t", "r2"),
            Event::run_finished_success("t", "r2"),
        ],
    ])
    .matching_requests();
    let inspect = transport.clone();
    let mut thread = Thread::new(transport, "t");
    assert_eq!(
        thread.send("first").unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
    let error = thread.run().expect_err("pending call must be derived");
    assert!(error.to_string().contains("call-1"), "{error}");
    assert_eq!(inspect.requests().len(), 1);

    thread
        .push_message(Message::tool("answer-1", "call-1", "done"))
        .unwrap();
    assert_eq!(
        thread.run().unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
    assert_eq!(inspect.requests().len(), 2);
}

#[tokio::test]
async fn a_server_tool_result_already_answers_its_call() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r1"),
            Event::tool_call_start("call-1", "lookup"),
            Event::tool_call_end("call-1"),
            Event::tool_call_result("result-1", "call-1", "done"),
            Event::run_finished_success("t", "r1"),
        ],
        vec![
            Event::run_started("t", "r2"),
            Event::run_finished_success("t", "r2"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    assert_eq!(
        thread.run().unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
    assert_eq!(
        thread.run().unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
}

#[tokio::test]
async fn send_message_can_answer_the_last_pending_tool_without_early_mutation() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r1"),
            Event::tool_call_start("call-1", "lookup"),
            Event::tool_call_end("call-1"),
            Event::run_finished_success("t", "r1"),
        ],
        vec![
            Event::run_started("t", "r2"),
            Event::run_finished_success("t", "r2"),
        ],
    ])
    .matching_requests();
    let inspect = transport.clone();
    let mut thread = Thread::new(transport, "t");
    thread.run().unwrap().collect_report().await;
    let before = thread.messages().to_vec();

    // Preparing, then abandoning, the answer must leave both the transcript
    // and the unanswered-call guard intact.
    drop(
        thread
            .send_message(Message::tool("answer", "call-1", "done"))
            .unwrap(),
    );
    assert_eq!(thread.messages(), before);
    assert_eq!(inspect.requests().len(), 1);
    assert!(thread.run().is_err());

    let report = thread
        .send_message(Message::tool("answer", "call-1", "done"))
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let requests = inspect.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].messages.last(),
        Some(&Message::tool("answer", "call-1", "done"))
    );
}

#[tokio::test]
async fn send_message_still_rejects_other_pending_tools_without_mutation_or_dispatch() {
    let transport = ReplayTransport::new([
        Event::run_started("t", "r1"),
        Event::tool_call_start("call-1", "lookup"),
        Event::tool_call_end("call-1"),
        Event::tool_call_start("call-2", "lookup"),
        Event::tool_call_end("call-2"),
        Event::run_finished_success("t", "r1"),
    ])
    .matching_requests();
    let inspect = transport.clone();
    let mut thread = Thread::new(transport, "t");
    thread.run().unwrap().collect_report().await;
    let before = thread.messages().to_vec();
    let error = thread
        .send_message(Message::tool("answer", "call-1", "done"))
        .unwrap_err();
    assert!(error.to_string().contains("call-2"), "{error}");
    assert!(!error.to_string().contains("call-1"), "{error}");
    assert_eq!(thread.messages(), before);
    assert_eq!(inspect.requests().len(), 1);
}

// A thread that cannot answer what a run left open must still have a way past
// it (#33). AG-UI 1.0 names the way for each: an interrupt the consumer judges
// expired "can still be — and, coverage being mandatory, must be — abandoned",
// and a tool call nobody will run is answered all the same, because "a failure
// is still an answer, as a tool message with `error` set".

const PAST: &str = "2000-01-01T00:00:00Z";

fn expiring(id: &str, expires_at: &str) -> Interrupt {
    let mut interrupt = Interrupt::new(id, "approval");
    interrupt.expires_at = Some(expires_at.into());
    interrupt
}

fn success() -> Vec<Event> {
    vec![
        Event::run_started("t", "r"),
        Event::run_finished_success("t", "r"),
    ]
}

/// Replies to the first request with `first` and then holds the connection
/// open, the way a server does that has gone quiet; replies to every later
/// request with a success. Records each request.
#[derive(Clone)]
struct GoesQuiet {
    first: fn(&RunAgentInput) -> Vec<Event>,
    requests: Arc<Mutex<Vec<RunAgentInput>>>,
}
impl GoesQuiet {
    fn new(first: fn(&RunAgentInput) -> Vec<Event>) -> Self {
        Self {
            first,
            requests: Arc::default(),
        }
    }
    fn requests(&self) -> Vec<RunAgentInput> {
        self.requests.lock().unwrap().clone()
    }
}
impl Transport for GoesQuiet {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        let mut requests = self.requests.lock().unwrap();
        requests.push(input.clone());
        let stream = if requests.len() == 1 {
            let events: Vec<_> = (self.first)(&input).into_iter().map(Ok).collect();
            TransportStream::typed(
                futures_util::stream::iter(events).chain(futures_util::stream::pending()),
            )
        } else {
            TransportStream::typed(futures_util::stream::iter([
                Ok(Event::run_started(
                    input.thread_id.clone(),
                    input.run_id.clone(),
                )),
                Ok(Event::run_finished_success(input.thread_id, input.run_id)),
            ]))
        };
        Box::pin(async move { Ok(stream) })
    }
}

#[tokio::test]
async fn an_expired_interrupt_is_declined_and_the_thread_moves_past_it() {
    // An expiry the thread cannot read is not evidence of expiry, and is
    // answered (`client_thread.rs`); one that has passed needs a way out.
    for (expires_at, refused) in [(PAST, "expired")] {
        let transport = ReplayTransport::with_runs([
            vec![
                Event::run_started("t", "r"),
                Event::run_finished_interrupt("t", "r", vec![expiring("i1", expires_at)]),
            ],
            success(),
            success(),
        ])
        .matching_requests();
        let inspect = transport.clone();
        let mut thread = Thread::new(transport, "t");
        thread.send("go").unwrap().collect_report().await;
        let pending = thread.interrupts()[0].clone();
        let before = thread.snapshot();

        // It can no longer be answered, and nothing may continue past it ...
        let error = thread.resume(&pending, true).unwrap_err();
        assert!(error.to_string().contains(refused), "{expires_at}: {error}");
        assert!(
            error.to_string().contains("declined"),
            "{expires_at}: {error}"
        );
        assert!(thread.send("next").is_err(), "{expires_at}");
        assert_eq!(thread.snapshot(), before, "{expires_at}");
        assert_eq!(inspect.requests().len(), 1, "{expires_at}");

        // ... but it can be declined, and that is said to the server.
        let report = thread.decline(&pending).unwrap().collect_report().await;
        assert_eq!(report.end, RunEnd::Success { result: None }, "{expires_at}");
        assert_eq!(
            inspect.requests()[1].resume,
            Some(vec![ResumeEntry::cancelled("i1")]),
            "{expires_at}"
        );
        assert!(thread.interrupts().is_empty(), "{expires_at}");
        assert!(thread.submission().is_none(), "{expires_at}");
        assert_eq!(
            thread.send("next").unwrap().collect_report().await.end,
            RunEnd::Success { result: None },
            "{expires_at}"
        );
    }
}

#[tokio::test]
async fn an_expired_interrupt_among_several_is_cancelled_while_the_rest_are_answered() {
    let late = expiring("late", PAST);
    let open = Interrupt::new("open", "approval");
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_interrupt("t", "r", vec![late.clone(), open.clone()]),
        ],
        success(),
    ])
    .matching_requests();
    let inspect = transport.clone();
    let mut thread = Thread::new(transport, "t");
    thread.send("go").unwrap().collect_report().await;

    let error = thread
        .resume_many([late.resolve(true), open.resolve(true)])
        .unwrap_err();
    assert!(error.to_string().contains("late has expired"), "{error}");
    // Cancelling the late one does not excuse leaving the other uncovered.
    assert!(thread.resume_many([late.cancel()]).is_err());
    assert_eq!(inspect.requests().len(), 1);

    let entries = [late.cancel(), open.resolve(true)];
    let report = thread
        .resume_many(entries.clone())
        .unwrap()
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    assert_eq!(inspect.requests()[1].resume, Some(entries.to_vec()));
}

#[tokio::test]
async fn a_pause_that_takes_effect_when_the_run_stops_can_be_declined_once_expired() {
    // The interrupts RUN_FINISHED reports take effect when the run ends: here,
    // when the application stops reading a connection that stayed open.
    for drop_it in [false, true] {
        let transport = GoesQuiet::new(|input| {
            vec![
                Event::run_started(input.thread_id.clone(), input.run_id.clone()),
                Event::run_finished_interrupt(
                    input.thread_id.clone(),
                    input.run_id.clone(),
                    vec![expiring("i1", PAST)],
                ),
            ]
        });
        let mut thread = Thread::new(transport.clone(), "t");
        let mut run = thread.send("go").unwrap();
        assert!(
            run.next().now_or_never().is_none(),
            "the pause before the stream said what follows it"
        );
        if drop_it {
            drop(run);
        } else {
            run.abort();
            let updates: Vec<_> = run.collect().await;
            assert!(
                matches!(
                    &updates[..],
                    [
                        Update::Interrupt(_),
                        Update::RunEnded(_),
                        Update::Done(RunEnd::Interrupted { .. })
                    ]
                ),
                "{updates:?}"
            );
        }
        assert_eq!(
            thread.interrupts(),
            [expiring("i1", PAST)],
            "drop {drop_it}"
        );
        assert!(thread.send("next").is_err(), "drop {drop_it}");

        let pending = thread.interrupts()[0].clone();
        let report = thread.decline(&pending).unwrap().collect_report().await;
        assert_eq!(
            report.end,
            RunEnd::Success { result: None },
            "drop {drop_it}"
        );
        assert_eq!(
            transport.requests()[1].resume,
            Some(vec![ResumeEntry::cancelled("i1")]),
            "drop {drop_it}"
        );
        assert!(thread.interrupts().is_empty(), "drop {drop_it}");
    }

    // And when a later run on the same stream ends the first one: the pause
    // took effect, and stays when the run after it is cut short.
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::run_finished_interrupt("t", "r", vec![expiring("i1", PAST)]),
            Event::run_started("t", "r-later"),
        ],
        success(),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    let report = thread.send("go").unwrap().collect_report().await;
    assert!(matches!(report.end, RunEnd::Failed { .. }), "{report:?}");
    assert!(
        matches!(report.runs[0].end, RunEnd::Interrupted { .. }),
        "{report:?}"
    );
    let pending = thread.interrupts()[0].clone();
    assert_eq!(
        thread.decline(&pending).unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
}

#[tokio::test]
async fn an_expired_pause_survives_a_snapshot_and_is_declined_after_restore() {
    let transport = ReplayTransport::new([
        Event::run_started("t", "r"),
        Event::run_finished_interrupt("t", "r", vec![expiring("i1", PAST)]),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    thread.send("go").unwrap().collect_report().await;
    let saved = serde_json::to_string(&thread.snapshot()).unwrap();

    let transport = ReplayTransport::new(success()).matching_requests();
    let mut restored =
        Thread::<_>::restore(transport.clone(), serde_json::from_str(&saved).unwrap()).unwrap();
    assert_eq!(restored.interrupts(), [expiring("i1", PAST)]);
    let pending = restored.interrupts()[0].clone();
    assert!(restored.resume(&pending, true).is_err());
    assert!(restored.send("next").is_err());
    assert_eq!(
        restored
            .decline(&pending)
            .unwrap()
            .collect_report()
            .await
            .end,
        RunEnd::Success { result: None }
    );
    assert_eq!(
        transport.last_request().unwrap().resume,
        Some(vec![ResumeEntry::cancelled("i1")])
    );
    assert!(restored.interrupts().is_empty());
}

fn calls_of(id: &str, messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|message| match message {
            Message::Assistant(assistant) => assistant
                .tool_calls
                .iter()
                .flatten()
                .any(|call| call.id == id),
            _ => false,
        })
        .count()
}

#[tokio::test]
async fn a_call_left_open_by_a_failed_run_is_abandoned_explicitly() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::tool_call_start("c1", "lookup"),
            Event::run_error("the model provider went away"),
        ],
        success(),
    ])
    .matching_requests();
    let inspect = transport.clone();
    let mut thread = Thread::new(transport, "t");
    let report = thread.send("go").unwrap().collect_report().await;
    assert!(matches!(report.end, RunEnd::Failed { .. }), "{report:?}");

    // Nothing can follow the dangling call, and the thread says which it is.
    let error = thread.send("again").unwrap_err();
    assert!(error.to_string().contains("c1"), "{error}");
    assert_eq!(inspect.requests().len(), 1);
    assert_eq!(thread.unanswered_tool_calls(), ["c1"]);

    let reason = "not run: the run that made this call failed";
    let c1 = ToolCallId::new("c1");
    thread.abandon_tool_call(&c1, reason).unwrap();
    assert!(thread.unanswered_tool_calls().is_empty());
    assert!(
        thread.abandon_tool_call(&c1, reason).is_err(),
        "an answered call is not abandoned twice"
    );
    assert!(
        thread
            .abandon_tool_call(&ToolCallId::new("unknown"), reason)
            .is_err()
    );

    // The call and its abandonment both stay in the transcript ...
    assert_eq!(calls_of("c1", thread.messages()), 1);
    let Some(Message::Tool(answer)) = thread.messages().last() else {
        panic!("{:?}", thread.messages());
    };
    assert_eq!(answer.tool_call_id, "c1");
    assert_eq!(answer.error.as_deref(), Some(reason));
    assert_eq!(answer.content, ToolContent::Text(reason.into()));
    let answer = Message::Tool(answer.clone());

    // ... survive a snapshot ...
    let restored = Thread::<_>::restore(ReplayTransport::new([]), thread.snapshot()).unwrap();
    assert_eq!(restored.messages(), thread.messages());
    assert!(restored.unanswered_tool_calls().is_empty());

    // ... and reach the server with the next run, before the new turn.
    let report = thread.send("again").unwrap().collect_report().await;
    assert_eq!(report.end, RunEnd::Success { result: None });
    let request = &inspect.requests()[1];
    assert_eq!(calls_of("c1", &request.messages), 1);
    let answered_at = request.messages.iter().position(|m| *m == answer);
    assert_eq!(answered_at, Some(request.messages.len() - 2), "{request:?}");
    assert!(matches!(request.messages.last(), Some(Message::User(_))));
}

#[tokio::test]
async fn a_call_left_open_by_an_aborted_run_is_abandoned_on_a_restored_thread() {
    let transport = GoesQuiet::new(|input| {
        vec![
            Event::run_started(input.thread_id.clone(), input.run_id.clone()),
            Event::tool_call_start("c1", "lookup"),
            Event::tool_call_args("c1", r#"{"query":"#),
        ]
    });
    let mut thread = Thread::new(transport, "t");
    let mut run = thread.send("go").unwrap();
    assert!(run.next().await.is_some());
    while run.next().now_or_never().flatten().is_some() {}
    let in_flight = run.thread().snapshot();
    assert!(in_flight.active_run_id.is_some());
    drop(run);
    assert_eq!(thread.last_run_end(), Some(&RunEnd::Aborted));
    assert_eq!(thread.unanswered_tool_calls(), ["c1"]);

    // A thread restored from the snapshot taken mid-run inherits the call.
    let transport = ReplayTransport::new(success()).matching_requests();
    let mut restored = Thread::<_>::restore(transport.clone(), in_flight).unwrap();
    assert_eq!(restored.last_run_end(), Some(&RunEnd::Aborted));
    assert_eq!(restored.unanswered_tool_calls(), ["c1"]);
    assert!(restored.send("again").is_err());
    restored
        .abandon_tool_call(&ToolCallId::new("c1"), "not run: the run was stopped")
        .unwrap();
    assert_eq!(
        restored.send("again").unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
    assert!(transport.last_request().unwrap().messages.iter().any(
        |message| matches!(message, Message::Tool(tool) if tool.tool_call_id == "c1" && tool.error.is_some())
    ));
}

#[tokio::test]
async fn a_late_run_error_leaves_the_call_it_paused_on_to_abandon() {
    // The approval RUN_FINISHED asked for is withdrawn by the RUN_ERROR after
    // it, so the call it concerned is left without a result.
    let mut approval = Interrupt::new("i1", "tool_approval");
    approval.tool_call_id = Some("c1".into());
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::tool_call_start("c1", "transfer_funds"),
            Event::tool_call_end("c1"),
            Event::run_finished_interrupt("t", "r", vec![approval]),
            Event::run_error("failed after pausing"),
        ],
        success(),
    ])
    .matching_requests();
    let mut thread = Thread::new(transport, "t");
    let report = thread.send("go").unwrap().collect_report().await;
    assert!(matches!(report.end, RunEnd::Failed { .. }), "{report:?}");
    assert!(thread.interrupts().is_empty());
    assert_eq!(thread.unanswered_tool_calls(), ["c1"]);
    assert!(thread.send("again").is_err());

    thread
        .abandon_tool_call(&ToolCallId::new("c1"), "not run: the run failed")
        .unwrap();
    assert_eq!(
        thread.send("again").unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
}

#[tokio::test]
async fn a_call_awaiting_an_interrupt_is_decided_by_the_interrupt_not_abandoned() {
    let mut approval = expiring("i1", PAST);
    approval.tool_call_id = Some("c1".into());
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("t", "r"),
            Event::tool_call_start("c1", "transfer_funds"),
            Event::tool_call_end("c1"),
            Event::run_finished_interrupt("t", "r", vec![approval]),
        ],
        success(),
    ])
    .matching_requests();
    let inspect = transport.clone();
    let mut thread = Thread::new(transport, "t");
    thread.send("go").unwrap().collect_report().await;
    let before = thread.snapshot();

    let error = thread
        .abandon_tool_call(&ToolCallId::new("c1"), "not run")
        .unwrap_err();
    assert!(error.to_string().contains("interrupt i1"), "{error}");
    assert_eq!(thread.snapshot(), before);

    // The approval expired, so it is declined, and that decides the call.
    let pending = thread.interrupts()[0].clone();
    assert_eq!(
        thread.decline(&pending).unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
    let request = &inspect.requests()[1];
    assert_eq!(request.resume, Some(vec![ResumeEntry::cancelled("i1")]));
    assert!(
        !request
            .messages
            .iter()
            .any(|message| matches!(message, Message::Tool(_)))
    );
    assert!(thread.unanswered_tool_calls().is_empty());
}
