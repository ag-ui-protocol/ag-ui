//! The human-in-the-loop round trip: pause, ask, resume.

#![cfg(feature = "client")]

use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{
    InterruptExt, RemoteAgent, ResumeBuilder, RunEnd, RunParams, Thread, Update, interrupts_of,
    resume_run,
};
use ag_ui::{Event, Interrupt, Message, ResumeStatus, RunAgentInput, TextMessageRole};
use futures_util::StreamExt;
use serde_json::json;

fn approval() -> Interrupt {
    Interrupt {
        message: Some("Delete the staging database?".into()),
        tool_call_id: Some("call-1".into()),
        ..Interrupt::new("i-1", "tool_approval")
    }
}

/// A run that pauses, and the run that follows it.
fn paused_then_resumed() -> ReplayTransport {
    ReplayTransport::with_runs([
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::tool_call_start("call-1", "drop_database"),
            Event::tool_call_args("call-1", r#"{"name":"staging"}"#),
            Event::tool_call_end("call-1"),
            Event::run_finished_interrupt("thread-1", "run-1", vec![approval()]),
        ],
        vec![
            Event::run_started("thread-1", "run-2"),
            Event::tool_call_result("msg-2", "call-1", "dropped"),
            Event::text_message_start("msg-3", TextMessageRole::Assistant),
            Event::text_message_content("msg-3", "Done."),
            Event::text_message_end("msg-3"),
            Event::run_finished_success("thread-1", "run-2"),
        ],
    ])
    .matching_requests()
}

#[tokio::test]
async fn an_interrupt_surfaces_and_resuming_sends_the_answer() {
    let transport = paused_then_resumed();
    let mut thread = Thread::<_>::new(transport.clone(), "thread-1");

    // First run: the agent pauses.
    let mut pending = Vec::new();
    let mut ended = None;
    let mut run = thread.send("drop the staging database").unwrap();
    while let Some(update) = run.next().await {
        match update {
            Update::Interrupt(interrupt) => pending.push(interrupt),
            Update::Done(end) => ended = Some(end),
            Update::Error(error) => panic!("unexpected error: {error}"),
            _ => {}
        }
    }
    drop(run);

    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, "i-1");
    assert!(pending[0].is_tool_approval());
    assert!(matches!(ended, Some(RunEnd::Interrupted { .. })));
    // The thread remembers what it is waiting for.
    assert_eq!(thread.interrupts().len(), 1);

    // Second run: the human said yes.
    let mut resumed = thread
        .resume(&pending[0], json!({ "approved": true }))
        .unwrap();
    while let Some(update) = resumed.next().await {
        if let Update::Error(error) = update {
            panic!("unexpected error: {error}");
        }
    }
    drop(resumed);

    let requests = transport.requests();
    assert_eq!(requests.len(), 2);

    let resume = requests[1]
        .resume
        .as_ref()
        .expect("the resuming request must carry the answers");
    assert_eq!(resume.len(), 1);
    assert_eq!(resume[0].interrupt_id, "i-1");
    assert_eq!(resume[0].status, ResumeStatus::Resolved);
    assert_eq!(resume[0].payload, Some(json!({ "approved": true })));

    // Same thread, a new run, and the conversation so far.
    assert_eq!(requests[1].thread_id, "thread-1");
    assert_ne!(requests[1].run_id, requests[0].run_id);
    assert!(requests[1].is_resume());
    assert!(!requests[1].messages.is_empty());

    // And the paused interrupt is no longer pending.
    assert!(thread.interrupts().is_empty());
    assert_eq!(thread.applier().text_of("msg-3"), Some("Done."));
}

#[tokio::test]
async fn declining_an_interrupt_resumes_with_a_cancellation() {
    let transport = paused_then_resumed();
    let mut thread = Thread::<_>::new(transport.clone(), "thread-1");

    let mut pending = Vec::new();
    let mut run = thread.send("drop the staging database").unwrap();
    while let Some(update) = run.next().await {
        if let Update::Interrupt(interrupt) = update {
            pending.push(interrupt);
        }
    }
    drop(run);

    let mut resumed = thread.decline(&pending[0]).unwrap();
    while resumed.next().await.is_some() {}
    drop(resumed);

    let resume = transport.requests()[1]
        .resume
        .clone()
        .expect("the resuming request must carry the answers");
    assert_eq!(resume[0].status, ResumeStatus::Cancelled);
    assert_eq!(resume[0].payload, None);
}

