//! Streaming one reasoning block.

use crate::{Event, MessageId, ReasoningEncryptedValueSubtype};

use crate::server::agent::AgentState;
use crate::server::emit::EventSink;
use crate::server::error::Result;
use crate::server::state::RunState;

/// One open reasoning block.
///
/// Created by [`RunContext::reasoning`](crate::server::RunContext::reasoning). The
/// `REASONING_*` family nests a message inside a block, so the handle brackets
/// four events rather than two:
///
/// ```text
/// REASONING_START          ← on creation
/// REASONING_MESSAGE_START  ← on creation
/// REASONING_MESSAGE_CONTENT × n
/// REASONING_MESSAGE_END    ← on end() or Drop
/// REASONING_END            ← on end() or Drop
/// ```
///
/// Use it for model reasoning you want the client to render. Reasoning a
/// provider returns only as an opaque blob goes through
/// [`encrypted_value`](Self::encrypted_value) instead.
#[derive(Debug)]
pub struct ReasoningHandle<'a, S> {
    sink: &'a mut EventSink,
    state: &'a mut RunState<S>,
    id: MessageId,
    ended: bool,
}

impl<'a, S> ReasoningHandle<'a, S> {
    /// Emits `REASONING_START` and `REASONING_MESSAGE_START`.
    pub(crate) fn start(
        sink: &'a mut EventSink,
        state: &'a mut RunState<S>,
        id: MessageId,
    ) -> Result<Self> {
        sink.emit(Event::reasoning_start(id.clone()))?;
        // The block is open now, so from here on a failure must still leave a
        // handle behind to close it.
        let handle = Self {
            sink,
            state,
            id,
            ended: false,
        };
        handle
            .sink
            .emit(Event::reasoning_message_start(handle.id.clone()))?;
        Ok(handle)
    }

    /// The id every event of this block carries.
    pub fn id(&self) -> &MessageId {
        &self.id
    }

    /// Appends reasoning text — `REASONING_MESSAGE_CONTENT`.
    pub fn delta(&mut self, text: impl Into<String>) -> Result<()> {
        self.sink
            .emit(Event::reasoning_message_content(self.id.clone(), text))
    }

    /// Attaches the provider's opaque reasoning signature —
    /// `REASONING_ENCRYPTED_VALUE`.
    ///
    /// Under zero-data-retention the provider returns no readable reasoning,
    /// only a blob that must be replayed on the next request for the model to
    /// stay coherent.
    pub fn encrypted_value(&mut self, value: impl Into<String>) -> Result<()> {
        self.sink.emit(Event::reasoning_encrypted_value(
            ReasoningEncryptedValueSubtype::Message,
            self.id.clone(),
            value,
        ))
    }

    /// Emits an unrelated event without closing the block. See
    /// [`MessageHandle::emit`](crate::server::MessageHandle::emit).
    pub fn emit(&mut self, event: Event) -> Result<()> {
        self.sink.emit(event)
    }

    /// Emits `REASONING_MESSAGE_END` then `REASONING_END`, and consumes the
    /// handle.
    pub fn end(mut self) -> Result<()> {
        self.ended = true;
        self.close()
    }

    /// Closes both halves. The block terminator is attempted even when the
    /// message terminator failed, so a half-open block cannot outlive the
    /// handle.
    fn close(&mut self) -> Result<()> {
        let message = self
            .sink
            .emit(Event::reasoning_message_end(self.id.clone()));
        let block = self.sink.emit(Event::reasoning_end(self.id.clone()));
        message.and(block)
    }
}

/// The run's state, reachable while the block is open. See
/// [`ToolCallHandle`](crate::server::ToolCallHandle), where this matters most.
impl<S: AgentState> ReasoningHandle<'_, S> {
    /// The typed state, as of the last publish.
    pub fn state(&self) -> &S {
        self.state.get()
    }

    /// The typed state, mutably. Nothing is emitted until you call
    /// [`publish_state`](Self::publish_state).
    pub fn state_mut(&mut self) -> &mut S {
        self.state.get_mut()
    }

    /// Publishes whatever [`state_mut`](Self::state_mut) left behind, as a
    /// `STATE_SNAPSHOT` or a `STATE_DELTA` inside this block's brackets.
    ///
    /// A no-op when nothing changed since the last publish.
    pub fn publish_state(&mut self) -> Result<()> {
        self.state.publish(self.sink)
    }
}

impl<S> Drop for ReasoningHandle<'_, S> {
    fn drop(&mut self) {
        if !self.ended {
            let _ = self.close();
        }
    }
}
