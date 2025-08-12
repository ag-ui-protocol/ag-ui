use ag_ui_client::agent::{AgentError, AgentStateMutation, RunAgentParams};
use ag_ui_client::http::HttpAgent;
use ag_ui_client::subscriber::{AgentSubscriber, AgentSubscriberParams};
use ag_ui_core::event::{
    CustomEvent, Event, MessagesSnapshotEvent, RawEvent, RunErrorEvent, RunFinishedEvent,
    RunStartedEvent, StateDeltaEvent, StateSnapshotEvent, StepFinishedEvent, StepStartedEvent,
    TextMessageChunkEvent, TextMessageContentEvent, TextMessageEndEvent, TextMessageStartEvent,
    ThinkingEndEvent, ThinkingStartEvent, ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent, ThinkingTextMessageStartEvent, ToolCallArgsEvent,
    ToolCallChunkEvent, ToolCallEndEvent, ToolCallResultEvent, ToolCallStartEvent,
};
use ag_ui_core::{AgentState, FwdProps, JsonValue};
use async_trait::async_trait;
use reqwest::Url;
use reqwest::header::{HeaderMap, HeaderValue};
use std::error::Error;

// Import our simple subscriber implementation
use ag_ui_client::Agent;
use ag_ui_core::types::ids::MessageId;
use ag_ui_core::types::message::Message;
use ag_ui_core::types::tool::ToolCall;
use log::info;
use std::collections::HashMap;
use std::fmt::Debug;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Base URL for the mock server
    // Run the following command to start the mock server:
    // `uv run rust-sdk/crates/ag-ui-client/scripts/basic_agent.py`
    let base_url = Url::parse("http://127.0.0.1:3001/")?;

    // Create the HTTP agent
    let agent = HttpAgent::builder().with_url(base_url).build()?;

    // Create a simple subscriber
    let subscriber = LoggingSubscriber::new(true);

    // Create run parameters
    let params = RunAgentParams {
        run_id: None,
        tools: None,
        context: None,
        forwarded_props: Some(serde_json::json!({})),
        messages: vec![Message::User {
            id: MessageId::random(),
            content: "Can you give me the current temperature in New York?".into(),
            name: None,
        }],
        state: serde_json::json!({}),
    };

    info!("Running agent with simple subscriber...");

    // Run the agent with the subscriber
    let result = agent.run_agent(&params, [subscriber]).await?;

    info!(
        "Agent run completed with {} new messages",
        result.new_messages.len()
    );
    info!("Result: {}", result.result);

    Ok(())
}

/// A simple implementation of the AgentSubscriber trait that logs events
pub struct LoggingSubscriber {
    pub verbose: bool,
}

impl LoggingSubscriber {
    pub fn new(verbose: bool) -> Self {
        Self { verbose }
    }

    fn log_event<T: Debug>(&self, event_name: &str, event: &T) {
        if self.verbose {
            info!("Event: {} - {:?}", event_name, event);
        } else {
            info!("Event: {}", event_name);
        }
    }
}

#[async_trait]
impl<StateT, FwdPropsT> AgentSubscriber<StateT, FwdPropsT> for LoggingSubscriber
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    async fn on_run_initialized(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        info!("Run initialized with {} messages", params.messages.len());
        Ok(AgentStateMutation::default())
    }

    async fn on_run_failed(
        &self,
        error: &AgentError,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        info!("Run failed: {:?}", error);
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finalized(
        &self,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        info!("Run finalized");
        Ok(AgentStateMutation::default())
    }

    async fn on_event(
        &self,
        event: &Event<StateT>,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("Generic event", &event);
        Ok(AgentStateMutation::default())
    }

    async fn on_run_started_event(
        &self,
        event: &RunStartedEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("RunStarted", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_run_finished_event(
        &self,
        event: &RunFinishedEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("RunFinished", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_run_error_event(
        &self,
        event: &RunErrorEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("RunError", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_step_started_event(
        &self,
        event: &StepStartedEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("StepStarted", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_step_finished_event(
        &self,
        event: &StepFinishedEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("StepFinished", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_start_event(
        &self,
        event: &TextMessageStartEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("TextMessageStart", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_content_event(
        &self,
        event: &TextMessageContentEvent,
        text_message_buffer: &str,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("TextMessageContent", event);
        info!("Current buffer: {}", text_message_buffer);
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_end_event(
        &self,
        event: &TextMessageEndEvent,
        text_message_buffer: &str,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("TextMessageEnd", event);
        info!("Final message: {}", text_message_buffer);
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_start_event(
        &self,
        event: &ToolCallStartEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ToolCallStart", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_args_event(
        &self,
        event: &ToolCallArgsEvent,
        tool_call_buffer: &str,
        tool_call_name: &str,
        partial_tool_call_args: &HashMap<String, JsonValue>,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ToolCallArgs", event);
        info!(
            "Tool call: {} with args: {}",
            tool_call_name, tool_call_buffer
        );
        info!("Partial args: {:?}", partial_tool_call_args);
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_end_event(
        &self,
        event: &ToolCallEndEvent,
        tool_call_name: &str,
        tool_call_args: &HashMap<String, JsonValue>,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ToolCallEnd", event);
        info!(
            "Tool call completed: {} with args: {:?}",
            tool_call_name, tool_call_args
        );
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_result_event(
        &self,
        event: &ToolCallResultEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ToolCallResult", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_state_snapshot_event(
        &self,
        event: &StateSnapshotEvent<StateT>,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("StateSnapshot", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_state_delta_event(
        &self,
        event: &StateDeltaEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("StateDelta", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_messages_snapshot_event(
        &self,
        event: &MessagesSnapshotEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("MessagesSnapshot", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_raw_event(
        &self,
        event: &RawEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("Raw", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_custom_event(
        &self,
        event: &CustomEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("Custom", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_text_message_chunk_event(
        &self,
        event: &TextMessageChunkEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("TextMessageChunk", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_text_message_start_event(
        &self,
        event: &ThinkingTextMessageStartEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ThinkingTextMessageStart", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_text_message_content_event(
        &self,
        event: &ThinkingTextMessageContentEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ThinkingTextMessageContent", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_text_message_end_event(
        &self,
        event: &ThinkingTextMessageEndEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ThinkingTextMessageEnd", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_tool_call_chunk_event(
        &self,
        event: &ToolCallChunkEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ToolCallChunk", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_start_event(
        &self,
        event: &ThinkingStartEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ThinkingStart", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_thinking_end_event(
        &self,
        event: &ThinkingEndEvent,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        self.log_event("ThinkingEnd", event);
        Ok(AgentStateMutation::default())
    }

    async fn on_messages_changed(
        &self,
        params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        info!("Messages changed: {} messages", params.messages.len());
        Ok(())
    }

    async fn on_state_changed(
        &self,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        info!("State changed");
        Ok(())
    }

    async fn on_new_message(
        &self,
        message: &Message,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        info!("New message: {:?}", message);
        Ok(())
    }

    async fn on_new_tool_call(
        &self,
        tool_call: &ToolCall,
        _params: AgentSubscriberParams<'async_trait, StateT, FwdPropsT>,
    ) -> Result<(), AgentError> {
        info!("New tool call: {:?}", tool_call);
        Ok(())
    }
}
