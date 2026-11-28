//! Turning a stream of events into materialised state.
//!
//! Consuming AG-UI is not "read a response". The agent sends deltas — a message
//! opens, text arrives a fragment at a time, tool arguments accumulate as
//! unparseable JSON fragments, state moves by RFC 6902 patch. [`Applier`] is the
//! state machine that folds all of that back into something a UI can draw:
//! a message list, reasoning and activities included, and a JSON state
//! document.
//!
//! It is a plain synchronous struct. No async, no runtime, no I/O — feed it
//! events from anywhere.
//!
//! ```
//! # #[cfg(feature = "client")]
//! # fn main() -> Result<(), ag_ui::client::Error> {
//! use ag_ui::client::apply::Applier;
//! use ag_ui::{Event, TextMessageRole};
//!
//! let mut applier = Applier::new();
//! for event in [
//!     Event::run_started("thread-1", "run-1"),
//!     Event::text_message_start("msg-1", TextMessageRole::Assistant),
//!     Event::text_message_content("msg-1", "Hello, "),
//!     Event::text_message_content("msg-1", "world"),
//!     Event::text_message_end("msg-1"),
//!     Event::run_finished_success("thread-1", "run-1"),
//! ] {
//!     applier.apply(&event)?;
//! }
//!
//! assert_eq!(applier.messages().len(), 1);
//! assert_eq!(applier.text_of("msg-1"), Some("Hello, world"));
//! # Ok(())
//! # }
//! # #[cfg(not(feature = "client"))]
//! # fn main() {}
//! ```
//!
//! # What it does not do
//!
//! The applier is *tolerant*: an orphan `TEXT_MESSAGE_CONTENT` opens a message
//! rather than failing, because a half-drawn conversation beats a blank screen.
//! Catching the producer's mistake is [`crate::client::verify`]'s job, and
//! [`crate::client::Thread`] runs both. The one thing the applier refuses to do
//! quietly is corrupt state: a patch that does not apply is an error.
//!
//! It applies the explicit form of the protocol only. A `*_CHUNK` event
//! stands for a start, content and an end that depend on what came before it,
//! and a retired `THINKING_*` event for a `REASONING_*` one; expanding the
//! first is [`crate::client::chunks`]'s job and translating the second is the
//! compatibility boundary's
//! ([`TransportStream::into_events`](crate::client::transport::TransportStream::into_events),
//! [`enforce_events`](crate::client::transport::enforce_events)). Both run
//! before the applier in a [`Thread`](crate::client::Thread). Handed one
//! directly, [`Applier::apply`] returns [`Error::Unsupported`] and changes
//! nothing.

// The THINKING_* events are deprecated, and this module has to name them to
// refuse them. Downstream users still get the warnings.
#![allow(deprecated)]

use std::collections::HashMap;

use crate::{
    ActivityDeltaEvent, ActivityMessage, ActivitySnapshotEvent, AssistantMessage, DeveloperMessage,
    Event, InputContent, Interrupt, JsonObject, Message, MessageId, PatchOperation,
    ReasoningEncryptedValueEvent, ReasoningEncryptedValueSubtype, ReasoningMessage, RunId,
    RunOutcome, SubagentErrorEvent, SubagentFinishedEvent, SubagentOutcome, SubagentRunId,
    SubagentStartedEvent, SystemMessage, TextInputContent, TextMessageRole, ThreadId, ToolCall,
    ToolCallId, ToolContent, ToolMessage, UserContent, UserMessage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::error::{Error, Result};
use crate::metadata::merge_metadata_into;

/// What one event changed.
///
/// Returned by [`Applier::apply`] so a UI can redraw one row instead of the
/// whole conversation. Every variant that names a message carries its index
/// into [`Applier::messages`].
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum Changed {
    /// Nothing a view would redraw: `STEP_*`, `RAW`, `CUSTOM`, a reasoning
    /// span (`REASONING_START`, `REASONING_END`), or an event whose target
    /// does not exist.
    Nothing,
    /// One message was created, appended to, or completed.
    Message(MessageChange),
    /// `MESSAGES_SNAPSHOT` replaced the whole list. Messages may have been
    /// removed, so a view must redraw all of it.
    MessagesReplaced,
    /// The application state was replaced or patched.
    State,
    /// A `REASONING_MESSAGE_*` event created, appended to or completed a
    /// message, or a reasoning message took an encrypted value. The message
    /// is in [`Applier::messages`] like any other. The variant is its own so
    /// that a view can draw reasoning apart from the reply, or leave it out.
    Reasoning(ReasoningChange),
    /// A subagent was announced, resumed, finished, suspended or failed. What
    /// it *produces* arrives as ordinary message and reasoning changes,
    /// carrying its id; this is the lifecycle. See [`Applier::subagents`].
    Subagent(SubagentChange),
    /// `RUN_STARTED`.
    RunStarted {
        /// The conversation the run belongs to.
        thread_id: ThreadId,
        /// The run that started.
        run_id: RunId,
    },
    /// `RUN_FINISHED`. An absent outcome is reported as
    /// [`RunOutcome::Success`], which is what the protocol says it means.
    RunFinished {
        /// How the run ended.
        outcome: RunOutcome,
        /// The agent's return value, if it sent one.
        result: Option<Value>,
    },
    /// `RUN_ERROR`.
    RunError {
        /// What went wrong, for a human.
        message: String,
        /// The machine-readable code, when the agent sent one.
        code: Option<String>,
    },
}

/// Which message changed, and how.
///
/// `#[non_exhaustive]`: read the fields, match with `..`, and build one, to
/// compare with what [`Applier::apply`] returned, with [`MessageChange::new`].
///
/// ```
/// # #[cfg(feature = "client")]
/// # fn main() -> Result<(), ag_ui::client::Error> {
/// use ag_ui::client::apply::{Applier, Changed, MessageChange, MessageChangeKind};
/// use ag_ui::{Event, TextMessageRole};
///
/// let mut applier = Applier::new();
/// let started = applier.apply(&Event::text_message_start("m-1", TextMessageRole::Assistant))?;
/// assert_eq!(
///     started,
///     Changed::Message(MessageChange::new(0, "m-1", MessageChangeKind::Started))
/// );
/// # Ok(())
/// # }
/// # #[cfg(not(feature = "client"))]
/// # fn main() {}
/// ```
///
/// A struct literal does not compile outside this crate:
///
/// ```compile_fail,E0639
/// use ag_ui::client::apply::{MessageChange, MessageChangeKind};
///
/// let change = MessageChange { index: 0, id: "m-1".into(), kind: MessageChangeKind::Ended };
/// ```
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct MessageChange {
    /// Index into [`Applier::messages`].
    pub index: usize,
    /// The message's id.
    pub id: MessageId,
    /// What happened to it.
    pub kind: MessageChangeKind,
}

impl MessageChange {
    /// A change of `kind` to the message `id`, at `index` of
    /// [`Applier::messages`].
    pub fn new(index: usize, id: impl Into<MessageId>, kind: MessageChangeKind) -> Self {
        Self {
            index,
            id: id.into(),
            kind,
        }
    }
}

/// What happened to a message.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum MessageChangeKind {
    /// Local consumption stopped before the producer completed this message.
    Aborted,
    /// The message was created and is now open for content.
    Started,
    /// Text was appended.
    Content {
        /// The text this event appended.
        delta: String,
    },
    /// The message was closed; no more content will arrive for it.
    Ended,
    /// A tool call was attached to the message. Several can be open at once —
    /// a model asking for two things at once opens two.
    ToolCallStarted {
        /// The call's id.
        tool_call_id: ToolCallId,
        /// The tool being called.
        name: String,
    },
    /// Argument JSON was appended to a tool call.
    ///
    /// Parallel calls interleave their events, so consecutive `ToolCallArgs`
    /// need not belong to the same call: `tool_call_id` is what separates them,
    /// and arrival order is the only nesting there is — see the [thread module
    /// docs](crate::client::thread).
    ToolCallArgs {
        /// The call being appended to.
        tool_call_id: ToolCallId,
        /// The fragment this event appended. Rarely valid JSON on its own.
        delta: String,
    },
    /// A tool call's arguments are complete.
    ToolCallEnded {
        /// The call that closed.
        tool_call_id: ToolCallId,
    },
    /// A tool result arrived and was appended as a new message.
    ToolResult {
        /// The call this result answers.
        tool_call_id: ToolCallId,
    },
    /// An activity was published or patched.
    Activity,
    /// A provider's opaque reasoning blob was attached to the message or to one
    /// of its tool calls.
    EncryptedValue,
}

