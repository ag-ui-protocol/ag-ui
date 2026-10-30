//! Subagent scopes: what a handle emits, what it attributes, and what the
//! driver does with one left open.

#![cfg(feature = "server")]

use ag_ui::server::{Agent, Error, EventReceiver, Result, RunContext, run};
use ag_ui::{
    Event, EventType, Interrupt, ResumeEntry, RunAgentInput, RunOutcome, SubagentOutcome,
    SubagentStartedEvent,
};
use futures_util::StreamExt as _;
use serde_json::json;

fn context() -> (RunContext<()>, EventReceiver) {
    RunContext::new(RunAgentInput::new("t", "run-1")).expect("an empty state always decodes")
}

fn tag(event: &Event) -> Option<&str> {
    event.subagent_run_id().map(|id| id.as_str())
}

fn types(events: &[Event]) -> Vec<EventType> {
    events.iter().map(Event::event_type).collect()
}

async fn collect(agent: impl Agent) -> Vec<Event> {
    run(agent, RunAgentInput::new("t", "run-1"))
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await
}

#[test]
fn everything_emitted_through_the_handle_is_attributed_until_the_scope_ends() {
    let (mut ctx, mut events) = context();
    ctx.say("before").unwrap();
    assert_eq!(ctx.subagent_run_id(), None);
    {
        let mut researcher = ctx.subagent("researcher").unwrap();
        assert_eq!(researcher.id().as_str(), "run-1-sub-1");
        assert_eq!(researcher.name(), "researcher");
        assert_eq!(
            researcher.subagent_run_id().map(|id| id.as_str()),
            Some("run-1-sub-1")
        );

        researcher.say("inside").unwrap();
        let mut call = researcher.tool_call("search").unwrap();
        call.args("{}").unwrap();
        call.result("ok").unwrap();
        let step = researcher.step("plan").unwrap();
        drop(step);
        researcher.think("hmm").unwrap();
        researcher.emit(Event::custom("ping", json!(1))).unwrap();
        researcher.finish().unwrap();
    }
    assert_eq!(ctx.subagent_run_id(), None);
    ctx.say("after").unwrap();

    let events = events.drain();
    let started = events
        .iter()
        .position(|e| e.event_type() == EventType::SubagentStarted)
        .unwrap();
    let finished = events
        .iter()
        .position(|e| e.event_type() == EventType::SubagentFinished)
        .unwrap();
    assert_eq!(started, 3, "the parent's own message came first");

    let Event::SubagentStarted(announce) = &events[started] else {
        panic!("wrong variant");
    };
    assert_eq!(announce.name, "researcher");
    assert_eq!(announce.parent_subagent_run_id, None);

    for event in &events[..started] {
        assert_eq!(tag(event), None, "{:?}", event.event_type());
    }
    for event in &events[started + 1..finished] {
        assert_eq!(tag(event), Some("run-1-sub-1"), "{:?}", event.event_type());
    }
    let Event::SubagentFinished(closed) = &events[finished] else {
        panic!("wrong variant");
    };
    assert_eq!(closed.outcome, Some(SubagentOutcome::Success));
    assert_eq!(closed.result, None);
    for event in &events[finished + 1..] {
        assert_eq!(tag(event), None, "{:?}", event.event_type());
    }
    assert_eq!(
        types(&events[finished - 1..]),
        [
            EventType::Custom,
            EventType::SubagentFinished,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
        ]
    );
}

#[test]
fn nested_scopes_link_to_their_parent_and_restore_it_on_close() {
    let (mut ctx, mut events) = context();
    {
        let mut planner = ctx.subagent("planner").unwrap();
        planner.say("outer").unwrap();
        {
            let mut estimator = planner.subagent("estimator").unwrap();
            assert_eq!(estimator.id().as_str(), "run-1-sub-2");
            estimator.say("inner").unwrap();
            estimator.finish().unwrap();
        }
        planner.say("outer again").unwrap();
        planner.finish().unwrap();
    }

    let events = events.drain();
    let Event::SubagentStarted(inner) = &events[4] else {
        panic!("expected the nested announcement, got {:?}", events[4]);
    };
    assert_eq!(inner.subagent_run_id.as_str(), "run-1-sub-2");
    assert_eq!(inner.parent_subagent_run_id.as_deref(), Some("run-1-sub-1"));

    let tags: Vec<Option<&str>> = events.iter().map(tag).collect();
    assert_eq!(
        tags,
        [
            Some("run-1-sub-1"), // SUBAGENT_STARTED: its own subject
            Some("run-1-sub-1"),
            Some("run-1-sub-1"),
            Some("run-1-sub-1"),
            Some("run-1-sub-2"), // nested SUBAGENT_STARTED
            Some("run-1-sub-2"),
            Some("run-1-sub-2"),
            Some("run-1-sub-2"),
            Some("run-1-sub-2"), // nested SUBAGENT_FINISHED
            Some("run-1-sub-1"), // the outer scope is back
            Some("run-1-sub-1"),
            Some("run-1-sub-1"),
            Some("run-1-sub-1"), // outer SUBAGENT_FINISHED
        ]
    );
}

