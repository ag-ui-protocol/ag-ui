//! The open-stream model: what a `*_CHUNK` event continues, and what ends it.
//!
//! `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK` and `REASONING_MESSAGE_CHUNK` are a
//! compact spelling of start, content and end. They carry their id and the
//! fields that open an item **only on the first chunk**, and they have no end
//! event, so two things have to be remembered: which item a chunk that names
//! none continues, and when the item it was assembling is over. AG-UI 1.0
//! states both (`basic/patterns/streaming`, "The chunked form"), and this
//! module is the one place they are implemented. Three callers share it:
//!
//! - the client's `ChunkNormalizer`, which expands chunks before verification;
//! - the ordering rules, which judge a chunk as the events it stands for when
//!   one reaches a verifier unexpanded;
//! - the server's transformers, which have to know which call or message a
//!   chunk that names no id continues before they filter or re-attribute it.
//!
//! # Lanes
//!
//! A *lane* is the parent agent's, or one subagent's. A lane assembles at
//! most one chunk stream. That stream ends when:
//!
//! - a chunk opens a different item in the same lane;
//! - a message, tool-call, step, state, custom or reasoning event arrives in
//!   the lane. `RAW`, `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`,
//!   `REASONING_ENCRYPTED_VALUE` and `SUBAGENT_STARTED` stand aside and end
//!   nothing;
//! - `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` or `MESSAGES_SNAPSHOT`
//!   arrives, which ends every lane's;
//! - `SUBAGENT_FINISHED` or `SUBAGENT_ERROR` arrives, which ends that
//!   subagent's.
//!
//! An event is in the lane of the owner it is attributed to. An explicit
//! event of the three families that carries no `subagentRunId` is in the lane
//! of the owner the ordering rules record for its item: AG-UI 1.0
//! (`events/subagents`, "Ownership"), "an untagged continuation continues
//! whatever the opener owns". So the untagged `TEXT_MESSAGE_CONTENT` of a
//! message a subagent opened ends that subagent's chunk stream, and leaves
//! the parent agent's alone. The record is the rules': the opener's owner
//! while an item is open; for an id, its first writer, the newest
//! `TOOL_CALL_RESULT` that minted it, or the last `MESSAGES_SNAPSHOT` that
//! restated it; for a tool call, the owner of the message that carries it.
//! The same goes for `REASONING_START` and `REASONING_END`. An id nothing
//! records is the parent agent's.
//!
//! # The two spellings do not mix
//!
//! Only chunks open and continue a chunk stream. An explicit event that names
//! the id a chunk stream is assembling is not a continuation of it: it ends
//! the stream like any other event in the lane, and is then judged by the
//! rules of the explicit form. So an explicit `TEXT_MESSAGE_END` for a
//! chunk-opened message finds the message already closed, and a chunk that
//! names an explicitly opened message opens it a second time. Both are for the
//! ordering rules to reject; this module only reports what the chunk stood
//! for.
//!
//! # What the synthesized events carry
//!
//! A chunk's metadata goes on every event synthesized from it, and its
//! `rawEvent` on the content event. Its `timestamp` goes on none: the
//! synthesized events are not the chunk (`basic/processing`, "Where
//! middleware sits"). A chunk without a `delta` still stands for a content
//! event, with an empty delta, when it carries a `rawEvent`, or metadata on a
//! continuation: without one, a final chunk reporting a finish reason would
//! never reach the item it continues (`basic/patterns/streaming`, "Chunk
//! metadata").

// Each caller uses its own part of this API: a consumer and the ordering
// rules expand, a transformer tracks. With one of them compiled out, its part
// has no caller.
#![cfg_attr(
    not(all(feature = "client", feature = "server", feature = "verify")),
    allow(dead_code)
)]

use std::collections::HashMap;
use std::fmt;

use serde_json::Value;

use crate::{
    BaseEvent, Event, JsonObject, Message, MessageId, ReasoningMessageChunkEvent,
    ReasoningMessageContentEvent, ReasoningMessageStartEvent, SubagentRunId, TextMessageChunkEvent,
    TextMessageContentEvent, TextMessageRole, TextMessageStartEvent, ToolCallArgsEvent,
    ToolCallChunkEvent, ToolCallId, ToolCallStartEvent,
};

/// Whose lane: a subagent's, or the parent agent's when `None`.
pub(crate) type Owner = Option<SubagentRunId>;

/// Which family of item a chunk stream assembles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Kind {
    Text,
    Tool,
    Reasoning,
}

impl Kind {
    const fn chunk_name(self) -> &'static str {
        match self {
            Self::Text => "TEXT_MESSAGE_CHUNK",
            Self::Tool => "TOOL_CALL_CHUNK",
            Self::Reasoning => "REASONING_MESSAGE_CHUNK",
        }
    }

    const fn id_name(self) -> &'static str {
        match self {
            Self::Text | Self::Reasoning => "messageId",
            Self::Tool => "toolCallId",
        }
    }

    const fn noun(self) -> &'static str {
        match self {
            Self::Text => "message",
            Self::Tool => "call",
            Self::Reasoning => "reasoning message",
        }
    }
}

/// What a chunk stream was opened with: the fields a continuation may repeat,
/// with the same values only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Opener {
    Text {
        role: TextMessageRole,
        name: Option<String>,
    },
    Tool {
        name: String,
        parent_message_id: Option<MessageId>,
    },
    Reasoning,
}

/// A chunk stream being assembled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Stream {
    pub(crate) kind: Kind,
    /// The message id or tool call id, as a plain string.
    pub(crate) id: String,
    /// The lane the stream is in.
    pub(crate) owner: Owner,
    pub(crate) opener: Opener,
}

impl Stream {
    /// The end event the chunked form never sends, carrying the stream's
    /// attribution.
    fn end(self) -> Event {
        let mut end = match self.kind {
            Kind::Text => Event::text_message_end(MessageId::new(self.id)),
            Kind::Tool => Event::tool_call_end(ToolCallId::new(self.id)),
            Kind::Reasoning => Event::reasoning_message_end(MessageId::new(self.id)),
        };
        if let Some(owner) = self.owner {
            end.set_subagent_run_id(owner);
        }
        end
    }
}

