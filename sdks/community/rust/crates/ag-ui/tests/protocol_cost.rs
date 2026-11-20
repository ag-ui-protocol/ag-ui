//! Schema enforcement costs what the event costs, not what the schema costs.
#![cfg(all(feature = "client", feature = "sse"))]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use ag_ui::client::transport::decode_events;
use futures_util::{FutureExt, StreamExt, stream};

/// Counts the bytes each thread allocates, so parallel tests do not mix.
struct Counting;

thread_local! {
    static ALLOCATED: Cell<usize> = const { Cell::new(0) };
}

fn count(bytes: usize) {
    let _ = ALLOCATED.try_with(|allocated| allocated.set(allocated.get() + bytes));
}

// SAFETY: every call is forwarded to `System` unchanged.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count(new_size.saturating_sub(layout.size()));
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn decode(body: &str) -> usize {
    let bytes = body.as_bytes().to_vec();
    let before = ALLOCATED.with(Cell::get);
    let events: Vec<_> = decode_events(stream::iter([Ok::<_, std::io::Error>(bytes)]))
        .collect::<Vec<_>>()
        .now_or_never()
        .expect("an in-memory stream is ready at once");
    let allocated = ALLOCATED.with(Cell::get) - before;
    assert_eq!(events.len(), 1);
    events[0].as_ref().expect("the event decodes");
    allocated
}

/// A copy of the parsed schema allocates about five times its own text, so an
/// event that copies the schema, or anything of its size, fails here.
#[test]
fn decoding_an_event_allocates_less_than_the_schema_text() {
    let schema = include_str!("../src/protocol/schema-1.0.json").len();
    for event in [
        r#"{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hello"}"#,
        r#"{"type":"TOOL_CALL_ARGS","toolCallId":"t1","delta":"{\"a\":1}"}"#,
        r#"{"type":"STATE_DELTA","delta":[{"op":"replace","path":"/a","value":1}]}"#,
        r#"{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m1","role":"user","content":"hi"}]}"#,
        r#"{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"success"}}"#,
    ] {
        let body = format!("data: {event}\n\n");
        // The first decode parses the vendored schema once for the process.
        decode(&body);
        let allocated = decode(&body);
        assert!(
            allocated < schema,
            "decoding {event} allocated {allocated} bytes; the schema text is {schema}"
        );
    }
}
