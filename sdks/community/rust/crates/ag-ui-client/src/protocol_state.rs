//! Protocol lifecycle, stream identity, and history ownership policy.
use crate::agent::{AgentError, RunTerminalStatus};
use crate::core::{
    AgentState,
    event::Event,
    types::{
        Message, MessageId, ReasoningEncryptedValueSubtype, Role, RunId, ThreadId, ToolCallId,
    },
};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq)]
enum RunPhase {
    #[default]
    Idle,
    Running {
        run_id: RunId,
    },
    Terminal(RunTerminalStatus),
}

#[derive(Clone, Default)]
pub(crate) struct ProtocolState {
    phase: RunPhase,
    active_text: HashMap<MessageId, Option<String>>,
    active_reasoning: HashMap<MessageId, Option<String>>,
    active_span: HashMap<MessageId, Option<String>>,
    active_tools: HashMap<ToolCallId, Option<String>>,
    active_steps: HashSet<(Option<String>, String)>,
    activity_owners: HashMap<MessageId, Option<String>>,
    active_subagents: HashSet<String>,
    closed_subagents: HashSet<String>,
    message_owners: HashMap<MessageId, Option<String>>,
    tool_owners: HashMap<ToolCallId, Option<String>>,
}

impl ProtocolState {
    pub(crate) fn new(messages: &[Message]) -> Self {
        let mut state = Self::default();
        state.reseed_history(messages);
        state
    }

    pub(crate) fn terminal_status(&self) -> Option<&RunTerminalStatus> {
        match &self.phase {
            RunPhase::Terminal(status) => Some(status),
            RunPhase::Idle | RunPhase::Running { .. } => None,
        }
    }

