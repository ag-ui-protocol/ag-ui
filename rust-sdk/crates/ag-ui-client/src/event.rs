use crate::agent::{AgentError, AgentStateMutation};
use crate::subscriber::AgentSubscriber;
use ag_ui_core::event::Event;
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::types::message::Message;
use ag_ui_core::{FwdProps, JsonValue, State};
use std::sync::Arc;

pub trait EventExt<StateT: State, FwdPropsT: FwdProps> {
    async fn apply_and_process_event(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
        messages: &[Message],
        state: &StateT,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(AgentStateMutation<StateT>, JsonValue), AgentError>;
}

impl<StateT: State, FwdPropsT: FwdProps> EventExt<StateT, FwdPropsT> for Event {
    async fn apply_and_process_event(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
        messages: &[Message],
        state: &StateT,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(AgentStateMutation<StateT>, JsonValue), AgentError> {
        // TODO: Return value
        let (mutation, value) = match self {
            Event::RunFinished(e) => {
                for sub in subscribers {
                    sub.on_run_finished(&e.result.clone().unwrap(), messages, state, input)
                        .await?;
                }

                (AgentStateMutation::default(), e.result.clone().unwrap_or(JsonValue::Null))
            }
            // In a real implementation, other events like Text, ToolCall, etc.,
            // would create mutations to update messages and state.
            _ => (AgentStateMutation::default(), JsonValue::Null),
        };

        Ok((mutation, value))
    }
}
