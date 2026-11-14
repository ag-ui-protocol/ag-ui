//! Host an [AG-UI] agent in Rust.
//!
//! AG-UI is the protocol between a user-facing application and an agent
//! backend: a POST carrying [`RunAgentInput`],
//! answered by a stream of typed events. This crate is the server half —
//! implement [`Agent`], hand it to [`run()`], and you have a stream a transport
//! can serialize. [`axum`] mounts it on a router; nothing here depends on
//! a web framework, an executor or an LLM client.
//!
//! ```
//! use ag_ui::{Event, EventType, RunAgentInput, RunOutcome};
//! use ag_ui::server::{Agent, Result, RunContext, run};
//! use futures_util::StreamExt;
//! use serde::{Deserialize, Serialize};
//!
//! /// State the client mirrors and the agent updates.
//! #[derive(Default, Serialize, Deserialize)]
//! struct Draft {
//!     revision: u32,
//!     title: String,
//! }
//!
//! struct Editor;
//!
//! impl Agent for Editor {
//!     type State = Draft;
//!
//!     async fn run(&self, ctx: &mut RunContext<Draft>) -> Result<RunOutcome> {
//!         // A step brackets a phase of the run. Its guard emits
//!         // STEP_FINISHED on drop, so an early `?` cannot skip it.
//!         let mut step = ctx.step("draft")?;
//!
//!         // Reasoning the client can render, in its own REASONING_* block.
//!         step.think("The user wants a title.")?;
//!
//!         // A message streams as TEXT_MESSAGE_START / _CONTENT* / _END.
//!         let mut message = step.assistant_message()?;
//!         message.delta("Naming it ")?;
//!         message.delta("\"Q3 plan\".")?;
//!         message.end()?;
//!
//!         // Publishing state diffs against the last snapshot and sends
//!         // whichever of STATE_SNAPSHOT / STATE_DELTA is smaller.
//!         step.update_state(|draft| {
//!             draft.revision += 1;
//!             draft.title = "Q3 plan".into();
//!         })?;
//!
//!         drop(step); // or just let it fall out of scope
//!         Ok(RunOutcome::Success)
//!     }
//! }
//!
//! # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
//! # rt.block_on(async {
//! let input = RunAgentInput::new("thread-1", "run-1");
//! let events: Vec<Event> = run(Editor, input)
//!     .map(|event| event.expect("the stream should not break"))
//!     .collect()
//!     .await;
//!
//! let types: Vec<EventType> = events.iter().map(Event::event_type).collect();
//! assert_eq!(
//!     types,
//!     [
//!         EventType::RunStarted,
//!         EventType::StepStarted,
//!         EventType::ReasoningStart,
//!         EventType::ReasoningMessageStart,
//!         EventType::ReasoningMessageContent,
//!         EventType::ReasoningMessageEnd,
//!         EventType::ReasoningEnd,
//!         EventType::TextMessageStart,
//!         EventType::TextMessageContent,
//!         EventType::TextMessageContent,
//!         EventType::TextMessageEnd,
//!         EventType::StateSnapshot,
//!         EventType::StepFinished,
//!         EventType::RunFinished,
//!     ]
//! );
//! # });
//! ```
//!
//! # The four things that shape this API
//!
//! **Protocol misuse should not compile.** Event ordering is enforced by
//! [typestate handles](emit) that borrow the run context mutably, so
//! interleaving two messages is a borrow-check error. The handles emit their
//! terminating event on `Drop`, so it cannot be forgotten. What the borrow
//! checker cannot catch — raw [`emit`](RunContext::emit) calls — a runtime
//! [ordering verifier](verify) catches, on by default.
//!
//! **The emit path is synchronous.** `Drop` cannot be async, so a handle cannot
//! `await` while emitting its terminator: `msg.delta(text)?` takes no `.await`.
//! Emitters push into a channel and the transport drains it. Set
//! [`Runner::event_buffer_capacity`] to terminate on overflow; the default
//! remains unbounded.
//!
//! **Executor-agnostic.** `futures` primitives throughout, no tokio in the
//! dependency list, no `spawn`. [`CancellationToken`] is an `AtomicBool` and a
//! waker list rather than `tokio_util`'s. Polling the stream is what runs the
//! agent.
//!
//! **One extension point.** Everything that observes or rewrites the stream is
//! a [`StreamTransformer`]. There is no parallel builder of callbacks; the
//! hooks other SDKs expose that way are built-in transformers here —
//! [`FilterToolCalls`], [`ToolResultToState`].
//!
//! # Human in the loop
//!
//! Return [`RunOutcome::Interrupt`] to pause
//! a run. The client answers, and the next request carries the answers in
//! [`RunContext::resume`]:
//!
//! ```
//! # use ag_ui::{Interrupt, ResumeStatus, RunOutcome};
//! # use ag_ui::server::{Agent, Result, RunContext};
//! # struct Approver;
//! impl Agent for Approver {
//!     type State = ();
//!
//!     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
//!         match ctx.resume_for("delete-everything") {
//!             None => Ok(RunOutcome::interrupt(vec![Interrupt::new(
//!                 "delete-everything",
//!                 "tool_approval",
//!             )])),
//!             Some(answer) if answer.status == ResumeStatus::Resolved => {
//!                 ctx.say("Done.")?;
//!                 Ok(RunOutcome::Success)
//!             }
//!             Some(_) => {
//!                 ctx.say("Cancelled.")?;
//!                 Ok(RunOutcome::Success)
//!             }
//!         }
//!     }
//! }
//! ```
//!
//! # Subagents
//!
//! An agent that delegates opens a [`RunContext::subagent`] scope. Everything
//! emitted through the handle — text, tool calls, reasoning, steps, nested
//! subagents — comes out attributed to that invocation, bracketed by
//! `SUBAGENT_STARTED` and `SUBAGENT_FINISHED`, so a client can group the
//! output by who produced it:
//!
//! ```
//! # use ag_ui::RunOutcome;
//! # use ag_ui::server::{Agent, Result, RunContext};
//! # struct Supervisor;
//! impl Agent for Supervisor {
//!     type State = ();
//!
//!     async fn run(&self, ctx: &mut RunContext<()>) -> Result<RunOutcome> {
//!         let mut planner = ctx.subagent("planner")?;
//!         planner.say("Two tasks: scope, then risks.")?;
//!         {
//!             let mut estimator = planner.subagent("estimator")?;   // nested
//!             estimator.say("About a day each.")?;
//!         }                                                          // SUBAGENT_FINISHED
//!         planner.finish_with(serde_json::json!({ "tasks": 2 }))?;
//!
//!         ctx.say("Plan ready.")?;                                   // the parent's own
//!         Ok(RunOutcome::Success)
//!     }
//! }
//! ```
//!
//! What a consumer sees is a producer-side choice, because a client older than
//! subagent support fails while decoding the lifecycle events. The default
//! sends the stream as emitted; [`SubagentVisibility::inline`] flattens it to
//! the pre-subagent shape and [`SubagentVisibility::hidden`] keeps only the
//! parent's own events — both are ordinary transformers.
//!
//! # Features
//!
//! - `verify` *(default)* — the ordering state machine. Off, the whole
//!   verifier is a zero-sized type whose checks compile away.
//!
//! [AG-UI]: https://docs.ag-ui.com
//! [`axum`]: https://docs.rs/ag-ui/latest/ag_ui/axum/index.html
//
// Core protocol items are spelled as absolute links to the published rustdoc
// rather than as intra-doc paths. `cargo doc --no-deps` — which is what CI and
// the Pages deploy both run — cannot emit a path into a crate it is not
// documenting, and it does not warn: a cross-crate intra-doc link silently
// becomes literal `[text]`, and the `[text](path)` form silently becomes an
// href of `path`, which renders as a link and 404s. See the `doc-links` job.
//! [`RunAgentInput`]: crate::input::RunAgentInput
//! [`RunOutcome::Interrupt`]: crate::outcome::RunOutcome::Interrupt

pub mod agent;
pub mod cancel;
pub mod context;
pub mod emit;
pub mod error;
pub mod run;
pub mod state;
pub mod transform;
pub mod verify;

pub use agent::{Agent, AgentState, BoxAgent, DynAgent};
pub use cancel::{CancellationToken, Cancelled};
pub use context::RunContext;
pub use emit::{
    EventReceiver, MessageHandle, ReasoningHandle, StepGuard, SubagentHandle, ToolCallHandle,
};
pub use error::{Error, Result, Rule, VerificationError};
pub use run::{Runner, run};
pub use state::{StateManager, StatePublish};
pub use transform::{
    FilterToolCalls, StreamTransformer, SubagentFilter, SubagentVisibility, ToolResultToState,
    TransformerChain,
};

#[cfg(feature = "verify")]
pub use verify::EventVerifier;
