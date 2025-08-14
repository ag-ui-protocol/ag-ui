use futures::stream::StreamExt;
use std::collections::HashSet;
use thiserror::Error;

use crate::core::JsonValue;
use crate::core::types::{
    AgentId, Context, Message, MessageId, RunAgentInput, RunId, ThreadId, Tool,
};
use crate::core::{AgentState, FwdProps};
use crate::event_handler::EventHandler;
use crate::stream::EventStream;
use crate::subscriber::IntoSubscribers;

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
pub struct RunAgentParams<StateT: AgentState = JsonValue, FwdPropsT: FwdProps = JsonValue> {
    pub run_id: Option<RunId>,
    pub tools: Vec<Tool>,
    pub context: Vec<Context>,
    pub forwarded_props: FwdPropsT,
    pub messages: Vec<Message>,
    pub state: StateT,
}

impl<StateT: AgentState + Default, FwdPropsT: FwdProps + Default>
    RunAgentParams<StateT, FwdPropsT>
{
    pub fn new_typed() -> Self {
        Self {
            run_id: None,
            tools: Vec::new(),
            context: Vec::new(),
            forwarded_props: FwdPropsT::default(),
            messages: Vec::new(),
            state: StateT::default(),
        }
    }

    pub fn with_run_id(mut self, run_id: RunId) -> Self {
        self.run_id = Some(run_id);
        self
    }
    pub fn add_tool(mut self, tool: Tool) -> Self {
        self.tools.push(tool);
        self
    }
    pub fn add_context(mut self, ctx: Context) -> Self {
        self.context.push(ctx);
        self
    }
    pub fn with_forwarded_props(mut self, props: FwdPropsT) -> Self {
        self.forwarded_props = props;
        self
    }
    pub fn with_state(mut self, state: StateT) -> Self {
        self.state = state;
        self
    }
    pub fn add_message(mut self, msg: Message) -> Self {
        self.messages.push(msg);
        self
    }
    pub fn user(mut self, content: impl Into<String>) -> Self {
        self.messages.push(Message::User {
            id: MessageId::random(),
            content: content.into(),
            name: None,
        });
        self
    }
}

impl RunAgentParams<JsonValue, JsonValue> {
    /// Construct an empty parameter object with JSON Values for state and forwarded props.
    ///
    /// If you want typed state and/or fwd props, use [Self::new_typed]
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone)]
pub struct RunAgentResult<StateT: AgentState> {
    pub result: JsonValue,
    pub new_messages: Vec<Message>,
    pub new_state: StateT,
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

// TODO: Expand documentation
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

    // TODO: Expand documentation
    /// The main execution method, containing the full pipeline logic.
    async fn run_agent(
        &self,
        params: &RunAgentParams<StateT, FwdPropsT>,
        subscribers: impl IntoSubscribers<StateT, FwdPropsT>,
    ) -> Result<RunAgentResult<StateT>, AgentError> {
        // TODO: Use Agent ID?
        let _agent_id = AgentId::random();

        let input = RunAgentInput {
            thread_id: ThreadId::random(),
            run_id: params.run_id.clone().unwrap_or_else(RunId::random),
            state: params.state.clone(),
            messages: params.messages.clone(),
            tools: params.tools.clone(),
            context: params.context.clone(),
            // TODO: Find suitable default value
            forwarded_props: params.forwarded_props.clone(),
        };
        let current_message_ids: HashSet<&MessageId> =
            params.messages.iter().map(|m| m.id()).collect();

        // Initialize event handler with the current state
        let subscribers = subscribers.into_subscribers();
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
            new_state: event_handler.state,
        })
    }
}
