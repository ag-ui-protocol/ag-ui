//! Expand the three chunk shorthands before verification and subscriber delivery.
use crate::agent::AgentError;
use crate::core::event::*;
use crate::core::types::{Message, MessageId, Role, ToolCallId};
use crate::core::{AgentState, JsonValue};

type Lane = Option<String>;

#[derive(Clone)]
enum Pending {
    Text {
        id: MessageId,
        role: Role,
        name: Option<String>,
    },
    Tool {
        id: ToolCallId,
        name: String,
        parent: Option<MessageId>,
    },
    Reasoning {
        id: MessageId,
    },
}
impl Pending {
    fn kind(&self) -> &'static str {
        match self {
            Self::Text { .. } => "TEXT_MESSAGE_CHUNK",
            Self::Tool { .. } => "TOOL_CALL_CHUNK",
            Self::Reasoning { .. } => "REASONING_MESSAGE_CHUNK",
        }
    }
    fn id(&self) -> &str {
        match self {
            Self::Text { id, .. } | Self::Reasoning { id } => id.as_ref(),
            Self::Tool { id, .. } => id.as_ref(),
        }
    }
}

#[derive(Default)]
pub(crate) struct ChunkExpander {
    // Vec preserves the order in which lanes opened when a run terminal closes all.
    lanes: Vec<(Lane, Pending)>,
}

fn base(
    owner: Lane,
    metadata: Option<serde_json::Map<String, JsonValue>>,
    raw_event: Option<JsonValue>,
) -> BaseEvent {
    {
        let mut value = BaseEvent::default();
        value.raw_event = raw_event;
        value.metadata = metadata;
        value.subagent_run_id = owner;
        value
    }
}
fn fail(message: impl Into<String>) -> AgentError {
    AgentError::Execution {
        message: message.into(),
    }
}

impl ChunkExpander {
    fn close<StateT: AgentState>(&mut self, lane: &Lane) -> Vec<Event<StateT>> {
        let Some(index) = self.lanes.iter().position(|(owner, _)| owner == lane) else {
            return vec![];
        };
        let (owner, pending) = self.lanes.remove(index);
        let end = match pending {
            Pending::Text { id, .. } => Event::TextMessageEnd(
                TextMessageEndEvent::new(id).with_base(base(owner, None, None)),
            ),
            Pending::Tool { id, .. } => {
                Event::ToolCallEnd(ToolCallEndEvent::new(id).with_base(base(owner, None, None)))
            }
            Pending::Reasoning { id } => Event::ReasoningMessageEnd(
                ReasoningMessageEndEvent::new(id).with_base(base(owner, None, None)),
            ),
        };
        vec![end]
    }
    fn close_all<StateT: AgentState>(&mut self) -> Vec<Event<StateT>> {
        let owners: Vec<_> = self.lanes.iter().map(|(owner, _)| owner.clone()).collect();
        owners
            .iter()
            .flat_map(|owner| self.close::<StateT>(owner))
            .collect()
    }
    fn resolve(&self, kind: &str, id: Option<&str>, tag: &Lane) -> Result<Lane, AgentError> {
        if let Some(id) = id {
            if let Some((owner, _)) = self
                .lanes
                .iter()
                .find(|(_, pending)| pending.kind() == kind && pending.id() == id)
            {
                if tag.as_ref().is_some_and(|tag| Some(tag) != owner.as_ref()) {
                    return Err(fail(format!(
                        "Cannot continue {kind} '{id}': chunk subagentRunId does not match the open stream"
                    )));
                }
                return Ok(owner.clone());
            }
            return Ok(tag.clone());
        }
        if tag.is_some() {
            return Ok(tag.clone());
        }
        if self
            .lanes
            .iter()
            .any(|(owner, pending)| owner.is_none() && pending.kind() == kind)
        {
            return Ok(None);
        }
        let candidates: Vec<_> = self
            .lanes
            .iter()
            .filter(|(_, pending)| pending.kind() == kind)
            .collect();
        match candidates.len() {
            0 => Ok(None),
            1 => Ok(candidates[0].0.clone()),
            _ => Err(fail(format!(
                "Ambiguous {kind}: continuation has no identifier or subagentRunId"
            ))),
        }
    }
    fn lane(&self, owner: &Lane) -> Option<&Pending> {
        self.lanes
            .iter()
            .find(|(lane, _)| lane == owner)
            .map(|(_, pending)| pending)
    }