#[test]
fn each_terminator_names_the_subagent_and_leaves_the_scope() {
    let (mut ctx, mut events) = context();

    let sub = ctx.subagent("a").unwrap();
    sub.finish_with(json!({ "sources": 3 })).unwrap();
    let sub = ctx.subagent("b").unwrap();
    sub.suspend(vec!["int-1".to_owned()]).unwrap();
    let sub = ctx.subagent("c").unwrap();
    sub.fail("boom").unwrap();
    let sub = ctx.subagent("d").unwrap();
    sub.fail_with_code("rate limited", "429").unwrap();
    assert_eq!(ctx.subagent_run_id(), None);

    let events = events.drain();
    let Event::SubagentFinished(a) = &events[1] else {
        panic!("wrong variant");
    };
    assert_eq!(a.subagent_run_id.as_str(), "run-1-sub-1");
    assert_eq!(a.result, Some(json!({ "sources": 3 })));
    assert_eq!(a.outcome, Some(SubagentOutcome::Success));

    let Event::SubagentFinished(b) = &events[3] else {
        panic!("wrong variant");
    };
    assert_eq!(b.subagent_run_id.as_str(), "run-1-sub-2");
    assert_eq!(b.outcome.as_ref().unwrap().interrupt_ids(), ["int-1"]);

    let Event::SubagentError(c) = &events[5] else {
        panic!("wrong variant");
    };
    assert_eq!(
        (
            c.subagent_run_id.as_str(),
            c.message.as_str(),
            c.code.as_deref()
        ),
        ("run-1-sub-3", "boom", None)
    );

    let Event::SubagentError(d) = &events[7] else {
        panic!("wrong variant");
    };
    assert_eq!(d.code.as_deref(), Some("429"));
}

#[test]
fn an_explicit_tag_inside_a_scope_is_kept_and_unattributable_events_stay_bare() {
    let (mut ctx, mut events) = context();
    {
        let mut sub = ctx.subagent("a").unwrap();
        sub.emit(Event::custom("mine", json!(1))).unwrap();
        sub.emit(Event::custom("theirs", json!(2)).with_subagent_run_id("other"))
            .unwrap();
        sub.emit(Event::messages_snapshot(Vec::new())).unwrap();
        sub.finish().unwrap();
    }
    let events = events.drain();
    assert_eq!(tag(&events[1]), Some("run-1-sub-1"));
    assert_eq!(tag(&events[2]), Some("other"));
    assert_eq!(tag(&events[3]), None);
}

#[test]
fn subagent_with_keeps_an_explicit_parent_and_fills_an_absent_one() {
    let (mut ctx, mut events) = context();
    let first = ctx.subagent("a").unwrap();
    first.finish().unwrap();
    {
        let mut outer = ctx.subagent("b").unwrap();
        // Explicit: the closed one, which a parent legitimately may be.
        let explicit = outer
            .subagent_with(
                SubagentStartedEvent::new("explicit", "c").with_parent_subagent("run-1-sub-1"),
            )
            .unwrap();
        explicit.finish().unwrap();
        // Absent: the enclosing scope.
        let implicit = outer
            .subagent_with(SubagentStartedEvent::new("implicit", "d"))
            .unwrap();
        implicit.finish().unwrap();
        outer.finish().unwrap();
    }
    let events = events.drain();
    let Event::SubagentStarted(explicit) = &events[3] else {
        panic!("wrong variant");
    };
    assert_eq!(
        explicit.parent_subagent_run_id.as_deref(),
        Some("run-1-sub-1")
    );
    let Event::SubagentStarted(implicit) = &events[5] else {
        panic!("wrong variant");
    };
    assert_eq!(
        implicit.parent_subagent_run_id.as_deref(),
        Some("run-1-sub-2")
    );
}

