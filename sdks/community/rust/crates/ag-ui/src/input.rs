//! The request body an agent receives to start or resume a run.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::context::Context;
use crate::ids::{RunId, ThreadId};
use crate::message::Message;
use crate::outcome::ResumeEntry;
use crate::tool::Tool;

/// Everything an agent needs for one run.
///
/// This is the body of the AG-UI run request, and it is also embedded verbatim
/// in [`RunStartedEvent::input`](crate::event::RunStartedEvent::input) so a
/// recorded stream can be replayed without the original request.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct RunAgentInput {
    /// The conversation this run belongs to.
    pub thread_id: ThreadId,
    /// This run's id, echoed on every lifecycle event.
    pub run_id: RunId,
    /// The run that spawned this one, for nested / delegated agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    /// Shared state, mutated by the agent through `STATE_SNAPSHOT` and
    /// `STATE_DELTA`. Free-form JSON, opaque to the protocol.
    #[serde(default)]
    pub state: Value,
    /// Conversation history, oldest first.
    pub messages: Vec<Message>,
    /// Tools the client is offering for this run.
    pub tools: Vec<Tool>,
    /// Ambient context entries.
    pub context: Vec<Context>,
    /// Arbitrary passthrough properties, opaque to the protocol.
    #[serde(default)]
    pub forwarded_props: Value,
    /// Answers to the interrupts a previous run paused on. Present only when
    /// resuming — see [`crate::outcome`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<Vec<ResumeEntry>>,
}

impl RunAgentInput {
    /// Builds an input with only the two required identifiers set.
    pub fn new(thread_id: impl Into<ThreadId>, run_id: impl Into<RunId>) -> Self {
        Self {
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            ..Default::default()
        }
    }

    /// Whether this request resumes a paused run.
    pub fn is_resume(&self) -> bool {
        self.resume.as_ref().is_some_and(|r| !r.is_empty())
    }
}
