//! State published as snapshots and as RFC 6902 patches, across the wire.
//!
//! The server decides per publish whether to send `STATE_SNAPSHOT` or
//! `STATE_DELTA`, and the client has to end up in the same place either way.
//! [`Editor`] forces both decisions, and two of its keys contain the characters
//! RFC 6901 escapes (`/` and `~`) — an unescaped pointer applies the patch to a
//! *nested* key instead, which nothing but a round trip catches.
//!
//! [`StateManager`](ag_ui::server::StateManager) only ever emits patches of one
//! shape, though: a diff against a snapshot it sent itself, first, in the same
//! run. The protocol allows far more than that, and a producer in another
//! language emits it — so [`Patcher`] sends the patches by hand, and
//! [`Fumbler`] sends one that cannot apply at all.

mod common;

use std::collections::BTreeMap;

use ag_ui::client::{Error as ClientError, RemoteAgent, RunEnd, RunParams, Thread, Update};
use ag_ui::server::{Agent, Result, RunContext};
use ag_ui::{Event, EventType, PatchOperation, RunOutcome};
use common::{serve, transport};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Long enough that a one-field change is cheaper to patch than to resend.
const NOTE: &str = "the document the user is editing, at a length that makes resending it wasteful";

/// The shared document.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Board {
    revision: u32,
    title: String,
    notes: Vec<String>,
    tags: Vec<String>,
    /// Keys deliberately contain `/` and `~`, the two characters a JSON Pointer
    /// has to escape.
    counts: BTreeMap<String, u32>,
}

/// Publishes seven times, sized so the server picks each encoding at least
/// once.
struct Editor;

impl Agent for Editor {
    type State = Board;

    async fn run(&self, ctx: &mut RunContext<Board>) -> Result<RunOutcome> {
        // 1 — the first publish is a snapshot whatever its size.
        ctx.update_state(|board| {
            board.revision = 1;
            board.title = "Draft".to_owned();
            board.notes = vec![NOTE.to_owned()];
        })?;
        // 2 — one small field of a large document: a patch is smaller.
        ctx.update_state(|board| board.revision = 2)?;
        // 3 — the document shrinks to almost nothing: the patch describing that
        //     costs more than the document, so this falls back to a snapshot.
        ctx.update_state(|board| {
            board.title = "Shipped".to_owned();
            board.notes.clear();
        })?;
        // 4-7 — small additive changes, including two escaped pointers.
        ctx.update_state(|board| {
            board.counts.insert("a/b".to_owned(), 7);
        })?;
        ctx.update_state(|board| {
            board.counts.insert("c~d".to_owned(), 9);
        })?;
        ctx.update_state(|board| {
            board.counts.insert("a/b".to_owned(), 8);
        })?;
        ctx.update_state(|board| board.tags.push("urgent".to_owned()))?;

        Ok(RunOutcome::Success)
    }
}

/// What the agent's state looked like after each publish, in order.
fn published() -> Vec<Board> {
    let mut board = Board {
        revision: 1,
        title: "Draft".to_owned(),
        notes: vec![NOTE.to_owned()],
        ..Default::default()
    };
    let mut history = vec![board.clone()];

    board.revision = 2;
    history.push(board.clone());

    board.title = "Shipped".to_owned();
    board.notes.clear();
    history.push(board.clone());

    for (key, value) in [("a/b", 7), ("c~d", 9), ("a/b", 8)] {
        board.counts.insert(key.to_owned(), value);
        history.push(board.clone());
    }

    board.tags.push("urgent".to_owned());
    history.push(board);
    history
}

