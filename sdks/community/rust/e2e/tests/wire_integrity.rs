//! The awkward payloads: the ones that break framing rather than semantics.
//!
//! Everything else in this suite would still pass if the SSE encoder and
//! decoder agreed on a *slightly* wrong contract, because the payloads are
//! short ASCII that fits in one TCP segment. These deliberately do not: text
//! carrying the framing's own delimiters, multi-byte characters landing on a
//! read boundary, and a state document far larger than any single chunk.

mod common;

use ag_ui::client::{Thread, Update};
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::{Event, Message, PatchOperation, RunOutcome};
use common::{serve, transport};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Every delimiter the framing cares about, inside the payload it frames.
const AWKWARD: &str = "line one\nline two\r\nline three\rdata: not a frame\n\n: not a comment\n\
                       tab\there, quote \" here, backslash \\ here";

/// Long enough to span several reads, and made of characters whose UTF-8
/// encodings a naive decoder would split.
fn multibyte() -> String {
    "안녕하세요 🇰🇷 — Grüße, ｆｕｌｌｗｉｄｔｈ, and a combining é\u{301} ".repeat(2_000)
}

/// A state document far bigger than one chunk.
fn bulky() -> String {
    "Every valley shall be exalted, and every mountain and hill made low. ".repeat(4_000)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Document {
    body: String,
    lines: u32,
}

/// Says the awkward things and publishes the bulky ones.
struct Awkward;

impl Agent for Awkward {
    type State = Document;

    async fn run(&self, ctx: &mut RunContext<Document>) -> Result<RunOutcome> {
        // A message carrying the framing's own delimiters.
        ctx.say(AWKWARD)?;

        // A long multi-byte message, delivered a fragment at a time so the
        // fragments land wherever the socket happens to split them.
        let text = multibyte();
        let mut message = ctx.assistant_message()?;
        for fragment in split_evenly(&text, 64) {
            message.delta(fragment)?;
        }
        // An unordered event mid-message: legal, and a real producer pattern.
        message.emit(Event::state_snapshot(json!({"body": "", "lines": 0})))?;
        message.emit(Event::state_delta(vec![PatchOperation::replace(
            "/lines", 3,
        )]))?;
        message.end()?;

        // A state document nothing will fit in one chunk.
        ctx.update_state(|document| {
            document.body = bulky();
            document.lines = 4_000;
        })?;

        Ok(RunOutcome::Success)
    }
}

/// Splits `text` into roughly `parts` pieces, never mid-character.
///
/// The deltas therefore end on character boundaries and the *socket* is the
/// only thing that can split one — which is the split being tested.
fn split_evenly(text: &str, parts: usize) -> Vec<&str> {
    let target = (text.len() / parts).max(1);
    let mut pieces = Vec::with_capacity(parts + 1);
    let mut rest = text;
    while !rest.is_empty() {
        let mut at = target.min(rest.len());
        while at < rest.len() && !rest.is_char_boundary(at) {
            at += 1;
        }
        let (piece, tail) = rest.split_at(at);
        pieces.push(piece);
        rest = tail;
    }
    pieces
}

/// One run against a served [`Awkward`].
async fn run_once() -> Thread<ag_ui::client::transport::HttpTransport, Document> {
    let url = serve(Awkward).await;
    let mut thread = Thread::<_, Document>::builder(transport(&url), "wire")
        .state(serde_json::json!(Document::default()))
        .build()
        .expect("typed thread");
    thread.set_next_run_id("wire-run-1");
    {
        let mut run = thread.send("say something awkward").expect("run preflight");
        while let Some(update) = run.next().await {
            if let Update::Error(error) = update {
                panic!("an awkward payload is not a malformed stream: {error}");
            }
        }
    }
    thread
}

#[tokio::test(flavor = "multi_thread")]
async fn text_carrying_the_framings_own_delimiters_arrives_unchanged() {
    let thread = run_once().await;
    assert_eq!(
        thread.messages().get(1),
        Some(&Message::assistant("wire-run-1-msg-1", AWKWARD))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_multibyte_message_reassembles_character_for_character() {
    let thread = run_once().await;
    let expected = multibyte();

    let Some(Message::Assistant(message)) = thread.messages().get(2) else {
        panic!(
            "expected a second assistant message: {:?}",
            thread.messages()
        );
    };
    let content = message.content.as_deref().unwrap_or_default();
    assert_eq!(content.len(), expected.len(), "byte length");
    assert_eq!(content.chars().count(), expected.chars().count());
    assert_eq!(content, expected);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_state_document_larger_than_any_chunk_arrives_whole() {
    let thread = run_once().await;
    assert_eq!(
        thread.state().ok(),
        Some(&Document {
            body: bulky(),
            lines: 4_000,
        })
    );
}

/// State events between two fragments of one message must not split the
/// message, and must still apply.
#[tokio::test(flavor = "multi_thread")]
async fn state_events_may_interleave_with_an_open_message() {
    let url = serve(Awkward).await;
    let mut thread = Thread::<_, Document>::builder(transport(&url), "wire")
        .state(serde_json::json!(Document::default()))
        .build()
        .expect("typed thread");
    thread.set_next_run_id("wire-run-1");

    let mut states = Vec::new();
    {
        let mut run = thread.send("say something awkward").expect("run preflight");
        while let Some(update) = run.next().await {
            match update {
                Update::State(state) => states.push(state.lines),
                Update::Error(error) => panic!("interleaving is legal: {error}"),
                _ => {}
            }
        }
    }

    // The snapshot and the patch that arrived mid-message, then the publish
    // that came after it.
    assert_eq!(states, [0, 3, 4_000]);
    // …and the message they interleaved with is still one message.
    assert_eq!(thread.messages().len(), 3, "{:?}", thread.messages());
}
