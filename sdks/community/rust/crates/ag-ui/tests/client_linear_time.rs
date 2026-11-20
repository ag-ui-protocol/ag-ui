//! What reading a stream costs grows with what the producer sends, and not
//! with its square.
//!
//! A run may hold many items open at once. The applier and the ordering
//! rules keep what is open by id, so an event that opens, continues or
//! closes one costs the same however many others are open. Before, each
//! scanned the open ones: the reviewer measured 9 s in a release build for
//! 80,000 messages opened and never closed.
//!
//! No time is asserted. The streams here are large enough that a scan per
//! event would keep the test running for minutes, which a test run notices.

#![cfg(feature = "client")]

use ag_ui::client::apply::Applier;
use ag_ui::client::{ChunkNormalizer, Verifier};
use ag_ui::{Event, TextMessageRole};

const OPEN: usize = 100_000;

/// Reads `events` the way a `Thread` does, without the transport: the chunk
/// normalizer, the verifier, the applier. The first error, if any.
fn read(events: Vec<Event>) -> (Applier, Option<String>) {
    let mut normalizer = ChunkNormalizer::new();
    let mut verifier = Verifier::new();
    let mut applier = Applier::new();
    let mut explicit = Vec::new();
    for event in events {
        normalizer.normalize(event, &mut explicit).unwrap();
        for event in explicit.drain(..) {
            if let Err(error) = verifier.verify(&event) {
                return (applier, Some(error.to_string()));
            }
            applier.apply(&event).unwrap();
        }
    }
    (applier, None)
}

fn id(n: usize) -> String {
    format!("m-{n}")
}

#[test]
fn many_items_open_at_once_cost_what_their_events_cost() {
    // Each message opens and takes a fragment while every one before it is
    // still open, then they close, the newest first.
    let mut events = vec![Event::run_started("t", "r")];
    for n in 0..OPEN {
        events.push(Event::text_message_start(id(n), TextMessageRole::Assistant));
        events.push(Event::text_message_content(id(n), "x"));
    }
    for n in (0..OPEN).rev() {
        events.push(Event::text_message_end(id(n)));
    }
    events.push(Event::run_finished_success("t", "r"));
    let (applier, error) = read(events);
    assert_eq!(error, None);
    assert_eq!(applier.messages().len(), OPEN);
    assert_eq!(applier.text_of(id(OPEN - 1)), Some("x"));
}

#[test]
fn items_opened_and_never_closed_are_named_once_at_the_end() {
    // The run ends with everything open, which names the first one opened:
    // the one place the order of opening is read.
    let mut events = vec![Event::run_started("t", "r")];
    for n in 0..OPEN {
        events.push(Event::text_message_start(id(n), TextMessageRole::Assistant));
    }
    events.push(Event::run_finished_success("t", "r"));
    let (applier, error) = read(events);
    assert_eq!(applier.messages().len(), OPEN);
    let error = error.expect("RUN_FINISHED finds the messages open");
    assert!(error.contains("\"m-0\""), "{error}");
}
