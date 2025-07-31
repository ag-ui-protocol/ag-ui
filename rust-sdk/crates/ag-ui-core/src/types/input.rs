use crate::types::context::Context;
use crate::types::messages::Message;
use crate::types::tool::Tool;
use serde::{Deserialize, Serialize};

/// Input for running an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunAgentInput<State = serde_json::Value, FwdProps = serde_json::Value> {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub state: State,
    pub messages: Vec<Message>,
    pub tools: Vec<Tool>,
    pub context: Vec<Context>,
    #[serde(rename = "forwardedProps")]
    pub forwarded_props: FwdProps,
}

impl<State, FwdProps> RunAgentInput<State, FwdProps> {
    pub fn new(
        thread_id: String,
        run_id: String,
        state: State,
        messages: Vec<Message>,
        tools: Vec<Tool>,
        context: Vec<Context>,
        forwarded_props: FwdProps,
    ) -> Self {
        Self {
            thread_id,
            run_id,
            state,
            messages,
            tools,
            context,
            forwarded_props,
        }
    }
}