/// Which reasoning message changed, and how.
///
/// `#[non_exhaustive]`: read the fields, match with `..`, and build one, to
/// compare with what [`Applier::apply`] returned, with
/// [`ReasoningChange::new`]. A struct literal does not compile outside this
/// crate:
///
/// ```compile_fail,E0639
/// use ag_ui::client::apply::{ReasoningChange, ReasoningChangeKind};
///
/// let change = ReasoningChange { index: 0, id: "r-1".into(), kind: ReasoningChangeKind::Ended };
/// ```
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct ReasoningChange {
    /// Index into [`Applier::messages`].
    pub index: usize,
    /// The reasoning message's id.
    pub id: MessageId,
    /// What happened to it.
    pub kind: ReasoningChangeKind,
}

impl ReasoningChange {
    /// A change of `kind` to the reasoning message `id`, at `index` of
    /// [`Applier::messages`].
    pub fn new(index: usize, id: impl Into<MessageId>, kind: ReasoningChangeKind) -> Self {
        Self {
            index,
            id: id.into(),
            kind,
        }
    }
}

/// What happened to a reasoning message.
///
/// The message is what `REASONING_MESSAGE_START`, `_CONTENT` and `_END`
/// assemble. The span around it, `REASONING_START` to `REASONING_END`, opens
/// no message and reports no change, whether or not it carries the message's
/// id. So [`Started`](Self::Started) and [`Ended`](Self::Ended) arrive once
/// per message, and a consumer that prints a finished thought prints it once.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum ReasoningChangeKind {
    /// Consumption stopped before this reasoning message completed.
    Aborted,
    /// The reasoning message was created.
    Started,
    /// Reasoning text was appended.
    Content {
        /// The text this event appended.
        delta: String,
    },
    /// The reasoning message was closed; no more content will arrive for it.
    Ended,
    /// A provider's opaque reasoning blob was attached.
    EncryptedValue,
}

/// One subagent invocation the run has announced, as the applier tracks it.
///
/// Keyed by [`run_id`](Self::run_id), which names *this invocation* — running
/// the same subagent twice yields two entries — while [`name`](Self::name) is
/// the reusable half, for display. Key transient UI by the id; persist
/// nothing by it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Subagent {
    /// The invocation's id, as every event it produced carries it.
    pub run_id: SubagentRunId,
    /// The subagent's declared type or name.
    pub name: String,
    /// Human-readable description, when announced.
    pub description: Option<String>,
    /// The enclosing subagent, when subagents nest.
    pub parent_subagent_run_id: Option<SubagentRunId>,
    /// The tool call that spawned it, for the agents-as-tools pattern.
    pub parent_tool_call_id: Option<ToolCallId>,
    /// The message that held that tool call.
    pub parent_message_id: Option<MessageId>,
    /// Where the invocation stands.
    pub status: SubagentStatus,
}

/// Where a subagent invocation stands.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum SubagentStatus {
    /// The enclosing run stopped without confirming this invocation's outcome.
    Aborted,
    /// Announced and not yet closed.
    Running,
    /// Closed with a success outcome — or with none, the legacy reading.
    Finished {
        /// The completion payload, if it sent one.
        result: Option<Value>,
    },
    /// Closed because the run paused on interrupts the subagent raised. The
    /// same id may be announced again by the run that resumes it, and that
    /// arrives as [`SubagentChangeKind::Resumed`] rather than as a second
    /// subagent.
    Suspended {
        /// The completion payload so far, if it sent one.
        result: Option<Value>,
        /// The run-level interrupts it directly owns — empty for an ancestor
        /// suspended because a descendant interrupted. Each such
        /// [`Interrupt`] carries the id back as `subagent_run_id`.
        interrupt_ids: Vec<String>,
    },
    /// Closed by `SUBAGENT_ERROR`.
    Failed {
        /// What went wrong, for a human.
        message: String,
        /// The machine-readable code, when the agent sent one.
        code: Option<String>,
    },
}

/// Which subagent changed, and how.
///
/// `#[non_exhaustive]`: read the fields, match with `..`, and build one, to
/// compare with what [`Applier::apply`] returned, with
/// [`SubagentChange::new`]. A struct literal does not compile outside this
/// crate:
///
/// ```compile_fail,E0639
/// use ag_ui::client::apply::{SubagentChange, SubagentChangeKind};
///
/// let change = SubagentChange { index: 0, run_id: "s-1".into(), kind: SubagentChangeKind::Finished };
/// ```
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct SubagentChange {
    /// Index into [`Applier::subagents`].
    pub index: usize,
    /// The invocation's id.
    pub run_id: SubagentRunId,
    /// What happened to it.
    pub kind: SubagentChangeKind,
}

impl SubagentChange {
    /// A change of `kind` to the invocation `run_id`, at `index` of
    /// [`Applier::subagents`].
    pub fn new(index: usize, run_id: impl Into<SubagentRunId>, kind: SubagentChangeKind) -> Self {
        Self {
            index,
            run_id: run_id.into(),
            kind,
        }
    }
}

/// What happened to a subagent invocation.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum SubagentChangeKind {
    /// The enclosing run stopped; no business outcome was inferred.
    Aborted,
    /// A new invocation was announced.
    Started,
    /// A suspended invocation was announced again — a continuation, not a
    /// second subagent. Move its group from waiting back to running.
    Resumed,
    /// The invocation completed.
    Finished,
    /// The invocation paused on interrupts; see [`SubagentStatus::Suspended`].
    Suspended,
    /// The invocation failed.
    Failed,
}

/// The ids one kind of stream has open, in the order they opened.
///
/// Kept by id, so that opening and closing one costs the same however many
/// are open: a producer that opens messages and never closes them does not
/// make each later event slower. The order is read only when a run stops.
#[derive(Clone, Debug, Default)]
struct Open {
    /// Each open id, with its place in the order of opening.
    opened: HashMap<MessageId, u64>,
    /// The place the next one opened takes.
    next: u64,
}

impl Open {
    /// Opens `id`. One that is open already moves behind the others.
    fn open(&mut self, id: MessageId) {
        self.opened.insert(id, self.next);
        self.next += 1;
    }

    fn close(&mut self, id: &MessageId) {
        self.opened.remove(id);
    }

    fn contains(&self, id: &MessageId) -> bool {
        self.opened.contains_key(id)
    }

    fn clear(&mut self) {
        self.opened.clear();
    }

    /// The open ids, the one opened first first.
    fn in_order(&self) -> Vec<&MessageId> {
        let mut ids: Vec<_> = self.opened.iter().collect();
        ids.sort_unstable_by_key(|(_, place)| **place);
        ids.into_iter().map(|(id, _)| id).collect()
    }
}

/// The materialised view of a run.
///
/// See the [module docs](self) for the shape of the problem this solves.
#[derive(Clone, Debug)]
pub struct Applier {
    messages: Vec<Message>,
    by_id: HashMap<MessageId, usize>,
    /// Tool call id to the index of the assistant message that owns it.
    tool_calls: HashMap<ToolCallId, usize>,
    /// Carriers allocated for parentless calls in this run. A chunk stream
    /// can reopen after another lane interrupts it and must keep its carrier.
    synthetic_carriers: HashMap<ToolCallId, MessageId>,
    /// Text messages open for content, in the order they opened — several at
    /// once under concurrent subagents. What a run that stops reports as
    /// aborted. An id stays here when a `MESSAGES_SNAPSHOT` removes its
    /// message: the stream is still open, and has nowhere to write.
    open_text: Open,
    /// The same for reasoning messages: what `REASONING_MESSAGE_START` opened
    /// and `REASONING_MESSAGE_END` has not closed.
    open_reasoning: Open,
    /// The owner the first `TEXT_MESSAGE_START` for an id gave it, where the
    /// conversation held that id as a reasoning or an activity message, so
    /// the text went into that message or nowhere. The ordering rules keep
    /// text apart from reasoning and record that owner for the id as a text
    /// message's, which is whose a tool call naming the id as its parent is.
    claimed: HashMap<MessageId, Option<SubagentRunId>>,
    state: Value,
    thread_id: Option<ThreadId>,
    run_id: Option<RunId>,
    interrupts: Vec<Interrupt>,
    /// The subagent invocations announced so far, in announcement order.
    subagents: Vec<Subagent>,
    subagent_by_id: HashMap<SubagentRunId, usize>,
}