#[tokio::test]
async fn a_confirmed_approval_decision_does_not_block_later_runs() {
    for approved in [true, false] {
        let transport = ReplayTransport::with_runs([
            vec![
                Event::run_started("thread-1", "run-1"),
                Event::tool_call_start("call-1", "drop_database"),
                Event::tool_call_end("call-1"),
                Event::run_finished_interrupt("thread-1", "run-1", vec![approval()]),
            ],
            vec![
                Event::run_started("thread-1", "run-2"),
                Event::run_finished_success("thread-1", "run-2"),
            ],
            vec![
                Event::run_started("thread-1", "run-3"),
                Event::run_finished_success("thread-1", "run-3"),
            ],
        ])
        .matching_requests();
        let mut thread = Thread::new(transport.clone(), "thread-1");
        thread.send("first").unwrap().collect_report().await;
        let pending = thread.interrupts()[0].clone();
        let report = if approved {
            thread
                .resume(&pending, json!(true))
                .unwrap()
                .collect_report()
                .await
        } else {
            thread.decline(&pending).unwrap().collect_report().await
        };
        assert_eq!(report.end, RunEnd::Success { result: None });

        // The decision, including a decline, is an interrupt response. No
        // frontend ToolMessage is fabricated for the approval-linked call.
        let snapshot = thread.snapshot();
        let mut restored =
            Thread::<_, serde_json::Value>::restore(transport.clone(), snapshot).unwrap();
        assert_eq!(
            restored
                .send("next task")
                .unwrap()
                .collect_report()
                .await
                .end,
            RunEnd::Success { result: None }
        );
        assert_eq!(transport.requests().len(), 3);
    }
}