/// Why a chunk cannot be read as the events it stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChunkError {
    /// It names no id and no chunk stream of its kind is there to continue:
    /// none at all, or none in the lane of the subagent it is attributed to.
    NothingOpen {
        kind: Kind,
        subagent: Option<SubagentRunId>,
    },
    /// It names neither an id nor a subagent, and several subagents are
    /// assembling a stream of its kind.
    Ambiguous { kind: Kind },
    /// It opens a tool call without naming the tool.
    Unnamed { id: String },
    /// It repeats a field its stream was opened with, with another value.
    Conflict {
        kind: Kind,
        id: String,
        field: &'static str,
        repeated: String,
        established: Option<String>,
    },
}

impl fmt::Display for ChunkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NothingOpen { kind, subagent } => {
                write!(
                    f,
                    "{} carries no {} and ",
                    kind.chunk_name(),
                    kind.id_name()
                )?;
                match subagent {
                    Some(id) => write!(f, "subagent {:?} has no {}", id.as_str(), kind.noun())?,
                    None => write!(f, "no {} is", kind.noun())?,
                }
                f.write_str(" open as a chunk stream")
            }
            Self::Ambiguous { kind } => write!(
                f,
                "{} carries no {} and several subagents have a {} open; attribute the chunk",
                kind.chunk_name(),
                kind.id_name(),
                kind.noun()
            ),
            Self::Unnamed { id } => write!(
                f,
                "TOOL_CALL_CHUNK opens tool call {id:?} without a toolCallName"
            ),
            Self::Conflict {
                kind,
                id,
                field,
                repeated,
                established,
            } => {
                write!(
                    f,
                    "{} for {} {id:?} repeats {field} {repeated:?}, which does not match the \
                     open stream's {field} ",
                    kind.chunk_name(),
                    kind.noun()
                )?;
                match established {
                    Some(value) => write!(f, "{value:?}"),
                    None => f.write_str("(absent)"),
                }
            }
        }
    }
}

/// A chunk, reduced to what placing it needs.
struct Chunk<'a> {
    kind: Kind,
    id: Option<&'a str>,
    tag: &'a Owner,
    fields: Fields<'a>,
}

/// The opener fields a chunk carries, each of which may be absent.
enum Fields<'a> {
    Text {
        role: Option<TextMessageRole>,
        name: Option<&'a str>,
    },
    Tool {
        name: Option<&'a str>,
        parent_message_id: Option<&'a MessageId>,
    },
    Reasoning,
}

impl<'a> Chunk<'a> {
    fn text(chunk: &'a TextMessageChunkEvent) -> Self {
        Self {
            kind: Kind::Text,
            id: chunk.message_id.as_deref(),
            tag: &chunk.subagent_run_id,
            fields: Fields::Text {
                role: chunk.role,
                name: chunk.name.as_deref(),
            },
        }
    }

    fn tool(chunk: &'a ToolCallChunkEvent) -> Self {
        Self {
            kind: Kind::Tool,
            id: chunk.tool_call_id.as_deref(),
            tag: &chunk.subagent_run_id,
            fields: Fields::Tool {
                name: chunk.tool_call_name.as_deref(),
                parent_message_id: chunk.parent_message_id.as_ref(),
            },
        }
    }

    fn reasoning(chunk: &'a ReasoningMessageChunkEvent) -> Self {
        Self {
            kind: Kind::Reasoning,
            id: chunk.message_id.as_deref(),
            tag: &chunk.subagent_run_id,
            fields: Fields::Reasoning,
        }
    }
}

/// What the events a chunk stands for keep of its base fields.
///
/// AG-UI 1.0 carries a chunk's metadata and `rawEvent` through expansion
/// intact, and not its `timestamp`. The metadata applies to every event
/// synthesized from the chunk; merged key by key, stamping it on a start and
/// its content is the same as stamping it once. 1.0 does not say which event
/// carries the one provider payload. It rides the content event, which is
/// what the producer sent, as in the reference client; the start is
/// expansion's own.
struct Carried {
    metadata: Option<JsonObject>,
    raw_event: Option<Value>,
}

impl Carried {
    fn new(base: BaseEvent) -> Self {
        Self {
            metadata: base.metadata,
            raw_event: base.raw_event.filter(|raw| !raw.is_null()),
        }
    }

    /// The base of the synthesized start: the metadata alone.
    fn start(&self) -> BaseEvent {
        BaseEvent {
            metadata: self.metadata.clone(),
            ..BaseEvent::default()
        }
    }

    /// The delta and base of the content event the chunk stands for.
    ///
    /// A chunk without a delta stands for one with an empty delta when it
    /// carries what only a content event can deliver: a provider payload, or,
    /// on a continuation, metadata, which has no start to ride. Otherwise it
    /// stands for no content.
    fn content(self, delta: Option<String>, opened: bool) -> Option<(String, BaseEvent)> {
        let delta = match delta {
            Some(delta) => delta,
            None if self.raw_event.is_some() || (!opened && self.metadata.is_some()) => {
                String::new()
            }
            None => return None,
        };
        let base = BaseEvent {
            timestamp: None,
            raw_event: self.raw_event,
            metadata: self.metadata,
        };
        Some((delta, base))
    }
}

/// Where a chunk landed.
struct Placed {
    id: String,
    owner: Owner,
    /// Whether the chunk opened the stream, and so stands for a start event.
    opened: bool,
}

/// Rejects a continuation chunk that repeats an opener's field with another
/// value. One that leaves the field out agrees with anything.
fn agree(
    chunk: &Chunk<'_>,
    id: &str,
    field: &'static str,
    repeated: Option<&str>,
    established: Option<&str>,
) -> Result<(), ChunkError> {
    match repeated {
        Some(repeated) if Some(repeated) != established => Err(ChunkError::Conflict {
            kind: chunk.kind,
            id: id.to_owned(),
            field,
            repeated: repeated.to_owned(),
            established: established.map(str::to_owned),
        }),
        _ => Ok(()),
    }
}

