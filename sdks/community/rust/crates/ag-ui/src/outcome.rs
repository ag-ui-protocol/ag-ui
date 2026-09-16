//! Run outcomes and the human-in-the-loop interrupt protocol.
//!
//! A run does not only end in success or error. It can also *pause*: the agent
//! emits `RUN_FINISHED` with an [`RunOutcome::Interrupt`] outcome listing one or
//! more [`Interrupt`]s, the client collects the answers, and the next request
//! resumes the run by passing [`ResumeEntry`] values in
//! [`RunAgentInput::resume`](crate::input::RunAgentInput::resume).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonObject;
use crate::error::{Error, Result};
use crate::ids::{SubagentRunId, ToolCallId};

/// A request for human input that pauses the run.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct Interrupt {
    /// Correlation id — echoed back as
    /// [`ResumeEntry::interrupt_id`] when the run resumes.
    pub id: String,
    /// Machine-readable reason, for example `"tool_approval"`.
    pub reason: String,
    /// Human-readable prompt to show the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The tool call awaiting approval, when the interrupt is about one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    /// JSON Schema the resume payload must satisfy — lets a client render a
    /// form for the answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub response_schema: Option<JsonObject>,
    /// When the interrupt stops being answerable, as an ISO-8601 timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Integration-specific extras.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub metadata: Option<JsonObject>,
    /// The subagent whose work raised this interrupt, when it was raised
    /// inside one — absent for a root-raised interrupt. Attribution lives on
    /// each interrupt rather than on `RUN_FINISHED` because one run can carry
    /// interrupts from several subagents; a client uses it to render the
    /// approval request inside that subagent's group. A JSON `null` is
    /// rejected — see [`crate::event::subagent`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub subagent_run_id: Option<SubagentRunId>,
}

impl Interrupt {
    /// Builds an interrupt from its two required fields.
    pub fn new(id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            reason: reason.into(),
            ..Default::default()
        }
    }

    /// Attributes the interrupt to the subagent that raised it.
    #[must_use]
    pub fn with_subagent_run_id(mut self, subagent_run_id: impl Into<SubagentRunId>) -> Self {
        self.subagent_run_id = Some(subagent_run_id.into());
        self
    }
}

/// How a run ended.
///
/// The field is optional on `RUN_FINISHED`: producers that predate the
/// interrupt protocol omit it entirely, which consumers must read as success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum RunOutcome {
    /// The run completed.
    Success,
    /// The run is paused, waiting on the answers to `interrupts`.
    Interrupt {
        /// The pending requests. The protocol requires at least one; see
        /// [`RunOutcome::validate`].
        interrupts: Vec<Interrupt>,
    },
}

impl RunOutcome {
    /// Builds an interrupt outcome.
    pub fn interrupt(interrupts: impl Into<Vec<Interrupt>>) -> Self {
        Self::Interrupt {
            interrupts: interrupts.into(),
        }
    }

    /// Whether the run is paused rather than finished.
    pub const fn is_interrupt(&self) -> bool {
        matches!(self, Self::Interrupt { .. })
    }

    /// The pending interrupts, or an empty slice for a success outcome.
    pub fn interrupts(&self) -> &[Interrupt] {
        match self {
            Self::Success => &[],
            Self::Interrupt { interrupts } => interrupts,
        }
    }

    /// Checks the one rule the type system cannot: an `interrupt` outcome must
    /// carry at least one interrupt.
    ///
    /// Deserializing does not enforce this, so that a stray empty array from a
    /// buggy producer surfaces as a protocol error you can log rather than as
    /// an unparseable event that kills the stream.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Interrupt { interrupts } if interrupts.is_empty() => Err(Error::Protocol(
                "RUN_FINISHED outcome `interrupt` requires at least one interrupt".to_owned(),
            )),
            _ => Ok(()),
        }
    }
}

/// How the client answered one interrupt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum ResumeStatus {
    /// The user answered; `payload` carries the answer.
    Resolved,
    /// The user declined or the request timed out.
    Cancelled,
}

impl ResumeStatus {
    /// The status string as it appears on the wire.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Resolved => "resolved",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One answer to one [`Interrupt`], sent on the resuming request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ResumeEntry {
    /// The [`Interrupt::id`] being answered.
    pub interrupt_id: String,
    /// Whether the user answered or declined.
    pub status: ResumeStatus,
    /// The answer. Shape is up to the agent; when the interrupt supplied a
    /// `responseSchema`, this should satisfy it. For a tool approval that was
    /// edited before approval, agents that advertise `approveWithEdits` expect
    /// `{"editedArgs": …}` here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    /// Envelope data about the answer — signatures, routing keys — as opposed
    /// to `payload`, which is the answer the agent asked for and will act on.
    /// A request field, so nothing merges into it. Absent or an object — a
    /// JSON `null` is rejected. See [`crate::metadata`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub metadata: Option<JsonObject>,
}

impl ResumeEntry {
    /// Answers an interrupt with a payload.
    pub fn resolved(interrupt_id: impl Into<String>, payload: impl Into<Value>) -> Self {
        Self {
            interrupt_id: interrupt_id.into(),
            status: ResumeStatus::Resolved,
            payload: Some(payload.into()),
            metadata: None,
        }
    }

    /// Declines an interrupt.
    pub fn cancelled(interrupt_id: impl Into<String>) -> Self {
        Self {
            interrupt_id: interrupt_id.into(),
            status: ResumeStatus::Cancelled,
            payload: None,
            metadata: None,
        }
    }

    /// Attaches envelope metadata to the answer.
    #[must_use]
    pub fn with_metadata(mut self, metadata: JsonObject) -> Self {
        self.metadata = Some(metadata);
        self
    }
}