    pub(crate) fn verify<S: AgentState>(
        &mut self,
        event: &Event<S>,
        messages: &[Message],
        thread_id: &ThreadId,
    ) -> Result<(), AgentError> {
        if matches!(
            event,
            Event::TextMessageChunk(_) | Event::ToolCallChunk(_) | Event::ReasoningMessageChunk(_)
        ) {
            return Err(AgentError::exec(
                "chunk must be expanded before event handling",
            ));
        }
        let fail = |message: String| AgentError::Execution { message };
        if matches!(self.phase, RunPhase::Terminal(_))
            && !matches!(event, Event::RunStarted(_))
            && (!matches!(event, Event::RunError(_))
                || matches!(
                    self.phase,
                    RunPhase::Terminal(RunTerminalStatus::ProducerError(_))
                ))
        {
            return Err(fail(
                "The run has already finished with 'RUN_FINISHED' or 'RUN_ERROR'".into(),
            ));
        }
        if !matches!(self.phase, RunPhase::Running { .. })
            && !matches!(event, Event::RunStarted(_) | Event::RunError(_))
        {
            return Err(fail(
                "First event must be 'RUN_STARTED' or 'RUN_ERROR'".into(),
            ));
        }
        match event {
            Event::RunStarted(_) if matches!(self.phase, RunPhase::Running { .. }) => {
                return Err(fail(
                    "Cannot send 'RUN_STARTED' while a run is still active".into(),
                ));
            }
            Event::RunStarted(e) => {
                if e.thread_id != *thread_id {
                    return Err(AgentError::ExchangeIdentity(
                        "RUN_STARTED threadId does not match the request".into(),
                    ));
                }
                self.phase = RunPhase::Running {
                    run_id: e.run_id.clone(),
                };
                self.active_text.clear();
                self.active_reasoning.clear();
                self.active_span.clear();
                self.active_tools.clear();
                self.active_steps.clear();
                self.active_subagents.clear();
                self.closed_subagents.clear();
                self.reseed_history(messages);
            }
            Event::RunFinished(e) => {
                if e.thread_id != *thread_id
                    || !matches!(&self.phase, RunPhase::Running { run_id } if run_id == &e.run_id)
                {
                    return Err(AgentError::ExchangeIdentity(
                        "RUN_FINISHED identity does not match its RUN_STARTED and request threadId"
                            .into(),
                    ));
                }
                if !self.active_subagents.is_empty() {
                    return Err(fail(format!(
                        "RUN_FINISHED with active subagent {}",
                        self.active_subagents.iter().next().unwrap()
                    )));
                }
                if !self.active_text.is_empty()
                    || !self.active_reasoning.is_empty()
                    || !self.active_span.is_empty()
                    || !self.active_tools.is_empty()
                    || !self.active_steps.is_empty()
                {
                    return Err(fail("Cannot send 'RUN_FINISHED' while text messages are still active or another streamed item is open".into()));
                }
                self.phase = RunPhase::Terminal(RunTerminalStatus::Finished {
                    thread_id: e.thread_id.clone(),
                    run_id: e.run_id.clone(),
                });
            }
            Event::RunError(e) => {
                self.phase = RunPhase::Terminal(RunTerminalStatus::ProducerError(e.clone()));
                self.active_text.clear();
                self.active_reasoning.clear();
                self.active_span.clear();
                self.active_tools.clear();
                self.active_steps.clear();
                self.active_subagents.clear();
                self.activity_owners.clear();
            }
            Event::TextMessageStart(e) => {
                if !matches!(
                    e.role,
                    None | Some(Role::Assistant | Role::User | Role::System | Role::Developer)
                ) {
                    return Err(fail("TEXT_MESSAGE_START has an invalid text role".into()));
                }
                let owner = self
                    .message_owners
                    .entry(e.message_id.clone())
                    .or_insert_with(|| e.base.subagent_run_id.clone());
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
                if self
                    .active_text
                    .insert(e.message_id.clone(), owner.clone())
                    .is_some()
                {
                    return Err(fail(format!(
                        "TEXT_MESSAGE_START for open message '{}'",
                        e.message_id
                    )));
                }
            }
            Event::TextMessageContent(e) => {
                let owner = self.active_text.get(&e.message_id).ok_or_else(|| {
                    fail(format!(
                        "No active text message found with ID '{}'",
                        e.message_id
                    ))
                })?;
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
            }
            Event::TextMessageEnd(e) => {
                let owner = self.active_text.get(&e.message_id).ok_or_else(|| {
                    fail(format!(
                        "No active text message found with ID '{}'",
                        e.message_id
                    ))
                })?;
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
                self.active_text.remove(&e.message_id);
            }
            Event::ReasoningStart(e) => {
                let owner = self
                    .message_owners
                    .entry(e.message_id.clone())
                    .or_insert_with(|| e.base.subagent_run_id.clone());
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
                if self
                    .active_span
                    .insert(e.message_id.clone(), owner.clone())
                    .is_some()
                {
                    return Err(fail("REASONING_START for an already open span".into()));
                }
            }
            Event::ReasoningEnd(e) => {
                let owner = self
                    .active_span
                    .get(&e.message_id)
                    .ok_or_else(|| fail("No active reasoning span".into()))?;
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
                self.active_span.remove(&e.message_id);
            }
            Event::ReasoningMessageStart(e) => {
                if e.role != Role::Reasoning {
                    return Err(fail(
                        "Reasoning message role: expected \\\"reasoning\\\"".into(),
                    ));
                }
                let owner = self
                    .message_owners
                    .entry(e.message_id.clone())
                    .or_insert_with(|| e.base.subagent_run_id.clone());
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
                if self
                    .active_reasoning
                    .insert(e.message_id.clone(), owner.clone())
                    .is_some()
                {
                    return Err(fail(format!(
                        "REASONING_MESSAGE_START for open message '{}'",
                        e.message_id
                    )));
                }
            }
            Event::ReasoningMessageContent(e) => {
                let owner = self.active_reasoning.get(&e.message_id).ok_or_else(|| {
                    fail(format!(
                        "No active reasoning message found with ID '{}'",
                        e.message_id
                    ))
                })?;
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
            }
            Event::ReasoningMessageEnd(e) => {
                let owner = self.active_reasoning.get(&e.message_id).ok_or_else(|| {
                    fail(format!(
                        "No active reasoning message found with ID '{}'",
                        e.message_id
                    ))
                })?;
                check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
                self.active_reasoning.remove(&e.message_id);
            }
            Event::ReasoningEncryptedValue(e) => {
                let target = match e.subtype {
                    ReasoningEncryptedValueSubtype::Message => messages
                        .iter()
                        .find(|message| message.id().as_ref() == e.entity_id),
                    ReasoningEncryptedValueSubtype::ToolCall => messages.iter().find(|message| {
                        message.tool_calls().is_some_and(|calls| {
                            calls.iter().any(|call| call.id.as_ref() == e.entity_id)
                        })
                    }),
                    _ => return Err(fail("Unsupported encrypted value subtype".into())),
                };
                if let Some(target) = target {
                    check_owner(
                        &message_owner(target).cloned(),
                        &e.base.subagent_run_id,
                        &e.entity_id,
                    )?;
                }
            }
            Event::ToolCallStart(e) => {
                let inherited = tool_call_owner(
                    messages,
                    e.parent_message_id.as_ref(),
                    &e.base.subagent_run_id,
                    Some(e.tool_call_id.as_ref()),
                )?;
                let effective_owner = inherited
                    .clone()
                    .unwrap_or_else(|| e.base.subagent_run_id.clone());
                if let Some(owner) = self.tool_owners.get(&e.tool_call_id) {
                    check_owner(owner, &e.base.subagent_run_id, e.tool_call_id.as_ref())?;
                    if inherited.is_some() && owner != &effective_owner {
                        return Err(fail("Tool call owner does not match parent message".into()));
                    }
                }
                let owner = self
                    .tool_owners
                    .entry(e.tool_call_id.clone())
                    .or_insert(effective_owner)
                    .clone();
                if self
                    .active_tools
                    .insert(e.tool_call_id.clone(), owner)
                    .is_some()
                {
                    return Err(fail(format!(
                        "TOOL_CALL_START for open call '{}'",
                        e.tool_call_id
                    )));
                }
            }
            Event::ToolCallArgs(e) => {
                let owner = self.active_tools.get(&e.tool_call_id).ok_or_else(|| {
                    fail(format!(
                        "No active tool call found with ID '{}'",
                        e.tool_call_id
                    ))
                })?;
                check_owner(owner, &e.base.subagent_run_id, e.tool_call_id.as_ref())?;
            }
            Event::ToolCallEnd(e) => {
                let owner = self.active_tools.get(&e.tool_call_id).ok_or_else(|| {
                    fail(format!(
                        "No active tool call found with ID '{}'",
                        e.tool_call_id
                    ))
                })?;
                check_owner(owner, &e.base.subagent_run_id, e.tool_call_id.as_ref())?;
                self.active_tools.remove(&e.tool_call_id);
            }
            Event::StepStarted(e) => {
                let key = (e.base.subagent_run_id.clone(), e.step_name.clone());
                if !self.active_steps.insert(key) {
                    return Err(fail(format!(
                        "STEP_STARTED for already open step '{}' in this owner",
                        e.step_name
                    )));
                }
            }
            Event::StepFinished(e) => {
                let key = (e.base.subagent_run_id.clone(), e.step_name.clone());
                if !self.active_steps.remove(&key) {
                    return Err(fail(format!(
                        "STEP_FINISHED for step that was not started in this owner: {}",
                        e.step_name
                    )));
                }
            }
            Event::ActivitySnapshot(e) => {
                let existing = messages.iter().find(|m| m.id() == &e.message_id);
                if existing.is_none() || e.replace.unwrap_or(true) {
                    self.activity_owners
                        .insert(e.message_id.clone(), e.base.subagent_run_id.clone());
                }
            }
            Event::ActivityDelta(e) => {
                // A reminted non-activity target is the tolerated missing-target
                // case, not a continuation of its former activity ownership.
                if messages
                    .iter()
                    .any(|m| m.id() == &e.message_id && m.role() == Role::Activity)
                    && let Some(owner) = self.activity_owners.get(&e.message_id)
                {
                    check_owner(owner, &e.base.subagent_run_id, e.message_id.as_ref())?;
                }
            }
            Event::ToolCallResult(e) => {
                self.activity_owners.remove(&e.message_id);
                self.message_owners
                    .insert(e.message_id.clone(), e.base.subagent_run_id.clone());
            }
            Event::SubagentStarted(e) => {
                if self.active_subagents.contains(&e.subagent_run_id)
                    || self.closed_subagents.contains(&e.subagent_run_id)
                {
                    return Err(fail("Subagent invocation ID is already active or was already closed in this run".into()));
                }
                // Producers should announce invocations before attributed events,
                // but consumers can still recover a late lifecycle announcement.
                if let Some(parent) = &e.parent_subagent_run_id
                    && !self.active_subagents.contains(parent)
                    && !self.closed_subagents.contains(parent)
                {
                    return Err(fail(
                        "parentSubagentRunId has not been started in this run".into(),
                    ));
                }
                self.active_subagents.insert(e.subagent_run_id.clone());
            }
            Event::SubagentFinished(e) => {
                if !self.active_subagents.remove(&e.subagent_run_id) {
                    return Err(fail(format!("Subagent not started: {}", e.subagent_run_id)));
                }
                self.closed_subagents.insert(e.subagent_run_id.clone());
            }
            Event::SubagentError(e) => {
                if !self.active_subagents.remove(&e.subagent_run_id) {
                    return Err(fail(format!("Subagent not started: {}", e.subagent_run_id)));
                }
                self.closed_subagents.insert(e.subagent_run_id.clone());
            }
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn reseed_history(&mut self, messages: &[Message]) {
        self.message_owners.clear();
        self.activity_owners.clear();
        self.tool_owners.clear();
        for message in messages {
            let owner = message_owner(message).cloned();
            if message.role() == Role::Activity {
                self.activity_owners
                    .insert(message.id().clone(), owner.clone());
            } else {
                self.message_owners
                    .insert(message.id().clone(), owner.clone());
            }
            if let Some(calls) = message.tool_calls() {
                for call in calls {
                    self.tool_owners.insert(call.id.clone(), owner.clone());
                }
            }
        }
        for (id, owner) in &mut self.active_text {
            if let Some(current) = self.message_owners.get(id) {
                *owner = current.clone();
            }
        }
        for (id, owner) in &mut self.active_reasoning {
            if let Some(current) = self.message_owners.get(id) {
                *owner = current.clone();
            }
        }
        for (id, owner) in &mut self.active_tools {
            if let Some(current) = self.tool_owners.get(id) {
                *owner = current.clone();
            }
        }
    }

    pub(crate) fn record_tool_parent(&mut self, messages: &[Message], call_id: &ToolCallId) {
        for message in messages {
            if message
                .tool_calls()
                .is_some_and(|calls| calls.iter().any(|call| &call.id == call_id))
            {
                self.message_owners
                    .insert(message.id().clone(), message_owner(message).cloned());
            }
        }
    }

    pub(crate) fn check_completion(&self, requested_run_id: &RunId) -> Result<(), AgentError> {
        match self.terminal_status() {
            None => Err(AgentError::IncompleteRun(
                "AG-UI stream ended before RUN_FINISHED or RUN_ERROR for the latest run".into(),
            )),
            Some(RunTerminalStatus::Finished { run_id, .. }) if run_id != requested_run_id => {
                Err(AgentError::ExchangeIdentity(
                    "The final successful runId is not the requested runId".into(),
                ))
            }
            Some(_) => Ok(()),
        }
    }
}

/// Resolve ownership from the same reconciled history for verification and
/// chunk expansion. Known root ownership is distinct from an unknown entity.
pub(crate) fn tool_call_owner(
    messages: &[Message],
    parent_id: Option<&MessageId>,
    explicit_owner: &Option<String>,
    call_id: Option<&str>,
) -> Result<Option<Option<String>>, AgentError> {
    let entity = call_id.unwrap_or("");
    let inherited = if let Some(parent) = parent_id.and_then(|id| {
        messages
            .iter()
            .find(|message| message.id() == id && message.role() == Role::Assistant)
    }) {
        let owner = message_owner(parent).cloned();
        check_owner(&owner, explicit_owner, entity)?;
        Some(owner)
    } else {
        None
    };
    let known = call_id
        .and_then(|id| {
            messages.iter().find(|message| {
                message
                    .tool_calls()
                    .is_some_and(|calls| calls.iter().any(|call| call.id.as_ref() == id))
            })
        })
        .map(|message| message_owner(message).cloned());
    if let Some(owner) = &known {
        check_owner(owner, explicit_owner, entity)?;
        if inherited
            .as_ref()
            .is_some_and(|parent_owner| parent_owner != owner)
        {
            return Err(AgentError::exec(
                "Tool call owner does not match parent message",
            ));
        }
    }
    Ok(known.or(inherited))
}

fn message_owner(message: &Message) -> Option<&String> {
    message.subagent_run_id()
}

fn check_owner(
    expected: &Option<String>,
    incoming: &Option<String>,
    entity: &str,
) -> Result<(), AgentError> {
    if incoming
        .as_ref()
        .is_some_and(|tag| Some(tag) != expected.as_ref())
    {
        return Err(AgentError::Execution {
            message: format!("Subagent attribution for '{entity}' does not match the opener"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