impl Default for Applier {
    fn default() -> Self {
        Self::new()
    }
}

impl Applier {
    /// An empty applier: no messages, and `{}` for state.
    ///
    /// The state starts as an empty object rather than `null` so that the first
    /// `STATE_DELTA` of a run has something to patch.
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            by_id: HashMap::new(),
            tool_calls: HashMap::new(),
            synthetic_carriers: HashMap::new(),
            open_text: Open::default(),
            open_reasoning: Open::default(),
            claimed: HashMap::new(),
            state: Value::Object(JsonObject::new()),
            thread_id: None,
            run_id: None,
            interrupts: Vec::new(),
            subagents: Vec::new(),
            subagent_by_id: HashMap::new(),
        }
    }

    /// Seeds the applier with an existing conversation.
    #[must_use]
    pub fn with_messages(mut self, messages: impl Into<Vec<Message>>) -> Self {
        self.replace_messages(messages.into());
        self
    }

    /// Seeds the applier with an existing state document.
    #[must_use]
    pub fn with_state(mut self, state: impl Into<Value>) -> Self {
        self.state = state.into();
        self
    }

    /// The assembled conversation, oldest first: every role, reasoning and
    /// activity included, each message where it arrived.
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// Material already delivered for a message that is still streaming.
    #[cfg(feature = "server")]
    pub(crate) fn open_messages(&self) -> impl Iterator<Item = &Message> {
        self.messages.iter().filter(|message| {
            self.open_text.contains(message.id()) || self.open_reasoning.contains(message.id())
        })
    }

    pub(crate) fn tool_call_holder(&self, call: &ToolCallId) -> Option<&MessageId> {
        self.messages
            .get(*self.tool_calls.get(call)?)
            .map(Message::id)
    }

    /// The message with this id, if the applier has seen one.
    pub fn message(&self, id: &MessageId) -> Option<&Message> {
        self.by_id
            .get(id)
            .and_then(|index| self.messages.get(*index))
    }

    /// The text of the message with this id, for the roles that carry plain
    /// text. Multimodal user messages return only their text parts' first
    /// fragment; use [`Applier::message`] for the whole payload.
    pub fn text_of(&self, id: impl Into<MessageId>) -> Option<&str> {
        match self.message(&id.into())? {
            Message::Assistant(m) => m.content.as_deref(),
            Message::System(m) => Some(&m.content),
            Message::Developer(m) => Some(&m.content),
            Message::Tool(m) => match &m.content {
                ToolContent::Text(text) => Some(text),
                ToolContent::Parts(parts) => parts.iter().find_map(|part| match part {
                    InputContent::Text(text) => Some(text.text.as_str()),
                    _ => None,
                }),
            },
            Message::Reasoning(m) => Some(&m.content),
            Message::User(m) => match &m.content {
                UserContent::Text(text) => Some(text),
                UserContent::Parts(parts) => parts.iter().find_map(|part| match part {
                    InputContent::Text(text) => Some(text.text.as_str()),
                    _ => None,
                }),
            },
            Message::Activity(_) => None,
        }
    }

    /// The application state, as the JSON document the protocol carries.
    ///
    /// This is the authority: snapshots replace it and deltas patch it. A typed
    /// view is a projection of this — see [`Applier::state_as`].
    pub fn state(&self) -> &Value {
        &self.state
    }

    /// Deserializes the application state into a caller-defined type.
    ///
    /// ```
    /// # #[cfg(feature = "client")]
    /// # fn main() -> Result<(), ag_ui::client::Error> {
    /// # use ag_ui::client::apply::Applier;
    /// # use ag_ui::Event;
    /// # use serde::{Deserialize, Serialize};
    /// #[derive(Deserialize)]
    /// struct Ui {
    ///     step: u32,
    /// }
    ///
    /// let mut applier = Applier::new();
    /// applier.apply(&Event::state_snapshot(serde_json::json!({ "step": 2 })))?;
    /// assert_eq!(applier.state_as::<Ui>()?.step, 2);
    /// # Ok(())
    /// # }
    /// # #[cfg(not(feature = "client"))]
    /// # fn main() {}
    /// ```
    pub fn state_as<T: for<'de> Deserialize<'de>>(&self) -> Result<T> {
        T::deserialize(&self.state).map_err(Error::State)
    }

    /// Replaces the application state without going through an event.
    pub fn set_state(&mut self, state: impl Into<Value>) {
        self.state = state.into();
    }

    /// The reasoning messages of the conversation, oldest first.
    ///
    /// A view over [`Applier::messages`], not a second list: a reasoning
    /// message is held there, where it arrived, and is sent back to the agent
    /// with the rest. This is for a UI that shows reasoning in a pane of its
    /// own.
    pub fn reasoning(&self) -> impl Iterator<Item = &ReasoningMessage> {
        self.messages.iter().filter_map(|message| match message {
            Message::Reasoning(reasoning) => Some(reasoning),
            _ => None,
        })
    }

    /// The accumulated text of one reasoning message. `None` for an id that
    /// names no message, or a message of another role.
    pub fn reasoning_text(&self, id: &MessageId) -> Option<&str> {
        match self.message(id)? {
            Message::Reasoning(message) => Some(&message.content),
            _ => None,
        }
    }

    /// The thread of the run last seen on `RUN_STARTED`.
    pub fn thread_id(&self) -> Option<&ThreadId> {
        self.thread_id.as_ref()
    }

    /// The run id last seen on `RUN_STARTED`.
    pub fn run_id(&self) -> Option<&RunId> {
        self.run_id.as_ref()
    }

    /// The interrupts the last `RUN_FINISHED` paused on. Empty unless the run
    /// is waiting for human input; cleared when the next run starts, and by
    /// `RUN_ERROR` — a failed run waits for nothing.
    pub fn interrupts(&self) -> &[Interrupt] {
        &self.interrupts
    }

    /// The subagent invocations the run has announced, in announcement order.
    ///
    /// Kept across runs on purpose: a subagent suspended in one run is
    /// announced again by the run that resumes it, and the entry it left is
    /// what makes that read as a continuation rather than a duplicate.
    pub fn subagents(&self) -> &[Subagent] {
        &self.subagents
    }

    /// One subagent invocation, by id.
    pub fn subagent(&self, run_id: &SubagentRunId) -> Option<&Subagent> {
        self.subagent_by_id
            .get(run_id)
            .and_then(|index| self.subagents.get(*index))
    }

    /// Appends a message the client itself produced — typically the user's
    /// turn, before starting a run.
    ///
    /// Returns its index in [`Applier::messages`].
    pub fn push_message(&mut self, message: Message) -> usize {
        let index = self.messages.len();
        self.by_id.insert(message.id().clone(), index);
        if let Message::Assistant(assistant) = &message {
            for call in assistant.tool_calls.iter().flatten() {
                self.tool_calls.insert(call.id.clone(), index);
            }
        }
        self.messages.push(message);
        index
    }

    /// Applies one event and reports what it changed.
    ///
    /// An event the conversation has no place for changes nothing and is not
    /// an error: [`Changed::Nothing`] is returned for text, reasoning or
    /// tool-call arguments whose message or call the conversation does not
    /// hold, or holds as an activity message, which takes no text. That is
    /// what follows a `MESSAGES_SNAPSHOT` that removed a message or a call
    /// the run still had open: the snapshot is the new baseline, and nothing
    /// is made again from the rest of the item. A
    /// [`Thread`](crate::client::Thread) reports each such item once per run,
    /// as a warning.
    ///
    /// # Errors
    ///
    /// [`Error::Patch`] or [`Error::InvalidPatchDocument`] for a state or
    /// activity patch that does not apply, [`Error::Protocol`] for a
    /// `RUN_FINISHED` whose interrupt outcome carries no interrupt, and
    /// [`Error::Unsupported`] for a
    /// `*_CHUNK` or a retired `THINKING_*` event, which this applies only in
    /// their explicit form. Run a raw stream through a
    /// [`ChunkNormalizer`](crate::client::ChunkNormalizer) first, and read
    /// one that may carry `THINKING_*` through the compatibility boundary;
    /// see the [module docs](self).
    pub fn apply(&mut self, event: &Event) -> Result<Changed> {
        let changed = self.apply_inner(event)?;
        // Metadata folds into whatever the event built, once the event has
        // built it — see `crate::metadata` for which events build anything.
        if let Some(metadata) = event.metadata() {
            self.merge_event_metadata(event, &changed, metadata);
        }
        Ok(changed)
    }

    fn apply_inner(&mut self, event: &Event) -> Result<Changed> {
        match event {
            Event::TextMessageStart(e) => Ok(self.text_start(
                e.message_id.clone(),
                e.role,
                e.name.clone(),
                e.subagent_run_id.clone(),
            )),
            Event::TextMessageContent(e) => {
                self.text_content(&e.message_id, &e.delta, &e.subagent_run_id)
            }
            Event::TextMessageEnd(e) => Ok(self.text_end(&e.message_id)),

            Event::ToolCallStart(e) => Ok(self.tool_call_start(
                e.tool_call_id.clone(),
                e.tool_call_name.clone(),
                e.parent_message_id.clone(),
                e.subagent_run_id.clone(),
            )),
            Event::ToolCallArgs(e) => self.tool_call_args(&e.tool_call_id, &e.delta),
            Event::ToolCallEnd(e) => Ok(self.tool_call_end(&e.tool_call_id)),
            Event::ToolCallResult(e) => Ok(self.tool_call_result(
                e.message_id.clone(),
                e.tool_call_id.clone(),
                e.content.clone(),
                e.subagent_run_id.clone(),
            )),

            Event::StateSnapshot(e) => {
                self.state = e.snapshot.clone();
                Ok(Changed::State)
            }
            Event::StateDelta(e) => {
                self.state = patched(self.state.clone(), &e.delta, "state")?;
                Ok(Changed::State)
            }
            Event::MessagesSnapshot(e) => {
                self.merge_snapshot(e.messages.clone());
                Ok(Changed::MessagesReplaced)
            }

            Event::ActivitySnapshot(e) => Ok(self.activity_snapshot(e)),
            Event::ActivityDelta(e) => self.activity_delta(e),

            // A span opens no message, so it leaves nothing to draw: a
            // reasoning message is in the conversation from its own start to
            // its own end. A caller that wants the span reads these two
            // events where it reads the stream.
            Event::ReasoningStart(_) | Event::ReasoningEnd(_) => Ok(Changed::Nothing),
            Event::ReasoningMessageStart(e) => {
                Ok(self.reasoning_start(e.message_id.clone(), e.subagent_run_id.clone()))
            }
            Event::ReasoningMessageContent(e) => {
                self.reasoning_content(&e.message_id, &e.delta, &e.subagent_run_id)
            }
            Event::ReasoningMessageEnd(e) => Ok(self.reasoning_end(&e.message_id)),
            Event::ReasoningEncryptedValue(e) => Ok(self.encrypted_value(e)),

            // The two families that stand for other events. What a chunk
            // continues, and which reasoning message a THINKING_* event
            // belongs to, is decided before the applier, in one place each.
            Event::TextMessageChunk(_)
            | Event::ToolCallChunk(_)
            | Event::ReasoningMessageChunk(_) => Err(Error::Unsupported(format!(
                "{} is applied in its expanded form: run the stream through a \
                 ChunkNormalizer first",
                event.event_type()
            ))),
            Event::ThinkingStart(_)
            | Event::ThinkingEnd(_)
            | Event::ThinkingTextMessageStart(_)
            | Event::ThinkingTextMessageContent(_)
            | Event::ThinkingTextMessageEnd(_) => Err(Error::Unsupported(format!(
                "{} is retired in AG-UI 1.0 and is applied as the REASONING_* event the \
                 compatibility boundary translates it to",
                event.event_type()
            ))),

            Event::RunStarted(e) => {
                if self.run_id.as_ref() != Some(&e.run_id)
                    || self.thread_id.as_ref() != Some(&e.thread_id)
                {
                    self.synthetic_carriers.clear();
                }
                self.thread_id = Some(e.thread_id.clone());
                self.run_id = Some(e.run_id.clone());
                self.interrupts.clear();
                Ok(Changed::RunStarted {
                    thread_id: e.thread_id.clone(),
                    run_id: e.run_id.clone(),
                })
            }
            Event::RunFinished(e) => {
                let outcome = e.outcome.clone().unwrap_or(RunOutcome::Success);
                outcome.validate()?;
                self.interrupts = outcome.interrupts().to_vec();
                Ok(Changed::RunFinished {
                    outcome,
                    result: e.result.clone(),
                })
            }
            // Even after RUN_FINISHED: a late failure fails the run that
            // paused, so what it paused on is no longer asked.
            Event::RunError(e) => {
                self.interrupts.clear();
                Ok(Changed::RunError {
                    message: e.message.clone(),
                    code: e.code.clone(),
                })
            }

            Event::StepStarted(_) | Event::StepFinished(_) | Event::Raw(_) | Event::Custom(_) => {
                Ok(Changed::Nothing)
            }

            Event::SubagentStarted(e) => Ok(self.subagent_started(e)),
            Event::SubagentFinished(e) => Ok(self.subagent_finished(e)),
            Event::SubagentError(e) => Ok(self.subagent_error(e)),
        }
    }

    /// Restore materialized auxiliary state without reopening streaming parsers.
    pub(crate) fn restore_auxiliary(
        &mut self,
        subagents: Vec<Subagent>,
        interrupts: Vec<Interrupt>,
    ) {
        self.subagent_by_id = subagents
            .iter()
            .enumerate()
            .map(|(i, subagent)| (subagent.run_id.clone(), i))
            .collect();
        self.subagents = subagents;
        self.interrupts = interrupts;
    }

    pub(crate) fn reset_streams(&mut self) {
        self.open_text.clear();
        self.open_reasoning.clear();
    }

    pub(crate) fn abort_messages(&mut self) -> (Vec<MessageChange>, Vec<ReasoningChange>) {
        // One a snapshot removed while it was open has no message to report.
        let messages = self
            .open_text
            .in_order()
            .into_iter()
            .filter_map(|id| {
                self.streamable(id).map(|index| MessageChange {
                    index,
                    id: id.clone(),
                    kind: MessageChangeKind::Aborted,
                })
            })
            .collect();
        let reasoning = self
            .open_reasoning
            .in_order()
            .into_iter()
            .filter_map(|id| {
                self.streamable(id).map(|index| ReasoningChange {
                    index,
                    id: id.clone(),
                    kind: ReasoningChangeKind::Aborted,
                })
            })
            .collect();
        self.reset_streams();
        (messages, reasoning)
    }

    pub(crate) fn abort_subagents(&mut self) -> Vec<SubagentChange> {
        self.reset_streams();
        self.subagents
            .iter_mut()
            .enumerate()
            .filter_map(|(index, subagent)| {
                if subagent.status != SubagentStatus::Running {
                    return None;
                }
                subagent.status = SubagentStatus::Aborted;
                Some(SubagentChange {
                    index,
                    run_id: subagent.run_id.clone(),
                    kind: SubagentChangeKind::Aborted,
                })
            })
            .collect()
    }

    // ---- messages -------------------------------------------------------

    fn replace_messages(&mut self, messages: Vec<Message>) {
        self.by_id.clear();
        self.tool_calls.clear();
        self.synthetic_carriers.clear();
        for (index, message) in messages.iter().enumerate() {
            self.by_id.insert(message.id().clone(), index);
            if let Message::Assistant(assistant) = message {
                for call in assistant.tool_calls.iter().flatten() {
                    self.tool_calls.insert(call.id.clone(), index);
                    // A join prelude can send a partial carrier as a snapshot
                    // before reopening its call. The call itself must be on
                    // that carrier: its message ID alone proves nothing.
                    let base = format!("{}-message", call.id);
                    let id = assistant.id.as_str();
                    let synthetic = id == base
                        || id
                            .strip_prefix(&base)
                            .and_then(|tail| tail.strip_prefix('-'))
                            .is_some_and(|suffix| {
                                !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
                            });
                    if synthetic {
                        self.synthetic_carriers
                            .insert(call.id.clone(), assistant.id.clone());
                    }
                }
            } else if let Message::Tool(result) = message {
                self.synthetic_carriers.remove(&result.tool_call_id);
            }
        }
        self.messages = messages;
        // What is open stays open. AG-UI 1.0 (`basic/patterns/streaming`):
        // the standalone events, `MESSAGES_SNAPSHOT` among them, "open and
        // close no items of their own, and MAY appear anywhere within an
        // open run". The events that follow for an open item apply to what
        // the conversation now holds under its id, and to nothing when the
        // snapshot removed it.
    }

    /// The index of the message with this id, when it can take streamed
    /// text: any message but an activity, whose content is an object.
    fn streamable(&self, id: &MessageId) -> Option<usize> {
        let index = *self.by_id.get(id)?;
        (!matches!(self.messages.get(index)?, Message::Activity(_))).then_some(index)
    }

    /// Folds a `MESSAGES_SNAPSHOT` into the conversation.
    ///
    /// A snapshot is an *edit*, not a replacement — upstream
    /// (`client/src/apply/default.ts`, `case EventType.MESSAGES_SNAPSHOT`)
    /// rebuilds the list by filtering the local one and appending whatever the
    /// snapshot adds. Three consequences, all of them load-bearing:
    ///
    /// - a message the snapshot carries replaces the local one with the same
    ///   id, in the place the local one had, so a backend that reorders its
    ///   own history does not reshuffle the transcript under the user. One
    ///   the client has not seen is appended, in snapshot order;
    /// - messages the snapshot leaves out are dropped — that is how a
    ///   summarizing backend deletes turns;
    /// - except `activity` and `reasoning`, each of which survives a snapshot
    ///   that carries none of its role. Activity never travels back to the
    ///   backend and most backends do not track reasoning, so a backend that
    ///   does not track a role *cannot* list it. Dropping the local copies
    ///   would clear a pane of the UI on every snapshot, and take the
    ///   reasoning out of the next request. A snapshot that does carry a role
    ///   is declaring the whole set of it, so a message of that role missing
    ///   from it has been deleted. Without that half a client-side activity
    ///   would be undeletable, and a backend that restates reasoning under
    ///   ids of its own would leave every thought in the list twice.
    ///
    /// A snapshot is the new baseline for what a run has open, too. It
    /// closes nothing, and it is not merged with what was there: a message
    /// being streamed into is replaced by the snapshot's copy or removed,
    /// and a tool call the snapshot's copy of its message does not list is
    /// gone. AG-UI 1.0 (`basic/patterns/snapshots`): "A consumer MUST
    /// replace its copy with the snapshot's content — a snapshot is not a
    /// merge"; and of what a snapshot leaves out (`events/reasoning`): "The
    /// consumer's duty is to return what it holds once all events have
    /// applied, not to resurrect what a snapshot removed."
    ///
    /// An id names one message (1.0, `basic`: "it MUST be unique within its
    /// thread"), so of a snapshot that carries an id more than once the last
    /// copy is kept, where the first stood.
    fn merge_snapshot(&mut self, snapshot: Vec<Message>) {
        let owns_activity = snapshot.iter().any(|m| matches!(m, Message::Activity(_)));
        let owns_reasoning = snapshot.iter().any(|m| matches!(m, Message::Reasoning(_)));

        // `Option` slots so a message can be moved out when it is placed, and
        // whatever is left over is exactly what the snapshot added.
        let mut incoming: Vec<Option<Message>> = Vec::with_capacity(snapshot.len());
        let mut position: HashMap<MessageId, usize> = HashMap::with_capacity(snapshot.len());
        for message in snapshot {
            match position.get(message.id()) {
                Some(first) => incoming[*first] = Some(message),
                None => {
                    position.insert(message.id().clone(), incoming.len());
                    incoming.push(Some(message));
                }
            }
        }

        let previous = std::mem::take(&mut self.messages);
        let mut merged = Vec::with_capacity(previous.len().max(incoming.len()));
        for message in previous {
            let restated = position
                .get(message.id())
                .and_then(|index| incoming[*index].take());
            if let Some(replacement) = restated {
                // By id alone: the snapshot's copy takes the place, whatever
                // role either copy has.
                merged.push(replacement);
                continue;
            }
            let survives = match message {
                Message::Activity(_) => !owns_activity,
                Message::Reasoning(_) => !owns_reasoning,
                _ => false,
            };
            if survives {
                merged.push(message);
            }
        }
        merged.extend(incoming.into_iter().flatten());

        self.replace_messages(merged);
    }

    fn text_start(
        &mut self,
        id: MessageId,
        role: TextMessageRole,
        name: Option<String>,
        owner: Option<SubagentRunId>,
    ) -> Changed {
        if let Some(held) = self.message(&id) {
            if matches!(held, Message::Reasoning(_) | Message::Activity(_)) {
                self.claimed.entry(id.clone()).or_insert(owner);
            }
            // An activity message has no text to append to, so the id opens
            // nothing: its content is left as it is, as in the reference
            // client.
            let Some(index) = self.streamable(&id) else {
                return Changed::Nothing;
            };
            self.open_text.open(id.clone());
            // Re-opening a known id keeps the message and appends to it, which
            // is what a producer that restarts a stream means — and keeps its
            // attribution, which the opener transferred once.
            return Changed::Message(MessageChange {
                index,
                id,
                kind: MessageChangeKind::Started,
            });
        }
        self.open_text.open(id.clone());
        // Attribution transfers to the message the event creates, so a
        // renderer can group a conversation by subagent without replaying
        // the stream.
        let mut message = empty_message(id.clone(), role, name);
        message.set_subagent_run_id(owner);
        let index = self.push_message(message);
        Changed::Message(MessageChange {
            index,
            id,
            kind: MessageChangeKind::Started,
        })
    }

    fn text_content(
        &mut self,
        id: &MessageId,
        delta: &str,
        owner: &Option<SubagentRunId>,
    ) -> Result<Changed> {
        if !self.by_id.contains_key(id) {
            // The message was open and a `MESSAGES_SNAPSHOT` removed it.
            // Nothing is made again from the rest of it: the snapshot said
            // the conversation does not hold it.
            if self.open_text.contains(id) {
                return Ok(Changed::Nothing);
            }
            // Tolerant: an orphan content event opens the message it names.
            self.text_start(id.clone(), TextMessageRole::Assistant, None, owner.clone());
        }
        // An activity message under this id takes no text.
        let Some(index) = self.streamable(id) else {
            return Ok(Changed::Nothing);
        };
        append_text(&mut self.messages[index], delta);
        Ok(Changed::Message(MessageChange {
            index,
            id: id.clone(),
            kind: MessageChangeKind::Content {
                delta: delta.to_owned(),
            },
        }))
    }

    fn text_end(&mut self, id: &MessageId) -> Changed {
        self.open_text.close(id);
        match self.streamable(id) {
            Some(index) => Changed::Message(MessageChange {
                index,
                id: id.clone(),
                kind: MessageChangeKind::Ended,
            }),
            None => Changed::Nothing,
        }
    }

    // ---- tool calls -----------------------------------------------------

    fn tool_call_start(
        &mut self,
        tool_call_id: ToolCallId,
        name: String,
        parent_message_id: Option<MessageId>,
        owner: Option<SubagentRunId>,
    ) -> Changed {
        // The message the call names carries it, when that is an assistant
        // message, or none yet, which the call then opens. A message created
        // here takes the call's attribution; one that already exists keeps
        // its own.
        let named = parent_message_id
            .as_ref()
            .and_then(|parent| self.by_id.get(parent).copied());
        let carries =
            |index: usize| matches!(self.messages.get(index), Some(Message::Assistant(_)));
        let (carrier, owner) = match (parent_message_id, named) {
            (Some(parent), Some(index)) if carries(index) => (parent, owner),
            (Some(parent), None) => (parent, owner),
            // A call with no parent belongs to a message of its own; the call
            // id is the only id available to name it. So does one whose
            // parent is not an assistant message and cannot carry a call: a
            // reasoning message a reply shares its id with, say. The
            // reference client does the same.
            //
            // Unattributed, such a call is whoever's the ordering rules make
            // it: the owner they record for the parent as a text message.
            // That is the named message's own, or, for an id the
            // conversation holds as reasoning or activity, the owner the
            // text start that shared it claimed. None claimed it: the parent
            // agent's.
            (parent, named) => {
                let inherited = || {
                    let held = self.messages.get(named?)?;
                    match held {
                        Message::Reasoning(_) | Message::Activity(_) => {
                            self.claimed.get(parent.as_ref()?).cloned().flatten()
                        }
                        _ => held.subagent_run_id().cloned(),
                    }
                };
                let owner = owner.or_else(inherited);
                let resumed = self.synthetic_carriers.get(&tool_call_id).filter(|id| {
                    self.tool_call_holder(&tool_call_id) == Some(*id)
                        && matches!(self.message(id), Some(Message::Assistant(assistant))
                            if (owner.is_none() || owner == assistant.subagent_run_id)
                            && assistant.tool_calls.iter().flatten().any(|call| call.id == tool_call_id && call.function.name == name))
                });
                let id = match resumed {
                    Some(id) => id.clone(),
                    _ => {
                        let base = format!("{tool_call_id}-message");
                        let mut id = MessageId::new(&base);
                        let mut suffix = 1usize;
                        while self.by_id.contains_key(&id) {
                            id = MessageId::new(format!("{base}-{suffix}"));
                            suffix += 1;
                        }
                        self.synthetic_carriers
                            .insert(tool_call_id.clone(), id.clone());
                        id
                    }
                };
                (id, owner)
            }
        };
        let index = match self.by_id.get(&carrier) {
            Some(index) => *index,
            None => self.push_message(Message::Assistant(AssistantMessage {
                id: carrier.clone(),
                subagent_run_id: owner,
                ..Default::default()
            })),
        };
        let Some(Message::Assistant(assistant)) = self.messages.get_mut(index) else {
            return Changed::Nothing;
        };
        let calls = assistant.tool_calls.get_or_insert_with(Vec::new);
        if !calls.iter().any(|call| call.id == tool_call_id) {
            calls.push(ToolCall::new(tool_call_id.clone(), name.clone(), ""));
        }
        self.tool_calls.insert(tool_call_id.clone(), index);
        Changed::Message(MessageChange {
            index,
            id: carrier,
            kind: MessageChangeKind::ToolCallStarted { tool_call_id, name },
        })
    }

    fn tool_call_args(&mut self, tool_call_id: &ToolCallId, delta: &str) -> Result<Changed> {
        // No message holds the call: it was never started, its start had
        // nowhere to put it, or a `MESSAGES_SNAPSHOT` since restated its
        // message without it. The fragment is dropped, as in the reference
        // client, and a `Thread` says so.
        let Some(index) = self.tool_calls.get(tool_call_id).copied() else {
            return Ok(Changed::Nothing);
        };
        let Some(Message::Assistant(assistant)) = self.messages.get_mut(index) else {
            return Ok(Changed::Nothing);
        };
        let Some(call) = assistant
            .tool_calls
            .as_mut()
            .and_then(|calls| calls.iter_mut().find(|call| &call.id == tool_call_id))
        else {
            return Ok(Changed::Nothing);
        };
        call.function.arguments.push_str(delta);
        Ok(Changed::Message(MessageChange {
            index,
            id: assistant.id.clone(),
            kind: MessageChangeKind::ToolCallArgs {
                tool_call_id: tool_call_id.clone(),
                delta: delta.to_owned(),
            },
        }))
    }

    fn tool_call_end(&mut self, tool_call_id: &ToolCallId) -> Changed {
        match self.tool_calls.get(tool_call_id).copied() {
            Some(index) => match self.messages.get(index) {
                Some(message) => Changed::Message(MessageChange {
                    index,
                    id: message.id().clone(),
                    kind: MessageChangeKind::ToolCallEnded {
                        tool_call_id: tool_call_id.clone(),
                    },
                }),
                None => Changed::Nothing,
            },
            None => Changed::Nothing,
        }
    }

    fn tool_call_result(
        &mut self,
        message_id: MessageId,
        tool_call_id: ToolCallId,
        content: ToolContent,
        owner: Option<SubagentRunId>,
    ) -> Changed {
        self.synthetic_carriers.remove(&tool_call_id);
        let index = match self.by_id.get(&message_id).copied() {
            Some(index) => {
                if let Some(Message::Tool(tool)) = self.messages.get_mut(index) {
                    tool.content = content;
                    // The newest mint wins, as both verifiers record it.
                    tool.subagent_run_id = owner;
                }
                index
            }
            // The result's own attribution, not the call's: whoever executed
            // the tool owns the message that reports it.
            None => self.push_message(Message::Tool(ToolMessage {
                id: message_id.clone(),
                content,
                tool_call_id: tool_call_id.clone(),
                subagent_run_id: owner,
                ..Default::default()
            })),
        };
        Changed::Message(MessageChange {
            index,
            id: message_id,
            kind: MessageChangeKind::ToolResult { tool_call_id },
        })
    }

    // ---- activities -----------------------------------------------------

    fn activity_snapshot(&mut self, event: &ActivitySnapshotEvent) -> Changed {
        let index = match self.by_id.get(&event.message_id).copied() {
            Some(index) => index,
            // A snapshot for an id not seen yet creates the activity, in
            // sequence position, whatever `replace` says.
            None => {
                let index = self.push_message(Message::Activity(ActivityMessage {
                    id: event.message_id.clone(),
                    activity_type: event.activity_type.clone(),
                    content: event.content.clone(),
                    subagent_run_id: event.subagent_run_id.clone(),
                    ..Default::default()
                }));
                return Changed::Message(MessageChange {
                    index,
                    id: event.message_id.clone(),
                    kind: MessageChangeKind::Activity,
                });
            }
        };
        // `replace: false` leaves an existing activity as it stands: content,
        // `activityType` and owner. It is not a merge.
        if !event.replace {
            return Changed::Nothing;
        }
        // A replacing snapshot re-mints the activity, attribution included:
        // one that carries none takes the activity back for the parent.
        // Metadata is not content, and keeps merging.
        if let Some(Message::Activity(activity)) = self.messages.get_mut(index) {
            activity.activity_type = event.activity_type.clone();
            activity.subagent_run_id = event.subagent_run_id.clone();
            activity.content = event.content.clone();
        }
        Changed::Message(MessageChange {
            index,
            id: event.message_id.clone(),
            kind: MessageChangeKind::Activity,
        })
    }

    /// Patches an activity's content and gives it the delta's `activityType`.
    /// A delta whose target does not exist, or is not an activity, is
    /// skipped: the error says so, nothing is created, and a `Thread` reports
    /// it without failing the run. A patch that does not apply changes nothing.
    fn activity_delta(&mut self, event: &ActivityDeltaEvent) -> Result<Changed> {
        let what = format!("activity {}", event.message_id);
        let index = self.by_id.get(&event.message_id).copied();
        let Some((index, Message::Activity(activity))) =
            index.and_then(|index| Some((index, self.messages.get_mut(index)?)))
        else {
            return Err(Error::Patch {
                target: what,
                message: "no activity message has this id, so the delta was skipped; an \
                          ACTIVITY_SNAPSHOT has to create it first"
                    .to_owned(),
            });
        };
        // Patched on a copy, and committed only once the result is still an
        // object. An activity's content is an object by definition, so a
        // whole-document operation — `{"op":"replace","path":"","value":7}`
        // — has nowhere to land; taking the content out first would leave
        // the activity holding nothing at all.
        let content = patched(Value::Object(activity.content.clone()), &event.patch, &what)?;
        let Value::Object(object) = content else {
            return Err(Error::Patch {
                target: what,
                message: format!(
                    "patch replaced the whole activity with {}, which is not an object",
                    kind_of(&content)
                ),
            });
        };
        activity.content = object;
        // The delta's type replaces the message's: a delta may retype the
        // activity it amends.
        activity.activity_type = event.activity_type.clone();
        Ok(Changed::Message(MessageChange {
            index,
            id: event.message_id.clone(),
            kind: MessageChangeKind::Activity,
        }))
    }

    // ---- reasoning ------------------------------------------------------

    /// Opens the reasoning message a `REASONING_MESSAGE_START` names: a
    /// message of the conversation, appended where it arrives.
    ///
    /// A message id is unique within its thread. So an id the conversation
    /// already holds continues that message, whatever its role, as a
    /// `TEXT_MESSAGE_START` for a known id does and as the reference client
    /// does. Nothing is created beside it.
    fn reasoning_start(&mut self, id: MessageId, owner: Option<SubagentRunId>) -> Changed {
        let index = if self.by_id.contains_key(&id) {
            // An activity message has no text, so the id opens nothing.
            let Some(index) = self.streamable(&id) else {
                return Changed::Nothing;
            };
            index
        } else {
            // Attribution transfers to the message the event creates, as it
            // does for text.
            self.push_message(Message::Reasoning(ReasoningMessage {
                id: id.clone(),
                subagent_run_id: owner,
                ..Default::default()
            }))
        };
        self.open_reasoning.open(id.clone());
        Changed::Reasoning(ReasoningChange {
            index,
            id,
            kind: ReasoningChangeKind::Started,
        })
    }

    fn reasoning_content(
        &mut self,
        id: &MessageId,
        delta: &str,
        owner: &Option<SubagentRunId>,
    ) -> Result<Changed> {
        if !self.by_id.contains_key(id) {
            // Open, and removed by a `MESSAGES_SNAPSHOT`: as for text,
            // nothing is made again from the rest of it.
            if self.open_reasoning.contains(id) {
                return Ok(Changed::Nothing);
            }
            // Tolerant: an orphan content event opens the message it names.
            self.reasoning_start(id.clone(), owner.clone());
        }
        // An activity message under this id takes no text.
        let Some(index) = self.streamable(id) else {
            return Ok(Changed::Nothing);
        };
        append_text(&mut self.messages[index], delta);
        Ok(Changed::Reasoning(ReasoningChange {
            index,
            id: id.clone(),
            kind: ReasoningChangeKind::Content {
                delta: delta.to_owned(),
            },
        }))
    }

    fn reasoning_end(&mut self, id: &MessageId) -> Changed {
        self.open_reasoning.close(id);
        match self.streamable(id) {
            Some(index) => Changed::Reasoning(ReasoningChange {
                index,
                id: id.clone(),
                kind: ReasoningChangeKind::Ended,
            }),
            None => Changed::Nothing,
        }
    }

    fn encrypted_value(&mut self, event: &ReasoningEncryptedValueEvent) -> Changed {
        let blob = event.encrypted_value.clone();
        match event.subtype {
            ReasoningEncryptedValueSubtype::ToolCall => {
                let tool_call_id = ToolCallId::new(event.entity_id.clone());
                let Some(index) = self.tool_calls.get(&tool_call_id).copied() else {
                    return Changed::Nothing;
                };
                let Some(Message::Assistant(assistant)) = self.messages.get_mut(index) else {
                    return Changed::Nothing;
                };
                if let Some(call) = assistant
                    .tool_calls
                    .as_mut()
                    .and_then(|calls| calls.iter_mut().find(|call| call.id == tool_call_id))
                {
                    call.encrypted_value = Some(blob);
                }
                Changed::Message(MessageChange {
                    index,
                    id: assistant.id.clone(),
                    kind: MessageChangeKind::EncryptedValue,
                })
            }
            // Stored with the message it names, which is what carries it
            // back: the next request sends that message as it stands.
            ReasoningEncryptedValueSubtype::Message => {
                let id = MessageId::new(event.entity_id.clone());
                let Some(index) = self.by_id.get(&id).copied() else {
                    return Changed::Nothing;
                };
                let Some(message) = self.messages.get_mut(index) else {
                    return Changed::Nothing;
                };
                // An activity has no field for the value, so the event names
                // nothing that can hold it.
                if !set_encrypted_value(message, blob) {
                    return Changed::Nothing;
                }
                if matches!(message, Message::Reasoning(_)) {
                    Changed::Reasoning(ReasoningChange {
                        index,
                        id,
                        kind: ReasoningChangeKind::EncryptedValue,
                    })
                } else {
                    Changed::Message(MessageChange {
                        index,
                        id,
                        kind: MessageChangeKind::EncryptedValue,
                    })
                }
            }
        }
    }

    // ---- subagents ------------------------------------------------------

    fn subagent_started(&mut self, event: &SubagentStartedEvent) -> Changed {
        let run_id = event.subagent_run_id.clone();
        if let Some(index) = self.subagent_by_id.get(&run_id).copied() {
            // The one legal re-announcement: a suspended invocation continuing
            // on the resuming run. Anything else is a producer bug the
            // verifier already reported, and the entry is reset rather than
            // duplicated so a view keeps one row per id.
            let subagent = &mut self.subagents[index];
            let kind = if matches!(subagent.status, SubagentStatus::Suspended { .. }) {
                SubagentChangeKind::Resumed
            } else {
                SubagentChangeKind::Started
            };
            subagent.name.clone_from(&event.name);
            if event.description.is_some() {
                subagent.description.clone_from(&event.description);
            }
            if let Some(parent) = &event.parent_subagent_run_id {
                self.adopt(index, parent);
            }
            let subagent = &mut self.subagents[index];
            if event.parent_tool_call_id.is_some() {
                subagent
                    .parent_tool_call_id
                    .clone_from(&event.parent_tool_call_id);
                subagent
                    .parent_message_id
                    .clone_from(&event.parent_message_id);
            }
            subagent.status = SubagentStatus::Running;
            return Changed::Subagent(SubagentChange {
                index,
                run_id,
                kind,
            });
        }
        let index = self.push_subagent(Subagent {
            run_id: run_id.clone(),
            name: event.name.clone(),
            description: event.description.clone(),
            // No invocation spawned itself.
            parent_subagent_run_id: event
                .parent_subagent_run_id
                .clone()
                .filter(|parent| parent != &run_id),
            parent_tool_call_id: event.parent_tool_call_id.clone(),
            parent_message_id: event.parent_message_id.clone(),
            status: SubagentStatus::Running,
        });
        Changed::Subagent(SubagentChange {
            index,
            run_id,
            kind: SubagentChangeKind::Started,
        })
    }

    /// Gives the subagent at `index`, which is announced again, the parent
    /// its new announcement names.
    ///
    /// The newest announcement stands. What the table holds may say the
    /// opposite: a run that announces two invocations the other way round
    /// than the run before it finds the named parent recorded *under* this
    /// subagent, and keeping both links would make each the other's
    /// ancestor, which no tree has and no snapshot restores. So the older
    /// link, the one on the way up from the parent that ends at this
    /// subagent, is dropped, and its holder stands directly under the
    /// parent agent, where an announcement that names no parent puts it.
    ///
    /// Only an announcement that changes the parent of a known invocation
    /// walks the ancestors, so a first announcement costs the same at any
    /// depth.
    fn adopt(&mut self, index: usize, parent: &SubagentRunId) {
        let id = self.subagents[index].run_id.clone();
        let unchanged = self.subagents[index].parent_subagent_run_id.as_ref() == Some(parent);
        // No invocation spawned itself.
        if unchanged || *parent == id {
            return;
        }
        let mut at = self.subagent_by_id.get(parent).copied();
        // A walk longer than the table has met a cycle that was there
        // already, which only a stream nothing verified leaves.
        for _ in 0..self.subagents.len() {
            let Some(ancestor) = at else { break };
            let above = self.subagents[ancestor].parent_subagent_run_id.clone();
            match above {
                Some(above) if above == id => {
                    self.subagents[ancestor].parent_subagent_run_id = None;
                    break;
                }
                Some(above) => at = self.subagent_by_id.get(&above).copied(),
                None => break,
            }
        }
        self.subagents[index].parent_subagent_run_id = Some(parent.clone());
    }

    fn subagent_finished(&mut self, event: &SubagentFinishedEvent) -> Changed {
        let run_id = event.subagent_run_id.clone();
        let index = self.subagent_index(&run_id);
        let (status, kind) = match &event.outcome {
            Some(SubagentOutcome::Suspended { interrupt_ids }) => (
                SubagentStatus::Suspended {
                    result: event.result.clone(),
                    interrupt_ids: interrupt_ids.clone().unwrap_or_default(),
                },
                SubagentChangeKind::Suspended,
            ),
            // Absent means success: the legacy reading.
            Some(SubagentOutcome::Success) | None => (
                SubagentStatus::Finished {
                    result: event.result.clone(),
                },
                SubagentChangeKind::Finished,
            ),
        };
        self.subagents[index].status = status;
        Changed::Subagent(SubagentChange {
            index,
            run_id,
            kind,
        })
    }

    fn subagent_error(&mut self, event: &SubagentErrorEvent) -> Changed {
        let run_id = event.subagent_run_id.clone();
        let index = self.subagent_index(&run_id);
        self.subagents[index].status = SubagentStatus::Failed {
            message: event.message.clone(),
            code: event.code.clone(),
        };
        Changed::Subagent(SubagentChange {
            index,
            run_id,
            kind: SubagentChangeKind::Failed,
        })
    }

    /// The index of the subagent with this id, creating a bare entry when a
    /// producer closed one it never announced. Tolerant, like the rest of the
    /// applier: the verifier is where that is a complaint, and a view still
    /// wants a row to hang the outcome on.
    fn subagent_index(&mut self, run_id: &SubagentRunId) -> usize {
        match self.subagent_by_id.get(run_id).copied() {
            Some(index) => index,
            None => self.push_subagent(Subagent {
                run_id: run_id.clone(),
                name: run_id.to_string(),
                description: None,
                parent_subagent_run_id: None,
                parent_tool_call_id: None,
                parent_message_id: None,
                status: SubagentStatus::Running,
            }),
        }
    }

    fn push_subagent(&mut self, subagent: Subagent) -> usize {
        let index = self.subagents.len();
        self.subagent_by_id.insert(subagent.run_id.clone(), index);
        self.subagents.push(subagent);
        index
    }

    // ---- metadata -------------------------------------------------------

    /// Folds an event's metadata into what the event built: the message for
    /// the text, result and activity families, the tool call for `TOOL_CALL_*`,
    /// the reasoning message for `REASONING_MESSAGE_*`. Everything else keeps
    /// its metadata to itself — see [`crate::metadata`].
    fn merge_event_metadata(&mut self, event: &Event, changed: &Changed, metadata: &JsonObject) {
        match event {
            Event::TextMessageStart(_)
            | Event::TextMessageContent(_)
            | Event::TextMessageEnd(_)
            | Event::ToolCallResult(_)
            | Event::ActivitySnapshot(_)
            | Event::ActivityDelta(_) => {
                let Changed::Message(change) = changed else {
                    return;
                };
                if let Some(message) = self.messages.get_mut(change.index) {
                    merge_metadata_into(message.metadata_mut(), Some(metadata));
                }
            }
            Event::ToolCallStart(_) | Event::ToolCallArgs(_) | Event::ToolCallEnd(_) => {
                let Changed::Message(change) = changed else {
                    return;
                };
                let tool_call_id = match &change.kind {
                    MessageChangeKind::ToolCallStarted { tool_call_id, .. }
                    | MessageChangeKind::ToolCallArgs { tool_call_id, .. }
                    | MessageChangeKind::ToolCallEnded { tool_call_id } => tool_call_id.clone(),
                    _ => return,
                };
                let Some(Message::Assistant(assistant)) = self.messages.get_mut(change.index)
                else {
                    return;
                };
                if let Some(call) = assistant
                    .tool_calls
                    .as_mut()
                    .and_then(|calls| calls.iter_mut().find(|call| call.id == tool_call_id))
                {
                    merge_metadata_into(&mut call.metadata, Some(metadata));
                }
            }
            Event::ReasoningMessageStart(_)
            | Event::ReasoningMessageContent(_)
            | Event::ReasoningMessageEnd(_) => {
                let Changed::Reasoning(change) = changed else {
                    return;
                };
                if let Some(message) = self.messages.get_mut(change.index) {
                    merge_metadata_into(message.metadata_mut(), Some(metadata));
                }
            }
            _ => {}
        }
    }
}