/// The encoding the server chose for each publish, read off the raw stream.
#[tokio::test(flavor = "multi_thread")]
async fn the_server_picks_snapshots_and_deltas_and_both_reach_the_client() {
    let url = serve(Editor).await;
    let agent = RemoteAgent::new(transport(&url));

    let mut encodings = Vec::new();
    let mut events = agent.run_events(RunParams::new("board", "board-run-1"));
    while let Some(event) = events.next().await {
        let event = event.expect("the stream should not break");
        if matches!(event, Event::StateSnapshot(_) | Event::StateDelta(_)) {
            encodings.push(event.event_type());
        }
    }

    use EventType::{StateDelta, StateSnapshot};
    assert_eq!(
        encodings,
        [
            StateSnapshot, // first publish
            StateDelta,    // one field of a large document
            StateSnapshot, // the document shrank; the patch would cost more
            StateDelta,
            StateDelta,
            StateDelta,
            StateDelta,
        ],
        "this scenario is only meaningful if both encodings are exercised"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_clients_typed_state_matches_the_agents_after_every_publish() {
    let url = serve(Editor).await;
    let mut thread = Thread::<_, Board>::builder(transport(&url), "board")
        .state(serde_json::json!(Board::default()))
        .build()
        .expect("typed thread");

    let mut states = Vec::new();
    {
        let mut run = thread.send("tidy the board").expect("run preflight");
        while let Some(update) = run.next().await {
            match update {
                Update::State(state) => states.push(state),
                Update::Error(error) => panic!("state should apply cleanly: {error}"),
                _ => {}
            }
        }
    }

    let expected = published();
    assert_eq!(states, expected, "every intermediate state must agree");
    assert_eq!(thread.state().ok(), expected.last());
}

/// The delta path specifically: a pointer into a key containing `/` or `~` has
/// to come back out as that key, not as a nested object.
#[tokio::test(flavor = "multi_thread")]
async fn escaped_json_pointers_patch_the_key_they_name() {
    let url = serve(Editor).await;
    let mut thread = Thread::<_, Board>::builder(transport(&url), "board")
        .state(serde_json::json!(Board::default()))
        .build()
        .expect("typed thread");

    {
        let mut run = thread.send("tidy the board").expect("run preflight");
        while let Some(update) = run.next().await {
            // A patch this test cannot apply would leave the state at its
            // previous value, and every assertion below would then be about the
            // wrong document rather than about the pointers.
            if let Update::Error(error) = update {
                panic!("an escaped pointer should apply cleanly: {error}");
            }
        }
    }

    let counts = &thread.raw_state()["counts"];
    assert_eq!(
        counts,
        &json!({"a/b": 8, "c~d": 9}),
        "a mis-escaped pointer nests the key instead of naming it"
    );
    assert!(
        counts.get("a").is_none() && counts.get("c").is_none(),
        "an unescaped pointer would have created these: {counts}"
    );
}

// ------------------------------------------------- hand-written patches ----

/// Publishes by hand-written patch instead of through
/// [`RunContext::update_state`], in the shapes a producer with its own diff
/// generator sends and `StateManager` never does.
struct Patcher;

impl Agent for Patcher {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        // 1 — a delta as the *first* state event of the run. The client starts
        //     from `{}`; a producer is not obliged to send a snapshot first, so
        //     the empty document has to be a base a patch can land on.
        ctx.emit(Event::state_delta(vec![PatchOperation::add(
            "/cart",
            json!({"items": [], "total": 0}),
        )]))?;

        // 2 — one document, five operations, each of which only applies if the
        //     one before it did: `-` appends to the array the first operation
        //     created, and the copy reads the value the append wrote. Applying
        //     the whole document against the state as it was on arrival — a
        //     plausible shortcut — drops the second item and fails the copy.
        ctx.emit(Event::state_delta(vec![
            PatchOperation::add("/cart/items/-", json!({"sku": "espresso"})),
            PatchOperation::add("/cart/items/-", json!({"sku": "croissant"})),
            PatchOperation::replace("/cart/total", 7),
            PatchOperation::copy("/cart/items/0/sku", "/cart/featured"),
            PatchOperation::test("/cart/featured", "espresso"),
        ]))?;

        // 3 — `null` is a value, not an absence.
        ctx.emit(Event::state_delta(vec![PatchOperation::replace(
            "/cart/featured",
            Value::Null,
        )]))?;

        // 4 — a snapshot arriving after deltas is a replacement, not a merge.
        ctx.emit(Event::state_snapshot(json!({"cart": {"total": 3}})))?;

        // 5 — …and the delta after it patches that document, not the one the
        //     earlier patches had built.
        ctx.emit(Event::state_delta(vec![PatchOperation::add(
            "/cart/paid",
            true,
        )]))?;

        Ok(RunOutcome::Success)
    }
}

/// Sends a patch that cannot apply, halfway through a run that is otherwise
/// fine — the client's copy is missing the path the producer patched.
struct Fumbler;

impl Agent for Fumbler {
    type State = ();

    async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
        ctx.emit(Event::state_snapshot(json!({"seen": 1})))?;

        // Two operations, the second of which has nothing to remove. RFC 6902
        // is all-or-nothing, so the `add` in front of it must not survive
        // either: a half-applied patch is a state neither side ever held.
        ctx.emit(Event::state_delta(vec![
            PatchOperation::add("/kept", "no"),
            PatchOperation::remove("/never/here"),
        ]))?;

        // The run carries on, and so must the state: a patch the client refused
        // is a report, not a broken thread.
        ctx.emit(Event::state_delta(vec![PatchOperation::replace(
            "/seen", 2,
        )]))?;

        Ok(RunOutcome::Success)
    }
}

