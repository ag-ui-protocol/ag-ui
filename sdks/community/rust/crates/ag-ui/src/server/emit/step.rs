//! Bracketing a named step.

use std::ops::{Deref, DerefMut};

use crate::{Event, StepName};

use crate::server::context::RunContext;
use crate::server::error::Result;

/// One open step.
///
/// Created by [`RunContext::step`](crate::server::RunContext::step). `STEP_STARTED` has
/// already gone out; `Drop` emits `STEP_FINISHED`, including on the early
/// return that a `?` produces.
///
/// A step is a *scope*, not a stream, so unlike the message and tool-call
/// handles this one dereferences to the run context — everything nests inside
/// it, steps included:
///
/// ```
/// # use ag_ui::RunAgentInput;
/// # use ag_ui::server::RunContext;
/// # let (mut ctx, mut events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
/// {
///     let mut step = ctx.step("research")?;
///     step.say("looking it up")?;   // through Deref
/// }                                 // STEP_FINISHED here
/// assert_eq!(events.drain().len(), 5);
/// # Ok::<(), ag_ui::server::Error>(())
/// ```
#[derive(Debug)]
pub struct StepGuard<'a, S> {
    ctx: &'a mut RunContext<S>,
    name: StepName,
    ended: bool,
}

impl<'a, S> StepGuard<'a, S> {
    /// Emits `STEP_STARTED` and takes the step.
    pub(crate) fn start(ctx: &'a mut RunContext<S>, name: StepName) -> Result<Self> {
        ctx.emit(Event::step_started(name.clone()))?;
        Ok(Self {
            ctx,
            name,
            ended: false,
        })
    }

    /// The step's name.
    pub fn name(&self) -> &StepName {
        &self.name
    }

    /// Emits `STEP_FINISHED` and consumes the guard.
    ///
    /// Only worth calling over letting the guard drop when you want to see the
    /// error.
    pub fn finish(mut self) -> Result<()> {
        self.ended = true;
        self.ctx.emit(Event::step_finished(self.name.clone()))
    }
}

impl<S> Deref for StepGuard<'_, S> {
    type Target = RunContext<S>;

    fn deref(&self) -> &Self::Target {
        self.ctx
    }
}

impl<S> DerefMut for StepGuard<'_, S> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.ctx
    }
}

impl<S> Drop for StepGuard<'_, S> {
    fn drop(&mut self) {
        if !self.ended {
            let _ = self.ctx.emit(Event::step_finished(self.name.clone()));
        }
    }
}
