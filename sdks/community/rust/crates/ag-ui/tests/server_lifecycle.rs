//! Every run starts with `RUN_STARTED` and ends with exactly one of
//! `RUN_FINISHED` / `RUN_ERROR` — whatever the agent does or fails to do.

#![cfg(feature = "server")]

use ag_ui::server::{Agent, Error, Result, RunContext, run};
use ag_ui::{Event, EventType, Interrupt, RunAgentInput, RunOutcome};
use futures_util::StreamExt as _;

async fn collect(agent: impl Agent, input: RunAgentInput) -> Vec<Event> {
    run(agent, input).collect().await
}

fn input() -> RunAgentInput {
    RunAgentInput::new("thread-1", "run-1")
}

struct Idle;

impl Agent for Idle {
    type State = ();

    async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn an_agent_that_does_nothing_still_brackets_the_run() {
    let events = collect(Idle, input()).await;

    assert_eq!(
        events,
        vec![
            Event::run_started("thread-1", "run-1"),
            Event::run_finished_success("thread-1", "run-1"),
        ]
    );
}

#[tokio::test]
async fn an_error_becomes_run_error_and_not_a_panic() {
    struct Broken;

    impl Agent for Broken {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("about to fail")?;
            Err(Error::agent("the weather service is down"))
        }
    }

    let events = collect(Broken, input()).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();

    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunError,
        ]
    );

    let Event::RunError(error) = events.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", events.last());
    };
    assert_eq!(error.code.as_deref(), Some("AGENT_ERROR"));
    assert!(
        error.message.contains("the weather service is down"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn failing_mid_message_closes_the_message_before_run_error() {
    // What a peer AG-UI server sends here is not settled: upstream's own client
    // verifier allows RUN_ERROR at any point — `client/src/verify/verify.ts`,
    // `case EventType.RUN_ERROR: // RUN_ERROR can happen at any time` — and the
    // Python integrations yield a bare RunErrorEvent out of an `except` block,
    // leaving whatever was open open. Our verifier exempts RUN_ERROR from the
    // open-at-finish rule so that stream is accepted from a peer.
    //
    // What we *emit* is the tidier end of that range, and not by choice: the
    // message handle closes itself on `Drop`, so the `?` that ends the run
    // unwinds through TEXT_MESSAGE_END on the way out. A client that tolerates
    // the bare form tolerates this one too, so the strict output is the safe
    // one to send.
    struct FailsMidSentence;

    impl Agent for FailsMidSentence {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut message = ctx.assistant_message()?;
            message.delta("half a sen")?;
            Err(Error::agent("the model hung up"))
        }
    }

    let events = collect(FailsMidSentence, input()).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();

    assert_eq!(
        types,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunError,
        ],
        "the open message is closed on the way out, then the run reports"
    );
}

#[tokio::test]
async fn an_interrupt_outcome_rides_on_run_finished() {
    struct Asks;

    impl Agent for Asks {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.say("May I delete the file?")?;
            Ok(RunOutcome::interrupt(vec![Interrupt::new(
                "i-1",
                "tool_approval",
            )]))
        }
    }

    let events = collect(Asks, input()).await;
    let Event::RunFinished(finished) = events.last().expect("a terminal event") else {
        panic!("expected RUN_FINISHED, got {:?}", events.last());
    };

    assert_eq!(
        finished.outcome,
        Some(RunOutcome::interrupt(vec![Interrupt::new(
            "i-1",
            "tool_approval"
        )]))
    );
}

#[tokio::test]
async fn an_empty_interrupt_list_is_rejected_rather_than_shipped() {
    struct Empty;

    impl Agent for Empty {
        type State = ();

        async fn run(&self, _ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            Ok(RunOutcome::Interrupt {
                interrupts: Vec::new(),
            })
        }
    }

    let events = collect(Empty, input()).await;
    let Event::RunError(error) = events.last().expect("a terminal event") else {
        panic!("expected RUN_ERROR, got {:?}", events.last());
    };
    assert_eq!(error.code.as_deref(), Some("PROTOCOL"));
}

