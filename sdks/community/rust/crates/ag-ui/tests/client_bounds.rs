//! `Thread` and its friends are nameable without knowing the transport.
//!
//! A bound on a struct definition is viral: put `T: Transport` on `Thread<T, S>`
//! and every application helper that so much as mentions the type in a signature
//! has to repeat it, including ones that only read `messages()`. The bound
//! belongs on the impl blocks that actually call transport methods, and this
//! file is what says so — it is written the way an application writes helpers,
//! and it fails to *compile* if the bound migrates back onto the type.

#![cfg(feature = "client")]

use ag_ui::client::transport::ReplayTransport;
use ag_ui::client::{RunStream, Thread, ThreadBuilder};

fn count<T, S>(thread: &Thread<T, S>) -> usize {
    thread.messages().len()
}

fn seed<T, S>(builder: ThreadBuilder<T, S>) -> ThreadBuilder<T, S> {
    builder.verify(false)
}

fn describe<T, S>(run: &RunStream<'_, T, S>) -> String {
    format!("{run:?}")
}

/// An application holding a thread in its own state, deriving `Debug`.
#[derive(Debug)]
struct App<T, S> {
    thread: Thread<T, S>,
}

#[test]
fn helpers_naming_a_thread_need_no_transport_bound() {
    let thread: Thread<ReplayTransport> =
        Thread::new(ReplayTransport::new([]).matching_requests(), "thread-1");
    assert_eq!(count(&thread), 0);

    let builder: ThreadBuilder<ReplayTransport> =
        Thread::builder(ReplayTransport::new([]).matching_requests(), "thread-1");
    assert_eq!(count(&seed(builder).build().unwrap()), 0);

    let mut app = App { thread };
    assert!(format!("{app:?}").contains("Thread"));
    assert!(describe(&app.thread.run().unwrap()).contains("RunStream"));
}
