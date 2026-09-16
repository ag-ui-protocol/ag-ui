//! Turning a stream of events into materialised state.
//!
//! Consuming AG-UI is not "read a response". The agent sends deltas — a message
//! opens, text arrives a fragment at a time, tool arguments accumulate as
//! unparseable JSON fragments, state moves by RFC 6902 patch. [`Applier`] is the
//! state machine that folds all of that back into something a UI can draw:
//! a message list, a JSON state document, reasoning text, activities.
//!
//! It is a plain synchronous struct. No async, no runtime, no I/O — feed it
//! events from anywhere.
//!
//! ```
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
//! # Ok::<(), ag_ui::client::Error>(())
//! ```
//!
//! # What it does not do
//!
//! The applier is *tolerant*: an orphan `TEXT_MESSAGE_CONTENT` opens a message
//! rather than failing, because a half-drawn conversation beats a blank screen.
//! Catching the producer's mistake is [`crate::client::verify`]'s job, and
//! [`crate::client::Thread`] runs both. The one thing the applier refuses to do
//! quietly is corrupt state: a patch that does not apply is an error.

// The THINKING_* events are deprecated but still arrive on real streams, so
// this module has to name them. Downstream users still get the warnings.
#![allow(deprecated)]

use std::collections::{HashMap, HashSet};

