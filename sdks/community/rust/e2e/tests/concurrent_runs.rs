//! Many clients, one mounted agent, all in flight at once.
//!
//! Nothing behind the endpoint is shared mutable state, and the proof is that
//! every thread ends up with exactly its own events and nobody else's. The
//! overlap is not left to luck: each run stops at a shared barrier that only
//! releases once every run has reached it, so a server that answered one
//! request at a time would deadlock here rather than pass slowly.
//!
//! The endpoint's own per-run state gets the same treatment. A
//! [`StreamTransformer`] is a state machine and
//! [`AgentEndpoint`](ag_ui::axum::AgentEndpoint) builds a fresh one per request
//! for exactly that reason — so [`Numbering`] counts, and a shared instance
//! would hand one run another run's numbers.

mod common;

use std::sync::Arc;
use std::time::Duration;

use ag_ui::axum::AgentEndpoint;
use ag_ui::client::{RunEnd, Thread, Update};
use ag_ui::server::{Agent, Result, RunContext, StreamTransformer};
use ag_ui::{Event, Message, RunOutcome, UserContent};
use common::{serve, serve_endpoint, transport};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use tokio::sync::Barrier;
use tokio::time::timeout;

/// Enough to interleave properly, few enough to stay quick.
const CLIENTS: usize = 8;

/// Replies per run.
const REPLIES: usize = 4;

/// A deadline, because the failure mode being ruled out is a server that
/// serializes runs — which presents as a hang, not as a wrong answer.
const DEADLINE: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Tally {
    thread: String,
    replies: u32,
}

/// Echoes the caller's own question back, stamped with the ids of *this* run,
/// and waits for every other run to get here first.
struct Echo {
    barrier: Arc<Barrier>,
}

impl Agent for Echo {
    type State = Tally;

    async fn run(&self, ctx: &mut RunContext<Tally>) -> Result<RunOutcome> {
        let question = last_question(ctx);
        let thread = ctx.thread_id().to_string();
        let run = ctx.run_id().to_string();

        let mut step = ctx.step("answer")?;
        for index in 0..REPLIES {
            let mut message = step.assistant_message()?;
            message.delta(format!("{thread}/{run}#{index}: "))?;
            message.delta(question.clone())?;
            message.end()?;

            // Halfway through, wait for everyone. Every run has to be open at
            // the same time for this to return at all.
            if index == REPLIES / 2 {
                self.barrier.wait().await;
            }
        }

        step.update_state(|tally| {
            tally.thread.clone_from(&thread);
            tally.replies = REPLIES as u32;
        })?;

        drop(step);
        Ok(RunOutcome::Success)
    }
}

/// The most recent thing the user said.
fn last_question(ctx: &RunContext<Tally>) -> String {
    ctx.messages()
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::User(user) => match &user.content {
                UserContent::Text(text) => Some(text.clone()),
                UserContent::Parts(_) => None,
            },
            _ => None,
        })
        .unwrap_or_default()
}

/// Stamps every text fragment with how many it has seen.
///
/// A count is the cheapest thing that makes sharing visible: one instance
/// across the runs below would stamp numbers from every other run's stream into
/// each reply, and no run would come out holding a clean sequence.
struct Numbering {
    seen: usize,
}

impl StreamTransformer for Numbering {
    fn transform(&mut self, event: Event) -> Vec<Event> {
        match event {
            Event::TextMessageContent(mut content) => {
                self.seen += 1;
                content.delta = format!("[{}]{}", self.seen, content.delta);
                vec![Event::TextMessageContent(content)]
            }
            other => vec![other],
        }
    }
}

/// What one client got back.
struct Transcript {
    thread: String,
    replies: Vec<String>,
    state: Option<Tally>,
    ended: RunEnd,
}

/// Runs every client at once against one served agent.
async fn run_all() -> Vec<Transcript> {
    let barrier = Arc::new(Barrier::new(CLIENTS));
    drive_all(serve(Echo { barrier }).await).await
}

