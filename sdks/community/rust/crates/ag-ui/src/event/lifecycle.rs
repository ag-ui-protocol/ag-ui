//! Run and step lifecycle: `RUN_*` and `STEP_*`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::BaseEvent;
use crate::ids::{RunId, StepName, SubagentRunId, ThreadId};
use crate::input::RunAgentInput;
use crate::outcome::RunOutcome;
use crate::token_usage::TokenUsage;

/// The first event of every run.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunStartedEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The conversation this run belongs to.
    pub thread_id: ThreadId,
    /// The run that is starting.
    pub run_id: RunId,
    /// The run that spawned this one, for nested / delegated agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    /// The request that started the run, echoed so a recorded stream replays
    /// without the original HTTP body.
    ///
    /// Boxed: it is the largest payload in the protocol and is usually absent,
    /// so inlining it would bloat every [`Event`](crate::event::Event).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Box<RunAgentInput>>,
}

impl RunStartedEvent {
    /// Starts a run.
    pub fn new(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        Self {
            base: BaseEvent::default(),
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            parent_run_id: None,
            input: None,
        }
    }
}

/// The last event of a run that did not error.
///
/// "Finished" includes *paused*: an [`RunOutcome::Interrupt`] outcome means the
/// agent is waiting on human input and the run continues on the next request.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunFinishedEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The conversation this run belongs to.
    pub thread_id: ThreadId,
    /// The run that finished.
    pub run_id: RunId,
    /// Agent-defined return value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// How the run ended. Absent from producers that predate the interrupt
    /// protocol, which consumers read as success. A JSON `null` also reads as
    /// absent, for producers that serialize `None` rather than omitting it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RunOutcome>,
    /// Token usage, one entry per `(provider, model)` the run invoked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Vec<TokenUsage>>,
}

impl RunFinishedEvent {
    /// Finishes a run without declaring an outcome (legacy shape).
    pub fn new(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        Self {
            base: BaseEvent::default(),
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            result: None,
            outcome: None,
            usage: None,
        }
    }

    /// Sets the outcome.
    #[must_use]
    pub fn with_outcome(mut self, outcome: RunOutcome) -> Self {
        self.outcome = Some(outcome);
        self
    }

    /// Sets the return value.
    #[must_use]
    pub fn with_result(mut self, result: impl Into<Value>) -> Self {
        self.result = Some(result.into());
        self
    }

    /// Sets the token usage.
    #[must_use]
    pub fn with_usage(mut self, usage: impl Into<Vec<TokenUsage>>) -> Self {
        self.usage = Some(usage.into());
        self
    }
}

/// The run failed. No further events follow.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunErrorEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// What went wrong, for a human.
    pub message: String,
    /// Machine-readable error code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Partial usage for a run that failed after some model calls completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Vec<TokenUsage>>,
}

impl RunErrorEvent {
    /// Fails the run with a message.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            message: message.into(),
            code: None,
            usage: None,
        }
    }

    /// Sets the error code.
    #[must_use]
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}

/// Opens a named step within a run.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct StepStartedEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The step that is starting.
    pub step_name: StepName,
    /// The subagent that opened the step; absent means the parent agent. A
    /// JSON `null` is rejected — see [`crate::event::subagent`]. Steps are
    /// scoped to the agent that opened them: a subagent cannot close the
    /// parent's step, or a sibling's, so the same name may be open under two
    /// owners at once.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl StepStartedEvent {
    /// Starts a step.
    pub fn new(step_name: impl Into<StepName>) -> Self {
        Self {
            base: BaseEvent::default(),
            step_name: step_name.into(),
            subagent_run_id: None,
        }
    }
}

/// Closes a named step.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct StepFinishedEvent {
    /// Timestamp and raw provider event.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The step that finished.
    pub step_name: StepName,
    /// The subagent that closes the step; absent means the parent agent. A
    /// JSON `null` is rejected — see [`crate::event::subagent`]. Must match
    /// the owner that opened it, as on [`StepStartedEvent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl StepFinishedEvent {
    /// Finishes a step.
    pub fn new(step_name: impl Into<StepName>) -> Self {
        Self {
            base: BaseEvent::default(),
            step_name: step_name.into(),
            subagent_run_id: None,
        }
    }
}
