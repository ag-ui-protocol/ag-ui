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
//! from what follows it. That bookkeeping is this module.
//!
//! # What ends a chunk stream
//!
//! AG-UI 1.0 lists it, per *lane* — the parent agent's, or one subagent's:
//!
//! - a chunk that opens a different item in the same lane;
//! - a message, tool-call, step, state, custom or reasoning event in that
//!   lane. `RAW`, `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`,
//!   `REASONING_ENCRYPTED_VALUE` and `SUBAGENT_STARTED` stand aside and end
//!   nothing;
//! - `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` or `MESSAGES_SNAPSHOT`, which
//!   end every lane's;
//! - `SUBAGENT_FINISHED` or `SUBAGENT_ERROR`, which end that subagent's.
//!
//! A chunk that names no id after one of these has nothing to continue, and is
//! rejected. So is a continuation that repeats `role`, `name`, `toolCallName`
//! or `parentMessageId` with a value other than the one its stream was opened
//! with — an absent `role` having opened an `assistant` message.
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
//! # What the synthesized events carry
//!
//! A chunk's `metadata` goes on every event synthesized from it, so it merges
//! into the item; its `rawEvent` goes on the content event; its `timestamp` on
//! none, since the synthesized events are not the chunk. A continuation that
//! carries only metadata, such as a final chunk reporting a finish reason,
//! stands for a content event with an empty delta, which is how the metadata
//! reaches the item. So does a chunk that carries a `rawEvent` and no delta.
//!
//! ```
//! use ag_ui::client::chunks::normalize_all;
//! use ag_ui::{Event, MessageId};
//! use serde_json::json;
//!
//! let finish = json!({ "finishReason": "stop" }).as_object().unwrap().clone();
//! let events = normalize_all([
//!     Event::text_message_chunk(Some(MessageId::new("msg-1")), Some("Done.".into())),
//!     Event::text_message_chunk(None, None).with_metadata(finish.clone()),
//! ])?;
//!
//! let Event::TextMessageContent(last) = &events[2] else { panic!("{events:?}") };
//! assert_eq!(last.delta, "");
//! assert_eq!(last.base.metadata, Some(finish));
//! # Ok::<(), ag_ui::client::Error>(())
//! ```
//!
//! # The two spellings do not mix
//!
//! An item opened by a chunk is continued and closed in chunk form, and one
//! opened by a `*_START` event explicitly. An explicit event that names the id
//! a chunk stream is assembling is in that stream's lane like any other, so it
//! ends the stream: the synthesized end comes out first, then the event,
//! which [`crate::client::verify`] judges by the rules of the explicit form.
//! The other way round, an explicitly opened item is not a stream a chunk can
//! continue: a chunk that names no id is rejected unless a *chunk* opened
//! something for it to continue, and one that names the open item's id opens
//! it again.
//!
//! ```
//! use ag_ui::client::{normalize_all, verify_all};
//! use ag_ui::{Event, EventType, MessageId};
//!
//! let events = normalize_all([
//!     Event::run_started("thread-1", "run-1"),
//!     Event::text_message_chunk(Some(MessageId::new("msg-1")), Some("Hel".into())),
//!     Event::text_message_end("msg-1"),
//! ])?;
//! let types: Vec<EventType> = events.iter().map(Event::event_type).collect();
//! // The chunk stream ended when the explicit event arrived ...
//! assert_eq!(types[3..], [EventType::TextMessageEnd, EventType::TextMessageEnd]);
//! // ... so that event closes a message that is no longer open.
//! assert!(verify_all(&events).is_err());
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

use crate::Event;
use crate::streams::Streams;

use crate::client::error::{Error, Result};

/// Expands chunk events into the explicit events the rest of the protocol is
/// written in.
///
/// Feed every event of a run through it, in order, and apply what comes out.
/// Events that are not chunks pass through untouched, after the end of
/// whatever chunk stream they close.
#[derive(Clone, Debug, Default)]
pub struct ChunkNormalizer {
    streams: Streams,
}

impl ChunkNormalizer {
    /// A normalizer with nothing open.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a chunk stream is currently open: one a chunk opened and
    /// nothing has ended yet.
    pub fn is_open(&self) -> bool {
        !self.streams.is_idle()
    }

    /// Expands one event, appending the result to `out`.
    ///
    /// Appends the synthesized end of each stream the event closes, then for
    /// a chunk the synthesized start of the stream it opens and its content,
    /// and for any other event the event itself.
    ///
    /// # Errors
    ///
    /// A chunk that names no stream and has none to continue — none open, or
    /// several subagents' open and no attribution to pick one — or a tool call
    /// chunk that opens a call without naming the tool, is a protocol
    /// violation: there is no id to attach the payload to, and guessing one
    /// would put text in the wrong message. So is a continuation chunk that
    /// contradicts what its stream was opened with. Nothing is appended and
    /// nothing changes when a chunk is rejected.
    pub fn normalize(&mut self, event: Event, out: &mut Vec<Event>) -> Result<()> {
        self.streams
            .expand(event, out)
            .map_err(|error| Error::protocol(error.to_string()))
    }

    /// Closes whatever the normalizer opened but never got to end.
    ///
    /// Call this when the transport stream ends. A chunk stream that never
    /// terminates is the normal case, not an error: the last message of a run
    /// has nothing after it to imply its end.
    pub fn finish(&mut self, out: &mut Vec<Event>) {
        self.streams.finish(out);
    }

    /// Drops what is being assembled without ending it, for a run that
    /// failed: what it had open ends with it. Whose each item is stays
    /// known, for the lane of an untagged event of a later run.
    pub(crate) fn abandon(&mut self) {
        self.streams.abandon();
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
