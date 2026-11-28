//! A client that goes away has to reach the agent.
//!
//! Dropping the response body already stops the run — polling the stream is
//! what runs the agent — but that is invisible to anything the run reached
//! *outside* itself. So the agent here carries a guard that records, on its way
//! out, whether it was cancelled, and reports through a channel. Nothing in
//! this file is timed: the assertions wait on a channel or on the cancellation
//! token, with a deadline only so that a hang fails instead of hanging.

mod common;

use std::time::Duration;

use ag_ui::client::{RemoteAgent, RunParams, Thread};
use ag_ui::server::{Agent, CancellationToken, Result, RunContext};
use ag_ui::{EventType, RunOutcome};
use common::{serve, transport};
use futures_util::StreamExt as _;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::time::timeout;

/// A hang is one of the things being ruled out, so every wait has a deadline.
const DEADLINE: Duration = Duration::from_secs(10);

/// Reports whether the run had been cancelled by the time the agent's future
/// went away — on *every* way out, including the one where the future is simply
/// dropped mid-await.
struct ExitGuard {
    token: CancellationToken,
    report: UnboundedSender<bool>,
}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        let _ = self.report.send(self.token.is_cancelled());
    }
}

/// Says one thing, then waits forever — an agent thirty seconds into a model
/// call, which is when a user actually hits stop.
struct Patient {
    token: UnboundedSender<CancellationToken>,
    exit: UnboundedSender<bool>,
}

impl Agent for Patient {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let _ = self.token.send(ctx.cancel_token());
        ctx.say("working on it")?;

        let _guard = ExitGuard {
            token: ctx.cancel_token(),
            report: self.exit.clone(),
        };
        std::future::pending::<()>().await;
        Ok(RunOutcome::Success)
    }
}

/// Finishes at once, through the same guard — the other half of the claim.
struct Prompt {
    exit: UnboundedSender<bool>,
}

impl Agent for Prompt {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let _guard = ExitGuard {
            token: ctx.cancel_token(),
            report: self.exit.clone(),
        };
        ctx.say("done")?;
        Ok(RunOutcome::Success)
    }
}

/// Waits for the agent's exit report.
async fn exit_report(rx: &mut tokio::sync::mpsc::UnboundedReceiver<bool>) -> bool {
    timeout(DEADLINE, rx.recv())
        .await
        .expect("the agent's future should have been dropped by now")
        .expect("the guard reports before the channel closes")
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_the_event_stream_mid_run_cancels_the_agent() {
    let (token_tx, mut token_rx) = unbounded_channel();
    let (exit_tx, mut exit_rx) = unbounded_channel();
    let url = serve(Patient {
        token: token_tx,
        exit: exit_tx,
    })
    .await;

    {
        let client = RemoteAgent::new(transport(&url));
        let mut events = client.run_events(RunParams::new("patient", "patient-run-1"));

        // Read until the agent has finished speaking, so the run is
        // unambiguously under way before the plug is pulled.
        for expected in [
            EventType::RunStarted,
            EventType::TextMessageStart,
            EventType::TextMessageContent,
            EventType::TextMessageEnd,
        ] {
            let event = timeout(DEADLINE, events.next())
                .await
                .expect("the agent should be streaming")
                .expect("the stream should not end here")
                .expect("the stream should not break");
            assert_eq!(event.event_type(), expected);
        }
    } // the stream and the client go away here

    let token = timeout(DEADLINE, token_rx.recv())
        .await
        .expect("the agent should have handed out its token")
        .expect("one token per run");
    timeout(DEADLINE, token.cancelled())
        .await
        .expect("the disconnect should have reached the run");

    assert!(
        exit_report(&mut exit_rx).await,
        "the agent left the run without ever seeing the cancellation"
    );
}

/// The same, one layer up: a UI dropping a [`Thread`]'s run stream is the
/// ordinary way this happens.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_thread_run_stream_cancels_the_agent() {
    let (token_tx, mut token_rx) = unbounded_channel();
    let (exit_tx, mut exit_rx) = unbounded_channel();
    let url = serve(Patient {
        token: token_tx,
        exit: exit_tx,
    })
    .await;

    let mut thread = Thread::<_>::new(transport(&url), "patient");
    {
        let mut run = thread.send("take your time").expect("run preflight");
        // Four events in, the agent is waiting and the user changes their mind.
        for _ in 0..3 {
            timeout(DEADLINE, run.next())
                .await
                .expect("the agent should be streaming")
                .expect("the run should not have ended");
        }
    }
    drop(thread);

    let token = timeout(DEADLINE, token_rx.recv())
        .await
        .expect("the agent should have handed out its token")
        .expect("one token per run");
    timeout(DEADLINE, token.cancelled())
        .await
        .expect("abandoning the run stream should have reached the agent");

    assert!(
        exit_report(&mut exit_rx).await,
        "the agent left the run without ever seeing the cancellation"
    );
}

/// The guard's other half: finishing is not disconnecting.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_completes_is_never_reported_as_cancelled() {
    let (exit_tx, mut exit_rx) = unbounded_channel();
    let url = serve(Prompt { exit: exit_tx }).await;

    let client = RemoteAgent::new(transport(&url));
    let events: Vec<EventType> = client
        .run_events(RunParams::new("prompt", "prompt-run-1"))
        .map(|event| event.expect("the stream should not break").event_type())
        .collect()
        .await;
    assert_eq!(events.last(), Some(&EventType::RunFinished));

    assert!(
        !exit_report(&mut exit_rx).await,
        "a completed run must not look like a disconnected one"
    );
}