/// What one run left behind, watched from the client's side.
struct Applied {
    /// Every state the client passed through, in order.
    states: Vec<Value>,
    /// Every error it surfaced. A run whose patches all apply produces none.
    errors: Vec<ClientError>,
    /// The document the run ended on.
    ended_with: Value,
    /// How the run ended.
    ended: RunEnd,
}

/// Runs `agent` once against a fresh endpoint.
async fn apply(agent: impl Agent + 'static) -> Applied {
    let url = serve(agent).await;
    let mut thread = Thread::<_>::new(transport(&url), "patch");

    let mut states = Vec::new();
    let mut errors = Vec::new();
    let mut ended = None;
    {
        let mut run = thread.send("change the state").expect("run preflight");
        while let Some(update) = run.next().await {
            match update {
                Update::State(state) => states.push(state),
                Update::Error(error) => errors.push(error),
                Update::Done(end) => ended = Some(end),
                _ => {}
            }
        }
    }

    Applied {
        states,
        errors,
        ended_with: thread.raw_state().clone(),
        ended: ended.expect("every run ends"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delta_that_arrives_before_any_snapshot_patches_the_empty_document() {
    let applied = apply(Patcher).await;

    assert!(applied.errors.is_empty(), "{:?}", applied.errors);
    assert_eq!(
        applied.states.first(),
        Some(&json!({"cart": {"items": [], "total": 0}})),
        "the client's `{{}}` has to be a base a patch can land on"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn operations_in_one_delta_apply_in_order_so_a_later_one_sees_the_earlier_ones() {
    let applied = apply(Patcher).await;

    assert!(applied.errors.is_empty(), "{:?}", applied.errors);
    assert_eq!(
        applied.states.get(1),
        Some(&json!({"cart": {
            "items": [{"sku": "espresso"}, {"sku": "croissant"}],
            "total": 7,
            "featured": "espresso",
        }})),
        "an append that shifted nothing, or a copy that read the wrong document"
    );
}

/// A producer whose new state holds nothing at a key sends `"value": null`, and
/// an applier that reads a null value as an absent one leaves the old value in
/// place — which is the same failure as dropping the operation entirely.
#[tokio::test(flavor = "multi_thread")]
async fn a_delta_whose_value_is_null_stores_null_rather_than_the_old_value() {
    let applied = apply(Patcher).await;

    assert!(applied.errors.is_empty(), "{:?}", applied.errors);
    let cart = applied
        .states
        .get(2)
        .and_then(|state| state.get("cart"))
        .expect("a third state");
    assert_eq!(
        cart.get("featured"),
        Some(&Value::Null),
        "the key must still be there, holding null: {cart}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_after_deltas_replaces_the_document_and_the_next_delta_patches_it() {
    let applied = apply(Patcher).await;

    assert!(applied.errors.is_empty(), "{:?}", applied.errors);
    assert_eq!(
        applied.states.get(3),
        Some(&json!({"cart": {"total": 3}})),
        "a snapshot is a replacement: everything it does not mention is gone"
    );
    assert_eq!(
        applied.ended_with,
        json!({"cart": {"total": 3, "paid": true}}),
        "the delta after a snapshot patches the snapshot"
    );
    assert_eq!(applied.states.len(), 5, "one publish, one Update::State");
    assert_eq!(applied.ended, RunEnd::Success { result: None });
}

/// The failure the applier refuses to be quiet about, and the one thing it will
/// not do about it: corrupt the state or end the run.
#[tokio::test(flavor = "multi_thread")]
async fn a_patch_that_cannot_apply_is_reported_without_corrupting_the_state() {
    let applied = apply(Fumbler).await;

    assert_eq!(applied.errors.len(), 1, "{:?}", applied.errors);
    match &applied.errors[0] {
        ClientError::Patch { target, .. } => assert_eq!(target, "state"),
        other => panic!("a failed patch is not {other:?}"),
    }

    assert_eq!(
        applied.states,
        [json!({"seen": 1}), json!({"seen": 2})],
        "the failed patch published nothing, and the one after it still applied"
    );
    assert_eq!(
        applied.ended_with.get("kept"),
        None,
        "the operation in front of the failing one was rolled back: {}",
        applied.ended_with
    );
    assert_eq!(
        applied.ended,
        RunEnd::Success { result: None },
        "a patch the client could not apply does not fail the agent's run"
    );
}
