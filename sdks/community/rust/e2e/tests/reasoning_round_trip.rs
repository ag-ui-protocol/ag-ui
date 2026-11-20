//! Reasoning, there and back.
//!
//! AG-UI 1.0 has a consumer store a `REASONING_ENCRYPTED_VALUE` with the
//! message it names and return it unmodified in later run input. Both ends of
//! that are this SDK here: the agent streams the reasoning and its value, the
//! client keeps the message in the conversation, and the next request carries
//! it back through the endpoint's own decoding of its input.

mod common;

use ag_ui::client::{RunEnd, Thread};
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::{Message, ReasoningMessage, RunOutcome};
use common::{serve, transport};
use serde_json::{Value, json};

/// Nothing a client may read as a format: one that trims or re-encodes it
/// sends something else back.
const VALUE: &str = " opaque/+==\n";

/// Reasons, under an encrypted value, when its request carries no reasoning.
/// On every later run it reports the reasoning messages the request did
/// carry, as the run's result.
struct Recalls;

impl Agent for Recalls {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        let returned: Vec<Value> = ctx
            .messages()
            .iter()
            .filter(|message| matches!(message, Message::Reasoning(_)))
            .map(|message| serde_json::to_value(message).expect("a message serializes"))
            .collect();
        if returned.is_empty() {
            let mut thought = ctx.reasoning()?;
            thought.delta("weighing the options")?;
            thought.encrypted_value(VALUE)?;
            thought.end()?;
            ctx.say("the answer")?;
        } else {
            ctx.set_result(returned);
        }
        Ok(RunOutcome::Success)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_agent_gets_its_encrypted_reasoning_back_on_every_later_run() {
    let url = serve(Recalls).await;
    let mut thread = Thread::<_>::new(transport(&url), "recall");
    thread.set_next_run_id("recall-run-1");

    let first = thread
        .send_message(Message::user("user-1", "why?"))
        .expect("run preflight")
        .collect_report()
        .await;
    assert_eq!(first.end, RunEnd::Success { result: None });
    assert!(first.diagnostics.is_empty(), "{:?}", first.diagnostics);

    // In the conversation, between the question and the answer.
    assert_eq!(
        thread.messages()[1],
        Message::Reasoning(ReasoningMessage {
            id: "recall-run-1-msg-1".into(),
            content: "weighing the options".to_owned(),
            encrypted_value: Some(VALUE.to_owned()),
            ..Default::default()
        })
    );

    // And in what the agent is sent, as it was received, run after run.
    let returned = json!([{
        "role": "reasoning",
        "id": "recall-run-1-msg-1",
        "content": "weighing the options",
        "encryptedValue": VALUE,
    }]);
    for text in ["and then?", "and after that?"] {
        let report = thread
            .send(text)
            .expect("run preflight")
            .collect_report()
            .await;
        assert_eq!(
            report.end,
            RunEnd::Success {
                result: Some(returned.clone())
            }
        );
        assert!(report.diagnostics.is_empty(), "{:?}", report.diagnostics);
    }
}
