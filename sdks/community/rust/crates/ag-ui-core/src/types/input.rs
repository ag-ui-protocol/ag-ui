use crate::JsonValue;
use crate::types::context::Context;
use crate::types::ids::{RunId, ThreadId};
use crate::types::message::Message;
use crate::types::tool::Tool;
use serde::{Deserialize, Serialize};

/// Input for running an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct RunAgentInput<StateT = JsonValue, FwdPropsT = JsonValue> {
    #[serde(rename = "threadId")]
    pub thread_id: ThreadId,
    #[serde(rename = "runId")]
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "is_null_json")]
    pub state: StateT,
    pub messages: Vec<Message>,
    #[serde(
        default,
        deserialize_with = "crate::types::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub tools: Option<Vec<Tool>>,
    #[serde(
        default,
        deserialize_with = "crate::types::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub context: Option<Vec<Context>>,
    #[serde(rename = "forwardedProps")]
    #[serde(default, skip_serializing_if = "is_null_json")]
    pub forwarded_props: FwdPropsT,
    #[serde(rename = "protocolVersion", skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(rename = "parentRunId", skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<Vec<crate::types::ResumeEntry>>,
}

impl<StateT, FwdPropsT> RunAgentInput<StateT, FwdPropsT> {
    pub fn new(
        thread_id: impl Into<ThreadId>,
        run_id: impl Into<RunId>,
        state: StateT,
        messages: Vec<Message>,
        tools: Vec<Tool>,
        context: Vec<Context>,
        forwarded_props: FwdPropsT,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            run_id: run_id.into(),
            state,
            messages,
            tools: Some(tools),
            context: Some(context),
            forwarded_props,
            protocol_version: None,
            parent_run_id: None,
            resume: None,
        }
    }
}

fn is_null_json<T: Serialize>(value: &T) -> bool {
    serde_json::to_value(value).is_ok_and(|v| v.is_null())
}