#[tokio::test]
async fn a_run_with_nested_subagents_passes_the_driver_and_the_verifier() {
    struct Supervisor;

    impl Agent for Supervisor {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut planner = ctx.subagent("planner")?;
            planner.say("Two tasks.")?;
            {
                let mut estimator = planner.subagent("estimator")?;
                estimator.say("A day each.")?;
                estimator.finish()?;
            }
            planner.finish_with(json!({ "tasks": 2 }))?;
            ctx.say("Plan ready.")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = collect(Supervisor).await;
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::SubagentStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::SubagentStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::SubagentFinished,
            EventType::SubagentFinished,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
    assert_eq!(tag(&events[6]), Some("run-1-sub-2"));
    assert_eq!(tag(&events[11]), None);
}

#[tokio::test]
async fn a_suspended_subagent_pauses_the_run_and_continues_under_the_same_id() {
    struct Deleter;

    impl Agent for Deleter {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let answered = ctx.resume_for("int-1").is_some();
            let mut sub = ctx.subagent_with(SubagentStartedEvent::new("sub-fixed", "deleter"))?;
            if answered {
                sub.say("Deleted.")?;
                sub.finish()?;
                return Ok(RunOutcome::Success);
            }
            sub.say("May I?")?;
            let interrupt =
                Interrupt::new("int-1", "tool_approval").with_subagent_run_id(sub.id().clone());
            sub.suspend(vec![interrupt.id.clone()])?;
            Ok(RunOutcome::interrupt(vec![interrupt]))
        }
    }

    let paused = collect(Deleter).await;
    let Event::SubagentFinished(finished) = &paused[5] else {
        panic!("expected SUBAGENT_FINISHED, got {:?}", paused[5]);
    };
    assert!(finished.outcome.as_ref().unwrap().is_suspended());
    assert_eq!(
        finished.outcome.as_ref().unwrap().interrupt_ids(),
        ["int-1"]
    );
    let Event::RunFinished(run_finished) = &paused[6] else {
        panic!("expected RUN_FINISHED, got {:?}", paused[6]);
    };
    let interrupts = run_finished.outcome.as_ref().unwrap().interrupts();
    assert_eq!(interrupts[0].subagent_run_id.as_deref(), Some("sub-fixed"));

    let mut input = RunAgentInput::new("t", "run-2");
    input.resume = Some(vec![ResumeEntry::resolved("int-1", json!(true))]);
    let resumed: Vec<Event> = run(Deleter, input)
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;
    let Event::SubagentStarted(again) = &resumed[1] else {
        panic!("expected SUBAGENT_STARTED, got {:?}", resumed[1]);
    };
    assert_eq!(
        again.subagent_run_id.as_str(),
        "sub-fixed",
        "a continuation reuses the id"
    );
    assert_eq!(
        resumed.last().map(Event::event_type),
        Some(EventType::RunFinished)
    );
}

#[tokio::test]
async fn a_scope_open_on_the_error_path_does_not_invent_success() {
    struct Broken;

    impl Agent for Broken {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut sub = ctx.subagent("x")?;
            sub.say("hi")?;
            Err(Error::agent("boom"))
        }
    }

    let events = collect(Broken).await;
    assert_eq!(
        types(&events),
        [
            EventType::RunStarted,
            EventType::SubagentStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunError,
        ]
    );
}

#[tokio::test]
async fn forgetting_to_finish_a_scope_rejects_success_and_interrupt_even_when_hidden() {
    use ag_ui::server::{Runner, SubagentVisibility};

    struct Unfinished(bool);
    impl Agent for Unfinished {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut child = ctx.subagent_events("worker")?;
            child.say("still running")?;
            drop(child);
            ctx.say("parent attribution restored")?;
            Ok(if self.0 {
                RunOutcome::interrupt(vec![Interrupt::new("approve", "approval")])
            } else {
                RunOutcome::Success
            })
        }
    }

    for interrupted in [false, true] {
        for hidden in [false, true] {
            let runner = Runner::new(Unfinished(interrupted));
            let runner = if hidden {
                runner.transformer(SubagentVisibility::hidden())
            } else {
                runner
            };
            let events: Vec<_> = runner
                .run(RunAgentInput::new("t", "r"))
                .map(|event| event.unwrap())
                .collect()
                .await;
            assert!(
                !events.iter().any(|event| matches!(
                    event,
                    Event::SubagentFinished(_) | Event::RunFinished(_)
                ))
            );
            let Event::RunError(error) = events.last().unwrap() else {
                panic!("unfinished producer must report a run error");
            };
            assert_eq!(error.code.as_deref(), Some("PROTOCOL_VIOLATION"));
            assert!(error.message.contains("explicit finish, fail or suspend"));
            assert!(events.iter().any(|event| matches!(event,
                Event::TextMessageContent(text)
                    if text.delta == "parent attribution restored"
                        && text.subagent_run_id.is_none()
            )));
        }
    }
}

#[tokio::test]
async fn an_explicit_child_failure_can_be_handled_by_its_parent() {
    struct Recovering;
    impl Agent for Recovering {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.subagent_events("worker")?.fail("search unavailable")?;
            ctx.say("Using the cached answer.")?;
            Ok(RunOutcome::Success)
        }
    }
    let events = collect(Recovering).await;
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::SubagentError(_)))
    );
    assert!(matches!(events.last(), Some(Event::RunFinished(_))));
}

#[test]
fn hand_interleaved_concurrent_subagents_are_accepted() {
    let (mut ctx, _events) = context();
    for event in [
        Event::run_started("t", "run-1"),
        Event::subagent_started("s1", "researcher"),
        Event::subagent_started("s2", "researcher"),
        Event::text_message_start("m1", Default::default()).with_subagent_run_id("s1"),
        Event::text_message_start("m2", Default::default()).with_subagent_run_id("s2"),
        Event::text_message_content("m1", "GDP is ").with_subagent_run_id("s1"),
        Event::text_message_content("m2", "Population is ").with_subagent_run_id("s2"),
        Event::text_message_end("m1").with_subagent_run_id("s1"),
        Event::subagent_finished_success("s1"),
        Event::text_message_end("m2").with_subagent_run_id("s2"),
        Event::subagent_error("s2", "rate limited"),
        Event::run_finished_success("t", "run-1"),
    ] {
        ctx.emit(event.clone())
            .unwrap_or_else(|error| panic!("{event:?} should be accepted: {error}"));
    }
}