/// Who owns each item, as the ordering rules record it: what the lane of an
/// explicit event that carries no tag is resolved from. See the [module
/// docs](self).
///
/// Kept by id, so that what an event costs does not grow with how many ids
/// the run has used.
#[derive(Clone, Debug, Default)]
struct Owners {
    /// Each item open in the explicit form, by kind, with the owner its
    /// start gave it.
    open_text: HashMap<String, Owner>,
    open_tool: HashMap<String, Owner>,
    open_reasoning: HashMap<String, Owner>,
    /// Text message ids, and whose: the first writer, the newest result that
    /// minted one, the last snapshot that restated one.
    messages: HashMap<String, Owner>,
    /// The same for reasoning, a bucket apart, as the rules keep it.
    reasoning: HashMap<String, Owner>,
    /// Tool call ids, and whose.
    tool_calls: HashMap<String, Owner>,
}

impl Owners {
    fn open(&self, kind: Kind) -> &HashMap<String, Owner> {
        match kind {
            Kind::Text => &self.open_text,
            Kind::Tool => &self.open_tool,
            Kind::Reasoning => &self.open_reasoning,
        }
    }

    /// The owner the rules give an item of `kind` that `id` names and that
    /// is not open: for a tool call, the owner of the message `parent` names
    /// when one is recorded, and otherwise the id's own record.
    fn recorded(&self, kind: Kind, id: &str, parent: Option<&MessageId>) -> Option<Owner> {
        match kind {
            Kind::Text => self.messages.get(id).cloned(),
            Kind::Reasoning => self.reasoning.get(id).cloned(),
            Kind::Tool => parent
                .and_then(|parent| self.messages.get(parent.as_str()))
                .or_else(|| self.tool_calls.get(id))
                .cloned(),
        }
    }

    /// Records the owners one accepted event in the explicit form gives.
    fn note(&mut self, event: &Event) {
        match event {
            Event::TextMessageStart(e) => {
                let owner = self.opener(Kind::Text, e.message_id.as_str(), &e.subagent_run_id);
                self.messages
                    .entry(e.message_id.as_str().to_owned())
                    .or_insert_with(|| owner.clone());
                self.open_text
                    .insert(e.message_id.as_str().to_owned(), owner);
            }
            Event::TextMessageEnd(e) => {
                self.open_text.remove(e.message_id.as_str());
            }
            Event::ToolCallStart(e) => {
                // Its tag; else the owner of the message that carries it;
                // else whoever introduced it before; else the parent agent.
                let inherited = e
                    .parent_message_id
                    .as_ref()
                    .and_then(|parent| self.messages.get(parent.as_str()).cloned());
                let asserted = match &e.subagent_run_id {
                    Some(tag) => Some(Some(tag.clone())),
                    None => inherited,
                };
                let id = e.tool_call_id.as_str();
                let owner = asserted
                    .or_else(|| self.tool_calls.get(id).cloned())
                    .unwrap_or(None);
                self.tool_calls.insert(id.to_owned(), owner.clone());
                self.open_tool.insert(id.to_owned(), owner);
            }
            Event::ToolCallEnd(e) => {
                self.open_tool.remove(e.tool_call_id.as_str());
            }
            // A result mints the message it names under its own attribution.
            Event::ToolCallResult(e) => {
                self.messages
                    .insert(e.message_id.as_str().to_owned(), e.subagent_run_id.clone());
            }
            Event::ReasoningStart(e) => {
                let id = e.message_id.as_str();
                let owner = self.opener(Kind::Reasoning, id, &e.subagent_run_id);
                self.reasoning.entry(id.to_owned()).or_insert(owner);
            }
            Event::ReasoningMessageStart(e) => {
                let id = e.message_id.as_str();
                let owner = self.opener(Kind::Reasoning, id, &e.subagent_run_id);
                self.reasoning
                    .entry(id.to_owned())
                    .or_insert_with(|| owner.clone());
                self.open_reasoning.insert(id.to_owned(), owner);
            }
            Event::ReasoningMessageEnd(e) => {
                self.open_reasoning.remove(e.message_id.as_str());
            }
            // Authoritative: the snapshot restates the conversation.
            Event::MessagesSnapshot(e) => self.seed(&e.messages, true),
            // A new run starts with nothing open, and its input echo is
            // history: it records only what nothing has.
            Event::RunStarted(e) => {
                self.forget_open();
                if let Some(input) = &e.input {
                    self.seed(&input.messages, false);
                }
            }
            // A failing run abandons whatever it had open.
            Event::RunError(_) => self.forget_open(),
            _ => {}
        }
    }

    /// The owner a start of `kind` for `id` gives its item: its tag, else the
    /// recorded owner of the id, else the parent agent.
    fn opener(&self, kind: Kind, id: &str, tag: &Owner) -> Owner {
        match tag {
            Some(_) => tag.clone(),
            None => self.recorded(kind, id, None).flatten(),
        }
    }

    fn forget_open(&mut self) {
        self.open_text.clear();
        self.open_tool.clear();
        self.open_reasoning.clear();
    }

    /// Records the owners of the messages of a conversation, and of the tool
    /// calls they carry: all of them, or only those nothing has recorded.
    fn seed(&mut self, messages: &[Message], authoritative: bool) {
        for message in messages {
            let owner = message.subagent_run_id().cloned();
            let bucket = match message {
                Message::Activity(_) => continue,
                Message::Reasoning(_) => &mut self.reasoning,
                _ => &mut self.messages,
            };
            if authoritative || !bucket.contains_key(message.id().as_str()) {
                bucket.insert(message.id().as_str().to_owned(), owner.clone());
            }
            if let Message::Assistant(assistant) = message {
                for call in assistant.tool_calls.iter().flatten() {
                    if authoritative || !self.tool_calls.contains_key(call.id.as_str()) {
                        self.tool_calls
                            .insert(call.id.as_str().to_owned(), owner.clone());
                    }
                }
            }
        }
    }
}