#[tokio::test]
async fn a_resuming_request_reaches_the_agent() {
    struct Resumes;

    impl Agent for Resumes {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            assert!(ctx.is_resume());
            let answer = ctx.resume_for("i-1").expect("the answer to i-1");
            assert_eq!(answer.status, ag_ui::ResumeStatus::Resolved);
            ctx.say("Deleted.")?;
            Ok(RunOutcome::Success)
        }
    }

    let mut input = input();
    input.resume = Some(vec![ag_ui::ResumeEntry::resolved(
        "i-1",
        serde_json::json!(true),
    )]);

    let events = collect(Resumes, input).await;
    assert_eq!(events.len(), 5, "{events:#?}");
}

#[tokio::test]
async fn an_agent_that_ends_the_run_itself_is_not_terminated_twice() {
    struct EndsItself;

    impl Agent for EndsItself {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.emit(Event::run_error("I will report this myself"))?;
            Ok(RunOutcome::Success)
        }
    }

    let events = collect(EndsItself, input()).await;
    let types: Vec<_> = events.iter().map(Event::event_type).collect();
    assert_eq!(types, [EventType::RunStarted, EventType::RunError]);
}

#[tokio::test]
async fn the_agent_sees_the_whole_request() {
    struct Inspects;

    impl Agent for Inspects {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            assert_eq!(ctx.thread_id().as_str(), "thread-1");
            assert_eq!(ctx.run_id().as_str(), "run-1");
            assert_eq!(ctx.messages().len(), 1);
            assert_eq!(ctx.tools().len(), 1);
            assert!(ctx.tool("search").is_some());
            assert_eq!(ctx.context().len(), 1);
            assert_eq!(ctx.forwarded_props()["tenant"], "acme");
            Ok(RunOutcome::Success)
        }
    }

    let mut input = input();
    input.messages = vec![ag_ui::Message::user("m-1", "hello")];
    input.tools = vec![ag_ui::Tool::new(
        "search",
        "Search the web",
        serde_json::json!({"type": "object"}),
    )];
    input.context = vec![ag_ui::Context::new("page", "/invoices")];
    input.forwarded_props = serde_json::json!({"tenant": "acme"});

    collect(Inspects, input).await;
}

#[test]
fn the_run_stream_is_send_and_static() {
    // What a transport needs to hand it to `axum::response::Sse`. Asserted
    // here so a change to the driver cannot quietly take it away.
    fn assert_send_static<T: Send + 'static>(_value: T) {}
    assert_send_static(run(Idle, input()));
}

#[tokio::test]
async fn a_boxed_agent_runs_like_any_other() {
    let agent: ag_ui::server::BoxAgent<()> = Box::new(Idle);
    let events = collect(agent, input()).await;
    assert_eq!(events.len(), 2);
}

#[tokio::test]
async fn a_shared_agent_runs_like_any_other() {
    let agent = std::sync::Arc::new(Idle);
    let events = collect(agent.clone(), input()).await;
    assert_eq!(events.len(), 2);
    // …and the original is still usable.
    assert_eq!(collect(agent, input()).await.len(), 2);
}

fn usage(model: &str, input_tokens: u64, output_tokens: u64) -> ag_ui::TokenUsage {
    ag_ui::TokenUsage {
        model: Some(model.to_owned()),
        input_tokens: Some(input_tokens),
        output_tokens: Some(output_tokens),
        ..Default::default()
    }
}

struct Reports;

impl Agent for Reports {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.add_usage(usage("small", 10, 2));
        ctx.add_usage(usage("large", 100, 20));
        ctx.add_usage(usage("small", 5, 1));
        // Labels without counts report nothing.
        ctx.add_usage(ag_ui::TokenUsage {
            model: Some("idle".to_owned()),
            ..Default::default()
        });
        ctx.set_result(serde_json::json!({"answer": 42}));
        Ok(RunOutcome::Success)
    }
}

