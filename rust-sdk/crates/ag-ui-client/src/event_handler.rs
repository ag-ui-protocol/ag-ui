use ag_ui_core::{AgentState, FwdProps};
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::types::message::{FunctionCall, Message, Role};
use std::sync::Arc;
use serde_json::Value as JsonValue;
use ag_ui_core::event::Event;
use ag_ui_core::types::ids::MessageId;
use ag_ui_core::types::tool::ToolCall;
use json_patch::PatchOperation;
use log::warn;
use std::collections::HashSet;
use crate::agent::{AgentError, AgentStateMutation};
use crate::subscriber::{AgentSubscriber, AgentSubscriberParams};

/// Captures the run state and handles events
#[derive(Clone)]
pub(crate) struct EventHandler<'a, StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    pub messages: Vec<Message>,
    pub state: StateT,
    pub input: &'a RunAgentInput<StateT, FwdPropsT>,
    pub subscribers: Vec<Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>,
    pub result: JsonValue
}

impl<'a, StateT, FwdPropsT> EventHandler<'a, StateT, FwdPropsT>
where
    StateT: AgentState,
    FwdPropsT: FwdProps,
{
    pub fn new(
        messages: Vec<Message>,
        state: StateT,
        input: &'a RunAgentInput<StateT, FwdPropsT>,
        subscribers: Vec<Arc<dyn AgentSubscriber<StateT, FwdPropsT>>>,
    ) -> Self {
        Self {
            messages,
            state,
            input,
            subscribers,
            result: JsonValue::Null
        }
    }

    fn to_subscriber_params(&'a self) -> AgentSubscriberParams<'a, StateT, FwdPropsT> {
        AgentSubscriberParams {
            messages: &self.messages,
            state: &self.state,
            input: self.input,
        }
    }

    pub async fn handle_event(
        &mut self,
        event: &Event<StateT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        let mut current_mutation = AgentStateMutation::default();

        match event {
            Event::TextMessageStart(e) => {
                let new_message = Message::Assistant {
                    id: e.message_id.clone(),
                    content: Some(String::new()),
                    name: None,
                    tool_calls: None,
                };
                self.messages.push(new_message);
                current_mutation.messages = Some(self.messages.clone());
            }
            Event::TextMessageContent(e) => {
                if let Some(last_message) = self.messages.last_mut() {
                    let content = last_message.content_mut();
                    content.map(|s| s.push_str(&e.delta));
                    current_mutation.messages = Some(self.messages.clone());
                }

            }
            Event::ToolCallStart(e) => {
                let new_tool_call = ToolCall {
                    id: e.tool_call_id.clone(),
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: e.tool_call_name.clone(),
                        arguments: String::new(),
                    },
                };

                if let Some(last_message) = self.messages.last_mut() {
                    if Some(last_message.id()) == e.parent_message_id.clone().as_ref() {
                        let _ = last_message.tool_calls_mut().get_or_insert(&mut Vec::new());

                        let _ = last_message
                            .tool_calls_mut()
                            .map(|tc| tc.push(new_tool_call));
                    }
                } else {
                    let new_message = Message::Assistant {
                        id: e
                            .parent_message_id
                            .clone()
                            .unwrap_or_else(MessageId::random),
                        content: None,
                        name: None,
                        tool_calls: None,
                    };
                    self.messages.push(new_message);
                }
                current_mutation.messages = Some(self.messages.clone());
            }
            Event::ToolCallArgs(e) => {
                if let Some(last_message) = self.messages.last_mut() {
                    if let Some(tool_calls) = last_message.tool_calls_mut() {
                        if let Some(last_tool_call) = tool_calls.last_mut() {
                            last_tool_call.function.arguments.push_str(&e.delta);
                            current_mutation.messages = Some(self.messages.clone());
                        }
                    }
                }
            }
            Event::StateSnapshot(e) => {
                self.state = e.snapshot.clone();
                current_mutation.state = Some(self.state.clone());
            }
            Event::StateDelta(e) => {
                let mut state_val = serde_json::to_value(&self.state)?;

                // TODO: This cast to and from JsonValue seems unnecessary
                let patches: Vec<PatchOperation> =
                    serde_json::from_value(serde_json::to_value(e.delta.clone())?)?;

                json_patch::patch(&mut state_val, &patches).map_err(|err| {
                    AgentError::ExecutionError {
                        message: format!("Failed to apply state patch: {err}"),
                    }
                })?;
                let new_state: StateT = serde_json::from_value(state_val)?;
                self.state = new_state;
                current_mutation.state = Some(self.state.clone());
            }
            Event::RunFinished(e) => {
                self.result = e.result.clone().unwrap_or_else(|| JsonValue::Null);
            }
            _ => {
                warn!("Unhandled event: {event:?}");
            }
        }

        Ok(current_mutation)
    }

    pub async fn apply_mutation(
        &mut self,
        mutation: AgentStateMutation<StateT>,
    ) -> Result<(), AgentError> {
        if let Some(messages) = mutation.messages {
            // Check for new messages to notify about
            let old_message_ids: HashSet<&MessageId> =
                self.messages.iter().map(|m| m.id()).collect();

            let new_messages: Vec<&Message> = messages
                .iter()
                .filter(|m| !old_message_ids.contains(m.id()))
                .collect();

            // Set the new messages first
            self.messages = messages.clone();

            // Notify about new messages
            for message in new_messages {
                self.notify_new_message(message).await?;

                // If the message is from assistant and has tool calls, notify about those too
                if message.role() == Role::Assistant && message.tool_calls().is_some() {
                    for tool_call in message.tool_calls().unwrap() {
                        self.notify_new_tool_call(tool_call).await?;
                    }
                }
            }

            // Then notify about messages changed
            self.notify_messages_changed().await?;
        }

        if let Some(state) = mutation.state {
            self.state = state;
            self.notify_state_changed().await?;
        }

        Ok(())
    }

    async fn notify_new_message(&self, message: &Message) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_new_message(message, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    async fn notify_new_tool_call(&self, tool_call: &ToolCall) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_new_tool_call(tool_call, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    async fn notify_messages_changed(&self) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_messages_changed(self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    async fn notify_state_changed(&self) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            subscriber
                .on_state_changed(self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    pub async fn on_error(&self, error: &AgentError) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            let mutation = subscriber
                .on_run_failed(error, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    pub async fn on_finalize(&self) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            let mutation = subscriber
                .on_run_finalized(self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }
}