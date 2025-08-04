use serde_json::Value as JsonValue;
use ag_ui_core::{FwdProps, State};
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::types::message::Message;
use crate::agent::{AgentError, AgentStateMutation};

/// Subscriber trait for handling agent events
#[async_trait::async_trait]
pub trait AgentSubscriber<StateT = JsonValue, FwdPropsT = JsonValue>: Send + Sync
where
    StateT: State,
    FwdPropsT: FwdProps,
{
    async fn on_run_initialized(
        &self,
        _messages: &[Message],
        _state: &StateT,
        _input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finished(
        &self,
        _result: &JsonValue,
        _messages: &[Message],
        _state: &StateT,
        _input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_run_failed(
        &self,
        _error: &AgentError,
        _messages: &[Message],
        _state: &StateT,
        _input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finalized(
        &self,
        _messages: &[Message],
        _state: &StateT,
        _input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_messages_changed(
        &self,
        _messages: &[Message],
        _state: &StateT,
        _input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_state_changed(
        &self,
        _messages: &[Message],
        _state: &StateT,
        _input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }
}