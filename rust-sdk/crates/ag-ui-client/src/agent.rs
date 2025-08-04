use futures::stream::StreamExt;
use std::collections::HashSet;
use std::sync::Arc;
use thiserror::Error;

use crate::event::EventExt;
use crate::stream::EventStream;
use crate::subscriber::AgentSubscriber;
use ag_ui_core::event::Event;
use ag_ui_core::types::context::Context;
use ag_ui_core::types::ids::{AgentId, MessageId, RunId, ThreadId};
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::types::message::Message;
use ag_ui_core::types::tool::Tool;
use ag_ui_core::{FwdProps, JsonValue, State};

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
pub struct RunAgentParams<FwdPropsT = JsonValue> {
    pub run_id: Option<RunId>,
    pub tools: Option<Vec<Tool>>,
    pub context: Option<Vec<Context>>,
    pub forwarded_props: Option<FwdPropsT>,
}

#[derive(Debug, Clone)]
pub struct RunAgentResult {
    pub result: JsonValue,
    pub new_messages: Vec<Message>,
}

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
    StateT: State,
    FwdPropsT: FwdProps,
{
    fn run<'a>(&'a self, input: &'a RunAgentInput<StateT, FwdPropsT>) -> EventStream<'a>;

    // Idiomatic accessors for agent state.
    fn agent_id(&self) -> Option<&AgentId>;
    fn agent_id_mut(&mut self) -> &mut Option<AgentId>;
    fn description(&self) -> &str;
    fn description_mut(&mut self) -> &mut String;
    fn thread_id(&self) -> &ThreadId;
    fn thread_id_mut(&mut self) -> &mut ThreadId;
    fn messages(&self) -> &[Message];
    fn messages_mut(&mut self) -> &mut Vec<Message>;
    fn state(&self) -> &StateT;
    fn state_mut(&mut self) -> &mut StateT;
    fn subscribers(&self) -> &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>];
    fn subscribers_mut(&mut self) -> &mut Vec<Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>;

    /// Adds a subscriber to the agent.
    fn add_subscriber(&mut self, subscriber: Arc<dyn AgentSubscriber<StateT, FwdPropsT>>) {
        self.subscribers_mut().push(subscriber);
    }

    /// The main execution method, containing the full pipeline logic.
    async fn run_agent(
        &mut self,
        params: &RunAgentParams<FwdPropsT>,
        subscriber: Option<Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>,
    ) -> Result<RunAgentResult, AgentError> {
        if self.agent_id().is_none() {
            *self.agent_id_mut() = Some(AgentId::new());
        }

        let mut subscribers = self.subscribers().to_vec();
        if let Some(sub) = subscriber {
            subscribers.push(sub);
        }

        let input = self.prepare_run_agent_input(params);
        let messages = self.messages().to_vec();
        let current_message_ids: HashSet<&MessageId> = messages.iter().map(|m| m.id()).collect();
        let mut result_val = JsonValue::Null;

        let mut stream = self.run(&input).fuse();

        while let Some(event_result) = stream.next().await {
            match event_result {
                Ok(event) => {
                    let (mutation, value) = event
                        .apply_and_process_event(&input, &messages, &input.state, &subscribers)
                        .await?;
                    result_val = JsonValue::from(value);
                }
                Err(e) => {
                    // self.on_error(&input, &e, &subscribers).await?;
                    return Err(e);
                }
            }
        }

        // self.on_finalize(&input, &subscribers).await?;

        let new_messages = self
            .messages()
            .iter()
            .filter(|m| !current_message_ids.contains(&m.id()))
            .cloned()
            .collect();

        Ok(RunAgentResult {
            result: result_val,
            new_messages,
        })
    }

    /// Helper to construct the input for the `run` method.
    fn prepare_run_agent_input(
        &self,
        params: &RunAgentParams<FwdPropsT>,
    ) -> RunAgentInput<StateT, FwdPropsT> {
        RunAgentInput {
            thread_id: self.thread_id().clone(),
            run_id: params.run_id.clone().unwrap_or_else(|| RunId::new()),
            state: self.state().clone(),
            messages: self.messages().to_vec(),
            tools: params.tools.clone().unwrap_or_default(),
            context: params.context.clone().unwrap_or_default(),
            // TODO: Find suitable default value
            forwarded_props: params.forwarded_props.clone().unwrap(),
        }
    }

    /// Processes a single event, applying mutations and notifying subscribers.
    /// Returns the final result if the event is `Done`.
    async fn apply_and_process_event(
        &mut self,
        event: Event,
        input: &RunAgentInput<StateT, FwdPropsT>,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<Option<JsonValue>, AgentError> {
        // This is a simplified stand-in for the logic from `defaultApplyEvents` in TS.
        // A full implementation would handle each event type to create the correct state mutation.
        let (mutation, result) = match event {
            Event::RunFinished(e) => {
                for sub in subscribers {
                    sub.on_run_finished(
                        &e.result.clone().unwrap(),
                        self.messages(),
                        self.state(),
                        input,
                    )
                    .await?;
                }
                (AgentStateMutation::default(), e.result)
            }
            // In a real implementation, other events like Text, ToolCall, etc.,
            // would create mutations to update messages and state.
            _ => (AgentStateMutation::default(), None),
        };

        self.apply_mutation(mutation, input, subscribers).await?;
        Ok(result)
    }

    async fn on_initialize(
        &mut self,
        input: &mut RunAgentInput<StateT, FwdPropsT>,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(), AgentError> {
        for subscriber in subscribers {
            let mutation = subscriber
                .on_run_initialized(self.messages(), self.state(), input)
                .await?;

            if mutation.messages.is_some() || mutation.state.is_some() {
                if let Some(ref messages) = mutation.messages {
                    input.messages = messages.clone();
                }
                if let Some(ref state) = mutation.state {
                    input.state = state.clone();
                }
                self.apply_mutation(mutation, input, subscribers).await?;
            }
        }
        Ok(())
    }

    async fn on_error(
        &mut self,
        input: &RunAgentInput<StateT, FwdPropsT>,
        error: &AgentError,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(), AgentError> {
        for subscriber in subscribers {
            let mutation = subscriber
                .on_run_failed(error, self.messages(), self.state(), input)
                .await?;

            self.apply_mutation(mutation, input, subscribers).await?;
        }
        Ok(())
    }

    async fn on_finalize(
        &mut self,
        input: &RunAgentInput<StateT, FwdPropsT>,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(), AgentError> {
        for subscriber in subscribers {
            let mutation = subscriber
                .on_run_finalized(self.messages(), self.state(), input)
                .await?;

            self.apply_mutation(mutation, input, subscribers).await?;
        }
        Ok(())
    }

    async fn apply_mutation(
        &mut self,
        mutation: AgentStateMutation<StateT>,
        input: &RunAgentInput<StateT, FwdPropsT>,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(), AgentError> {
        if let Some(messages) = mutation.messages {
            *self.messages_mut() = messages;
            self.notify_messages_changed(input, subscribers).await?;
        }

        if let Some(state) = mutation.state {
            *self.state_mut() = state;
            self.notify_state_changed(input, subscribers).await?;
        }

        Ok(())
    }

    async fn notify_messages_changed(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(), AgentError> {
        for subscriber in subscribers {
            subscriber
                .on_messages_changed(self.messages(), self.state(), input)
                .await?;
        }
        Ok(())
    }

    async fn notify_state_changed(
        &self,
        input: &RunAgentInput<StateT, FwdPropsT>,
        subscribers: &[Arc<dyn AgentSubscriber<StateT, FwdPropsT>>],
    ) -> Result<(), AgentError> {
        for subscriber in subscribers {
            subscriber
                .on_state_changed(self.messages(), self.state(), input)
                .await?;
        }
        Ok(())
    }
}