/// The same, with a stateful transformer between the agent and the wire.
async fn run_all_numbered() -> Vec<Transcript> {
    let barrier = Arc::new(Barrier::new(CLIENTS));
    let endpoint = AgentEndpoint::new(Echo { barrier }).transformer(|| Numbering { seen: 0 });
    drive_all(serve_endpoint(endpoint).await).await
}

/// Opens every client at once against `url` and collects what each got back.
async fn drive_all(url: String) -> Vec<Transcript> {
    let clients: Vec<_> = (0..CLIENTS)
        .map(|index| {
            let url = url.clone();
            tokio::spawn(async move {
                let thread_id = format!("thread-{index}");
                let mut thread = Thread::<_, Tally>::builder(transport(&url), thread_id.clone())
                    .state(serde_json::json!(Tally::default()))
                    .build()
                    .expect("typed thread");

                thread.set_next_run_id(format!("{thread_id}-run-1"));
                let mut ended = None;
                {
                    let mut run = thread
                        .send(format!("question from {thread_id}"))
                        .expect("run preflight");
                    while let Some(update) = run.next().await {
                        match update {
                            Update::Done(end) => ended = Some(end),
                            Update::Error(error) => panic!("{thread_id}: {error}"),
                            _ => {}
                        }
                    }
                }

                let replies = thread
                    .messages()
                    .iter()
                    .filter_map(|message| match message {
                        Message::Assistant(assistant) => assistant.content.clone(),
                        _ => None,
                    })
                    .collect();

                Transcript {
                    thread: thread_id,
                    replies,
                    state: thread.state().ok().cloned(),
                    ended: ended.expect("every run ends"),
                }
            })
        })
        .collect();

    let mut transcripts = Vec::with_capacity(CLIENTS);
    for client in clients {
        transcripts.push(
            timeout(DEADLINE, client)
                .await
                .expect("concurrent runs must not serialize")
                .expect("no client task should panic"),
        );
    }
    transcripts
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_clients_each_get_only_their_own_events() {
    let transcripts = run_all().await;
    assert_eq!(transcripts.len(), CLIENTS);

    for transcript in &transcripts {
        let thread = &transcript.thread;
        assert_eq!(transcript.ended, RunEnd::Success { result: None });
        assert_eq!(
            transcript.replies.len(),
            REPLIES,
            "{thread}: {:?}",
            transcript.replies
        );

        for (index, reply) in transcript.replies.iter().enumerate() {
            assert_eq!(
                reply,
                &format!("{thread}/{thread}-run-1#{index}: question from {thread}"),
                "a reply from another run leaked into {thread}"
            );
        }

        // …and no other client's thread id appears anywhere in this transcript.
        for other in &transcripts {
            if other.thread != *thread {
                assert!(
                    !transcript
                        .replies
                        .iter()
                        .any(|reply| reply.contains(&other.thread)),
                    "{thread} saw {}'s events",
                    other.thread
                );
            }
        }
    }
}

/// Every run gets its own transformer chain, and the count proves it: a run
/// that shared one with the seven others running alongside it would see numbers
/// climb past its own fragment count and skip most of them.
#[tokio::test(flavor = "multi_thread")]
async fn a_stateful_transformer_starts_over_for_each_concurrent_run() {
    let transcripts = run_all_numbered().await;
    assert_eq!(transcripts.len(), CLIENTS);

    for transcript in &transcripts {
        let thread = &transcript.thread;
        assert_eq!(transcript.ended, RunEnd::Success { result: None });

        for (index, reply) in transcript.replies.iter().enumerate() {
            // Two fragments per reply — the stamped prefix and the stamped
            // question — so this run's numbering runs 1, 2, 3, … across them.
            assert_eq!(
                reply,
                &format!(
                    "[{}]{thread}/{thread}-run-1#{index}: [{}]question from {thread}",
                    2 * index + 1,
                    2 * index + 2
                ),
                "{thread} was numbered by a transformer another run had used"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_runs_keep_their_state_to_themselves() {
    let transcripts = run_all().await;

    for transcript in &transcripts {
        assert_eq!(
            transcript.state,
            Some(Tally {
                thread: transcript.thread.clone(),
                replies: REPLIES as u32,
            }),
            "{} ended up with someone else's state",
            transcript.thread
        );
    }
}