/// The chunk streams being assembled: at most one per lane, in the order they
/// opened.
#[derive(Clone, Debug, Default)]
pub(crate) struct Streams {
    open: Vec<Stream>,
    /// Whose each item is, for the lane of an untagged explicit event.
    owners: Owners,
}

/// The chunk streams a [`Streams`] was assembling, to put back with
/// [`Streams::rewind`].
pub(crate) struct Checkpoint(Vec<Stream>);

impl Streams {
    /// Whether no chunk stream is being assembled.
    pub(crate) fn is_idle(&self) -> bool {
        self.open.is_empty()
    }

    /// Learns the conversation a run continues, before its first event: the
    /// owners of its messages, for the ids nothing has recorded.
    pub(crate) fn seed(&mut self, history: &[Message]) {
        self.owners.seed(history, false);
    }

    /// Expands one event into the explicit form, appending the result to
    /// `out`: the ends it implies, then for a chunk the start it stands for
    /// and its content, and for anything else the event itself.
    pub(crate) fn expand(&mut self, event: Event, out: &mut Vec<Event>) -> Result<(), ChunkError> {
        let from = out.len();
        self.expand_quietly(event, out)?;
        self.note_all(&out[from..]);
        Ok(())
    }

    /// [`expand`](Self::expand) without recording the owners of what comes
    /// out, for a caller that judges it first and then [notes](Self::note)
    /// what it accepted.
    pub(crate) fn expand_quietly(
        &mut self,
        event: Event,
        out: &mut Vec<Event>,
    ) -> Result<(), ChunkError> {
        match event {
            Event::TextMessageChunk(chunk) => self.text_chunk(chunk, out),
            Event::ToolCallChunk(chunk) => self.tool_chunk(chunk, out),
            Event::ReasoningMessageChunk(chunk) => self.reasoning_chunk(chunk, out),
            other => {
                self.close_for(&other, out);
                out.push(other);
                Ok(())
            }
        }
    }

    /// Appends to `out` the end of every chunk stream an event that is not a
    /// chunk closes. The event itself is not appended.
    pub(crate) fn end_for(&mut self, event: &Event, out: &mut Vec<Event>) {
        let from = out.len();
        self.close_for(event, out);
        self.note_all(&out[from..]);
        self.note(event);
    }

    /// [`end_for`](Self::end_for) without recording owners: see
    /// [`expand_quietly`](Self::expand_quietly).
    pub(crate) fn close_for(&mut self, event: &Event, out: &mut Vec<Event>) {
        self.end(event, &mut |stream| out.push(stream.end()));
    }

    /// Records the owners an accepted event in the explicit form gives: a
    /// start, an end, a result, a snapshot, a run's start. Each event a
    /// caller of the quiet methods accepts is noted, in order, the ones a
    /// chunk stood for included.
    pub(crate) fn note(&mut self, event: &Event) {
        self.owners.note(event);
    }

    fn note_all(&mut self, events: &[Event]) {
        for event in events {
            self.owners.note(event);
        }
    }

    /// The chunk streams being assembled, to [`rewind`](Self::rewind) to
    /// when what follows is rejected. The owners are not in it: the quiet
    /// methods leave them alone.
    pub(crate) fn checkpoint(&self) -> Checkpoint {
        Checkpoint(self.open.clone())
    }

    pub(crate) fn rewind(&mut self, checkpoint: Checkpoint) {
        self.open = checkpoint.0;
    }

    /// Drops every chunk stream without ending it, for a run that is over
    /// whatever it had open. The owners stay, as the messages they describe
    /// do.
    pub(crate) fn abandon(&mut self) {
        self.open.clear();
        self.owners.forget_open();
    }

    /// Ends whatever is still being assembled. For the end of the transport
    /// stream: the last item of a run has nothing after it to imply its end.
    pub(crate) fn finish(&mut self, out: &mut Vec<Event>) {
        self.close_all(&mut |stream| out.push(stream.end()));
    }

    /// Folds an event into the model without handing back what it stands
    /// for. A chunk that cannot be placed changes nothing.
    pub(crate) fn track(&mut self, event: &Event) -> Vec<Event> {
        let mut stood_for = Vec::new();
        match event {
            Event::TextMessageChunk(_)
            | Event::ToolCallChunk(_)
            | Event::ReasoningMessageChunk(_) => {
                let _ = self.expand(event.clone(), &mut stood_for);
            }
            other => self.end_for(other, &mut stood_for),
        }
        stood_for
    }

    /// The stream a chunk that names no id continues: the one in the lane it
    /// is attributed to; unattributed, the parent's, else the only one of its
    /// kind.
    pub(crate) fn continued(&self, kind: Kind, tag: &Owner) -> Result<&Stream, ChunkError> {
        let of_kind = |stream: &&Stream| stream.kind == kind;
        if tag.is_some() {
            return self
                .lane(tag)
                .filter(of_kind)
                .ok_or(ChunkError::NothingOpen {
                    kind,
                    subagent: tag.clone(),
                });
        }
        if let Some(stream) = self.lane(&None).filter(of_kind) {
            return Ok(stream);
        }
        let mut candidates = self.open.iter().filter(of_kind);
        match (candidates.next(), candidates.next()) {
            (Some(only), None) => Ok(only),
            (None, _) => Err(ChunkError::NothingOpen {
                kind,
                subagent: None,
            }),
            (Some(_), Some(_)) => Err(ChunkError::Ambiguous { kind }),
        }
    }

    /// The stream assembling this id, whichever lane it is in.
    pub(crate) fn holder(&self, kind: Kind, id: &str) -> Option<&Stream> {
        self.open
            .iter()
            .find(|stream| stream.kind == kind && stream.id == id)
    }

