//! Two runs in flight on one conversation, merged, and a third request that
//! carries both.
//!
//! A [`Thread`](ag_ui::client::Thread) has one request in flight: `send`
//! borrows it until the stream ends. An application that wants a quick answer
//! while a long run works on the same conversation holds two threads with the
//! same thread id, and merges their messages once both streams have ended.
//! This is that pattern from start to finish, over real HTTP:
//!
//! 1. a second thread is made from a snapshot of the first;
//! 2. the long run starts on one, the quick question is asked and answered on
//!    the other while the long run is still open;
//! 3. both can be drawn as one list at any moment (`merge_messages`);
//! 4. when both have ended, one thread takes the other's messages
//!    (`merge_messages_from`), and the application settles the state;
//! 5. the next request carries both runs.
//!
//! The overlap is not left to luck. The long run stops at a gate that the
//! test opens only after the quick answer has arrived, so a server that
//! answered one request per conversation at a time would hang here, and the
//! deadline turns that into a failure.
//!
//! `concurrent_runs.rs` covers the other case, many conversations at once.

mod common;

use std::sync::Arc;
use std::time::Duration;

use ag_ui::client::{HttpAgent, MessageChangeKind, RunEnd, Update, merge_messages};
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::{Message, RunOutcome};
use common::{serve, transport};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use tokio::time::timeout;

const CONVERSATION: &str = "conversation-1";

/// A hang is the failure being ruled out, so every wait has a deadline.
const DEADLINE: Duration = Duration::from_secs(20);

/// What the agent and the application share.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Board {
    report: String,
    clock: String,
}

/// Writes a report in two parts with a wait between them, tells the time at
/// once, and on request repeats what it was shown.
struct Desk {
    /// Held shut until the test has seen the quick answer arrive.
    gate: Arc<Notify>,
}

impl Agent for Desk {
    type State = Board;

    async fn run(&self, ctx: &mut RunContext<Board>) -> Result<RunOutcome> {
        match ctx.last_user_text().unwrap_or_default().as_str() {
            "Write the report" => {
                ctx.say("Report, part one.")?;
                self.gate.notified().await;
                ctx.say("Report, part two.")?;
                ctx.update_state(|board| board.report = "ready".to_owned())?;
            }
            "What time is it?" => {
                ctx.say("It is noon.")?;
                ctx.update_state(|board| board.clock = "noon".to_owned())?;
            }
            "What have we said?" => {
                let mut shown: Vec<String> = ctx.messages().iter().map(line).collect();
                let board = ctx.state();
                shown.push(format!(
                    "state: report={} clock={}",
                    board.report, board.clock
                ));
                ctx.say(shown.join("\n"))?;
            }
            _ => {
                ctx.say("Hello.")?;
            }
        }
        Ok(RunOutcome::Success)
    }
}

/// One message as `role: text`.
fn line(message: &Message) -> String {
    let text = match message {
        Message::User(user) => user.content.to_text(),
        Message::Assistant(assistant) => assistant.content.clone().unwrap_or_default(),
        _ => String::new(),
    };
    format!("{}: {text}", message.role())
}

fn lines(messages: &[Message]) -> Vec<String> {
    messages.iter().map(line).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_run_and_a_quick_question_are_merged_and_the_next_request_carries_both() {
    let gate = Arc::new(Notify::new());
    let url = serve(Desk {
        gate: Arc::clone(&gate),
    })
    .await;
    let agent = HttpAgent::from_transport(transport(&url));

    // The conversation so far: one finished turn.
    let mut main = agent
        .thread_with_state(CONVERSATION, Board::default())
        .expect("typed thread");
    let report = main
        .send("Hello")
        .expect("preflight")
        .collect_report()
        .await;
    assert_eq!(report.end, RunEnd::Success { result: None });

    // 1. A second thread on the same conversation, holding the same messages
    //    and state. It is made before the long run is sent, so both start
    //    from one place.
    let mut side = agent
        .restore_thread_with_state::<Board>(main.snapshot())
        .expect("a snapshot of a thread at rest restores");
    assert_eq!(side.thread_id(), main.thread_id());
    assert_eq!(side.messages(), main.messages());

    // 2. The long run starts, and borrows `main` until its stream ends. Read
    //    it until the first part has arrived: it is in flight, at the gate.
    let mut long = main.send("Write the report").expect("preflight");
    loop {
        let update = timeout(DEADLINE, long.next())
            .await
            .expect("the long run must start");
        match update {
            Some(Update::Message(update)) if update.change == MessageChangeKind::Ended => break,
            Some(Update::Error(error)) => panic!("the long run failed: {error}"),
            Some(_) => {}
            None => panic!("the long run ended before the gate was opened"),
        }
    }

    //    The quick question goes to the other thread, and is answered from
    //    start to finish while the long run is still open.
    let quick = timeout(
        DEADLINE,
        side.send("What time is it?")
            .expect("preflight")
            .collect_report(),
    )
    .await
    .expect("a quick question must not wait for the long run on the same conversation");
    assert_eq!(quick.end, RunEnd::Success { result: None });

    // 3. One list of both, for a view, while the long run is still running.
    let on_screen = merge_messages(long.thread().messages(), side.messages());
    assert_eq!(
        lines(&on_screen),
        [
            "user: Hello",
            "assistant: Hello.",
            "user: Write the report",
            "assistant: Report, part one.",
            "user: What time is it?",
            "assistant: It is noon.",
        ]
    );

    //    Now the long run may finish.
    gate.notify_one();
    let report = timeout(DEADLINE, long.collect_report())
        .await
        .expect("the long run must finish once the gate is open");
    assert_eq!(report.end, RunEnd::Success { result: None });

    // 4. Both streams have ended. `main` takes the messages it lacks: the
    //    question and its answer, after its own.
    let merged = main
        .merge_messages_from(&side)
        .expect("both threads are at rest");
    assert_eq!(merged.added.len(), 2);
    assert!(merged.differing.is_empty());
    assert_eq!(
        lines(main.messages()),
        [
            "user: Hello",
            "assistant: Hello.",
            "user: Write the report",
            "assistant: Report, part one.",
            "assistant: Report, part two.",
            "user: What time is it?",
            "assistant: It is noon.",
        ]
    );

    //    State is not merged. Each thread holds what its own run left, and
    //    the application decides what the next run starts from.
    let ours = main.state().expect("typed state").clone();
    let theirs = side.state().expect("typed state").clone();
    assert_eq!((ours.report.as_str(), ours.clock.as_str()), ("ready", ""));
    assert_eq!(
        (theirs.report.as_str(), theirs.clock.as_str()),
        ("", "noon")
    );
    main.set_state(serde_json::json!(Board {
        report: ours.report,
        clock: theirs.clock,
    }))
    .expect("a Board");

    // 5. The next request carries both runs, in that order, and the state
    //    the application settled. The agent says what it was shown.
    let report = timeout(
        DEADLINE,
        main.send("What have we said?")
            .expect("the merged thread owes nothing, so it can send")
            .collect_report(),
    )
    .await
    .expect("the third run must finish");
    assert_eq!(report.end, RunEnd::Success { result: None });
    let Some(Message::Assistant(answer)) = main.messages().last() else {
        panic!("the third run must answer: {:?}", main.messages());
    };
    assert_eq!(
        answer.content.as_deref(),
        Some(
            "user: Hello\n\
             assistant: Hello.\n\
             user: Write the report\n\
             assistant: Report, part one.\n\
             assistant: Report, part two.\n\
             user: What time is it?\n\
             assistant: It is noon.\n\
             user: What have we said?\n\
             state: report=ready clock=noon"
        )
    );
}
