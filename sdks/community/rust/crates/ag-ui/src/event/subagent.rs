//! Subagent lifecycle: `SUBAGENT_STARTED`, `SUBAGENT_FINISHED`,
//! `SUBAGENT_ERROR`.
//!
//! Many frameworks let an agent delegate to child agents — a supervisor
//! dispatching research tasks, an agents-as-tools pattern where a tool call
//! *is* a nested agent, a planner farming out subtasks in parallel. To a
//! frontend all of that arrives as one event stream, and without extra
//! information three concurrent researchers render as one undifferentiated
//! wall of text.
//!
//! The protocol's subagent support solves exactly that and nothing more: it
//! **attributes** each event to the subagent that produced it, and reports
//! when subagents start and stop. It does not orchestrate, schedule or define
//! subagents — that stays with the framework.
//!
//! # Attribution
//!
//! Most events carry an optional `subagentRunId` naming who produced them —
//! the text, tool-call, activity, reasoning, step and state families, plus
//! `RAW` and `CUSTOM`. An event without one belongs to the parent agent, so a
//! stream that never sets the field behaves exactly as it did before subagents
//! existed. The events that describe the run as a whole — `RUN_STARTED`,
//! `RUN_FINISHED`, `RUN_ERROR` — cannot carry it, and neither can
//! `MESSAGES_SNAPSHOT`, whose messages carry their own. See
//! [`Event::subagent_run_id`](crate::event::Event::subagent_run_id) and
//! [`EventType::is_attributable`](crate::event::EventType::is_attributable).
//!
//! Attribution stands on its own: a producer may tag events without ever
//! emitting the three lifecycle events, and a consumer must accept an
//! identifier it never saw announced. Attribution on `STATE_*` is provenance,
//! not ownership — the state stays run-scoped, and an attributed snapshot
//! replaces the run's state like any other. There is no per-subagent state.
//!
//! # `subagentRunId` names an invocation, not a definition
//!
//! The easiest thing to get wrong. A [`SubagentRunId`] is an opaque handle for
//! **one invocation**: run the same subagent twice and you get two values. It
//! is not a name and not a stable id for a reusable definition — that is
//! [`SubagentStartedEvent::name`]. The symmetry with the top-level run is the
//! way to remember it: `agentId` is to `runId` as `name` is to `subagentRunId`.
//!
//! The one exception is suspension. A subagent that finished with
//! [`SubagentOutcome::Suspended`] *may* reuse its id on the run that resumes
//! it; a consumer treats that later `SUBAGENT_STARTED` as a continuation,
//! never a duplicate.
//!
//! # Compatibility
//!
//! Attribution is additive and safe — an unknown *field* is tolerated — but
//! the three lifecycle events are unknown *event types* to a client older than
//! subagent support, and such a client fails while decoding, before any
//! application code runs. A producer with older consumers must not emit them;
//! the server runtime's `SubagentVisibility` transformer exists for that.
//!
//! The model here follows upstream's `docs/concepts/subagents.mdx`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event::BaseEvent;
use crate::ids::{MessageId, SubagentRunId, ToolCallId};

/// Announces a subagent invocation and gives it a name a UI can display.
///
/// On this event, unlike the attributable ones, `subagent_run_id` is required:
/// it is the subject, not a tag.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct SubagentStartedEvent {
    /// Timestamp, raw provider event and metadata.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// Opaque id for this invocation. See the [module docs](self) for what it
    /// is not.
    pub subagent_run_id: SubagentRunId,
    /// The subagent's declared type or name, for display — the reusable half.
    pub name: String,
    /// Human-readable description.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<String>,
    /// The enclosing subagent, when subagents nest. May name one that has
    /// already finished — a parent legitimately finishes before its child.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_subagent_run_id: Option<SubagentRunId>,
    /// The tool call that spawned this subagent, for the agents-as-tools
    /// pattern: lets a consumer render the subagent inside the tool-call card
    /// without inspecting `rawEvent`.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_tool_call_id: Option<ToolCallId>,
    /// The message that held that tool call.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_message_id: Option<MessageId>,
}

impl SubagentStartedEvent {
    /// Announces a subagent invocation.
    pub fn new(subagent_run_id: impl Into<SubagentRunId>, name: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            subagent_run_id: subagent_run_id.into(),
            name: name.into(),
            description: None,
            parent_subagent_run_id: None,
            parent_tool_call_id: None,
            parent_message_id: None,
        }
    }

    /// Sets the description.
    #[must_use]
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Names the enclosing subagent.
    #[must_use]
    pub fn with_parent_subagent(mut self, parent: impl Into<SubagentRunId>) -> Self {
        self.parent_subagent_run_id = Some(parent.into());
        self
    }

    /// Links the subagent to the tool call that spawned it — the
    /// agents-as-tools pattern, where a UI draws the subagent inside the
    /// call's card.
    #[must_use]
    pub fn with_parent_tool_call(mut self, tool_call_id: impl Into<ToolCallId>) -> Self {
        self.parent_tool_call_id = Some(tool_call_id.into());
        self
    }

    /// Links the subagent to the assistant message that held the spawning
    /// tool call, when the call sat in one.
    #[must_use]
    pub fn with_parent_message(mut self, message_id: impl Into<MessageId>) -> Self {
        self.parent_message_id = Some(message_id.into());
        self
    }
}