    // ---- chunks ---------------------------------------------------------

    fn text_chunk(
        &mut self,
        chunk: TextMessageChunkEvent,
        out: &mut Vec<Event>,
    ) -> Result<(), ChunkError> {
        let placed = self.place(&Chunk::text(&chunk), &mut |stream| out.push(stream.end()))?;
        let id = MessageId::new(placed.id);
        let carried = Carried::new(chunk.base);
        if placed.opened {
            let mut start = TextMessageStartEvent::new(id.clone(), chunk.role.unwrap_or_default());
            start.name = chunk.name;
            start.base = carried.start();
            start.subagent_run_id = placed.owner.clone();
            out.push(start.into());
        }
        if let Some((delta, base)) = carried.content(chunk.delta, placed.opened) {
            let mut content = TextMessageContentEvent::new(id, delta);
            content.base = base;
            content.subagent_run_id = placed.owner;
            out.push(content.into());
        }
        Ok(())
    }

    fn tool_chunk(
        &mut self,
        chunk: ToolCallChunkEvent,
        out: &mut Vec<Event>,
    ) -> Result<(), ChunkError> {
        let placed = self.place(&Chunk::tool(&chunk), &mut |stream| out.push(stream.end()))?;
        let id = ToolCallId::new(placed.id);
        let carried = Carried::new(chunk.base);
        if placed.opened {
            // `place` opened the stream, so the chunk named its tool.
            let name = chunk.tool_call_name.unwrap_or_default();
            let mut start = ToolCallStartEvent::new(id.clone(), name);
            start.parent_message_id = chunk.parent_message_id;
            start.base = carried.start();
            start.subagent_run_id = placed.owner.clone();
            out.push(start.into());
        }
        if let Some((delta, base)) = carried.content(chunk.delta, placed.opened) {
            let mut args = ToolCallArgsEvent::new(id, delta);
            args.base = base;
            args.subagent_run_id = placed.owner;
            out.push(args.into());
        }
        Ok(())
    }

    fn reasoning_chunk(
        &mut self,
        chunk: ReasoningMessageChunkEvent,
        out: &mut Vec<Event>,
    ) -> Result<(), ChunkError> {
        let placed = self.place(&Chunk::reasoning(&chunk), &mut |stream| {
            out.push(stream.end());
        })?;
        let id = MessageId::new(placed.id);
        let carried = Carried::new(chunk.base);
        if placed.opened {
            let mut start = ReasoningMessageStartEvent::new(id.clone());
            start.base = carried.start();
            start.subagent_run_id = placed.owner.clone();
            out.push(start.into());
        }
        if let Some((delta, base)) = carried.content(chunk.delta, placed.opened) {
            let mut content = ReasoningMessageContentEvent::new(id, delta);
            content.base = base;
            content.subagent_run_id = placed.owner;
            out.push(content.into());
        }
        Ok(())
    }

    /// Finds the stream a chunk continues, or opens the one it names, handing
    /// `ended` whatever its lane was assembling before.
    ///
    /// Nothing changes when the chunk is rejected: a call that cannot be
    /// opened does not close the stream before it on the way to finding out.
    fn place(
        &mut self,
        chunk: &Chunk<'_>,
        ended: &mut impl FnMut(Stream),
    ) -> Result<Placed, ChunkError> {
        let (id, owner) = match chunk.id {
            Some(id) => (id.to_owned(), self.lane_of(chunk.kind, id, chunk.tag)),
            None => {
                let stream = self.continued(chunk.kind, chunk.tag)?;
                (stream.id.clone(), stream.owner.clone())
            }
        };
        let assembling = self
            .lane(&owner)
            .filter(|stream| stream.kind == chunk.kind && stream.id == id);
        if let Some(stream) = assembling {
            match (&stream.opener, &chunk.fields) {
                (
                    Opener::Text { role, name },
                    Fields::Text {
                        role: again,
                        name: named,
                    },
                ) => {
                    let again = again.map(|role| role.as_str());
                    agree(chunk, &id, "role", again, Some(role.as_str()))?;
                    agree(chunk, &id, "name", *named, name.as_deref())?;
                }
                (
                    Opener::Tool {
                        name,
                        parent_message_id,
                    },
                    Fields::Tool {
                        name: again,
                        parent_message_id: parent,
                    },
                ) => {
                    agree(chunk, &id, "toolCallName", *again, Some(name))?;
                    let parent = parent.map(MessageId::as_str);
                    let established = parent_message_id.as_deref();
                    agree(chunk, &id, "parentMessageId", parent, established)?;
                }
                _ => {}
            }
            return Ok(Placed {
                id,
                owner,
                opened: false,
            });
        }
        let opener = match &chunk.fields {
            Fields::Text { role, name } => Opener::Text {
                // An absent role opens an assistant message.
                role: role.unwrap_or_default(),
                name: name.map(str::to_owned),
            },
            Fields::Tool {
                name,
                parent_message_id,
            } => Opener::Tool {
                name: name
                    .ok_or_else(|| ChunkError::Unnamed { id: id.clone() })?
                    .to_owned(),
                parent_message_id: parent_message_id.cloned(),
            },
            Fields::Reasoning => Opener::Reasoning,
        };
        self.close_lane(&owner, ended);
        self.open.push(Stream {
            kind: chunk.kind,
            id: id.clone(),
            owner: owner.clone(),
            opener,
        });
        Ok(Placed {
            id,
            owner,
            opened: true,
        })
    }

    // ---- everything else ------------------------------------------------

