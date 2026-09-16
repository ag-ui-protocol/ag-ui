//! The human-in-the-loop round trip.
//!
//! A run does not only succeed or fail. It can *pause*: the agent finishes with
//! an [interrupt outcome](https://docs.rs/ag-ui/0.4.2/ag_ui/outcome/enum.RunOutcome.html#variant.Interrupt), listing what it
//! needs a human to decide, and the conversation continues when the client
//! sends the answers back in [`RunAgentInput::resume`](https://docs.rs/ag-ui/0.4.2/ag_ui/input/struct.RunAgentInput.html#structfield.resume).
//!
//! That round trip is the whole reason `RUN_FINISHED` carries an outcome, and
//! this module is the client half of it. With a [`Thread`](crate::client::Thread) it
//! is two calls:
//!
//! ```
//! # use ag_ui::client::{Thread, Update, transport::ReplayTransport};
//! # use ag_ui::{Event, Interrupt};
//! # use futures_util::StreamExt;
//! # let transport = ReplayTransport::with_runs([
//! #     vec![
//! #         Event::run_started("thread-1", "run-1"),
//! #         Event::run_finished_interrupt("thread-1", "run-1", vec![Interrupt::new("i-1", "tool_approval")]),
//! #     ],
//! #     vec![
//! #         Event::run_started("thread-1", "run-2"),
//! #         Event::run_finished_success("thread-1", "run-2"),
//! #     ],
//! # ]).matching_requests();
//! # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
//! # rt.block_on(async {
//! let mut thread = Thread::<_>::new(transport, "thread-1");
//! let mut pending = Vec::new();
//!
//! let mut run = thread.send("delete the staging database").unwrap();
//! while let Some(update) = run.next().await {
//!     if let Update::Interrupt(interrupt) = update {
//!         pending.push(interrupt);
//!     }
//! }
//! drop(run);
//!
//! // Ask the human, then answer the agent.
//! let mut resumed = thread.resume(&pending[0], serde_json::json!({ "approved": true })).unwrap();
//! while resumed.next().await.is_some() {}
//! # });
//! ```
//!
//! Without one — a proxy, or anything driving [`crate::client::RemoteAgent`] directly —
//! [`interrupts_of`] finds the interrupts on the event and [`resume_run`]
//! builds the next request.

use crate::{Event, Interrupt, ResumeEntry, RunAgentInput, RunId};
use serde_json::Value;

/// The interrupts a `RUN_FINISHED` paused on, or an empty slice for any other
/// event.
///
/// A `RUN_FINISHED` with no outcome at all is a success: producers that predate
/// the interrupt protocol omit the field, and reading that as "paused" would
/// hang every one of them.
pub fn interrupts_of(event: &Event) -> &[Interrupt] {
    match event {
        Event::RunFinished(finished) => match &finished.outcome {
            Some(outcome) => outcome.interrupts(),
            None => &[],
        },
        _ => &[],
    }
}

/// Builds the request that resumes a paused run.
///
/// Everything the paused run was given — messages, state, tools, context — is
/// carried over, because the agent is continuing the same conversation. What
/// changes is the run id and the `resume` payload.
///
/// A new run id, not the paused one: the resumed run emits its own
/// `RUN_STARTED`, and reusing the finished run's id would make two runs in one
/// thread indistinguishable in a log. Servers that key resumption on the
/// original id should be passed that id explicitly.
pub fn resume_run(
    previous: &RunAgentInput,
    run_id: impl Into<RunId>,
    entries: impl Into<Vec<ResumeEntry>>,
) -> RunAgentInput {
    RunAgentInput {
        run_id: run_id.into(),
        resume: Some(entries.into()),
        ..previous.clone()
    }
}

/// Answering interrupts, one call per decision.
///
/// A run can pause on several interrupts at once — three tool approvals, say —
/// and they are answered together, in one request. This collects the answers.
///
/// ```
/// use ag_ui::client::interrupts::ResumeBuilder;
/// use ag_ui::{Interrupt, ResumeStatus};
///
/// let approve = Interrupt::new("i-1", "tool_approval");
/// let deny = Interrupt::new("i-2", "tool_approval");
///
/// let entries = ResumeBuilder::new()
///     .resolve(&approve, serde_json::json!({ "approved": true }))
///     .cancel(&deny)
///     .build();
///
/// assert_eq!(entries[0].interrupt_id, "i-1");
/// assert_eq!(entries[1].status, ResumeStatus::Cancelled);
/// ```
#[derive(Clone, Debug, Default)]
pub struct ResumeBuilder {
    entries: Vec<ResumeEntry>,
}

impl ResumeBuilder {
    /// An empty builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Answers an interrupt.
    #[must_use]
    pub fn resolve(mut self, interrupt: &Interrupt, payload: impl Into<Value>) -> Self {
        self.entries
            .push(ResumeEntry::resolved(interrupt.id.clone(), payload));
        self
    }

    /// Approves a tool call after editing its arguments.
    ///
    /// Agents that advertise `approveWithEdits` expect the edited arguments
    /// under an `editedArgs` key; this writes that shape so callers do not have
    /// to remember it.
    #[must_use]
    pub fn resolve_with_edits(self, interrupt: &Interrupt, edited_args: impl Into<Value>) -> Self {
        self.resolve(
            interrupt,
            serde_json::json!({ "editedArgs": edited_args.into() }),
        )
    }

    /// Declines an interrupt — the user said no, or the request expired.
    #[must_use]
    pub fn cancel(mut self, interrupt: &Interrupt) -> Self {
        self.entries
            .push(ResumeEntry::cancelled(interrupt.id.clone()));
        self
    }

    /// Answers an interrupt with a status the caller picked.
    #[must_use]
    pub fn entry(mut self, entry: ResumeEntry) -> Self {
        self.entries.push(entry);
        self
    }

    /// Whether any answer has been recorded.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The answers collected so far.
    pub fn entries(&self) -> &[ResumeEntry] {
        &self.entries
    }

    /// Consumes the builder and returns the answers.
    pub fn build(self) -> Vec<ResumeEntry> {
        self.entries
    }
}

/// Answering one interrupt, on the interrupt itself.
///
/// The protocol type lives in `ag_ui::outcome`, which has no opinion about
/// consuming a run; these are the two things a client always does with one.
pub trait InterruptExt {
    /// Answers this interrupt with a payload.
    fn resolve(&self, payload: impl Into<Value>) -> ResumeEntry;

    /// Declines this interrupt.
    fn cancel(&self) -> ResumeEntry;

    /// Whether the interrupt is asking to approve a specific tool call.
    fn is_tool_approval(&self) -> bool;
}

impl InterruptExt for Interrupt {
    fn resolve(&self, payload: impl Into<Value>) -> ResumeEntry {
        ResumeEntry::resolved(self.id.clone(), payload)
    }

    fn cancel(&self) -> ResumeEntry {
        ResumeEntry::cancelled(self.id.clone())
    }

    fn is_tool_approval(&self) -> bool {
        self.tool_call_id.is_some() || self.reason == "tool_approval"
    }
}
