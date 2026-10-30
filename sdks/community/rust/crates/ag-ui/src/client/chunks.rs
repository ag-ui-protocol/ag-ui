//! Normalizing `*_CHUNK` events into explicit start/content/end triples.
//!
//! A producer that cannot bracket its output — most provider adapters, because
//! the upstream API does not tell them a message has ended until the next one
//! begins — sends `TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK` and
//! `REASONING_MESSAGE_CHUNK` instead. Those events fold start, content and end
//! into one, and they carry their id and name **only on the first chunk**:
//!
//! ```text
//! TEXT_MESSAGE_CHUNK { messageId: "msg-1", delta: "Hel" }
//! TEXT_MESSAGE_CHUNK { delta: "lo" }
//! TEXT_MESSAGE_CHUNK { messageId: "msg-2", delta: "Bye" }   <- msg-1 just ended
//! ```
//!
//! So the id has to be remembered, and the end of one stream is only knowable
//! from the start of the next — or from the end of the run. That bookkeeping is
//! this module.
//!
//! ```
//! use ag_ui::client::chunks::normalize_all;
//! use ag_ui::{Event, EventType, MessageId};
//!
//! let events = normalize_all([
//!     Event::text_message_chunk(Some(MessageId::new("msg-1")), Some("Hel".into())),
//!     Event::text_message_chunk(None, Some("lo".into())),
//! ])?;
//!
//! let types: Vec<EventType> = events.iter().map(Event::event_type).collect();
//! assert_eq!(types, [
//!     EventType::TextMessageStart,
//!     EventType::TextMessageContent,
//!     EventType::TextMessageContent,
//!     EventType::TextMessageEnd,
//! ]);
//! # Ok::<(), ag_ui::client::Error>(())
//! ```
//!
//! # Subagents
//!
//! "The previous chunk" is only meaningful *per subagent* once several stream
//! at once, so the shorthand resolves within the sending subagent's own
//! stream: one stream may be open per owner, and a chunk that names no id
//! continues the stream of the subagent it is attributed to. A chunk that
//! carries neither an id nor a `subagentRunId` continues the parent's open
//! stream when there is one, and otherwise the sole open stream; when several
//! subagents' streams could all claim it there is nothing to resolve it
//! against, and it is rejected rather than guessed at. When streaming
//! concurrently, attribute every chunk — or repeat the id.

use crate::{
    Event, MessageId, ReasoningMessageChunkEvent, SubagentRunId, TextMessageChunkEvent,
    TextMessageStartEvent, ToolCallChunkEvent, ToolCallId, ToolCallStartEvent,
};

use crate::client::error::{Error, Result};

/// Which family of stream is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
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

/// A stream in flight. At most one per owner: a new stream from the same
/// owner is what ends the previous one.
#[derive(Clone, Debug)]
struct Open {
    kind: Kind,
    /// The message id or tool call id, as a plain string.
    id: String,
    /// Whether this normalizer emitted the opening event and therefore owes the
    /// closing one. Streams the producer opened explicitly close themselves.
    owed: bool,
    /// The subagent the stream belongs to; `None` for the parent agent.
    owner: Option<SubagentRunId>,
}

/// Expands chunk events into the explicit events the rest of the protocol is
/// written in.
///
/// Feed every event of a run through it, in order, and apply what comes out.
/// Events that are not chunks pass through untouched — but they are still
/// *observed*, so that an explicitly opened message can absorb a following
/// bare chunk, and so an explicit end is not duplicated.
#[derive(Clone, Debug, Default)]
pub struct ChunkNormalizer {
    open: Vec<Open>,
}

impl ChunkNormalizer {
    /// A normalizer with nothing open.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether any stream is currently open.
    pub fn is_open(&self) -> bool {
        !self.open.is_empty()
    }

