use futures::stream::StreamExt;
use std::collections::HashSet;
use std::sync::Arc;
use thiserror::Error;

use ag_ui_core::types::context::Context;
use ag_ui_core::types::ids::{AgentId, MessageId, RunId, ThreadId};
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::types::message::Message;
use ag_ui_core::types::tool::Tool;
use ag_ui_core::{AgentState, FwdProps, JsonValue};

use crate::event_handler::EventHandler;
use crate::stream::EventStream;
use crate::subscriber::AgentSubscriber;

#[derive(Debug, Clone)]
pub struct AgentConfig<StateT = JsonValue> {
    pub agent_id: Option<AgentId>,
    pub description: Option<String>,
    pub thread_id: Option<ThreadId>,
    pub initial_messages: Option<Vec<Message>>,
    pub initial_state: Option<StateT>,
    pub debug: Option<bool>,
}

impl<S> Default for AgentConfig<S>
where
    S: Default,
{
    fn default() -> Self {
        Self {
            agent_id: None,
            description: None,
            thread_id: None,
            initial_messages: None,
            initial_state: None,
            debug: None,
        }
    }
}

/// Parameters for running an agent.
#[derive(Debug, Clone, Default)]
pub struct RunAgentParams<StateT: AgentState, FwdPropsT = JsonValue> {
    pub run_id: Option<RunId>,
    pub tools: Option<Vec<Tool>>,
    pub context: Option<Vec<Context>>,
    pub forwarded_props: Option<FwdPropsT>,
    pub messages: Vec<Message>,
    pub state: StateT,
}

#[derive(Debug, Clone)]
pub struct RunAgentResult<StateT: AgentState> {
    pub result: JsonValue,
    pub new_messages: Vec<Message>,
    pub new_state: StateT
}

pub type AgentRunState<StateT, FwdPropsT> = RunAgentInput<StateT, FwdPropsT>;

#[derive(Debug, Clone)]
pub struct AgentStateMutation<StateT = JsonValue> {
    pub messages: Option<Vec<Message>>,
    pub state: Option<StateT>,
    pub stop_propagation: bool,
}

impl<StateT> Default for AgentStateMutation<StateT> {
    fn default() -> Self {
        Self {
            messages: None,
            state: None,
            stop_propagation: false,
        }
    }
}

// Error types
#[derive(Error, Debug)]
pub enum AgentError {
    #[error("Agent execution failed: {message}")]
    ExecutionError { message: String },
    #[error("Invalid configuration: {message}")]
    ConfigError { message: String },
    #[error("Serialization error: {source}")]
    SerializationError {
        #[from]
        source: serde_json::Error,
    },
}

/// Agent trait
#[async_trait::async_trait]
pub trait Agent<StateT = JsonValue, FwdPropsT = JsonValue>: Send + Sync
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{

    async fn run(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
    ) -> Result<EventStream<'async_trait, StateT>, AgentError>;

    /// The main execution method, containing the full pipeline logic.
    async fn run_agent(
        &self,
        params: &RunAgentParams<StateT, FwdPropsT>,
        subscribers: Vec<Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>,
    ) -> Result<RunAgentResult<StateT>, AgentError> {
        // TODO: Use Agent ID?
        let _agent_id = AgentId::random();

        let input = RunAgentInput {
            thread_id: ThreadId::random(),
            run_id: params.run_id.clone().unwrap_or_else(RunId::random),
            state: params.state.clone(),
            messages: params.messages.clone(),
            tools: params.tools.clone().unwrap_or_default(),
            context: params.context.clone().unwrap_or_default(),
            // TODO: Find suitable default value
            forwarded_props: params.forwarded_props.clone().unwrap(),
        };
        let current_message_ids: HashSet<&MessageId> =
            params.messages.iter().map(|m| m.id()).collect();

        // Initialize event handler with the current state
        let mut event_handler = EventHandler::new(
            params.messages.clone(),
            params.state.clone(),
            &input,
            subscribers,
        );

        let mut stream = self.run(&input).await?.fuse();

        while let Some(event_result) = stream.next().await {
            match event_result {
                Ok(event) => {
                    let mutation = event_handler.handle_event(&event).await?;
                    event_handler.apply_mutation(mutation).await?;
                }
                Err(e) => {
                    event_handler.on_error(&e).await?;
                    return Err(e);
                }
            }
        }

        // Finalize the run
        event_handler.on_finalize().await?;

        // Collect new messages
        let new_messages = event_handler
            .messages
            .iter()
            .filter(|m| !current_message_ids.contains(&m.id()))
            .cloned()
            .collect();


        Ok(RunAgentResult {
            result: event_handler.result,
            new_messages,
            new_state: event_handler.state
        })
    }
}