/// How a subagent invocation's stream segment closed for this run.
///
/// Mirrors [`RunOutcome`](crate::outcome::RunOutcome) one level down. The
/// field is optional on `SUBAGENT_FINISHED`, and absent reads as success —
/// but an explicit `null` is rejected, because the field is newer than the
/// fix that made every official producer omit valueless fields.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum SubagentOutcome {
    /// The work completed.
    Success,
    /// The workflow is paused awaiting outside input — a human approval
    /// raised inside the subagent, say. The run then ends with an interrupt
    /// outcome, and because every started subagent closes before
    /// `RUN_FINISHED`, the paused one still emits `SUBAGENT_FINISHED` — with
    /// this outcome, so a UI can show "waiting" rather than "done".
    // `rename_all` on the enum names the variants; the field inside needs its
    // own, or it goes out as `interrupt_ids`.
    #[serde(rename_all = "camelCase")]
    Suspended {
        /// The run-level interrupts this subagent directly owns; each such
        /// [`Interrupt`](crate::outcome::Interrupt) carries `subagent_run_id`
        /// back. May be empty or absent: an ancestor suspended because a
        /// *descendant* interrupted owns no interrupt itself. Absent or a
        /// list, never `null`, like every other field on this surface.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::serde_util::reject_null"
        )]
        interrupt_ids: Option<Vec<String>>,
    },
}

impl SubagentOutcome {
    /// Builds a suspended outcome naming the interrupts the subagent owns.
    pub fn suspended(interrupt_ids: impl Into<Vec<String>>) -> Self {
        Self::Suspended {
            interrupt_ids: Some(interrupt_ids.into()),
        }
    }

    /// Whether the subagent is waiting rather than done.
    pub const fn is_suspended(&self) -> bool {
        matches!(self, Self::Suspended { .. })
    }

    /// The interrupts a suspended subagent owns, or an empty slice.
    pub fn interrupt_ids(&self) -> &[String] {
        match self {
            Self::Success => &[],
            Self::Suspended { interrupt_ids } => interrupt_ids.as_deref().unwrap_or(&[]),
        }
    }
}

/// Closes a subagent invocation's stream segment for this run.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct SubagentFinishedEvent {
    /// Timestamp, raw provider event and metadata.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The invocation being closed — the id from `SUBAGENT_STARTED`.
    pub subagent_run_id: SubagentRunId,
    /// The subagent's completion payload, mirroring `RUN_FINISHED.result`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// How it ended. Absent means success (the legacy reading); a JSON `null`
    /// is rejected — see [`SubagentOutcome`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub outcome: Option<SubagentOutcome>,
}

impl SubagentFinishedEvent {
    /// Closes a subagent invocation without declaring an outcome (legacy
    /// shape, read as success).
    pub fn new(subagent_run_id: impl Into<SubagentRunId>) -> Self {
        Self {
            base: BaseEvent::default(),
            subagent_run_id: subagent_run_id.into(),
            result: None,
            outcome: None,
        }
    }

    /// Sets the completion payload.
    #[must_use]
    pub fn with_result(mut self, result: impl Into<Value>) -> Self {
        self.result = Some(result.into());
        self
    }

    /// Sets the outcome.
    #[must_use]
    pub fn with_outcome(mut self, outcome: SubagentOutcome) -> Self {
        self.outcome = Some(outcome);
        self
    }
}

/// Marks a subagent invocation as failed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct SubagentErrorEvent {
    /// Timestamp, raw provider event and metadata.
    #[serde(flatten)]
    pub base: BaseEvent,
    /// The invocation that failed — the id from `SUBAGENT_STARTED`.
    pub subagent_run_id: SubagentRunId,
    /// What went wrong, for a human.
    pub message: String,
    /// Machine-readable error code.
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub code: Option<String>,
}

impl SubagentErrorEvent {
    /// Fails a subagent invocation with a message.
    pub fn new(subagent_run_id: impl Into<SubagentRunId>, message: impl Into<String>) -> Self {
        Self {
            base: BaseEvent::default(),
            subagent_run_id: subagent_run_id.into(),
            message: message.into(),
            code: None,
        }
    }

    /// Sets the error code.
    #[must_use]
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}
