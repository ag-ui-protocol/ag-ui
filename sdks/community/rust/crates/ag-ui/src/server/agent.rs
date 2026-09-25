//! The boundary: implement [`Agent`], get an AG-UI endpoint.
//!
//! This crate depends on no LLM client. The .NET SDK can build on
//! `Microsoft.Extensions.AI` because .NET has one blessed chat abstraction;
//! Rust has `async-openai`, `rig-core` and `genai` with no winner, so binding
//! to any of them would make this crate useless to two thirds of the ecosystem.
//! A framework integration is an `impl Agent for …` in its own crate.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::RunOutcome;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::server::context::RunContext;
use crate::server::error::Result;

/// What a run's shared state must be.
///
/// A blanket implementation covers every type that qualifies; you never write
/// `impl AgentState`. Use `()` when the agent keeps no state.
pub trait AgentState: Serialize + DeserializeOwned + Default + Send {}

impl<T> AgentState for T where T: Serialize + DeserializeOwned + Default + Send {}

/// An agent that can serve one AG-UI run.
///
/// This is the *hosting* side of the word. The consuming side —
/// a handle onto somebody else's agent — is
/// `client::RemoteAgent`, deliberately spelled differently so that an
/// agent which calls another agent can import both.
///
/// ```
/// use ag_ui::RunOutcome;
/// use ag_ui::server::{Agent, Result, RunContext};
///
/// struct Echo;
///
/// impl Agent for Echo {
///     type State = ();
///
///     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
///         let mut message = ctx.assistant_message()?;
///         message.delta("you said something")?;
///         message.end()?;
///         Ok(RunOutcome::Success)
///     }
/// }
/// ```
///
/// # Why `async fn` and not `#[async_trait]`
///
/// The trait uses a native `-> impl Future + Send` return (an RPITIT), so
/// implementations are plain `async fn` with no macro, no `Box::pin` per call
/// and no allocation. The cost is that the trait is not `dyn`-compatible; when
/// you need `Box<dyn …>` — a registry of agents behind one endpoint, say —
/// [`DynAgent`] is the boxed adapter, and [`BoxAgent`] implements `Agent`
/// again, so the driver takes it like any other.
///
/// # Why `&mut RunContext` and not `RunContext`
///
/// The driver has to emit `RUN_FINISHED` or `RUN_ERROR` *after* the agent
/// returns, through the same transformer chain and the same ordering verifier
/// the agent used. Handing the context over by value would drop both with the
/// agent's last statement.
pub trait Agent: Send + Sync {
    /// The run's shared state, deserialized from
    /// [`RunAgentInput::state`](crate::input::RunAgentInput::state) and published
    /// through [`RunContext::set_state`].
    type State: AgentState;

    /// Serves one run.
    ///
    /// Returning `Ok(RunOutcome::Success)` finishes the run;
    /// `Ok(RunOutcome::Interrupt { .. })` pauses it for human input; `Err`
    /// becomes a `RUN_ERROR` event, never a panic and never a truncated
    /// stream.
    fn run(
        &self,
        ctx: &mut RunContext<Self::State>,
    ) -> impl Future<Output = Result<RunOutcome>> + Send;
}

/// The `dyn`-compatible form of [`Agent`].
///
/// Implemented for every `Agent`, so `Box::new(my_agent) as BoxAgent<_>` just
/// works. The only difference is one boxed future per run.
pub trait DynAgent: Send + Sync {
    /// The run's shared state — see [`Agent::State`].
    type State: AgentState;

    /// Serves one run, boxing the future so the trait stays object-safe.
    fn run_boxed<'a>(
        &'a self,
        ctx: &'a mut RunContext<Self::State>,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome>> + Send + 'a>>;
}

impl<A: Agent> DynAgent for A {
    type State = A::State;

    fn run_boxed<'a>(
        &'a self,
        ctx: &'a mut RunContext<Self::State>,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutcome>> + Send + 'a>> {
        Box::pin(self.run(ctx))
    }
}

/// A type-erased agent over state `S`.
///
/// ```
/// # use ag_ui::RunOutcome;
/// # use ag_ui::server::{Agent, BoxAgent, Result, RunContext};
/// struct Fixed(&'static str);
///
/// impl Agent for Fixed {
///     type State = ();
///     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
///         ctx.say(self.0)?;
///         Ok(RunOutcome::Success)
///     }
/// }
///
/// let agents: Vec<BoxAgent<()>> = vec![Box::new(Fixed("a")), Box::new(Fixed("b"))];
/// assert_eq!(agents.len(), 2);
/// ```
pub type BoxAgent<S> = Box<dyn DynAgent<State = S>>;

impl<S: AgentState> Agent for BoxAgent<S> {
    type State = S;

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        (**self).run_boxed(ctx).await
    }
}

impl<A: Agent> Agent for &A {
    type State = A::State;

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        (**self).run(ctx).await
    }
}

impl<A: Agent> Agent for Arc<A> {
    type State = A::State;

    async fn run(&self, ctx: &mut RunContext<Self::State>) -> Result<RunOutcome> {
        (**self).run(ctx).await
    }
}