#[tokio::test]
async fn the_result_and_usage_an_agent_reports_ride_on_run_finished() {
    let events = collect(Reports, input()).await;
    let Some(Event::RunFinished(finished)) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(finished.result, Some(serde_json::json!({"answer": 42})));
    // One entry per model, in order of first appearance.
    assert_eq!(
        finished.usage,
        Some(vec![usage("small", 15, 3), usage("large", 100, 20)])
    );
}

#[tokio::test]
async fn a_failed_run_reports_its_usage_and_no_result() {
    struct SpendsThenFails;

    impl Agent for SpendsThenFails {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.add_usage(usage("small", 10, 2));
            ctx.set_result("never sent");
            Err(Error::agent("the model stopped answering"))
        }
    }

    let events = collect(SpendsThenFails, input()).await;
    let Some(Event::RunError(error)) = events.last() else {
        panic!("{events:?}");
    };
    assert_eq!(error.usage, Some(vec![usage("small", 10, 2)]));
}

#[tokio::test]
async fn a_run_that_reports_nothing_writes_neither_field() {
    let events = collect(Idle, input()).await;
    let json = serde_json::to_value(events.last().unwrap()).unwrap();
    assert!(json.get("result").is_none(), "{json}");
    assert!(json.get("usage").is_none(), "{json}");
}

#[tokio::test]
async fn a_tool_call_can_name_the_message_that_requested_it() {
    struct Calls;

    impl Agent for Calls {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let message_id = ctx.say("Checking.")?;
            let start = ag_ui::ToolCallStartEvent::new("call-1", "lookup")
                .with_parent_message_id(message_id);
            let mut call = ctx.tool_call_with(start)?;
            assert_eq!(call.id().as_str(), "call-1");
            call.args("{}")?;
            call.result("done")?;
            Ok(RunOutcome::Success)
        }
    }

    let events = collect(Calls, input()).await;
    let start = events
        .iter()
        .find_map(|event| match event {
            Event::ToolCallStart(start) => Some(start),
            _ => None,
        })
        .expect("a tool call");
    assert_eq!(
        start.parent_message_id.as_ref().map(|id| id.as_str()),
        Some("run-1-msg-1")
    );
    assert_eq!(
        events.last().map(Event::event_type),
        Some(EventType::RunFinished)
    );
}

#[tokio::test]
async fn a_filtered_terminal_still_closes_the_wire_stream_once() {
    use ag_ui::server::{Runner, StreamTransformer};

    struct FilterTerminal {
        replace: bool,
    }
    impl StreamTransformer for FilterTerminal {
        fn transform(&mut self, event: Event) -> Vec<Event> {
            match event {
                Event::RunFinished(_) if self.replace => vec![Event::custom("closing", true)],
                Event::RunFinished(_) | Event::RunError(_) => vec![],
                _ => vec![event],
            }
        }
    }
    for replace in [false, true] {
        let events: Vec<Event> = Runner::new(Reports)
            .transformer(FilterTerminal { replace })
            .run(input())
            .collect()
            .await;
        assert_eq!(events.len(), if replace { 3 } else { 2 }, "{events:?}");
        assert!(matches!(events.first(), Some(Event::RunStarted(_))));
        if replace {
            assert!(matches!(&events[1], Event::Custom(_)));
        }
        assert!(
            matches!(events.last(), Some(Event::RunError(error))
            if error.usage.is_none() && error.code.as_deref() == Some("PROTOCOL_VIOLATION")),
            "{events:?}"
        );
    }
}