#[tokio::test]
async fn resuming_an_approval_still_requires_unrelated_frontend_tool_answers() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::tool_call_start("approval-call", "drop_database"),
            Event::tool_call_end("approval-call"),
            Event::tool_call_start("frontend-call", "choose_file"),
            Event::tool_call_end("frontend-call"),
            Event::run_finished_interrupt(
                "thread-1",
                "run-1",
                vec![Interrupt {
                    tool_call_id: Some("approval-call".into()),
                    ..approval()
                }],
            ),
        ],
        vec![
            Event::run_started("thread-1", "run-2"),
            Event::run_finished_success("thread-1", "run-2"),
        ],
        vec![
            Event::run_started("thread-1", "run-3"),
            Event::run_finished_success("thread-1", "run-3"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::new(transport.clone(), "thread-1");
    thread.send("first").unwrap().collect_report().await;
    let pending = thread.interrupts()[0].clone();
    let message_count = thread.messages().len();
    let error = thread
        .resume(&pending, json!(true))
        .expect_err("unrelated frontend call still needs an answer");
    assert!(error.to_string().contains("frontend-call"), "{error}");
    assert!(!error.to_string().contains("approval-call"), "{error}");
    assert_eq!(thread.messages().len(), message_count);
    assert_eq!(transport.requests().len(), 1);

    thread
        .push_message(Message::tool("answer-1", "frontend-call", "chosen"))
        .unwrap();
    assert_eq!(
        thread
            .resume(&pending, json!(true))
            .unwrap()
            .collect_report()
            .await
            .end,
        RunEnd::Success { result: None }
    );
    assert!(transport.requests()[1].resume.is_some());
    assert_eq!(
        thread.send("next task").unwrap().collect_report().await.end,
        RunEnd::Success { result: None }
    );
}

#[tokio::test]
async fn a_later_call_reusing_an_approval_id_is_pending_again() {
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::tool_call_start("call-1", "drop_database"),
            Event::tool_call_end("call-1"),
            Event::run_finished_interrupt("thread-1", "run-1", vec![approval()]),
        ],
        vec![
            Event::run_started("thread-1", "run-2"),
            Event::run_finished_success("thread-1", "run-2"),
        ],
        vec![
            Event::run_started("thread-1", "run-3"),
            Event::tool_call_start("call-1", "choose_file"),
            Event::tool_call_end("call-1"),
            Event::run_finished_success("thread-1", "run-3"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::new(transport.clone(), "thread-1");
    thread.send("first").unwrap().collect_report().await;
    let pending = thread.interrupts()[0].clone();
    thread.decline(&pending).unwrap().collect_report().await;
    thread.send("second").unwrap().collect_report().await;
    let error = thread
        .send("too soon")
        .expect_err("new call needs an answer");
    assert!(error.to_string().contains("call-1"), "{error}");
    assert_eq!(transport.requests().len(), 3);
}

#[tokio::test]
async fn several_interrupts_are_answered_in_one_request() {
    let first = Interrupt::new("i-1", "tool_approval");
    let second = Interrupt::new("i-2", "tool_approval");
    let transport = ReplayTransport::with_runs([
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::run_finished_interrupt("thread-1", "run-1", vec![first.clone(), second.clone()]),
        ],
        vec![
            Event::run_started("thread-1", "run-2"),
            Event::run_finished_success("thread-1", "run-2"),
        ],
    ])
    .matching_requests();
    let mut thread = Thread::<_>::new(transport.clone(), "thread-1");

    let updates: Vec<_> = thread.send("do two risky things").unwrap().collect().await;
    let interrupts: Vec<_> = updates
        .iter()
        .filter(|update| matches!(update, Update::Interrupt(_)))
        .collect();
    assert_eq!(interrupts.len(), 2, "one update per pending interrupt");

    let entries = ResumeBuilder::new()
        .resolve_with_edits(&first, json!({ "name": "staging-2" }))
        .cancel(&second)
        .build();
    let mut resumed = thread.resume_many(entries).unwrap();
    while resumed.next().await.is_some() {}
    drop(resumed);

    let resume = transport.requests()[1].resume.clone().expect("answers");
    assert_eq!(resume.len(), 2);
    assert_eq!(
        resume[0].payload,
        Some(json!({ "editedArgs": { "name": "staging-2" } }))
    );
    assert_eq!(resume[1].status, ResumeStatus::Cancelled);
}

#[tokio::test]
async fn the_low_level_api_can_do_the_round_trip_without_a_thread() {
    // A proxy holds the raw events and builds the resuming request itself.
    let transport = paused_then_resumed();
    let agent = RemoteAgent::new(transport.clone());

    let first = RunParams::new("thread-1", "run-1")
        .user("msg-1", "drop the staging database")
        .into_input();

    let mut pending = Vec::new();
    let mut events = agent.run_events(first.clone());
    while let Some(event) = events.next().await {
        let event = event.expect("the replay transport does not fail");
        pending.extend(interrupts_of(&event).iter().cloned());
    }
    assert_eq!(pending.len(), 1);

    let next = resume_run(&first, "run-2", vec![pending[0].resolve(json!(true))]);
    let mut events = agent.run_events(next);
    while events.next().await.is_some() {}

    let requests = transport.requests();
    assert_eq!(requests[1].run_id, "run-2");
    assert_eq!(requests[1].thread_id, "thread-1");
    // The resuming request carries the paused run's messages unchanged.
    assert_eq!(requests[1].messages, requests[0].messages);
    assert_eq!(
        requests[1].resume.as_ref().expect("answers")[0].payload,
        Some(json!(true))
    );
}

#[test]
fn interrupts_of_only_reports_a_paused_run() {
    let paused = Event::run_finished_interrupt("t", "r", vec![approval()]);
    assert_eq!(interrupts_of(&paused).len(), 1);

    // A finished run, however it spelled its outcome, is not paused.
    assert!(interrupts_of(&Event::run_finished_success("t", "r")).is_empty());
    assert!(interrupts_of(&Event::run_finished("t", "r")).is_empty());
    assert!(interrupts_of(&Event::text_message_end("m")).is_empty());
}

#[test]
fn an_empty_interrupt_outcome_is_a_protocol_error() {
    // The type system cannot say "at least one", so the applier checks.
    let mut applier = ag_ui::client::Applier::new();
    let broken = Event::run_finished_interrupt("t", "r", Vec::new());
    let error = applier
        .apply(&broken)
        .expect_err("an interrupt outcome needs an interrupt");
    assert!(
        error.to_string().contains("at least one interrupt"),
        "unexpected error: {error}"
    );
}

#[test]
fn resume_run_keeps_everything_but_the_run_id_and_the_answers() {
    let previous = RunAgentInput {
        state: json!({ "count": 1 }),
        messages: vec![Message::user("m-1", "hello")],
        ..RunAgentInput::new("thread-1", "run-1")
    };

    let next = resume_run(&previous, "run-2", vec![approval().cancel()]);

    assert_eq!(next.thread_id, previous.thread_id);
    assert_eq!(next.state, previous.state);
    assert_eq!(next.messages, previous.messages);
    assert_eq!(next.run_id, "run-2");
    assert!(next.is_resume());
}