/// Applies a patch to an owned copy. A failed move may already have removed
/// its source; the caller only receives a document after every operation succeeds.
fn patched(mut candidate: Value, operations: &[PatchOperation], what: &str) -> Result<Value> {
    // The protocol's operation type and the patch engine's are both the RFC
    // wire format, so JSON is the conversion. Deserializing is also where a
    // malformed JSON Pointer is caught, before anything is mutated.
    let document = serde_json::to_value(operations)?;
    let patch: json_patch::Patch =
        serde_json::from_value(document).map_err(|error| Error::InvalidPatchDocument {
            target: what.to_owned(),
            message: error.to_string(),
        })?;
    json_patch::patch_unsafe(&mut candidate, &patch).map_err(|error| Error::Patch {
        target: what.to_owned(),
        message: error.to_string(),
    })?;
    Ok(candidate)
}

/// Names a JSON value's type, for an error message.
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// Builds the empty message a `TEXT_MESSAGE_START` opens.
fn empty_message(id: MessageId, role: TextMessageRole, name: Option<String>) -> Message {
    match role {
        TextMessageRole::Assistant => Message::Assistant(AssistantMessage {
            id,
            content: Some(String::new()),
            name,
            ..Default::default()
        }),
        TextMessageRole::User => Message::User(UserMessage {
            id,
            content: UserContent::Text(String::new()),
            name,
            ..Default::default()
        }),
        TextMessageRole::System => Message::System(SystemMessage {
            id,
            content: String::new(),
            name,
            ..Default::default()
        }),
        TextMessageRole::Developer => Message::Developer(DeveloperMessage {
            id,
            content: String::new(),
            name,
            ..Default::default()
        }),
    }
}

