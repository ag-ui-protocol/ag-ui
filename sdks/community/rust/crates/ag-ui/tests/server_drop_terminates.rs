//! Forgetting `end()` is harmless: `Drop` emits the terminator.
//!
//! This is the guarantee the whole synchronous emit path exists to make
//! possible — `Drop` cannot await, so `delta()` cannot either.

#![cfg(feature = "server")]

use ag_ui::server::{Agent, Error, Result, RunContext, run};
use ag_ui::{Event, EventType, RunAgentInput, RunOutcome};
use futures_util::StreamExt as _;

async fn types(agent: impl Agent) -> Vec<EventType> {
    run(agent, RunAgentInput::new("t", "r"))
        .map(|event| event.expect("the run stream should not break"))
        .map(|event| event.event_type())
        .collect()
        .await
}

#[tokio::test]
async fn a_dropped_message_still_ends() {
    struct Forgetful;

    impl Agent for Forgetful {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut message = ctx.assistant_message()?;
            message.delta("no end() call here")?;
            Ok(RunOutcome::Success)
        }
    }

    assert_eq!(
        types(Forgetful).await,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn a_dropped_reasoning_block_closes_both_halves() {
    struct Forgetful;

    impl Agent for Forgetful {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut reasoning = ctx.reasoning()?;
            reasoning.delta("thinking")?;
            Ok(RunOutcome::Success)
        }
    }

    assert_eq!(
        types(Forgetful).await,
        [
            EventType::RunStarted,
            EventType::ReasoningStart,
            EventType::ReasoningMessageStart,
            EventType::ReasoningMessageContent,
            EventType::ReasoningMessageEnd,
            EventType::ReasoningEnd,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn a_dropped_tool_call_still_ends() {
    struct Forgetful;

    impl Agent for Forgetful {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut call = ctx.tool_call("search")?;
            call.args("{}")?;
            Ok(RunOutcome::Success)
        }
    }

    assert_eq!(
        types(Forgetful).await,
        [
            EventType::RunStarted,
            EventType::ToolCallStart,
            EventType::ToolCallArgs,
            EventType::ToolCallEnd,
            EventType::RunFinished,
        ]
    );
}

#[tokio::test]
async fn an_early_return_still_closes_everything() {
    struct Fails;

    impl Agent for Fails {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut step = ctx.step("attempt")?;
            let mut message = step.assistant_message()?;
            message.delta("halfway through")?;
            // The `?` unwinds through both the message and the step.
            Err(Error::agent("the model hung up"))
        }
    }

    assert_eq!(
        types(Fails).await,
        [
            EventType::RunStarted,
            EventType::StepStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::StepFinished,
            EventType::RunError,
        ]
    );
}

#[tokio::test]
async fn nested_steps_close_innermost_first() {
    struct Nested;

    impl Agent for Nested {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut outer = ctx.step("outer")?;
            {
                let mut inner = outer.step("inner")?;
                inner.say("deep")?;
            }
            outer.say("shallow")?;
            Ok(RunOutcome::Success)
        }
    }

    let events: Vec<Event> = run(Nested, RunAgentInput::new("t", "r"))
        .map(|event| event.expect("the run stream should not break"))
        .collect()
        .await;

    assert_eq!(
        events[1..3],
        [Event::step_started("outer"), Event::step_started("inner")]
    );
    assert_eq!(events[6], Event::step_finished("inner"));
    assert_eq!(events[10], Event::step_finished("outer"));
}

#[tokio::test]
async fn explicit_end_does_not_double_emit() {
    struct Tidy;

    impl Agent for Tidy {
        type State = ();

        async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
            let mut message = ctx.assistant_message()?;
            message.delta("done")?;
            message.end()?;

            let step = ctx.step("clean")?;
            step.finish()?;
            Ok(RunOutcome::Success)
        }
    }

    assert_eq!(
        types(Tidy).await,
        [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
            EventType::StepStarted,
            EventType::StepFinished,
            EventType::RunFinished,
        ]
    );
}