#[tokio::test]
async fn ids_from_history_are_reserved_even_without_an_input_echo() {
    use ag_ui::server::Runner;
    use ag_ui::{AssistantMessage, Message, ToolCall};

    struct Mint;
    impl Agent for Mint {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            assert_eq!(ctx.new_message_id().as_str(), "run-1-msg-5");
            assert_eq!(ctx.new_tool_call_id().as_str(), "run-1-call-7");
            assert_eq!(ctx.new_subagent_run_id().as_str(), "run-1-sub-3");
            Ok(RunOutcome::Success)
        }
    }
    let mut request = input();
    request.messages = vec![
        Message::Assistant(AssistantMessage {
            id: "run-1-msg-4".into(),
            tool_calls: Some(vec![ToolCall::new("run-1-call-5", "old", "{}")]),
            subagent_run_id: Some("run-1-sub-2".into()),
            ..Default::default()
        }),
        Message::tool("archived-result", "run-1-call-6", "ok"),
    ];
    let (mut ctx, _events) = RunContext::new(request.clone()).unwrap();
    Mint.run(&mut ctx).await.unwrap();
    for echo in [false, true] {
        let events: Vec<Event> = Runner::new(Mint)
            .echo_input(echo)
            .run(request.clone())
            .collect()
            .await;
        assert!(matches!(events.last(), Some(Event::RunFinished(_))));
    }

    let sent = [Event::run_started("thread-1", "run-1")];
    let (driver, events) = Runner::new(Mint).continue_run(request, &sent).unwrap();
    driver.await;
    assert!(matches!(
        events.collect::<Vec<_>>().await.as_slice(),
        [Event::RunFinished(_)]
    ));
}

#[tokio::test]
async fn generated_ids_skip_explicit_ids_from_the_agent_and_transformers() {
    use ag_ui::TextMessageRole;
    use ag_ui::server::{Runner, StreamTransformer};

    struct Rename;
    impl StreamTransformer for Rename {
        fn transform(&mut self, mut event: Event) -> Vec<Event> {
            match &mut event {
                Event::TextMessageStart(e) => e.message_id = "run-1-msg-7".into(),
                Event::TextMessageEnd(e) => e.message_id = "run-1-msg-7".into(),
                _ => {}
            }
            vec![event]
        }
    }
    struct Names;
    impl Agent for Names {
        type State = ();
        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            ctx.message_with_id("run-1-msg-4", TextMessageRole::Assistant)?
                .end()?;
            assert_eq!(ctx.new_message_id().as_str(), "run-1-msg-8");
            ctx.tool_call_with_id("run-1-call-3", "search")?.end()?;
            assert_eq!(ctx.new_tool_call_id().as_str(), "run-1-call-4");
            ctx.subagent_with(ag_ui::SubagentStartedEvent::new("run-1-sub-5", "worker"))?
                .finish()?;
            assert_eq!(ctx.new_subagent_run_id().as_str(), "run-1-sub-6");
            Ok(RunOutcome::Success)
        }
    }
    let events: Vec<_> = Runner::new(Names)
        .transformer(Rename)
        .run(input())
        .collect()
        .await;
    assert!(matches!(events.last(), Some(Event::RunFinished(_))));
}

#[tokio::test]
async fn a_transformer_cannot_publish_an_invalid_terminal_outcome() {
    use ag_ui::server::{Runner, StreamTransformer};

    struct InvalidTerminal;
    impl StreamTransformer for InvalidTerminal {
        fn transform(&mut self, event: Event) -> Vec<Event> {
            match event {
                Event::RunFinished(_) => {
                    vec![Event::run_finished_interrupt("thread-1", "run-1", vec![])]
                }
                _ => vec![event],
            }
        }
    }

    let events: Vec<_> = Runner::new(Idle)
        .transformer(InvalidTerminal)
        .run(input())
        .collect()
        .await;
    assert!(
        matches!(events.as_slice(), [Event::RunStarted(_), Event::RunError(error)]
        if error.code.as_deref() == Some("PROTOCOL_VIOLATION") && error.message.contains("interrupt")),
        "{events:?}"
    );
}
