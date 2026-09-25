//! A transport that replays a scripted list of events.
//!
//! Testing a client against a live agent is slow, flaky, and needs a model. It
//! is also unnecessary: the agent's half of the conversation is just a list of
//! events. [`ReplayTransport`] serves one — and records the
//! [`RunAgentInput`]s it was handed, which is how a test asserts that a resume
//! carried the right answers.
//!
//! ```
//! use ag_ui::client::transport::ReplayTransport;
//! use ag_ui::Event;
//!
//! let transport = ReplayTransport::new([
//!     Event::run_started("thread-1", "run-1"),
//!     Event::run_finished_success("thread-1", "run-1"),
//! ]);
//! ```

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::{Event, RunAgentInput};

use crate::client::error::Error;
use crate::client::transport::{EventStream, Transport, TransportFuture};

/// A [`Transport`] that answers each run from a script.
///
/// Cloning shares the script and the recording, so a test can keep a handle
/// after handing one to a [`Thread`](crate::client::Thread).
#[derive(Clone, Debug, Default)]
pub struct ReplayTransport {
    inner: Arc<Mutex<Script>>,
    matching_requests: bool,
}

#[derive(Debug, Default)]
struct Script {
    runs: VecDeque<Vec<Event>>,
    requests: Vec<RunAgentInput>,
}

impl ReplayTransport {
    /// A transport that answers the first run with these events, and every
    /// later run with an error.
    pub fn new(events: impl IntoIterator<Item = Event>) -> Self {
        Self::with_runs([events.into_iter().collect::<Vec<_>>()])
    }

    /// A transport that answers each run with the next list in the script.
    ///
    /// This is what a human-in-the-loop round trip needs: the first run pauses
    /// on an interrupt, the second — the resume — carries on.
    pub fn with_runs(runs: impl IntoIterator<Item = Vec<Event>>) -> Self {
        Self {
            matching_requests: false,
            inner: Arc::new(Mutex::new(Script {
                runs: runs.into_iter().collect(),
                requests: Vec::new(),
            })),
        }
    }

    /// Rebind each script's first RUN_STARTED and its matching RUN_FINISHED
    /// to the actual request IDs. Unmatched terminal IDs stay unchanged so
    /// malformed fixtures still fail. The default replays events literally.
    #[must_use]
    pub fn matching_requests(mut self) -> Self {
        self.matching_requests = true;
        self
    }

    /// Every request this transport has been handed, in order.
    pub fn requests(&self) -> Vec<RunAgentInput> {
        self.lock().requests.clone()
    }

    /// The most recent request, if there has been one.
    pub fn last_request(&self) -> Option<RunAgentInput> {
        self.lock().requests.last().cloned()
    }

    /// How many runs are left in the script.
    pub fn remaining(&self) -> usize {
        self.lock().runs.len()
    }

    /// A poisoned lock still holds a perfectly good script — a test that
    /// panicked mid-assert should fail on that panic, not on this mutex.
    fn lock(&self) -> MutexGuard<'_, Script> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl Transport for ReplayTransport {
    fn run(&self, input: RunAgentInput) -> TransportFuture {
        let mut script = self.lock();
        script.requests.push(input.clone());
        let mut next = script.runs.pop_front();
        if self.matching_requests {
            if let Some(events) = &mut next {
                let original = events.iter().find_map(|event| match event {
                    Event::RunStarted(e) => Some((e.thread_id.clone(), e.run_id.clone())),
                    _ => None,
                });
                if let Some((thread_id, run_id)) = original {
                    for event in events {
                        match event {
                            Event::RunStarted(e)
                                if e.thread_id == thread_id && e.run_id == run_id =>
                            {
                                e.thread_id = input.thread_id.clone();
                                e.run_id = input.run_id.clone();
                            }
                            Event::RunFinished(e)
                                if e.thread_id == thread_id && e.run_id == run_id =>
                            {
                                e.thread_id = input.thread_id.clone();
                                e.run_id = input.run_id.clone();
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        drop(script);

        Box::pin(async move {
            let Some(events) = next else {
                return Err(Error::Transport(
                    "the replay script has no runs left".into(),
                ));
            };
            let stream = futures_util::stream::iter(events.into_iter().map(Ok));
            Ok(Box::pin(stream) as EventStream)
        })
    }
}