/// Appends streamed text to whichever field of the message carries it. An
/// activity message has none, and is not handed here.
fn append_text(message: &mut Message, delta: &str) {
    match message {
        Message::Assistant(m) => m.content.get_or_insert_with(String::new).push_str(delta),
        Message::System(m) => m.content.push_str(delta),
        Message::Developer(m) => m.content.push_str(delta),
        Message::Reasoning(m) => m.content.push_str(delta),
        Message::Tool(m) => match &mut m.content {
            ToolContent::Text(text) => text.push_str(delta),
            ToolContent::Parts(parts) => match parts.last_mut() {
                Some(InputContent::Text(text)) => text.text.push_str(delta),
                _ => parts.push(InputContent::text(delta)),
            },
        },
        Message::User(m) => match &mut m.content {
            UserContent::Text(text) => text.push_str(delta),
            UserContent::Parts(parts) => match parts.last_mut() {
                Some(InputContent::Text(text)) => text.text.push_str(delta),
                _ => parts.push(InputContent::Text(TextInputContent {
                    text: delta.to_owned(),
                    ..Default::default()
                })),
            },
        },
        Message::Activity(_) => {}
    }
}

/// Attaches a provider's opaque reasoning blob to a message, and says whether
/// the message could take it.
fn set_encrypted_value(message: &mut Message, blob: String) -> bool {
    let slot = match message {
        Message::Assistant(m) => &mut m.encrypted_value,
        Message::System(m) => &mut m.encrypted_value,
        Message::Developer(m) => &mut m.encrypted_value,
        Message::User(m) => &mut m.encrypted_value,
        Message::Tool(m) => &mut m.encrypted_value,
        Message::Reasoning(m) => &mut m.encrypted_value,
        // An activity has no field for it.
        Message::Activity(_) => return false,
    };
    *slot = Some(blob);
    true
}