    /// Expands one event, appending the result to `out`.
    ///
    /// Appends between zero and three events: the synthesized end of the
    /// previous stream, the synthesized start of this one, and the content.
    ///
    /// # Errors
    ///
    /// A chunk that names no stream and has none to continue — none open, or
    /// several subagents' open and no attribution to pick one — or a tool call
    /// chunk that opens a call without naming the tool, is a protocol
    /// violation: there is no id to attach the payload to, and guessing one
    /// would put text in the wrong message.
    pub fn normalize(&mut self, event: Event, out: &mut Vec<Event>) -> Result<()> {
        match event {
            Event::TextMessageChunk(chunk) => self.text_chunk(chunk, out),
            Event::ToolCallChunk(chunk) => self.tool_chunk(chunk, out),
            Event::ReasoningMessageChunk(chunk) => self.reasoning_chunk(chunk, out),
            other => {
                self.observe(&other, out);
                out.push(other);
                Ok(())
            }
        }
    }

    /// Closes whatever the normalizer opened but never got to end.
    ///
    /// Call this when the transport stream ends. A chunk stream that never
    /// terminates is the normal case, not an error: the last message of a run
    /// has nothing after it to imply its end.
    pub fn finish(&mut self, out: &mut Vec<Event>) {
        self.close_all(out);
    }

    // ---- chunk families -------------------------------------------------

    /// The stream a chunk belongs to: the one it names, or the open one of its
    /// kind that its attribution resolves to.
    fn stream_id(
        &self,
        kind: Kind,
        named: Option<&str>,
        tag: &Option<SubagentRunId>,
    ) -> Result<String> {
        if let Some(id) = named {
            return Ok(id.to_owned());
        }
        let missing = |why: String| {
            Error::protocol(format!(
                "{} carries no {} and {why}",
                kind.chunk_name(),
                kind.id_name()
            ))
        };
        if tag.is_some() {
            return self.current(kind, tag).ok_or_else(|| {
                missing(format!(
                    "subagent {:?} has no {} open",
                    tag.as_ref().map(|id| id.as_str()).unwrap_or_default(),
                    kind.noun()
                ))
            });
        }
        if let Some(id) = self.current(kind, &None) {
            return Ok(id);
        }
        let mut of_kind = self.open.iter().filter(|open| open.kind == kind);
        match (of_kind.next(), of_kind.next()) {
            (Some(only), None) => Ok(only.id.clone()),
            (None, _) => Err(missing(format!("no {} is open", kind.noun()))),
            (Some(_), Some(_)) => Err(missing(format!(
                "several subagents have a {} open; attribute the chunk",
                kind.noun()
            ))),
        }
    }

    /// Closes the owner's open stream, emits `start`, and takes on the debt
    /// for the matching end event.
    fn begin(
        &mut self,
        kind: Kind,
        id: &str,
        owner: Option<SubagentRunId>,
        start: Event,
        out: &mut Vec<Event>,
    ) {
        self.close_owner(&owner, out);
        out.push(start);
        self.open.push(Open {
            kind,
            id: id.to_owned(),
            owed: true,
            owner,
        });
    }

    fn text_chunk(&mut self, chunk: TextMessageChunkEvent, out: &mut Vec<Event>) -> Result<()> {
        let id = MessageId::new(self.stream_id(
            Kind::Text,
            chunk.message_id.as_ref().map(MessageId::as_str),
            &chunk.subagent_run_id,
        )?);

        let owner = self.owner_of(Kind::Text, id.as_str(), &chunk.subagent_run_id);
        if self.current(Kind::Text, &owner).as_deref() != Some(id.as_str()) {
            let mut start = TextMessageStartEvent::new(id.clone(), chunk.role.unwrap_or_default());
            start.name = chunk.name;
            start.base = chunk.base.clone();
            start.subagent_run_id = owner.clone();
            self.begin(Kind::Text, id.as_str(), owner.clone(), start.into(), out);
        }

        if let Some(delta) = chunk.delta {
            let mut content = crate::TextMessageContentEvent::new(id, delta);
            content.base = chunk.base;
            content.subagent_run_id = owner;
            out.push(content.into());
        }
        Ok(())
    }

