use crate::agent::{AgentError, AgentStateMutation};
use crate::subscriber::{AgentSubscriber, AgentSubscriberParams};
use ag_ui_core::event::Event;
use ag_ui_core::types::ids::MessageId;
use ag_ui_core::types::input::RunAgentInput;
use ag_ui_core::types::message::{FunctionCall, Message, Role};
use ag_ui_core::types::tool::ToolCall;
use ag_ui_core::{AgentState, FwdProps};
use json_patch::PatchOperation;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

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
    pub result: JsonValue,
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
            result: JsonValue::Null,
        }
    }

    fn to_subscriber_params(&'a self) -> AgentSubscriberParams<'a, StateT, FwdPropsT> {
        AgentSubscriberParams {
            messages: &self.messages,
            state: &self.state,
            input: self.input,
        }
    }

    // Helper method to directly update state and messages without using apply_mutation
    fn update_from_mutation(&mut self, mutation: &AgentStateMutation<StateT>) {
        if let Some(messages) = &mutation.messages {
            self.messages = messages.clone();
        }
        if let Some(state) = &mutation.state {
            self.state = state.clone();
        }
    }

    // Helper method to process a subscriber's mutation
    fn process_mutation(
        &mut self,
        mutation: AgentStateMutation<StateT>,
        current_mutation: &mut AgentStateMutation<StateT>,
    ) {
        // Apply any mutations
        if mutation.messages.is_some() || mutation.state.is_some() {
            // Update directly without using apply_mutation
            self.update_from_mutation(&mutation);

            // Update current_mutation with the applied changes
            if mutation.messages.is_some() {
                current_mutation.messages = mutation.messages;
            }
            if mutation.state.is_some() {
                current_mutation.state = mutation.state;
            }
        }
    }

    pub async fn handle_event(
        &mut self,
        event: &Event<StateT>,
    ) -> Result<AgentStateMutation<StateT>, AgentError> {
        let mut current_mutation = AgentStateMutation::default();

        // First, call the generic event handler for all subscribers
        // Clone subscribers to avoid borrowing issues
        let subscribers = self.subscribers.clone();
        for subscriber in subscribers {
            let params = self.to_subscriber_params();
            let mutation = subscriber.on_event(event, params).await?;
            if !mutation.stop_propagation {
                self.process_mutation(mutation, &mut current_mutation);
            } else {
                // If stop_propagation is true, apply the mutation and return it immediately
                self.update_from_mutation(&mutation);
                return Ok(mutation);
            }
        }

        // Then handle specific event types
        match event {
            Event::TextMessageStart(e) => {
                // Default behavior
                let new_message = Message::Assistant {
                    id: e.message_id.clone(),
                    content: Some(String::new()),
                    name: None,
                    tool_calls: None,
                };
                self.messages.push(new_message);
                current_mutation.messages = Some(self.messages.clone());

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_text_message_start_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::TextMessageContent(e) => {
                // Default behavior
                if let Some(last_message) = self.messages.last_mut() {
                    let content = last_message.content_mut();
                    if let Some(s) = content { s.push_str(&e.delta) }
                    current_mutation.messages = Some(self.messages.clone());
                }

                // Get the current text message buffer
                let text_message_buffer = self
                    .messages
                    .last()
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string(); // Clone to avoid borrowing issues

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_text_message_content_event(e, &text_message_buffer, params)
                        .await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::TextMessageEnd(e) => {
                // Get the current text message buffer
                let text_message_buffer = self
                    .messages
                    .last()
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string(); // Clone to avoid borrowing issues

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_text_message_end_event(e, &text_message_buffer, params)
                        .await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::TextMessageChunk(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_text_message_chunk_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ThinkingTextMessageStart(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_thinking_text_message_start_event(e, params)
                        .await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ThinkingTextMessageContent(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_thinking_text_message_content_event(e, params)
                        .await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ThinkingTextMessageEnd(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_thinking_text_message_end_event(e, params)
                        .await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ToolCallStart(e) => {
                // Default behavior
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

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_start_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ToolCallArgs(e) => {
                // Default behavior
                if let Some(last_message) = self.messages.last_mut() {
                    if let Some(tool_calls) = last_message.tool_calls_mut() {
                        if let Some(last_tool_call) = tool_calls.last_mut() {
                            last_tool_call.function.arguments.push_str(&e.delta);
                            current_mutation.messages = Some(self.messages.clone());
                        }
                    }
                }

                // Get the current tool call buffer and name
                let (tool_call_buffer, tool_call_name, partial_args) = if let Some(last_message) =
                    self.messages.last()
                {
                    if let Some(tool_calls) = last_message.tool_calls() {
                        if let Some(last_tool_call) = tool_calls.last() {
                            // Try to parse the arguments as JSON to get partial args
                            let partial_args = serde_json::from_str::<HashMap<String, JsonValue>>(
                                &last_tool_call.function.arguments,
                            )
                            .unwrap_or_default();
                            (
                                last_tool_call.function.arguments.clone(),
                                last_tool_call.function.name.clone(),
                                partial_args,
                            )
                        } else {
                            (String::new(), String::new(), HashMap::new())
                        }
                    } else {
                        (String::new(), String::new(), HashMap::new())
                    }
                } else {
                    (String::new(), String::new(), HashMap::new())
                };

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_tool_call_args_event(
                            e,
                            &tool_call_buffer,
                            &tool_call_name,
                            &partial_args,
                            params,
                        )
                        .await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ToolCallEnd(e) => {
                // Get the current tool call buffer and name
                let (tool_call_name, tool_call_args) =
                    if let Some(last_message) = self.messages.last() {
                        if let Some(tool_calls) = last_message.tool_calls() {
                            if let Some(last_tool_call) = tool_calls.last() {
                                // Try to parse the arguments as JSON
                                let args = serde_json::from_str::<HashMap<String, JsonValue>>(
                                    &last_tool_call.function.arguments,
                                )
                                .unwrap_or_default();
                                (last_tool_call.function.name.clone(), args)
                            } else {
                                (String::new(), HashMap::new())
                            }
                        } else {
                            (String::new(), HashMap::new())
                        }
                    } else {
                        (String::new(), HashMap::new())
                    };

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_tool_call_end_event(e, &tool_call_name, &tool_call_args, params)
                        .await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ToolCallChunk(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_chunk_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ToolCallResult(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_result_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ThinkingStart(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_thinking_start_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::ThinkingEnd(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_thinking_end_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::StateSnapshot(e) => {
                // Default behavior
                self.state = e.snapshot.clone();
                current_mutation.state = Some(self.state.clone());

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_state_snapshot_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::StateDelta(e) => {
                // Default behavior
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

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_state_delta_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::MessagesSnapshot(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_messages_snapshot_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::Raw(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_raw_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::Custom(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_custom_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::RunStarted(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_started_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::RunFinished(e) => {
                // Default behavior
                self.result = e.result.clone().unwrap_or(JsonValue::Null);

                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_finished_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::RunError(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_error_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::StepStarted(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_step_started_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
            }
            Event::StepFinished(e) => {
                // Call specific event handlers
                let subscribers = self.subscribers.clone();
                for subscriber in subscribers {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_step_finished_event(e, params).await?;
                    if !mutation.stop_propagation {
                        self.process_mutation(mutation, &mut current_mutation);
                    } else {
                        self.update_from_mutation(&mutation);
                        return Ok(mutation);
                    }
                }
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
            let _mutation = subscriber
                .on_run_failed(error, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    pub async fn on_finalize(&self) -> Result<(), AgentError> {
        for subscriber in &self.subscribers {
            let _mutation = subscriber
                .on_run_finalized(self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }
}
