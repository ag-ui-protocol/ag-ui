use std::collections::HashMap;

use ag_ui_core::event::*;
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::types::message::Message;
use ag_ui_core::types::tool::ToolCall;
use ag_ui_core::{AgentState, FwdProps};
use serde_json::Value as JsonValue;

use crate::agent::{AgentError, AgentStateMutation};

pub struct AgentSubscriberParams<'a, StateT: AgentState, FwdPropsT: FwdProps> {
    pub(crate) messages: &'a [Message],
    pub(crate) state: &'a StateT,
    pub(crate) input: &'a RunAgentInput<StateT, FwdPropsT>,
}

/// Subscriber trait for handling agent events
#[async_trait::async_trait]
pub trait AgentSubscriber<StateT = JsonValue, FwdPropsT = JsonValue>: Send + Sync
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    // Request lifecycle
    async fn on_run_initialized(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_failed(
        &self,
        error: &AgentError,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finalized(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    // Events
    async fn on_event(
        &self,
        event: &Event,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_started_event(
        &self,
        event: &RunStartedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finished_event(
        &self,
        event: &RunFinishedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_run_error_event(
        &self,
        event: &RunErrorEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_step_started_event(
        &self,
        event: &StepStartedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_step_finished_event(
        &self,
        event: &StepFinishedEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_start_event(
        &self,
        event: &TextMessageStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_content_event(
        &self,
        event: &TextMessageContentEvent,
        text_message_buffer: &str,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_end_event(
        &self,
        event: &TextMessageEndEvent,
        text_message_buffer: &str,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_start_event(
        &self,
        event: &ToolCallStartEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_args_event(
        &self,
        event: &ToolCallArgsEvent,
        tool_call_buffer: &str,
        tool_call_name: &str,
        partial_tool_call_args: &HashMap<String, JsonValue>,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_end_event(
        &self,
        event: &ToolCallEndEvent,
        tool_call_name: &str,
        tool_call_args: &HashMap<String, JsonValue>,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_result_event(
        &self,
        event: &ToolCallResultEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_state_snapshot_event(
        &self,
        event: &StateSnapshotEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_state_delta_event(
        &self,
        event: &StateDeltaEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_messages_snapshot_event(
        &self,
        event: &MessagesSnapshotEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_raw_event(
        &self,
        event: &RawEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    async fn on_custom_event(
        &self,
        event: &CustomEvent,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        Ok(AgentStateMutation::default())
    }

    // State changes
    async fn on_messages_changed(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_state_changed(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_new_message(
        &self,
        message: &Message,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }

    async fn on_new_tool_call(
        &self,
        tool_call: &ToolCall,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        Ok(())
    }
}
