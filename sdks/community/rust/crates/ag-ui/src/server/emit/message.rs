//! Streaming one text message.

use crate::{Event, MessageId, TextMessageRole};

use crate::server::agent::AgentState;
use crate::server::emit::EventSink;
use crate::server::error::Result;
use crate::server::state::RunState;

/// One open text message.
///
/// Created by [`RunContext::assistant_message`](crate::server::RunContext::assistant_message).
/// `TEXT_MESSAGE_START` has already gone out by the time you hold one; `Drop`
/// emits `TEXT_MESSAGE_END` if [`end`](Self::end) was not called.
///
/// ```
/// # use ag_ui::RunAgentInput;
/// # use ag_ui::server::RunContext;
/// # let (mut ctx, mut events) = RunContext::<()>::new(RunAgentInput::new("t", "r"))?;
/// let mut message = ctx.assistant_message()?;
/// for word in ["Hello", ", ", "world"] {
///     message.delta(word)?;
/// }
/// message.end()?;
/// assert_eq!(events.drain().len(), 5);
/// # Ok::<(), ag_ui::server::Error>(())
/// ```
#[derive(Debug)]
pub struct MessageHandle<'a, S> {
    sink: &'a mut EventSink,
    state: &'a mut RunState<S>,
    id: MessageId,
    ended: bool,
}

impl<'a, S> MessageHandle<'a, S> {
    /// Emits `TEXT_MESSAGE_START` and takes the message.
    ///
    /// Returns `Err` without producing a handle when the start could not be
    /// emitted, so a failed open never leaves a terminator to be emitted for a
    /// message that does not exist.
    pub(crate) fn start(
        sink: &'a mut EventSink,
        state: &'a mut RunState<S>,
        id: MessageId,
        role: TextMessageRole,
    ) -> Result<Self> {
        sink.emit(Event::text_message_start(id.clone(), role))?;
        Ok(Self {
            sink,
            state,
            id,
            ended: false,
        })
    }

    /// The id every event of this message carries.
    pub fn id(&self) -> &MessageId {
        &self.id
    }

    /// Appends text — `TEXT_MESSAGE_CONTENT`.
    ///
    /// No `.await`: see the [module docs](crate::server::emit) for why the emit path is
    /// synchronous.
    pub fn delta(&mut self, text: impl Into<String>) -> Result<()> {
        self.sink
            .emit(Event::text_message_content(self.id.clone(), text))
    }

    /// Emits an unrelated event without closing the message.
    ///
    /// For the unordered families — `STATE_*`, `ACTIVITY_*`, `CUSTOM`, `RAW` —
    /// which may legally interleave with a message. Raw events can open another message with a different ID. The caller must
    /// maintain its lifecycle; the verifier checks IDs and ordering.
    pub fn emit(&mut self, event: Event) -> Result<()> {
        self.sink.emit(event)
    }

    /// Emits `TEXT_MESSAGE_END` and consumes the handle.
    ///
    /// Only worth calling over letting the handle drop when you want to see the
    /// error: `Drop` cannot report one.
    pub fn end(mut self) -> Result<()> {
        self.ended = true;
        self.sink.emit(Event::text_message_end(self.id.clone()))
    }
}

/// The run's state, reachable while the message is open — an agent that
/// narrates what it is doing changes both in the same breath. See
/// [`ToolCallHandle`](crate::server::ToolCallHandle), where this matters most.
impl<S: AgentState> MessageHandle<'_, S> {
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
    /// `STATE_SNAPSHOT` or a `STATE_DELTA` inside this message's brackets.
    ///
    /// A no-op when nothing changed since the last publish.
    pub fn publish_state(&mut self) -> Result<()> {
        self.state.publish(self.sink)
    }
}

impl<S> Drop for MessageHandle<'_, S> {
    fn drop(&mut self) {
        if !self.ended {
            // Nowhere to report a failure to; a dead channel or a cancelled run
            // makes the terminator moot anyway.
            let _ = self.sink.emit(Event::text_message_end(self.id.clone()));
        }
    }
}
