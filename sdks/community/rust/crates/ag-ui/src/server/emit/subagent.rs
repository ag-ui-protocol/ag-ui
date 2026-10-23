//! Scoping a subagent invocation.

use std::ops::{Deref, DerefMut};

use crate::{Event, SubagentFinishedEvent, SubagentOutcome, SubagentRunId, SubagentStartedEvent};
use serde_json::Value;

use crate::server::context::RunContext;
use crate::server::error::Result;

/// One open subagent invocation.
///
/// Created by [`RunContext::subagent_events`](crate::server::RunContext::subagent_events).
/// `SUBAGENT_STARTED` has already gone out. Finish, fail or suspend explicitly:
/// dropping an unfinished scope restores attribution without inventing an outcome.
///
/// A subagent is a *scope*, like a step: everything emitted through the
/// handle comes out attributed to it. The handle therefore dereferences to
/// the run context — messages, tool calls, reasoning, steps and nested
/// subagents all open through it, and every event they produce carries this
/// invocation's `subagentRunId` without the agent saying so:
///
/// ```
/// # use ag_ui::{Event, EventType, RunAgentInput, TextMessageRole};
/// # use ag_ui::server::RunContext;
/// # let (mut ctx, mut events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
/// {
///     let mut researcher = ctx.subagent_events("researcher")?;
///     researcher.say("Three sources found.")?;   // attributed, through Deref
///     researcher.finish_with(serde_json::json!({ "sources": 3 }))?;
/// }
/// ctx.say("Thanks.")?;                            // the parent's own, untagged
///
/// let events = events.drain();
/// assert_eq!(events[0].event_type(), EventType::SubagentStarted);
/// assert_eq!(events[1].subagent_run_id().map(|id| id.as_str()), Some("r-sub-1"));
/// assert_eq!(events[4].event_type(), EventType::SubagentFinished);
/// assert_eq!(events[5].subagent_run_id(), None);
/// # Ok::<(), ag_ui::server::Error>(())
/// ```
///
/// Nesting is automatic: a subagent opened through a handle gets the handle's
/// id as its `parentSubagentRunId`. Two subagents cannot be open at once
/// through handles — the second `subagent()` is a borrow-check error, as
/// everything overlapping is here. For subagents that genuinely stream
/// concurrently, tag events yourself and emit them interleaved; see the
/// [module docs](crate::server::emit#subagents).
///
/// # Ending it
///
/// The terminator names the subagent it closes and is not itself attributed
/// to it, so every method here restores the enclosing attribution *before*
/// emitting. A parent error may terminate with the child still open. A successful
/// or interrupted parent must explicitly close every announced child; otherwise
/// the run driver reports a protocol error, including when `verify` is disabled.
/// This handle records events; the application executes the work.
#[derive(Debug)]
pub struct SubagentHandle<'a, S> {
    ctx: &'a mut RunContext<S>,
    id: SubagentRunId,
    name: String,
    /// The attribution in force before this subagent, restored on close.
    previous: Option<SubagentRunId>,
    ended: bool,
}

impl<'a, S> SubagentHandle<'a, S> {
    /// Emits `SUBAGENT_STARTED` and scopes the context to the new subagent.
    ///
    /// A `parent_subagent_run_id` the caller left absent is filled from the
    /// enclosing scope, which is what makes nesting through `Deref` correct
    /// without the agent naming the parent.
    pub(crate) fn start(
        ctx: &'a mut RunContext<S>,
        mut started: SubagentStartedEvent,
    ) -> Result<Self> {
        if started.parent_subagent_run_id.is_none() {
            started.parent_subagent_run_id = ctx.subagent_run_id().cloned();
        }
        let id = started.subagent_run_id.clone();
        let name = started.name.clone();
        ctx.emit(started.into())?;
        let previous = ctx.set_attribution(Some(id.clone()));
        Ok(Self {
            ctx,
            id,
            name,
            previous,
            ended: false,
        })
    }

    /// The id every event emitted through this handle carries.
    pub fn id(&self) -> &SubagentRunId {
        &self.id
    }

    /// The subagent's declared name, as announced.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Leaves the scope: the enclosing attribution is back in force, and the
    /// terminator about to be emitted belongs to it.
    fn leave(&mut self) {
        self.ended = true;
        let previous = self.previous.take();
        self.ctx.set_attribution(previous);
    }

    /// Emits `SUBAGENT_FINISHED` with a success outcome and consumes the
    /// handle.
    ///
    /// Unlike `Drop`, this explicitly reports successful completion.
    pub fn finish(mut self) -> Result<()> {
        self.leave();
        self.ctx
            .emit(Event::subagent_finished_success(self.id.clone()))
    }

    /// Emits `SUBAGENT_FINISHED` carrying a completion payload — the
    /// subagent's counterpart of `RUN_FINISHED.result`.
    pub fn finish_with(mut self, result: impl Into<Value>) -> Result<()> {
        self.leave();
        self.ctx.emit(
            SubagentFinishedEvent::new(self.id.clone())
                .with_result(result)
                .with_outcome(SubagentOutcome::Success)
                .into(),
        )
    }

    /// Emits `SUBAGENT_FINISHED` with a suspended outcome: the subagent is
    /// waiting on `interrupt_ids`, which the run is about to return in an
    /// interrupt outcome.
    ///
    /// Build each interrupt with
    /// [`Interrupt::with_subagent_run_id`](crate::Interrupt::with_subagent_run_id)
    /// so a client can render it inside this subagent's group, and announce
    /// the same id again on the resuming run to continue the invocation.
    pub fn suspend(mut self, interrupt_ids: impl Into<Vec<String>>) -> Result<()> {
        self.leave();
        self.ctx.emit(Event::subagent_finished_suspended(
            self.id.clone(),
            interrupt_ids,
        ))
    }

    /// Emits `SUBAGENT_ERROR` and consumes the handle.
    pub fn fail(mut self, message: impl Into<String>) -> Result<()> {
        self.leave();
        self.ctx
            .emit(Event::subagent_error(self.id.clone(), message))
    }

    /// Emits `SUBAGENT_ERROR` with a machine-readable code.
    pub fn fail_with_code(
        mut self,
        message: impl Into<String>,
        code: impl Into<String>,
    ) -> Result<()> {
        self.leave();
        self.ctx.emit(
            crate::SubagentErrorEvent::new(self.id.clone(), message)
                .with_code(code)
                .into(),
        )
    }
}

impl<S> Deref for SubagentHandle<'_, S> {
    type Target = RunContext<S>;

    fn deref(&self) -> &Self::Target {
        self.ctx
    }
}

impl<S> DerefMut for SubagentHandle<'_, S> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.ctx
    }
}

impl<S> Drop for SubagentHandle<'_, S> {
    fn drop(&mut self) {
        if !self.ended {
            self.leave();
        }
    }
}
