use crate::agent::{AgentError, AgentStateMutation, RunTerminalStatus};
use crate::core::event::Event;
use crate::core::types::{
    FunctionCall, Message, MessageId, ReasoningEncryptedValueSubtype, Role, RunAgentInput,
    RunFinishedOutcome, TokenUsage, ToolCall, ToolCallId,
};
use crate::core::{AgentState, FwdProps, JsonValue};
use crate::protocol_state::ProtocolState;
use crate::subscriber::{AgentSubscriberParams, Subscribers};
use json_patch::PatchOperation;
use log::error;
use std::collections::{HashMap, HashSet};

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
    pub subscribers: Subscribers<StateT, FwdPropsT>,
    pub output: Option<JsonValue>,
    pub outcome: Option<RunFinishedOutcome>,
    pub usage: Option<Vec<TokenUsage>>,
    protocol: ProtocolState,
    notified_messages: HashSet<MessageId>,
    notified_tools: HashSet<ToolCallId>,
    replace_tool_args: HashSet<ToolCallId>,
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
        subscribers: Subscribers<StateT, FwdPropsT>,
    ) -> Self {
        let notified_messages = messages.iter().map(|m| m.id().clone()).collect();
        let notified_tools = messages
            .iter()
            .filter_map(|m| m.tool_calls())
            .flatten()
            .map(|call| call.id.clone())
            .collect();
        let protocol = ProtocolState::new(&messages);
        Self {
            messages,
            state,
            input,
            subscribers,
            output: None,
            outcome: None,
            usage: None,
            protocol,
            notified_messages,
            notified_tools,
            replace_tool_args: HashSet::new(),
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
            self.protocol.reseed_history(&self.messages);
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
        // Generic callbacks precede reduction; stopping here suppresses reduction
        // and typed delivery. Typed callbacks observe the reduced event, so their
        // stop only suppresses later typed subscribers, not the existing reduction.
        macro_rules! dispatch_mutation {
            ($mutation:expr $(,)?) => {{
                let mutation = $mutation;
                let stop = mutation.stop_propagation;
                self.process_mutation(mutation, &mut current_mutation);
                if stop {
                    current_mutation.stop_propagation = true;
                    return Ok(current_mutation);
                }
            }};
        }

        self.protocol
            .verify(event, &self.messages, &self.input.thread_id)?;
        // Lifecycle transitions precede callbacks; terminal payload reduction
        // remains below so generic stops keep their existing semantics.
        match event {
            Event::RunStarted(_) => {
                self.output = None;
                self.outcome = None;
                self.usage = None;
                self.replace_tool_args.clear();
            }
            Event::RunError(_) => {
                self.output = None;
                self.outcome = None;
            }
            _ => {}
        }
        // Clone subscribers to avoid borrowing issues
        for subscriber in &self.subscribers.clone() {
            let params = self.to_subscriber_params();
            let mutation = subscriber.on_event(event, params).await?;
            dispatch_mutation!(mutation);
        }

        // Then handle specific event types
        match event {
            Event::TextMessageStart(e) => {
                // Default behavior
                if let Some(existing) = self.messages.iter_mut().find(|m| m.id() == &e.message_id) {
                    merge_message_metadata(existing, &e.base.metadata);
                } else {
                    self.messages.push(text_message(e)?);
                }
                current_mutation.messages = Some(self.messages.clone());

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_text_message_start_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::TextMessageContent(e) => {
                // Default behavior
                if let Some(last_message) = self
                    .messages
                    .iter_mut()
                    .rev()
                    .find(|m| m.id() == &e.message_id)
                {
                    merge_message_metadata(last_message, &e.base.metadata);
                    if let Some(s) = last_message.content_mut() {
                        s.push_str(&e.delta)
                    }
                    current_mutation.messages = Some(self.messages.clone());
                }

                // Get the current text message buffer
                let text_message_buffer = self
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.id() == &e.message_id)
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string(); // Clone to avoid borrowing issues

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_text_message_content_event(e, &text_message_buffer, params)
                        .await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::TextMessageEnd(e) => {
                if let Some(message) = self
                    .messages
                    .iter_mut()
                    .rev()
                    .find(|m| m.id() == &e.message_id)
                {
                    merge_message_metadata(message, &e.base.metadata);
                    current_mutation.messages = Some(self.messages.clone());
                }
                // Get the current text message buffer
                let text_message_buffer = self
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.id() == &e.message_id)
                    .and_then(|m| m.content())
                    .unwrap_or_default()
                    .to_string(); // Clone to avoid borrowing issues

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_text_message_end_event(e, &text_message_buffer, params)
                        .await?;
                    dispatch_mutation!(mutation);
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
                    metadata: e.base.metadata.clone(),
                    encrypted_value: None,
                };

                if let Some(existing_call) = self
                    .messages
                    .iter_mut()
                    .filter_map(existing_tool_calls_mut)
                    .flatten()
                    .find(|call| call.id == e.tool_call_id)
                {
                    self.replace_tool_args.insert(e.tool_call_id.clone());
                    existing_call.function.name = e.tool_call_name.clone();
                    if let Some(metadata) = &e.base.metadata {
                        existing_call
                            .metadata
                            .get_or_insert_with(Default::default)
                            .extend(metadata.clone());
                    }
                } else if let Some(last_message) = self.messages.iter_mut().rev().find(|m| {
                    m.role() == Role::Assistant && Some(m.id()) == e.parent_message_id.as_ref()
                }) {
                    if let Message::Assistant { tool_calls, .. } = last_message {
                        tool_calls.get_or_insert_with(Vec::new).push(new_tool_call);
                    }
                } else {
                    let invalid_parent = e
                        .parent_message_id
                        .as_ref()
                        .is_some_and(|id| self.messages.iter().any(|message| message.id() == id));
                    if invalid_parent {
                        self.emit_diagnostic(crate::core::processing::Diagnostic {
                            category: crate::core::processing::DiagnosticCategory::MissingTarget,
                            path: "/parentMessageId".into(),
                            message: "TOOL_CALL_START parent is not an assistant; creating a new assistant message".into(),
                        }).await?;
                    }
                    let new_message = Message::Assistant {
                        id: if invalid_parent {
                            MessageId::random()
                        } else {
                            e.parent_message_id
                                .clone()
                                .unwrap_or_else(MessageId::random)
                        },
                        content: None,
                        name: None,
                        tool_calls: None,
                        metadata: None,
                        encrypted_value: None,
                        subagent_run_id: e.base.subagent_run_id.clone(),
                    };
                    self.messages.push(new_message);
                    if let Some(Message::Assistant { tool_calls, .. }) = self.messages.last_mut() {
                        tool_calls.get_or_insert_with(Vec::new).push(new_tool_call);
                    }
                }
                self.protocol
                    .record_tool_parent(&self.messages, &e.tool_call_id);
                current_mutation.messages = Some(self.messages.clone());

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_start_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::ToolCallArgs(e) => {
                let call = self
                    .messages
                    .iter_mut()
                    .filter_map(existing_tool_calls_mut)
                    .flatten()
                    .find(|call| call.id == e.tool_call_id)
                    .ok_or_else(|| {
                        AgentError::exec(format!("No tool call with ID '{}'", e.tool_call_id))
                    })?;
                if self.replace_tool_args.remove(&e.tool_call_id) {
                    call.function.arguments.clear();
                }
                call.function.arguments.push_str(&e.delta);
                if let Some(metadata) = &e.base.metadata {
                    call.metadata
                        .get_or_insert_with(Default::default)
                        .extend(metadata.clone());
                }
                let tool_call_buffer = call.function.arguments.clone();
                let tool_call_name = call.function.name.clone();
                let partial_args =
                    serde_json::from_str::<HashMap<String, JsonValue>>(&tool_call_buffer)
                        .unwrap_or_default();
                current_mutation.messages = Some(self.messages.clone());

                for subscriber in &self.subscribers.clone() {
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
                    dispatch_mutation!(mutation);
                }
            }
            Event::ToolCallEnd(e) => {
                let call = self
                    .messages
                    .iter_mut()
                    .filter_map(existing_tool_calls_mut)
                    .flatten()
                    .find(|call| call.id == e.tool_call_id)
                    .ok_or_else(|| {
                        AgentError::exec(format!("No tool call with ID '{}'", e.tool_call_id))
                    })?;
                if let Some(metadata) = &e.base.metadata {
                    call.metadata
                        .get_or_insert_with(Default::default)
                        .extend(metadata.clone());
                }
                let tool_call_name = call.function.name.clone();
                let tool_call_args =
                    serde_json::from_str::<HashMap<String, JsonValue>>(&call.function.arguments)
                        .unwrap_or_default();
                if e.base.metadata.is_some() {
                    current_mutation.messages = Some(self.messages.clone());
                }

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber
                        .on_tool_call_end_event(e, &tool_call_name, &tool_call_args, params)
                        .await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::ToolCallResult(e) => {
                let message = Message::Tool {
                    id: e.message_id.clone(),
                    content: e.content.clone(),
                    tool_call_id: e.tool_call_id.clone(),
                    error: None,
                    metadata: e.base.metadata.clone(),
                    encrypted_value: None,
                    subagent_run_id: e.base.subagent_run_id.clone(),
                };
                upsert_tool_result(&mut self.messages, message);
                current_mutation.messages = Some(self.messages.clone());
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_tool_call_result_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::StateSnapshot(e) => {
                // Default behavior
                self.state = e.snapshot.clone();
                current_mutation.state = Some(self.state.clone());

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_state_snapshot_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::StateDelta(e) => {
                // Default behavior
                let mut state_val = serde_json::to_value(&self.state).map_err(|_| {
                    AgentError::exec("Application state cannot be serialized for patching")
                })?;

                // TODO: This cast to and from JsonValue seems unnecessary
                let patches: Vec<PatchOperation> =
                    serde_json::from_value(serde_json::to_value(e.delta.clone())?)?;

                if ag_ui_core::patch::apply_patch_to_copy(&mut state_val, &patches).is_err() {
                    self.warn(
                        "/delta",
                        "Failed to apply state patch: patch does not apply to the current state",
                    )
                    .await?;
                } else {
                    let new_state: StateT = serde_json::from_value(state_val).map_err(|_| {
                        AgentError::exec(
                            "Patched state cannot be represented by the application's state type",
                        )
                    })?;
                    self.state = new_state;
                    current_mutation.state = Some(self.state.clone());
                }

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_state_delta_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::MessagesSnapshot(e) => {
                reconcile_messages(&mut self.messages, &e.messages);
                self.protocol.reseed_history(&self.messages);
                current_mutation.messages = Some(self.messages.clone());
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_messages_snapshot_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::Raw(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_raw_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::Custom(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_custom_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::RunStarted(e) => {
                if let Some(input) = &e.input {
                    let mut seen: HashSet<_> =
                        self.messages.iter().map(|m| m.id().clone()).collect();
                    for message in &input.messages {
                        if seen.insert(message.id().clone()) {
                            self.messages.push(message.clone());
                        }
                    }
                    self.protocol.reseed_history(&self.messages);
                    current_mutation.messages = Some(self.messages.clone());
                }
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_started_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::RunFinished(e) => {
                // Default behavior
                self.output = e.result.clone();
                self.outcome = e.outcome.clone();
                self.usage = e.usage.clone();

                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_finished_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::RunError(e) => {
                self.usage = e.usage.clone();
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_run_error_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::StepStarted(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_step_started_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::StepFinished(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    let mutation = subscriber.on_step_finished_event(e, params).await?;
                    dispatch_mutation!(mutation);
                }
            }
            Event::ActivitySnapshot(e) => {
                if let Some(existing) = self.messages.iter_mut().find(|m| m.id() == &e.message_id) {
                    if let Message::Activity {
                        content,
                        activity_type,
                        subagent_run_id,
                        ..
                    } = existing
                    {
                        if e.replace.unwrap_or(true) {
                            *content = e.content.clone();
                            *activity_type = e.activity_type.clone();
                            *subagent_run_id = e.base.subagent_run_id.clone();
                        }
                        merge_message_metadata(existing, &e.base.metadata);
                    } else if e.replace.unwrap_or(true) {
                        *existing = activity_message(e);
                    }
                } else {
                    self.messages.push(activity_message(e));
                }
                current_mutation.messages = Some(self.messages.clone());
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_activity_snapshot_event(e, params).await?);
                }
            }
            Event::ActivityDelta(e) => {
                let mut warning = None;
                if let Some(message @ Message::Activity { .. }) =
                    self.messages.iter_mut().find(|m| m.id() == &e.message_id)
                {
                    merge_message_metadata(message, &e.base.metadata);
                    let Message::Activity {
                        content,
                        activity_type,
                        ..
                    } = message
                    else {
                        unreachable!()
                    };
                    let mut value = JsonValue::Object(content.clone());
                    let patches: Vec<PatchOperation> =
                        serde_json::from_value(serde_json::to_value(&e.patch)?)?;
                    match ag_ui_core::patch::apply_patch_to_copy(&mut value, &patches) {
                        Ok(()) => match value {
                            JsonValue::Object(map) => {
                                *content = map;
                                *activity_type = e.activity_type.clone();
                            }
                            _ => {
                                warning = Some(
                                    "Failed to apply activity patch: content must remain an object",
                                )
                            }
                        },
                        Err(_) => {
                            warning = Some(
                                "Failed to apply activity patch: patch does not apply to the current content",
                            )
                        }
                    }
                    current_mutation.messages = Some(self.messages.clone());
                } else {
                    warning =
                        Some("ACTIVITY_DELTA target is missing or is not an activity message");
                }
                if let Some(message) = warning {
                    self.warn("/patch", message).await?;
                }
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_activity_delta_event(e, params).await?);
                }
            }
            Event::ReasoningStart(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_reasoning_start_event(e, params).await?);
                }
            }
            Event::ReasoningMessageStart(e) => {
                if let Some(existing) = self.messages.iter_mut().find(|m| m.id() == &e.message_id) {
                    merge_message_metadata(existing, &e.base.metadata);
                } else {
                    self.messages.push(Message::Reasoning {
                        id: e.message_id.clone(),
                        content: String::new(),
                        encrypted_value: None,
                        metadata: e.base.metadata.clone(),
                        subagent_run_id: e.base.subagent_run_id.clone(),
                    });
                }
                current_mutation.messages = Some(self.messages.clone());
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(
                        subscriber
                            .on_reasoning_message_start_event(e, params)
                            .await?,
                    );
                }
            }
            Event::ReasoningMessageContent(e) => {
                if let Some(message) = self.messages.iter_mut().find(|m| m.id() == &e.message_id) {
                    merge_message_metadata(message, &e.base.metadata);
                    if let Message::Reasoning { content, .. } = message {
                        content.push_str(&e.delta);
                    }
                    current_mutation.messages = Some(self.messages.clone());
                }
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(
                        subscriber
                            .on_reasoning_message_content_event(e, params)
                            .await?,
                    );
                }
            }
            Event::ReasoningMessageEnd(e) => {
                if let Some(message) = self.messages.iter_mut().find(|m| m.id() == &e.message_id) {
                    merge_message_metadata(message, &e.base.metadata);
                    current_mutation.messages = Some(self.messages.clone());
                }
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_reasoning_message_end_event(e, params).await?);
                }
            }
            Event::ReasoningEnd(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_reasoning_end_event(e, params).await?);
                }
            }
            Event::ReasoningEncryptedValue(e) => {
                let retained = if e.subtype == ReasoningEncryptedValueSubtype::Message {
                    self.messages
                        .iter_mut()
                        .find(|message| message.id().as_ref() == e.entity_id)
                        .and_then(|message| match message {
                            Message::Assistant {
                                encrypted_value, ..
                            }
                            | Message::Reasoning {
                                encrypted_value, ..
                            }
                            | Message::Tool {
                                encrypted_value, ..
                            }
                            | Message::User {
                                encrypted_value, ..
                            }
                            | Message::System {
                                encrypted_value, ..
                            }
                            | Message::Developer {
                                encrypted_value, ..
                            } => Some(encrypted_value),
                            _ => None,
                        })
                        .map(|target| *target = Some(e.encrypted_value.clone()))
                        .is_some()
                } else {
                    self.messages
                        .iter_mut()
                        .filter_map(existing_tool_calls_mut)
                        .flatten()
                        .find(|call| call.id.as_ref() == e.entity_id)
                        .map(|call| call.encrypted_value = Some(e.encrypted_value.clone()))
                        .is_some()
                };
                if retained {
                    current_mutation.messages = Some(self.messages.clone());
                } else {
                    self.emit_diagnostic(crate::core::processing::Diagnostic {
                        category: crate::core::processing::DiagnosticCategory::MissingTarget,
                        path: "/entityId".into(),
                        message: "Encrypted reasoning target is missing or cannot retain the value"
                            .into(),
                    })
                    .await?;
                }
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(
                        subscriber
                            .on_reasoning_encrypted_value_event(e, params)
                            .await?,
                    );
                }
            }
            Event::SubagentStarted(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_subagent_started_event(e, params).await?);
                }
            }
            Event::SubagentFinished(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_subagent_finished_event(e, params).await?);
                }
            }
            Event::SubagentError(e) => {
                for subscriber in &self.subscribers.clone() {
                    let params = self.to_subscriber_params();
                    dispatch_mutation!(subscriber.on_subagent_error_event(e, params).await?);
                }
            }
            _ => {}
        }

        Ok(current_mutation)
    }

    pub async fn apply_mutation(
        &mut self,
        mutation: AgentStateMutation<StateT>,
    ) -> Result<(), AgentError> {
        if let Some(messages) = mutation.messages {
            self.messages = messages;
            let new_messages: Vec<_> = self
                .messages
                .iter()
                .filter(|message| !self.notified_messages.contains(message.id()))
                .cloned()
                .collect();
            for message in new_messages {
                self.notified_messages.insert(message.id().clone());
                self.notify_new_message(&message).await?;
            }
            let new_calls: Vec<_> = self
                .messages
                .iter()
                .filter_map(|m| m.tool_calls())
                .flatten()
                .filter(|call| !self.notified_tools.contains(&call.id))
                .cloned()
                .collect();
            for call in new_calls {
                self.notified_tools.insert(call.id.clone());
                self.notify_new_tool_call(&call).await?;
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

    async fn warn(&self, path: &str, message: &str) -> Result<(), AgentError> {
        use crate::core::processing::{Diagnostic, DiagnosticCategory};
        let diagnostic = Diagnostic {
            category: if message.starts_with("ACTIVITY_DELTA") {
                DiagnosticCategory::MissingTarget
            } else {
                DiagnosticCategory::PatchNotApplied
            },
            path: path.to_owned(),
            message: message.to_owned(),
        };
        self.emit_diagnostic(diagnostic).await
    }

    pub(crate) async fn emit_diagnostic(
        &self,
        diagnostic: crate::core::processing::Diagnostic,
    ) -> Result<(), AgentError> {
        log::warn!("{}", diagnostic.message);
        for subscriber in &self.subscribers {
            subscriber
                .on_diagnostic(&diagnostic, self.to_subscriber_params())
                .await?;
        }
        Ok(())
    }

    pub async fn on_initialize(&mut self) -> Result<bool, AgentError> {
        let mut state_changed = false;
        for subscriber in &self.subscribers.clone() {
            let mutation = subscriber
                .on_run_initialized(self.to_subscriber_params())
                .await?;
            state_changed |= mutation.state.is_some();
            self.apply_mutation(mutation).await?;
        }
        Ok(state_changed)
    }

    pub async fn on_error(&self, error: &AgentError) -> Result<(), AgentError> {
        error!("Agent error: {error}");
        let mut first_error = None;
        for subscriber in &self.subscribers {
            if let Err(error) = subscriber
                .on_run_failed(error, self.to_subscriber_params())
                .await
            {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub fn terminal_status(&self) -> Option<&RunTerminalStatus> {
        self.protocol.terminal_status()
    }

    pub fn check_completion(&self) -> Result<(), AgentError> {
        self.protocol.check_completion(&self.input.run_id)
    }

    pub async fn on_finalize(&mut self) -> Result<(), AgentError> {
        let mut first_error = None;
        for subscriber in &self.subscribers.clone() {
            match subscriber
                .on_run_finalized(self.to_subscriber_params())
                .await
            {
                Ok(mutation) => {
                    self.update_from_mutation(&mutation);
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn text_message(event: &crate::core::event::TextMessageStartEvent) -> Result<Message, AgentError> {
    let mut value = serde_json::json!({
        "id": event.message_id, "role": event.role.clone().unwrap_or(Role::Assistant), "content": "",
    });
    if let Some(name) = &event.name {
        value["name"] = name.clone().into();
    }
    if let Some(metadata) = &event.base.metadata {
        value["metadata"] = JsonValue::Object(metadata.clone());
    }
    if let Some(owner) = &event.base.subagent_run_id {
        value["subagentRunId"] = owner.clone().into();
    }
    Ok(serde_json::from_value(value)?)
}

fn activity_message(event: &crate::core::event::ActivitySnapshotEvent) -> Message {
    Message::Activity {
        id: event.message_id.clone(),
        activity_type: event.activity_type.clone(),
        content: event.content.clone(),
        metadata: event.base.metadata.clone(),
        subagent_run_id: event.base.subagent_run_id.clone(),
    }
}

fn upsert_tool_result(messages: &mut Vec<Message>, message: Message) {
    let Message::Tool { tool_call_id, .. } = &message else {
        unreachable!()
    };
    if let Some(existing) = messages.iter_mut().find(|m| {
        matches!(m, Message::Tool { id, tool_call_id: call, .. } if id == message.id() && call == tool_call_id)
    }) {
        // Corrections preserve metadata and other result fields not supplied by
        // this event, but replace content and execution ownership.
        if let Message::Tool { content, metadata, subagent_run_id, .. } = message {
            if let Message::Tool { content: old_content, subagent_run_id: old_owner, .. } = existing {
                *old_content = content;
                *old_owner = subagent_run_id;
            }
            merge_message_metadata(existing, &metadata);
        }
        return;
    }
    let mut newest = None;
    let mut owner = None;
    let mut answered = false;
    for (index, entry) in messages.iter().enumerate().rev() {
        if matches!(entry, Message::Tool { tool_call_id: call, .. } if call == tool_call_id) {
            answered = true;
        } else if entry
            .tool_calls()
            .is_some_and(|calls| calls.iter().any(|call| &call.id == tool_call_id))
        {
            newest.get_or_insert(index);
            if !answered {
                owner = Some(index);
                break;
            }
            answered = false;
        }
    }
    if let Some(owner) = owner.or(newest) {
        let mut at = owner + 1;
        while at < messages.len() && matches!(messages[at].role(), Role::Tool | Role::Activity) {
            at += 1;
        }
        messages.insert(at, message);
    } else {
        messages.push(message);
    }
}

// Looking up an existing call must not create toolCalls on unrelated messages.
fn existing_tool_calls_mut(message: &mut Message) -> Option<&mut Vec<ToolCall>> {
    match message {
        Message::Assistant { tool_calls, .. } => tool_calls.as_mut(),
        _ => None,
    }
}

fn reconcile_messages(current: &mut Vec<Message>, snapshot: &[Message]) {
    let declares_activity = snapshot
        .iter()
        .any(|message| message.role() == Role::Activity);
    let declares_reasoning = snapshot
        .iter()
        .any(|message| message.role() == Role::Reasoning);
    let by_id: HashMap<_, _> = snapshot
        .iter()
        .map(|message| (message.id().clone(), message))
        .collect();
    let mut retained = HashSet::new();
    current.retain_mut(|message| {
        if !retained.insert(message.id().clone()) {
            return false;
        }
        if let Some(replacement) = by_id.get(message.id()) {
            *message = (*replacement).clone();
            true
        } else {
            matches!(message.role(), Role::Activity if !declares_activity)
                || matches!(message.role(), Role::Reasoning if !declares_reasoning)
        }
    });
    let mut seen: HashSet<_> = current.iter().map(|message| message.id().clone()).collect();
    for message in snapshot {
        if seen.insert(message.id().clone()) {
            current.push((*by_id[message.id()]).clone());
        }
    }
    crate::core::history::keep_tool_results_with_calls(current);
}

fn merge_message_metadata(
    message: &mut Message,
    extra: &Option<serde_json::Map<String, JsonValue>>,
) {
    let Some(extra) = extra else {
        return;
    };
    let metadata = match message {
        Message::Developer { metadata, .. }
        | Message::System { metadata, .. }
        | Message::Assistant { metadata, .. }
        | Message::User { metadata, .. }
        | Message::Activity { metadata, .. }
        | Message::Reasoning { metadata, .. }
        | Message::Tool { metadata, .. } => metadata,
        _ => return,
    };
    metadata
        .get_or_insert_with(Default::default)
        .extend(extra.clone());
}

#[cfg(test)]
mod tests;