    pub(crate) fn expand<StateT: AgentState>(
        &mut self,
        event: Event<StateT>,
        messages: &[Message],
    ) -> Result<Vec<Event<StateT>>, AgentError> {
        // The generated events are typed at the same StateT as the incoming stream.
        let mut output: Vec<Event<StateT>> = Vec::new();
        match event {
            Event::TextMessageChunk(chunk) => {
                let owner = self.resolve(
                    "TEXT_MESSAGE_CHUNK",
                    chunk.message_id.as_ref().map(AsRef::as_ref),
                    &chunk.base.subagent_run_id,
                )?;
                let previous = self.lane(&owner).cloned();
                let (id, open) = if let Some(Pending::Text { id, role, name }) =
                    previous.as_ref().filter(|p| {
                        chunk
                            .message_id
                            .as_ref()
                            .is_none_or(|new| new.as_ref() == p.id())
                    }) {
                    if chunk.role.as_ref().is_some_and(|new| new != role)
                        || chunk
                            .name
                            .as_ref()
                            .is_some_and(|new| Some(new) != name.as_ref())
                    {
                        return Err(fail(
                            "TEXT_MESSAGE_CHUNK role or name does not match the open stream's role or name",
                        ));
                    }
                    (id.clone(), false)
                } else {
                    let id = chunk
                        .message_id
                        .clone()
                        .ok_or_else(|| fail("First TEXT_MESSAGE_CHUNK must have a messageId"))?;
                    output.extend(self.close::<StateT>(&owner));
                    let role = chunk.role.clone().unwrap_or(Role::Assistant);
                    self.lanes.push((
                        owner.clone(),
                        Pending::Text {
                            id: id.clone(),
                            role: role.clone(),
                            name: chunk.name.clone(),
                        },
                    ));
                    output.push(Event::TextMessageStart({
                        let mut value = TextMessageStartEvent::new(id.clone()).with_base(base(
                            owner.clone(),
                            chunk.base.metadata.clone(),
                            None,
                        ));
                        value.role = Some(role);
                        value.name = chunk.name.clone();
                        value
                    }));
                    (id, true)
                };
                if chunk.delta.is_some()
                    || chunk.base.raw_event.is_some()
                    || (!open && chunk.base.metadata.is_some())
                {
                    output.push(Event::TextMessageContent(
                        TextMessageContentEvent::new(id, chunk.delta.unwrap_or_default())
                            .map_err(|error| fail(error.to_string()))?
                            .with_base(base(owner, chunk.base.metadata, chunk.base.raw_event)),
                    ));
                }
            }
            Event::ToolCallChunk(chunk) => {
                let inherited = crate::protocol_state::tool_call_owner(
                    messages,
                    chunk.parent_message_id.as_ref(),
                    &chunk.base.subagent_run_id,
                    chunk.tool_call_id.as_ref().map(AsRef::as_ref),
                )?;
                // Only a new identified opener chooses a lane from its parent.
                // An id-less continuation still follows the normal lane rules.
                let new_opener = chunk.tool_call_id.as_ref().is_some_and(|id| {
                    !self.lanes.iter().any(|(_, pending)| {
                        pending.kind() == "TOOL_CALL_CHUNK" && pending.id() == id.as_ref()
                    })
                });
                let effective_owner = if new_opener {
                    inherited
                        .clone()
                        .unwrap_or_else(|| chunk.base.subagent_run_id.clone())
                } else {
                    chunk.base.subagent_run_id.clone()
                };
                let owner = self.resolve(
                    "TOOL_CALL_CHUNK",
                    chunk.tool_call_id.as_ref().map(AsRef::as_ref),
                    &effective_owner,
                )?;
                if inherited
                    .as_ref()
                    .is_some_and(|parent_owner| parent_owner != &owner)
                {
                    return Err(fail("Tool call owner does not match parent message"));
                }
                let previous = self.lane(&owner).cloned();
                let (id, open) = if let Some(Pending::Tool { id, name, parent }) =
                    previous.as_ref().filter(|p| {
                        chunk
                            .tool_call_id
                            .as_ref()
                            .is_none_or(|new| new.as_ref() == p.id())
                    }) {
                    if chunk.tool_call_name.as_ref().is_some_and(|new| new != name)
                        || chunk
                            .parent_message_id
                            .as_ref()
                            .is_some_and(|new| Some(new) != parent.as_ref())
                    {
                        return Err(fail(
                            "TOOL_CALL_CHUNK toolCallName or parentMessageId does not match the open stream's toolCallName or parentMessageId",
                        ));
                    }
                    (id.clone(), false)
                } else {
                    let id = chunk
                        .tool_call_id
                        .clone()
                        .ok_or_else(|| fail("First TOOL_CALL_CHUNK must have a toolCallId"))?;
                    let name = chunk
                        .tool_call_name
                        .clone()
                        .ok_or_else(|| fail("First TOOL_CALL_CHUNK must have a toolCallName"))?;
                    output.extend(self.close::<StateT>(&owner));
                    self.lanes.push((
                        owner.clone(),
                        Pending::Tool {
                            id: id.clone(),
                            name: name.clone(),
                            parent: chunk.parent_message_id.clone(),
                        },
                    ));
                    output.push(Event::ToolCallStart({
                        let mut value = ToolCallStartEvent::new(id.clone(), name).with_base(base(
                            owner.clone(),
                            chunk.base.metadata.clone(),
                            None,
                        ));
                        value.parent_message_id = chunk.parent_message_id.clone();
                        value
                    }));
                    (id, true)
                };
                if chunk.delta.is_some()
                    || chunk.base.raw_event.is_some()
                    || (!open && chunk.base.metadata.is_some())
                {
                    output.push(Event::ToolCallArgs(
                        ToolCallArgsEvent::new(id, chunk.delta.unwrap_or_default())
                            .with_base(base(owner, chunk.base.metadata, chunk.base.raw_event)),
                    ));
                }
            }
            Event::ReasoningMessageChunk(chunk) => {
                let owner = self.resolve(
                    "REASONING_MESSAGE_CHUNK",
                    chunk.message_id.as_ref().map(AsRef::as_ref),
                    &chunk.base.subagent_run_id,
                )?;
                let previous = self.lane(&owner).cloned();
                let (id, open) = if let Some(Pending::Reasoning { id }) =
                    previous.as_ref().filter(|p| {
                        chunk
                            .message_id
                            .as_ref()
                            .is_none_or(|new| new.as_ref() == p.id())
                    }) {
                    (id.clone(), false)
                } else {
                    let id = chunk.message_id.clone().ok_or_else(|| {
                        fail("First REASONING_MESSAGE_CHUNK must have a messageId")
                    })?;
                    output.extend(self.close::<StateT>(&owner));
                    self.lanes
                        .push((owner.clone(), Pending::Reasoning { id: id.clone() }));
                    output.push(Event::ReasoningMessageStart(
                        ReasoningMessageStartEvent::new(id.clone()).with_base(base(
                            owner.clone(),
                            chunk.base.metadata.clone(),
                            None,
                        )),
                    ));
                    (id, true)
                };
                if chunk.delta.is_some()
                    || chunk.base.raw_event.is_some()
                    || (!open && chunk.base.metadata.is_some())
                {
                    output.push(Event::ReasoningMessageContent(
                        ReasoningMessageContentEvent::new(id, chunk.delta.unwrap_or_default())
                            .with_base(base(owner, chunk.base.metadata, chunk.base.raw_event)),
                    ));
                }
            }
            other => {
                match &other {
                    Event::Raw(_)
                    | Event::ActivitySnapshot(_)
                    | Event::ActivityDelta(_)
                    | Event::ReasoningEncryptedValue(_)
                    | Event::SubagentStarted(_) => {}
                    Event::RunStarted(_)
                    | Event::RunFinished(_)
                    | Event::RunError(_)
                    | Event::MessagesSnapshot(_) => output.extend(self.close_all::<StateT>()),
                    Event::SubagentFinished(e) => {
                        output.extend(self.close::<StateT>(&Some(e.subagent_run_id.clone())))
                    }
                    Event::SubagentError(e) => {
                        output.extend(self.close::<StateT>(&Some(e.subagent_run_id.clone())))
                    }
                    _ => output.extend(self.close::<StateT>(&event_owner(&other))),
                }
                output.push(other);
            }
        }
        Ok(output)
    }
}

fn event_owner<StateT: AgentState>(event: &Event<StateT>) -> Lane {
    match event {
        Event::TextMessageStart(e) => &e.base,
        Event::TextMessageContent(e) => &e.base,
        Event::TextMessageEnd(e) => &e.base,
        Event::ToolCallStart(e) => &e.base,
        Event::ToolCallArgs(e) => &e.base,
        Event::ToolCallEnd(e) => &e.base,
        Event::ToolCallResult(e) => &e.base,
        Event::StateSnapshot(e) => &e.base,
        Event::StateDelta(e) => &e.base,
        Event::Custom(e) => &e.base,
        Event::StepStarted(e) => &e.base,
        Event::StepFinished(e) => &e.base,
        Event::ReasoningStart(e) => &e.base,
        Event::ReasoningMessageStart(e) => &e.base,
        Event::ReasoningMessageContent(e) => &e.base,
        Event::ReasoningMessageEnd(e) => &e.base,
        Event::ReasoningEnd(e) => &e.base,
        _ => return None,
    }
    .subagent_run_id
    .clone()
}