    fn tool_chunk(&mut self, chunk: ToolCallChunkEvent, out: &mut Vec<Event>) -> Result<()> {
        let id = ToolCallId::new(self.stream_id(
            Kind::Tool,
            chunk.tool_call_id.as_ref().map(ToolCallId::as_str),
            &chunk.subagent_run_id,
        )?);

        let owner = self.owner_of(Kind::Tool, id.as_str(), &chunk.subagent_run_id);
        if self.current(Kind::Tool, &owner).as_deref() != Some(id.as_str()) {
            // Checked before anything is emitted: a call with no name cannot be
            // opened, and the previous stream should not be closed on the way
            // to finding that out.
            let Some(name) = chunk.tool_call_name else {
                return Err(Error::protocol(format!(
                    "TOOL_CALL_CHUNK opens tool call {id:?} without a toolCallName"
                )));
            };
            let mut start = ToolCallStartEvent::new(id.clone(), name);
            start.parent_message_id = chunk.parent_message_id;
            start.base = chunk.base.clone();
            start.subagent_run_id = owner.clone();
            self.begin(Kind::Tool, id.as_str(), owner.clone(), start.into(), out);
        }

        if let Some(delta) = chunk.delta {
            let mut args = crate::ToolCallArgsEvent::new(id, delta);
            args.base = chunk.base;
            args.subagent_run_id = owner;
            out.push(args.into());
        }
        Ok(())
    }

    fn reasoning_chunk(
        &mut self,
        chunk: ReasoningMessageChunkEvent,
        out: &mut Vec<Event>,
    ) -> Result<()> {
        let id = MessageId::new(self.stream_id(
            Kind::Reasoning,
            chunk.message_id.as_ref().map(MessageId::as_str),
            &chunk.subagent_run_id,
        )?);

        let owner = self.owner_of(Kind::Reasoning, id.as_str(), &chunk.subagent_run_id);
        if self.current(Kind::Reasoning, &owner).as_deref() != Some(id.as_str()) {
            let mut start = crate::ReasoningMessageStartEvent::new(id.clone());
            start.base = chunk.base.clone();
            start.subagent_run_id = owner.clone();
            self.begin(
                Kind::Reasoning,
                id.as_str(),
                owner.clone(),
                start.into(),
                out,
            );
        }

        if let Some(delta) = chunk.delta {
            let mut content = crate::ReasoningMessageContentEvent::new(id, delta);
            content.base = chunk.base;
            content.subagent_run_id = owner;
            out.push(content.into());
        }
        Ok(())
    }

    // ---- explicit events ------------------------------------------------

    /// Tracks what an explicit (non-chunk) event does to the open streams.
    ///
    /// Only events that belong to a stream, the one that answers a tool call,
    /// and the two that end a run touch them: a `STATE_DELTA` between two chunks
    /// of one message must not split that message in half.
    fn observe(&mut self, event: &Event, out: &mut Vec<Event>) {
        match event {
            Event::TextMessageStart(e) => {
                self.open_explicit(Kind::Text, e.message_id.as_str(), &e.subagent_run_id, out);
            }
            Event::TextMessageContent(e) => {
                self.open_explicit(Kind::Text, e.message_id.as_str(), &e.subagent_run_id, out);
            }
            Event::TextMessageEnd(e) => self.close_explicit(Kind::Text, e.message_id.as_str()),

            Event::ToolCallStart(e) => {
                self.open_explicit(Kind::Tool, e.tool_call_id.as_str(), &e.subagent_run_id, out);
            }
            Event::ToolCallArgs(e) => {
                self.open_explicit(Kind::Tool, e.tool_call_id.as_str(), &e.subagent_run_id, out);
            }
            Event::ToolCallEnd(e) => self.close_explicit(Kind::Tool, e.tool_call_id.as_str()),
            // A result answers a call, so the call is over — and the protocol
            // puts `TOOL_CALL_END` before it. A chunk-streamed call has no end
            // of its own, so without this the result overtakes the terminator
            // this normalizer still owes. It also ends whatever else its owner
            // had streaming: a result cannot interleave with an open message
            // either, and the party answering has clearly moved on.
            Event::ToolCallResult(e) => {
                self.close_id(Kind::Tool, e.tool_call_id.as_str(), out);
                self.close_owner(&e.subagent_run_id, out);
            }

            Event::ReasoningMessageStart(e) => {
                self.open_explicit(
                    Kind::Reasoning,
                    e.message_id.as_str(),
                    &e.subagent_run_id,
                    out,
                );
            }
            Event::ReasoningMessageContent(e) => {
                self.open_explicit(
                    Kind::Reasoning,
                    e.message_id.as_str(),
                    &e.subagent_run_id,
                    out,
                );
            }
            Event::ReasoningMessageEnd(e) => {
                self.close_explicit(Kind::Reasoning, e.message_id.as_str());
            }
            // A reasoning block closing implies its message has closed.
            Event::ReasoningEnd(e) => self.close_id(Kind::Reasoning, e.message_id.as_str(), out),
            Event::RunFinished(_) | Event::RunError(_) => self.close_all(out),
            _ => {}
        }
    }