    /// Hands `ended` every stream an event that is not a chunk closes: the
    /// module docs list which events close what.
    fn end(&mut self, event: &Event, ended: &mut impl FnMut(Stream)) {
        // An explicit event of one of the three families ends the stream in
        // its lane, even when it names the id that stream is assembling: the
        // two spellings do not mix.
        if let Some((kind, id, tag)) = item(event) {
            let parent = match event {
                Event::ToolCallStart(e) => e.parent_message_id.as_ref(),
                _ => None,
            };
            let lane = self.explicit_lane(kind, id, tag, parent);
            return self.close_lane(&lane, ended);
        }
        match event {
            // A result answers a call, so the call is over, whoever was
            // assembling it: a chunk-streamed call has no end of its own, and
            // without this the result would overtake the end it is owed. The
            // result's own lane is the one it is attributed to, since whoever
            // executes a call can differ from whoever requested it.
            Event::ToolCallResult(e) => {
                self.close_id(Kind::Tool, &e.tool_call_id, ended);
                self.close_lane(&e.subagent_run_id, ended);
            }
            // A reasoning block closing implies the message inside it has.
            // Untagged, a block's event is in its owner's lane, as an item's
            // continuation is.
            Event::ReasoningEnd(e) => {
                self.close_id(Kind::Reasoning, &e.message_id, ended);
                let lane = self.block_lane(&e.message_id, &e.subagent_run_id);
                self.close_lane(&lane, ended);
            }
            Event::ReasoningStart(e) => {
                let lane = self.block_lane(&e.message_id, &e.subagent_run_id);
                self.close_lane(&lane, ended);
            }

            // The standalone events that end their lane's stream.
            Event::StateSnapshot(e) => self.close_lane(&e.subagent_run_id, ended),
            Event::StateDelta(e) => self.close_lane(&e.subagent_run_id, ended),
            Event::Custom(e) => self.close_lane(&e.subagent_run_id, ended),
            Event::StepStarted(e) => self.close_lane(&e.subagent_run_id, ended),
            Event::StepFinished(e) => self.close_lane(&e.subagent_run_id, ended),

            // A stream does not outlive the subagent it belongs to.
            Event::SubagentFinished(e) => {
                self.close_lane(&Some(e.subagent_run_id.clone()), ended);
            }
            Event::SubagentError(e) => self.close_lane(&Some(e.subagent_run_id.clone()), ended),

            Event::RunStarted(_)
            | Event::RunFinished(_)
            | Event::RunError(_)
            | Event::MessagesSnapshot(_) => self.close_all(ended),

            // These stand aside from assembly and end nothing.
            Event::Raw(_)
            | Event::ActivitySnapshot(_)
            | Event::ActivityDelta(_)
            | Event::ReasoningEncryptedValue(_)
            | Event::SubagentStarted(_) => {}

            // The explicit events of the three families were handled above,
            // chunks are placed rather than ended for, and the retired
            // THINKING_* family is translated before this stage.
            _ => {}
        }
    }

    // ---- bookkeeping ----------------------------------------------------

    /// The stream a lane is assembling.
    fn lane(&self, owner: &Owner) -> Option<&Stream> {
        self.open.iter().find(|stream| &stream.owner == owner)
    }

    /// The lane an explicit start, content or end event for `id` is in: the
    /// one it is attributed to; unattributed, the owner of the item it
    /// continues while that is open, else the owner of the chunk stream
    /// assembling the id, else the owner the rules record for the id, else
    /// the parent's. See the [module docs](self).
    fn explicit_lane(
        &self,
        kind: Kind,
        id: &str,
        tag: &Owner,
        parent: Option<&MessageId>,
    ) -> Owner {
        if tag.is_some() {
            return tag.clone();
        }
        if let Some(owner) = self.owners.open(kind).get(id) {
            return owner.clone();
        }
        if let Some(stream) = self.holder(kind, id) {
            return stream.owner.clone();
        }
        self.owners.recorded(kind, id, parent).flatten()
    }

    /// The lane of `REASONING_START` or `REASONING_END`: the tag, else the
    /// owner recorded for the block's id.
    fn block_lane(&self, id: &MessageId, tag: &Owner) -> Owner {
        if tag.is_some() {
            return tag.clone();
        }
        self.owners
            .recorded(Kind::Reasoning, id.as_str(), None)
            .flatten()
    }

    /// The lane a chunk for `id` is in: the one it is attributed to;
    /// unattributed, the one assembling that id, else the parent's. An
    /// untagged continuation of a subagent's stream is legal on the wire and
    /// must not be read as the parent's.
    fn lane_of(&self, kind: Kind, id: &str, tag: &Owner) -> Owner {
        if tag.is_some() {
            return tag.clone();
        }
        self.holder(kind, id)
            .and_then(|stream| stream.owner.clone())
    }

    fn close_lane(&mut self, owner: &Owner, ended: &mut impl FnMut(Stream)) {
        if let Some(index) = self.open.iter().position(|stream| &stream.owner == owner) {
            ended(self.open.remove(index));
        }
    }

    fn close_id(&mut self, kind: Kind, id: &str, ended: &mut impl FnMut(Stream)) {
        let holds = |stream: &Stream| stream.kind == kind && stream.id == id;
        if let Some(index) = self.open.iter().position(holds) {
            ended(self.open.remove(index));
        }
    }

    fn close_all(&mut self, ended: &mut impl FnMut(Stream)) {
        std::mem::take(&mut self.open).into_iter().for_each(ended);
    }
}