use crate::{
    ActivityDeltaEvent, ActivityMessage, ActivitySnapshotEvent, AssistantMessage, DeveloperMessage,
    Event, InputContent, Interrupt, JsonObject, Message, MessageId, PatchOperation,
    ReasoningEncryptedValueEvent, ReasoningEncryptedValueSubtype, ReasoningMessage,
    ReasoningMessageChunkEvent, RunId, RunOutcome, SubagentErrorEvent, SubagentFinishedEvent,
    SubagentOutcome, SubagentRunId, SubagentStartedEvent, SystemMessage, TextInputContent,
    TextMessageChunkEvent, TextMessageRole, ThreadId, ToolCall, ToolCallChunkEvent, ToolCallId,
    ToolMessage, UserContent, UserMessage,
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
    /// Nothing a view would redraw: `STEP_*`, `RAW`, `CUSTOM`, or an event
    /// whose target does not exist.
    Nothing,
    /// One message was created, appended to, or completed.
    Message(MessageChange),
    /// `MESSAGES_SNAPSHOT` replaced the whole list. Messages may have been
    /// removed, so a view must redraw all of it.
    MessagesReplaced,
    /// The application state was replaced or patched.
    State,
    /// Reasoning content changed. Reasoning is kept out of [`Applier::messages`];
    /// see [`Applier::reasoning`].
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
    /// [`RunOutcome::Success`](https://docs.rs/ag-ui/0.4.2/ag_ui/outcome/enum.RunOutcome.html#variant.Success), which is what the protocol says it means.
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
#[derive(Clone, Debug, PartialEq)]
pub struct MessageChange {
    /// Index into [`Applier::messages`].
    pub index: usize,
    /// The message's id.
    pub id: MessageId,
    /// What happened to it.
    pub kind: MessageChangeKind,
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
#[derive(Clone, Debug, PartialEq)]
pub struct ReasoningChange {
    /// The reasoning message's id.
    pub id: MessageId,
    /// What happened to it.
    pub kind: ReasoningChangeKind,
}

/// What happened to a reasoning message.
///
/// [`Started`](Self::Started) and [`Ended`](Self::Ended) arrive **once per id**.
/// The protocol brackets a thought twice — `REASONING_START` opens the block and
/// `REASONING_MESSAGE_START` the message inside it, both under the same id, and
/// the two terminators close it the same way — but that is protocol framing, not
/// two things happening. A consumer that prints a finished thought prints it
/// once.
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
#[derive(Clone, Debug, PartialEq)]
pub struct SubagentChange {
    /// Index into [`Applier::subagents`].
    pub index: usize,
    /// The invocation's id.
    pub run_id: SubagentRunId,
    /// What happened to it.
    pub kind: SubagentChangeKind,
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

/// The materialised view of a run.
///
/// See the [module docs](self) for the shape of the problem this solves.
#[derive(Clone, Debug)]
pub struct Applier {
    messages: Vec<Message>,
    by_id: HashMap<MessageId, usize>,
    /// Tool call id to the index of the assistant message that owns it.
    tool_calls: HashMap<ToolCallId, usize>,
    /// Text messages open for content, with the subagent each belongs to —
    /// several at once under concurrent subagents. What a chunk that names
    /// no message is resolved against.
    open_text: Vec<(Option<SubagentRunId>, MessageId)>,
    state: Value,
    reasoning: Vec<ReasoningMessage>,
    reasoning_by_id: HashMap<MessageId, usize>,
    /// Reasoning ids started and not yet ended. What makes a thought report one
    /// [`ReasoningChangeKind::Started`] and one [`ReasoningChangeKind::Ended`]
    /// however many events the protocol brackets it with.
    open_reasoning: HashSet<MessageId>,
    /// The reasoning message the events that carry no id belong to — the
    /// `THINKING_*` family and a `REASONING_MESSAGE_CHUNK` after the first.
    current_reasoning: Option<MessageId>,
    /// `THINKING_*` carries no message id, so ids are minted for it.
    thinking_counter: u64,
    /// Reasoning messages open for content, with the subagent each belongs
    /// to — the reasoning counterpart of `open_text`, for the chunk shorthand.
    reasoning_streams: Vec<(Option<SubagentRunId>, MessageId)>,
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
            open_text: Vec::new(),
            state: Value::Object(JsonObject::new()),
            reasoning: Vec::new(),
            reasoning_by_id: HashMap::new(),
            open_reasoning: HashSet::new(),
            current_reasoning: None,
            thinking_counter: 0,
            reasoning_streams: Vec::new(),
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

    /// The assembled conversation, oldest first.
    pub fn messages(&self) -> &[Message] {
        &self.messages
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
            Message::Tool(m) => Some(&m.content),
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
    /// # Ok::<(), ag_ui::client::Error>(())
    /// ```
    pub fn state_as<T: for<'de> Deserialize<'de>>(&self) -> Result<T> {
        T::deserialize(&self.state).map_err(Error::State)
    }

    /// Replaces the application state without going through an event.
    pub fn set_state(&mut self, state: impl Into<Value>) {
        self.state = state.into();
    }

    /// The reasoning messages, oldest first.
    ///
    /// Reasoning is deliberately not in [`Applier::messages`]: a UI shows it in
    /// a separate pane, or not at all, and folding it into the transcript would
    /// make "the assistant's reply" ambiguous.
    pub fn reasoning(&self) -> &[ReasoningMessage] {
        &self.reasoning
    }

    /// The accumulated reasoning text for one reasoning message.
    pub fn reasoning_text(&self, id: &MessageId) -> Option<&str> {
        self.reasoning_by_id
            .get(id)
            .and_then(|index| self.reasoning.get(*index))
            .map(|message| message.content.as_str())
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
    /// is waiting for human input; cleared when the next run starts.
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
    /// Chunk events are accepted here as well as their expanded form, so an
    /// applier driven directly from a raw stream still assembles correctly —
    /// but [`crate::client::chunks`] is the place that turns them into the explicit
    /// triples the rest of the protocol is written in.
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
            Event::TextMessageChunk(e) => self.text_chunk(e),

            Event::ToolCallStart(e) => Ok(self.tool_call_start(
                e.tool_call_id.clone(),
                e.tool_call_name.clone(),
                e.parent_message_id.clone(),
                e.subagent_run_id.clone(),
            )),
            Event::ToolCallArgs(e) => self.tool_call_args(&e.tool_call_id, &e.delta),
            Event::ToolCallEnd(e) => Ok(self.tool_call_end(&e.tool_call_id)),
            Event::ToolCallChunk(e) => self.tool_call_chunk(e),
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
                apply_patch(&mut self.state, &e.delta, "state")?;
                Ok(Changed::State)
            }
            Event::MessagesSnapshot(e) => {
                self.merge_snapshot(e.messages.clone());
                Ok(Changed::MessagesReplaced)
            }

            Event::ActivitySnapshot(e) => Ok(self.activity_snapshot(e)),
            Event::ActivityDelta(e) => self.activity_delta(e),

            Event::ReasoningStart(e) => {
                Ok(self.reasoning_start(e.message_id.clone(), e.subagent_run_id.clone()))
            }
            Event::ReasoningMessageStart(e) => {
                Ok(self.reasoning_start(e.message_id.clone(), e.subagent_run_id.clone()))
            }
            Event::ReasoningMessageContent(e) => {
                Ok(self.reasoning_content(&e.message_id, &e.delta, &e.subagent_run_id))
            }
            Event::ReasoningMessageEnd(e) => Ok(self.reasoning_end(&e.message_id)),
            Event::ReasoningEnd(e) => Ok(self.reasoning_end(&e.message_id)),
            Event::ReasoningMessageChunk(e) => self.reasoning_chunk(e),
            Event::ReasoningEncryptedValue(e) => Ok(self.encrypted_value(e)),

            // The THINKING_* family predates subagents and carries no
            // attribution, so a thought it opens is the parent's.
            Event::ThinkingStart(_) => {
                let id = self.mint_thinking_id();
                Ok(self.reasoning_start(id, None))
            }
            Event::ThinkingTextMessageStart(_) => {
                let id = self.thinking_id();
                Ok(self.reasoning_start(id, None))
            }
            Event::ThinkingTextMessageContent(e) => {
                let id = self.thinking_id();
                Ok(self.reasoning_content(&id, &e.delta, &None))
            }
            Event::ThinkingTextMessageEnd(_) | Event::ThinkingEnd(_) => {
                Ok(match self.current_reasoning.clone() {
                    Some(id) => self.reasoning_end(&id),
                    None => Changed::Nothing,
                })
            }

            Event::RunStarted(e) => {
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
            Event::RunError(e) => Ok(Changed::RunError {
                message: e.message.clone(),
                code: e.code.clone(),
            }),

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
        reasoning: Vec<ReasoningMessage>,
        subagents: Vec<Subagent>,
        interrupts: Vec<Interrupt>,
    ) {
        self.reasoning_by_id = reasoning
            .iter()
            .enumerate()
            .map(|(i, message)| (message.id.clone(), i))
            .collect();
        self.reasoning = reasoning;
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
        self.current_reasoning = None;
        self.reasoning_streams.clear();
    }

    pub(crate) fn abort_messages(&mut self) -> (Vec<MessageChange>, Vec<ReasoningChange>) {
        let messages = self
            .open_text
            .iter()
            .filter_map(|(_, id)| {
                self.by_id.get(id).map(|index| MessageChange {
                    index: *index,
                    id: id.clone(),
                    kind: MessageChangeKind::Aborted,
                })
            })
            .collect();
        let reasoning = self
            .open_reasoning
            .iter()
            .map(|id| ReasoningChange {
                id: id.clone(),
                kind: ReasoningChangeKind::Aborted,
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
        for (index, message) in messages.iter().enumerate() {
            self.by_id.insert(message.id().clone(), index);
            if let Message::Assistant(assistant) = message {
                for call in assistant.tool_calls.iter().flatten() {
                    self.tool_calls.insert(call.id.clone(), index);
                }
            }
        }
        self.messages = messages;
        // A snapshot can drop a message that was being streamed into.
        let by_id = &self.by_id;
        self.open_text.retain(|(_, open)| by_id.contains_key(open));
    }

    /// Folds a `MESSAGES_SNAPSHOT` into the conversation.
    ///
    /// A snapshot is an *edit*, not a replacement — upstream
    /// (`client/src/apply/default.ts`, `case EventType.MESSAGES_SNAPSHOT`)
    /// rebuilds the list by filtering the local one and appending whatever the
    /// snapshot adds. Three consequences, all of them load-bearing:
    ///
    /// - the order the client already had wins for every id the snapshot also
    ///   carries, so a backend that reorders its own history does not reshuffle
    ///   the transcript under the user;
    /// - messages the snapshot leaves out are dropped — that is how a
    ///   summarizing backend deletes turns;
    /// - except `activity`, which survives a snapshot that carries none.
    ///   Activity never travels back to the backend, so one that does not track
    ///   it *cannot* list it, and dropping the local copies would clear a pane
    ///   of the UI on every snapshot. A snapshot that does carry activity is
    ///   declaring the whole set, so an activity missing from it has been
    ///   deleted; without that half, a client-side activity would be
    ///   undeletable.
    ///
    /// Upstream's rule has a fourth clause, for `reasoning`. It needs no
    /// equivalent here: reasoning lives in [`Applier::reasoning`], not in
    /// [`Applier::messages`], so a snapshot of the conversation cannot drop it.
    fn merge_snapshot(&mut self, snapshot: Vec<Message>) {
        let snapshot_owns_activity = snapshot.iter().any(|m| matches!(m, Message::Activity(_)));

        // `Option` slots so a message can be moved out when it is placed, and
        // whatever is left over is exactly what the snapshot added.
        let mut incoming: Vec<Option<Message>> = snapshot.into_iter().map(Some).collect();
        let mut position: HashMap<MessageId, usize> = HashMap::with_capacity(incoming.len());
        for (index, message) in incoming.iter().enumerate() {
            let id = message.as_ref().expect("every slot starts full").id();
            position.insert(id.clone(), index);
        }

        let previous = std::mem::take(&mut self.messages);
        let mut merged = Vec::with_capacity(previous.len().max(incoming.len()));
        for message in previous {
            let keep_local = !snapshot_owns_activity && matches!(message, Message::Activity(_));
            if let Some(index) = position.get(message.id()).copied() {
                if keep_local {
                    // Claim the slot so the snapshot's copy is not appended on
                    // top of the local one further down.
                    incoming[index] = None;
                } else if let Some(replacement) = incoming[index].take() {
                    merged.push(replacement);
                    continue;
                }
            }
            if keep_local {
                merged.push(message);
            }
        }
        merged.extend(incoming.into_iter().flatten());

        self.replace_messages(merged);
    }

    fn message_change(&self, id: &MessageId, kind: MessageChangeKind) -> Changed {
        match self.by_id.get(id) {
            Some(index) => Changed::Message(MessageChange {
                index: *index,
                id: id.clone(),
                kind,
            }),
            None => Changed::Nothing,
        }
    }

    fn text_start(
        &mut self,
        id: MessageId,
        role: TextMessageRole,
        name: Option<String>,
        owner: Option<SubagentRunId>,
    ) -> Changed {
        self.open_text.retain(|(_, open)| open != &id);
        self.open_text.push((owner.clone(), id.clone()));
        if let Some(index) = self.by_id.get(&id) {
            // Re-opening a known id keeps the message and appends to it, which
            // is what a producer that restarts a stream means — and keeps its
            // attribution, which the opener transferred once.
            return Changed::Message(MessageChange {
                index: *index,
                id,
                kind: MessageChangeKind::Started,
            });
        }
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
            // Tolerant: an orphan content event opens the message it names.
            self.text_start(id.clone(), TextMessageRole::Assistant, None, owner.clone());
        }
        let Some(index) = self.by_id.get(id).copied() else {
            return Ok(Changed::Nothing);
        };
        let Some(message) = self.messages.get_mut(index) else {
            return Ok(Changed::Nothing);
        };
        append_text(message, delta)?;
        Ok(Changed::Message(MessageChange {
            index,
            id: id.clone(),
            kind: MessageChangeKind::Content {
                delta: delta.to_owned(),
            },
        }))
    }

    fn text_end(&mut self, id: &MessageId) -> Changed {
        self.open_text.retain(|(_, open)| open != id);
        self.message_change(id, MessageChangeKind::Ended)
    }

    /// A `TEXT_MESSAGE_CHUNK` applied directly.
    ///
    /// Reachable only for a caller driving the applier itself: a
    /// [`Thread`](crate::client::Thread) puts a
    /// [`ChunkNormalizer`](crate::client::ChunkNormalizer) in front, which expands
    /// chunks before they get here. The difference is that the normalizer also
    /// synthesizes the *end* of a chunk stream; this does not, because an
    /// applier never invents an event nobody sent.
    fn text_chunk(&mut self, event: &TextMessageChunkEvent) -> Result<Changed> {
        let id = match &event.message_id {
            Some(id) => id.clone(),
            None => resolve_open(
                &self.open_text,
                &event.subagent_run_id,
                "TEXT_MESSAGE_CHUNK",
                "message",
            )?,
        };
        if !self.open_text.iter().any(|(_, open)| open == &id) {
            self.text_start(
                id.clone(),
                event.role.unwrap_or_default(),
                event.name.clone(),
                event.subagent_run_id.clone(),
            );
        }
        match &event.delta {
            Some(delta) => self.text_content(&id, delta, &event.subagent_run_id),
            None => Ok(self.message_change(&id, MessageChangeKind::Started)),
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
        // A call with no parent belongs to a message of its own; the call id is
        // the only id available to name it. A message created here takes the
        // call's attribution; one that already exists keeps its own.
        let parent =
            parent_message_id.unwrap_or_else(|| MessageId::new(format!("{tool_call_id}-message")));
        let index = match self.by_id.get(&parent) {
            Some(index) => *index,
            None => self.push_message(Message::Assistant(AssistantMessage {
                id: parent.clone(),
                subagent_run_id: owner,
                ..Default::default()
            })),
        };
        // The parent may exist and not be an assistant message, in which case
        // there is nowhere to hang the call and nothing changes.
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
            id: parent,
            kind: MessageChangeKind::ToolCallStarted { tool_call_id, name },
        })
    }

    fn tool_call_args(&mut self, tool_call_id: &ToolCallId, delta: &str) -> Result<Changed> {
        let Some(index) = self.tool_calls.get(tool_call_id).copied() else {
            return Err(Error::protocol(format!(
                "TOOL_CALL_ARGS for unknown tool call {tool_call_id:?}"
            )));
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

    fn tool_call_chunk(&mut self, event: &ToolCallChunkEvent) -> Result<Changed> {
        let known = event
            .tool_call_id
            .as_ref()
            .is_some_and(|id| self.tool_calls.contains_key(id));
        match (&event.tool_call_id, known) {
            (Some(id), false) => {
                let Some(name) = event.tool_call_name.clone() else {
                    return Err(Error::protocol(format!(
                        "TOOL_CALL_CHUNK opens tool call {id:?} without a toolCallName"
                    )));
                };
                let started = self.tool_call_start(
                    id.clone(),
                    name,
                    event.parent_message_id.clone(),
                    event.subagent_run_id.clone(),
                );
                match &event.delta {
                    Some(delta) => self.tool_call_args(id, delta),
                    None => Ok(started),
                }
            }
            (Some(id), true) => match &event.delta {
                Some(delta) => self.tool_call_args(id, delta),
                None => Ok(self.tool_call_end(id)),
            },
            (None, _) => Err(Error::protocol(
                "TOOL_CALL_CHUNK carries no toolCallId and no call is open",
            )),
        }
    }

    fn tool_call_result(
        &mut self,
        message_id: MessageId,
        tool_call_id: ToolCallId,
        content: String,
        owner: Option<SubagentRunId>,
    ) -> Changed {
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
        let is_new = !self.by_id.contains_key(&event.message_id);
        let index = self.activity_index(&event.message_id, &event.activity_type);
        if let Some(Message::Activity(activity)) = self.messages.get_mut(index) {
            activity.activity_type = event.activity_type.clone();
            // A replacing snapshot re-mints the activity, attribution
            // included: one that carries none takes the activity back for
            // the parent. A merge leaves the message where it was, and the
            // verifier holds a following delta to that owner.
            if is_new || event.replace {
                activity.subagent_run_id = event.subagent_run_id.clone();
            }
            if event.replace {
                activity.content = event.content.clone();
            } else {
                // `replace: false` is a merge, and RFC 7396 is the merge the
                // protocol's sibling patch format defines.
                let mut merged = Value::Object(std::mem::take(&mut activity.content));
                json_patch::merge(&mut merged, &Value::Object(event.content.clone()));
                if let Value::Object(object) = merged {
                    activity.content = object;
                }
            }
        }
        Changed::Message(MessageChange {
            index,
            id: event.message_id.clone(),
            kind: MessageChangeKind::Activity,
        })
    }

    fn activity_delta(&mut self, event: &ActivityDeltaEvent) -> Result<Changed> {
        let index = self.activity_index(&event.message_id, &event.activity_type);
        if let Some(Message::Activity(activity)) = self.messages.get_mut(index) {
            let what = format!("activity {}", event.message_id);
            // Patched on a copy, and committed only once the result is still an
            // object. An activity's content is an object by definition, so a
            // whole-document operation — `{"op":"replace","path":"","value":7}`
            // — has nowhere to land; taking the content out first would leave
            // the activity holding nothing at all.
            let mut content = Value::Object(activity.content.clone());
            apply_patch(&mut content, &event.patch, &what)?;
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
        }
        Ok(Changed::Message(MessageChange {
            index,
            id: event.message_id.clone(),
            kind: MessageChangeKind::Activity,
        }))
    }

    /// The index of the activity message with this id, creating it if the
    /// producer patched an activity it never published.
    fn activity_index(&mut self, id: &MessageId, activity_type: &str) -> usize {
        match self.by_id.get(id).copied() {
            Some(index) => index,
            None => self.push_message(Message::Activity(ActivityMessage {
                id: id.clone(),
                activity_type: activity_type.to_owned(),
                content: JsonObject::new(),
                ..Default::default()
            })),
        }
    }

    // ---- reasoning ------------------------------------------------------

    /// Opens a reasoning message, or reports nothing when it is already open.
    ///
    /// `REASONING_START` and `REASONING_MESSAGE_START` both land here under the
    /// same id — the block and the message inside it — and so does the
    /// `THINKING_*` pair. Only the first of them starts anything.
    fn reasoning_start(&mut self, id: MessageId, owner: Option<SubagentRunId>) -> Changed {
        self.current_reasoning = Some(id.clone());
        self.reasoning_streams.retain(|(_, open)| open != &id);
        self.reasoning_streams.push((owner.clone(), id.clone()));
        if !self.reasoning_by_id.contains_key(&id) {
            self.reasoning_by_id
                .insert(id.clone(), self.reasoning.len());
            self.reasoning.push(ReasoningMessage {
                id: id.clone(),
                subagent_run_id: owner,
                ..Default::default()
            });
        }
        if !self.open_reasoning.insert(id.clone()) {
            return Changed::Nothing;
        }
        Changed::Reasoning(ReasoningChange {
            id,
            kind: ReasoningChangeKind::Started,
        })
    }

    /// A fresh id for a `THINKING_*` block.
    ///
    /// Those events carry no `messageId` at all, so the applier has to invent
    /// one — and it has to be the same one for the whole block, which is what
    /// [`Applier::thinking_id`] is for.
    fn mint_thinking_id(&mut self) -> MessageId {
        loop {
            self.thinking_counter += 1;
            let id = MessageId::new(format!("thinking-{}", self.thinking_counter));
            if !self.reasoning_by_id.contains_key(&id) {
                return id;
            }
        }
    }

    /// The id a `THINKING_*` event belongs to, minting one when the producer
    /// sent content before its `THINKING_START`.
    ///
    /// Only resolves the id; opening it is the caller's, so that the caller can
    /// report whether the open was the one that started the thought.
    fn thinking_id(&mut self) -> MessageId {
        match self.current_reasoning.clone() {
            Some(id) => id,
            None => self.mint_thinking_id(),
        }
    }

    fn reasoning_content(
        &mut self,
        id: &MessageId,
        delta: &str,
        owner: &Option<SubagentRunId>,
    ) -> Changed {
        if !self.reasoning_by_id.contains_key(id) {
            self.reasoning_start(id.clone(), owner.clone());
        }
        if let Some(message) = self
            .reasoning_by_id
            .get(id)
            .and_then(|index| self.reasoning.get_mut(*index))
        {
            message.content.push_str(delta);
        }
        Changed::Reasoning(ReasoningChange {
            id: id.clone(),
            kind: ReasoningChangeKind::Content {
                delta: delta.to_owned(),
            },
        })
    }

    /// A `REASONING_MESSAGE_CHUNK` applied directly. See
    /// [`Applier::text_chunk`] for when that happens.
    fn reasoning_chunk(&mut self, event: &ReasoningMessageChunkEvent) -> Result<Changed> {
        let id = match &event.message_id {
            Some(id) => id.clone(),
            None => resolve_open(
                &self.reasoning_streams,
                &event.subagent_run_id,
                "REASONING_MESSAGE_CHUNK",
                "reasoning message",
            )?,
        };
        let started = if self.open_reasoning.contains(&id) {
            Changed::Nothing
        } else {
            self.reasoning_start(id.clone(), event.subagent_run_id.clone())
        };
        Ok(match &event.delta {
            Some(delta) => self.reasoning_content(&id, delta, &event.subagent_run_id),
            // A chunk with no delta only opens, so it reports whatever the open
            // did — nothing at all when the message was already open.
            None => started,
        })
    }

    /// Closes a reasoning message, or reports nothing when it is already closed.
    ///
    /// The mirror of [`Applier::reasoning_start`]: `REASONING_MESSAGE_END` and
    /// `REASONING_END` are two events closing one thought, and a consumer that
    /// prints a finished thought has to see it finish once.
    fn reasoning_end(&mut self, id: &MessageId) -> Changed {
        if self.current_reasoning.as_ref() == Some(id) {
            self.current_reasoning = None;
        }
        self.reasoning_streams.retain(|(_, open)| open != id);
        if !self.open_reasoning.remove(id) {
            return Changed::Nothing;
        }
        Changed::Reasoning(ReasoningChange {
            id: id.clone(),
            kind: ReasoningChangeKind::Ended,
        })
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
            ReasoningEncryptedValueSubtype::Message => {
                let id = MessageId::new(event.entity_id.clone());
                if let Some(message) = self
                    .reasoning_by_id
                    .get(&id)
                    .and_then(|index| self.reasoning.get_mut(*index))
                {
                    message.encrypted_value = Some(blob);
                    return Changed::Reasoning(ReasoningChange {
                        id,
                        kind: ReasoningChangeKind::EncryptedValue,
                    });
                }
                let Some(index) = self.by_id.get(&id).copied() else {
                    return Changed::Nothing;
                };
                if let Some(message) = self.messages.get_mut(index) {
                    set_encrypted_value(message, blob);
                }
                Changed::Message(MessageChange {
                    index,
                    id,
                    kind: MessageChangeKind::EncryptedValue,
                })
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
            if event.parent_subagent_run_id.is_some() {
                subagent
                    .parent_subagent_run_id
                    .clone_from(&event.parent_subagent_run_id);
            }
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
            parent_subagent_run_id: event.parent_subagent_run_id.clone(),
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
            | Event::TextMessageChunk(_)
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
            Event::ToolCallStart(_)
            | Event::ToolCallArgs(_)
            | Event::ToolCallEnd(_)
            | Event::ToolCallChunk(_) => {
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
            | Event::ReasoningMessageEnd(_)
            | Event::ReasoningMessageChunk(_) => {
                let id = match (event, changed) {
                    (Event::ReasoningMessageStart(e), _) => e.message_id.clone(),
                    (Event::ReasoningMessageContent(e), _) => e.message_id.clone(),
                    (Event::ReasoningMessageEnd(e), _) => e.message_id.clone(),
                    (_, Changed::Reasoning(change)) => change.id.clone(),
                    _ => return,
                };
                if let Some(message) = self
                    .reasoning_by_id
                    .get(&id)
                    .and_then(|index| self.reasoning.get_mut(*index))
                {
                    merge_metadata_into(&mut message.metadata, Some(metadata));
                }
            }
            _ => {}
        }
    }
}

/// The stream a chunk without an id continues: the one its subagent has
/// open; for an untagged chunk the parent's, else the sole open one — and when
/// several subagents could claim it, an error rather than a guess.
fn resolve_open(
    streams: &[(Option<SubagentRunId>, MessageId)],
    tag: &Option<SubagentRunId>,
    kind: &str,
    what: &str,
) -> Result<MessageId> {
    if tag.is_some() {
        return streams
            .iter()
            .rev()
            .find(|(owner, _)| owner == tag)
            .map(|(_, id)| id.clone())
            .ok_or_else(|| {
                Error::protocol(format!(
                    "{kind} carries no messageId and subagent {:?} has no {what} open",
                    tag.as_deref().unwrap_or_default()
                ))
            });
    }
    if let Some((_, id)) = streams.iter().rev().find(|(owner, _)| owner.is_none()) {
        return Ok(id.clone());
    }
    match streams {
        [] => Err(Error::protocol(format!(
            "{kind} carries no messageId and no {what} is open"
        ))),
        [(_, id)] => Ok(id.clone()),
        _ => Err(Error::protocol(format!(
            "{kind} carries no messageId and several subagents have a {what} open; \
             attribute the chunk"
        ))),
    }
}

/// Applies an RFC 6902 patch, leaving `target` untouched when it fails.
fn apply_patch(target: &mut Value, operations: &[PatchOperation], what: &str) -> Result<()> {
    // The protocol's operation type and the patch engine's are both the RFC
    // wire format, so JSON is the conversion. Deserializing is also where a
    // malformed JSON Pointer is caught, before anything is mutated.
    let document = serde_json::to_value(operations)?;
    let patch: json_patch::Patch =
        serde_json::from_value(document).map_err(|error| Error::Patch {
            target: what.to_owned(),
            message: format!("invalid patch document: {error}"),
        })?;
    json_patch::patch(target, &patch).map_err(|error| Error::Patch {
        target: what.to_owned(),
        message: error.to_string(),
    })
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

/// Appends streamed text to whichever field of the message carries it.
fn append_text(message: &mut Message, delta: &str) -> Result<()> {
    match message {
        Message::Assistant(m) => m.content.get_or_insert_with(String::new).push_str(delta),
        Message::System(m) => m.content.push_str(delta),
        Message::Developer(m) => m.content.push_str(delta),
        Message::Reasoning(m) => m.content.push_str(delta),
        Message::Tool(m) => m.content.push_str(delta),
        Message::User(m) => match &mut m.content {
            UserContent::Text(text) => text.push_str(delta),
            UserContent::Parts(parts) => match parts.last_mut() {
                Some(InputContent::Text(text)) => text.text.push_str(delta),
                _ => parts.push(InputContent::Text(TextInputContent {
                    text: delta.to_owned(),
                })),
            },
        },
        Message::Activity(m) => {
            return Err(Error::protocol(format!(
                "text streamed into activity message {:?}, which has no text",
                m.id
            )));
        }
    }
    Ok(())
}

/// Attaches a provider's opaque reasoning blob to a message.
fn set_encrypted_value(message: &mut Message, blob: String) {
    match message {
        Message::Assistant(m) => m.encrypted_value = Some(blob),
        Message::System(m) => m.encrypted_value = Some(blob),
        Message::Developer(m) => m.encrypted_value = Some(blob),
        Message::User(m) => m.encrypted_value = Some(blob),
        Message::Tool(m) => m.encrypted_value = Some(blob),
        Message::Reasoning(m) => m.encrypted_value = Some(blob),
        // An activity has no field for it.
        Message::Activity(_) => {}
    }
}