    /// An explicit event for a stream: closes the owner's other open stream,
    /// then takes ownership of this one. Nothing is owed — a stream the
    /// producer opened, the producer ends.
    ///
    /// An explicit event for the stream *this* normalizer opened leaves the
    /// debt in place: the end is still owed until the producer sends one.
    fn open_explicit(
        &mut self,
        kind: Kind,
        id: &str,
        tag: &Option<SubagentRunId>,
        out: &mut Vec<Event>,
    ) {
        let owner = self.owner_of(kind, id, tag);
        if self.current(kind, &owner).as_deref() != Some(id) {
            self.close_owner(&owner, out);
            self.open.push(Open {
                kind,
                id: id.to_owned(),
                owed: false,
                owner,
            });
        }
    }

    /// The producer ended a stream itself: forget it without emitting.
    fn close_explicit(&mut self, kind: Kind, id: &str) {
        self.open
            .retain(|open| !(open.kind == kind && open.id == id));
    }

    // ---- bookkeeping ----------------------------------------------------

    /// The owner an event's stream belongs to: the event's tag when it has
    /// one, otherwise the owner of the stream already open under that id,
    /// otherwise the parent agent. An untagged continuation of a subagent's
    /// chunk stream is legal on the wire and must not be read as the parent's.
    fn owner_of(&self, kind: Kind, id: &str, tag: &Option<SubagentRunId>) -> Option<SubagentRunId> {
        if tag.is_some() {
            return tag.clone();
        }
        self.open
            .iter()
            .find(|open| open.kind == kind && open.id == id)
            .and_then(|open| open.owner.clone())
    }

    /// The id of `owner`'s open stream, if it is of this kind.
    fn current(&self, kind: Kind, owner: &Option<SubagentRunId>) -> Option<String> {
        self.open
            .iter()
            .find(|open| &open.owner == owner)
            .filter(|open| open.kind == kind)
            .map(|open| open.id.clone())
    }

    /// Emits the end event for `owner`'s open stream, if this normalizer owes
    /// one.
    fn close_owner(&mut self, owner: &Option<SubagentRunId>, out: &mut Vec<Event>) {
        if let Some(index) = self.open.iter().position(|open| &open.owner == owner) {
            let open = self.open.remove(index);
            Self::settle(open, out);
        }
    }

    /// Closes the stream with this id, whoever owns it.
    fn close_id(&mut self, kind: Kind, id: &str, out: &mut Vec<Event>) {
        if let Some(index) = self
            .open
            .iter()
            .position(|open| open.kind == kind && open.id == id)
        {
            let open = self.open.remove(index);
            Self::settle(open, out);
        }
    }

    fn close_all(&mut self, out: &mut Vec<Event>) {
        for open in std::mem::take(&mut self.open) {
            Self::settle(open, out);
        }
    }

    /// Emits the end this normalizer owes for a stream, carrying the stream's
    /// attribution.
    fn settle(open: Open, out: &mut Vec<Event>) {
        if !open.owed {
            return;
        }
        let mut end = match open.kind {
            Kind::Text => Event::text_message_end(MessageId::new(open.id)),
            Kind::Tool => Event::tool_call_end(ToolCallId::new(open.id)),
            Kind::Reasoning => Event::reasoning_message_end(MessageId::new(open.id)),
        };
        if let Some(owner) = open.owner {
            end.set_subagent_run_id(owner);
        }
        out.push(end);
    }
}

/// Normalizes a whole run in one call, closing anything left open at the end.
///
/// The streaming form is [`ChunkNormalizer`]; this is the convenience for
/// tests, recorded streams, and anything else that has all the events already.
pub fn normalize_all(events: impl IntoIterator<Item = Event>) -> Result<Vec<Event>> {
    let mut normalizer = ChunkNormalizer::new();
    let mut out = Vec::new();
    for event in events {
        normalizer.normalize(event, &mut out)?;
    }
    normalizer.finish(&mut out);
    Ok(out)
}