/// The item an explicit start, content or end event belongs to, and the
/// attribution the event carries.
fn item(event: &Event) -> Option<(Kind, &str, &Owner)> {
    Some(match event {
        Event::TextMessageStart(e) => (Kind::Text, e.message_id.as_str(), &e.subagent_run_id),
        Event::TextMessageContent(e) => (Kind::Text, e.message_id.as_str(), &e.subagent_run_id),
        Event::TextMessageEnd(e) => (Kind::Text, e.message_id.as_str(), &e.subagent_run_id),
        Event::ToolCallStart(e) => (Kind::Tool, e.tool_call_id.as_str(), &e.subagent_run_id),
        Event::ToolCallArgs(e) => (Kind::Tool, e.tool_call_id.as_str(), &e.subagent_run_id),
        Event::ToolCallEnd(e) => (Kind::Tool, e.tool_call_id.as_str(), &e.subagent_run_id),
        Event::ReasoningMessageStart(e) => {
            (Kind::Reasoning, e.message_id.as_str(), &e.subagent_run_id)
        }
        Event::ReasoningMessageContent(e) => {
            (Kind::Reasoning, e.message_id.as_str(), &e.subagent_run_id)
        }
        Event::ReasoningMessageEnd(e) => {
            (Kind::Reasoning, e.message_id.as_str(), &e.subagent_run_id)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EventType;

    fn text(id: Option<&str>, delta: &str) -> Event {
        Event::text_message_chunk(id.map(MessageId::new), Some(delta.to_owned()))
    }

    fn expand(events: impl IntoIterator<Item = Event>) -> Result<Vec<EventType>, ChunkError> {
        let mut streams = Streams::default();
        let mut out = Vec::new();
        for event in events {
            streams.expand(event, &mut out)?;
        }
        streams.finish(&mut out);
        Ok(out.iter().map(Event::event_type).collect())
    }

    #[test]
    fn an_explicit_event_for_the_assembled_id_ends_the_stream_rather_than_joining_it() {
        // The end the chunked form owes comes first; the explicit event that
        // follows is the ordering rules' to judge.
        for explicit in [
            Event::text_message_content("m1", "b"),
            Event::text_message_end("m1"),
            Event::text_message_start("m1", TextMessageRole::Assistant),
        ] {
            let kind = explicit.event_type();
            assert_eq!(
                expand([text(Some("m1"), "a"), explicit]).unwrap(),
                [
                    EventType::TextMessageStart,
                    EventType::TextMessageContent,
                    EventType::TextMessageEnd,
                    kind,
                ]
            );
        }
    }

    /// AG-UI 1.0, `events/subagents`: "an untagged continuation continues
    /// whatever the opener owns". Before, the untagged event below was read
    /// as the parent agent's, ended the parent's chunk stream, and the chunk
    /// after it had nothing to continue.
    #[test]
    fn an_untagged_explicit_event_is_in_the_lane_of_whoever_owns_its_item() {
        let s1 = |event: Event| event.with_subagent_run_id("s1");
        let parents = || text(Some("m-p"), "a");
        let continued = || text(None, "b");
        let open = [
            Event::subagent_started("s1", "worker"),
            s1(Event::text_message_start("m-s", TextMessageRole::Assistant)),
            s1(Event::tool_call_start("c-s", "search")),
            s1(Event::reasoning_start("r-s")),
            s1(Event::reasoning_message_start("r-s")),
        ];
        // Each continuation, content or end, of each kind.
        for untagged in [
            Event::text_message_content("m-s", "x"),
            Event::text_message_end("m-s"),
            Event::tool_call_args("c-s", "{}"),
            Event::tool_call_end("c-s"),
            Event::reasoning_message_content("r-s", "hm"),
            Event::reasoning_message_end("r-s"),
        ] {
            let mut events = open.to_vec();
            events.extend([parents(), untagged.clone(), continued()]);
            let out = expanded(events);
            let parents_stream: Vec<_> = out
                .iter()
                .filter(|event| match event {
                    Event::TextMessageContent(e) => e.message_id.as_str() == "m-p",
                    Event::TextMessageEnd(e) => e.message_id.as_str() == "m-p",
                    _ => false,
                })
                .map(Event::event_type)
                .collect();
            assert_eq!(
                parents_stream,
                [
                    EventType::TextMessageContent,
                    EventType::TextMessageContent,
                    EventType::TextMessageEnd,
                ],
                "{untagged:?}: {out:?}"
            );
        }

        // An item that has closed is still its owner's: an untagged start
        // for its id opens it again under that owner, in that lane. So is a
        // reasoning block's end.
        let mut events = vec![
            Event::subagent_started("s1", "worker"),
            s1(Event::text_message_start("m-s", TextMessageRole::Assistant)),
            s1(Event::text_message_end("m-s")),
            s1(Event::reasoning_start("r-s")),
            parents(),
            Event::text_message_start("m-s", TextMessageRole::Assistant),
            Event::reasoning_end("r-s"),
            continued(),
        ];
        assert!(expand(events.clone()).is_ok());
        // Tagged as the parent's, the start is in the parent's lane.
        events[5] = Event::text_message_start("m-p2", TextMessageRole::Assistant);
        assert_eq!(
            expand(events),
            Err(ChunkError::NothingOpen {
                kind: Kind::Text,
                subagent: None
            })
        );
    }

    #[test]
    fn the_lane_of_a_call_is_that_of_the_message_that_carries_it() {
        let s1 = |event: Event| event.with_subagent_run_id("s1");
        let call = crate::ToolCallStartEvent::new("c-1", "search").with_parent_message_id("m-s");
        let events = [
            Event::subagent_started("s1", "worker"),
            s1(Event::text_message_start("m-s", TextMessageRole::Assistant)),
            s1(Event::text_message_end("m-s")),
            text(Some("m-p"), "a"),
            call.into(),
            text(None, "b"),
        ];
        assert!(expand(events).is_ok());
    }

    #[test]
    fn an_explicitly_opened_item_is_not_a_stream_a_chunk_can_continue() {
        let start = || Event::text_message_start("m1", TextMessageRole::Assistant);
        // A chunk that names no id has no chunk stream to continue.
        assert_eq!(
            expand([start(), text(None, "a")]),
            Err(ChunkError::NothingOpen {
                kind: Kind::Text,
                subagent: None
            })
        );
        // One that names the id opens the item again.
        assert_eq!(
            expand([start(), text(Some("m1"), "a")]).unwrap(),
            [
                EventType::TextMessageStart,
                EventType::TextMessageStart,
                EventType::TextMessageContent,
                EventType::TextMessageEnd,
            ]
        );
    }

    #[test]
    fn a_rejected_chunk_leaves_the_model_as_it_was() {
        let mut streams = Streams::default();
        let mut out = Vec::new();
        streams.expand(text(Some("m1"), "a"), &mut out).unwrap();
        let before = out.len();
        let unnamed = Event::tool_call_chunk(Some("c1".into()), None, Some("{}".into()));
        assert_eq!(
            streams.expand(unnamed, &mut out),
            Err(ChunkError::Unnamed { id: "c1".into() })
        );
        assert_eq!(out.len(), before, "nothing was synthesized on the way");
        assert_eq!(
            streams.holder(Kind::Text, "m1").map(|s| &s.owner),
            Some(&None)
        );
    }

    #[test]
    fn tracking_follows_the_same_model_as_expanding() {
        let events = [
            text(Some("m1"), "a").with_subagent_run_id("s1"),
            Event::custom("note", serde_json::json!(1)),
            Event::tool_call_chunk(Some("c1".into()), Some("search".into()), None),
            Event::custom("note", serde_json::json!(1)).with_subagent_run_id("s1"),
        ];
        let mut tracked = Streams::default();
        let mut expanded = Streams::default();
        for event in events {
            tracked.track(&event);
            expanded.expand(event, &mut Vec::new()).unwrap();
            assert_eq!(tracked.open, expanded.open);
        }
        assert_eq!(tracked.open.len(), 1, "the parent's call is still open");
        assert!(tracked.holder(Kind::Tool, "c1").is_some());
    }

    /// One chunk of each kind: opening, with an id and a tool name, or
    /// continuing, with neither.
    fn each_kind(open: bool, delta: Option<&str>) -> [Event; 3] {
        let delta = delta.map(str::to_owned);
        [
            Event::text_message_chunk(open.then(|| "m1".into()), delta.clone()),
            Event::tool_call_chunk(
                open.then(|| "c1".into()),
                open.then(|| "search".into()),
                delta.clone(),
            ),
            Event::reasoning_message_chunk(open.then(|| "r1".into()), delta),
        ]
    }

    fn expanded(events: impl IntoIterator<Item = Event>) -> Vec<Event> {
        let mut streams = Streams::default();
        let mut out = Vec::new();
        for event in events {
            streams.expand(event, &mut out).unwrap();
        }
        streams.finish(&mut out);
        out
    }

    fn delta(event: &Event) -> Option<&str> {
        match event {
            Event::TextMessageContent(e) => Some(&e.delta),
            Event::ToolCallArgs(e) => Some(&e.delta),
            Event::ReasoningMessageContent(e) => Some(&e.delta),
            _ => None,
        }
    }

    fn object(value: Value) -> JsonObject {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn a_continuation_that_carries_only_metadata_stands_for_an_empty_content_event() {
        let finish = object(serde_json::json!({"finishReason": "stop"}));
        for (open, last) in each_kind(true, Some("a"))
            .into_iter()
            .zip(each_kind(false, None))
        {
            let out = expanded([open, last.with_metadata(finish.clone())]);
            let [_, _, content, end] = out.as_slice() else {
                panic!("start, content, content, end: {out:?}");
            };
            assert_eq!(delta(content), Some(""));
            assert_eq!(content.metadata(), Some(&finish));
            assert!(end.base().is_empty(), "an end carries nothing of a chunk");
        }
    }

    #[test]
    fn a_chunk_without_a_delta_stands_for_content_only_when_it_carries_something_for_it() {
        for (open, last) in each_kind(true, Some("a"))
            .into_iter()
            .zip(each_kind(false, None))
        {
            assert_eq!(
                expanded([open, last]).len(),
                3,
                "a bare continuation adds nothing"
            );
        }
        // An opener's metadata rides its start.
        let note = object(serde_json::json!({"k": 1}));
        for open in each_kind(true, None) {
            let out = expanded([open.with_metadata(note.clone())]);
            let [start, _end] = out.as_slice() else {
                panic!("start, end: {out:?}");
            };
            assert_eq!(start.metadata(), Some(&note));
        }
    }

    #[test]
    fn the_synthesized_events_carry_metadata_and_the_raw_event_but_not_the_timestamp() {
        let note = object(serde_json::json!({"k": 1}));
        let raw = serde_json::json!({"provider": "acme"});
        let stamp = |chunk: Event| {
            chunk
                .with_timestamp(1_700_000_000_000)
                .with_raw_event(raw.clone())
                .with_metadata(note.clone())
        };
        let on_start = BaseEvent {
            metadata: Some(note.clone()),
            ..BaseEvent::default()
        };
        let on_content = BaseEvent {
            timestamp: None,
            raw_event: Some(raw.clone()),
            metadata: Some(note.clone()),
        };
        // With a delta or without: the provider payload needs a content event
        // to ride either way.
        for opener in each_kind(true, Some("a"))
            .into_iter()
            .chain(each_kind(true, None))
        {
            let out = expanded([stamp(opener)]);
            let [start, content, end] = out.as_slice() else {
                panic!("start, content, end: {out:?}");
            };
            assert_eq!(start.base(), &on_start);
            assert_eq!(content.base(), &on_content);
            assert!(end.base().is_empty());
        }
        for (open, last) in each_kind(true, Some("a"))
            .into_iter()
            .zip(each_kind(false, None))
        {
            let out = expanded([open, stamp(last)]);
            assert_eq!(delta(&out[2]), Some(""));
            assert_eq!(out[2].base(), &on_content);
        }
    }

    #[test]
    fn the_errors_read_as_sentences() {
        let nothing = ChunkError::NothingOpen {
            kind: Kind::Text,
            subagent: None,
        };
        assert_eq!(
            nothing.to_string(),
            "TEXT_MESSAGE_CHUNK carries no messageId and no message is open as a chunk stream"
        );
        let subagent = ChunkError::NothingOpen {
            kind: Kind::Tool,
            subagent: Some("s3".into()),
        };
        assert_eq!(
            subagent.to_string(),
            r#"TOOL_CALL_CHUNK carries no toolCallId and subagent "s3" has no call open as a chunk stream"#
        );
    }
}
