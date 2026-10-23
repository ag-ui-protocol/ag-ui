//! Client-side protocol verification.
//!
//! The TypeScript SDK puts its verifier on the *client*, and that is the right
//! instinct for a consumer: the events arrive from someone else's process, and
//! a stream that breaks the rules should produce one clear error rather than a
//! confused UI. This module is that check, as an ordering state machine.
//!
//! [`crate::client::Thread`] runs it by default. Turn it off with
//! [`ThreadBuilder::verify`](crate::client::ThreadBuilder::verify) when talking to a
//! producer whose quirks you have decided to live with.
//!
//! ```
//! use ag_ui::client::verify::Verifier;
//! use ag_ui::Event;
//!
//! let mut verifier = Verifier::new();
//! verifier.verify(&Event::run_started("thread-1", "run-1"))?;
//!
//! // Content for a message that was never opened.
//! let orphan = Event::text_message_content("msg-1", "Hello");
//! assert!(verifier.verify(&orphan).is_err());
//! # Ok::<(), ag_ui::client::Error>(())
//! ```
//!
//! # The rules
//!
//! 1. `RUN_STARTED` opens the stream, and does so exactly once. Only `RAW` and
//!    `CUSTOM` may precede it.
//! 2. `RUN_FINISHED` and `RUN_ERROR` close it. Nothing may follow.
//! 3. `TEXT_MESSAGE_CONTENT` and `TEXT_MESSAGE_END` require an open message
//!    with the same id, and `TEXT_MESSAGE_START` may not re-open an id that is
//!    already open.
//! 4. The same, for `TOOL_CALL_*` and for `REASONING_MESSAGE_*`.
//! 5. `TOOL_CALL_RESULT` may not answer a call that has not ended.
//! 6. `STEP_FINISHED` requires a matching `STEP_STARTED`, and step names do not
//!    nest with themselves.
//! 7. Everything open must be closed before `RUN_FINISHED`.
//! 8. An `interrupt` outcome must carry at least one interrupt — the one rule
//!    the type system cannot express, checked by
//!    [`RunOutcome::validate`](crate::outcome::RunOutcome::validate).
//! 9. A continuation, terminator or re-open that *names* a subagent must name
//!    the one that opened the entity — a message, a reasoning block or the
//!    message inside it, a tool call, an activity, or whatever a
//!    `REASONING_ENCRYPTED_VALUE` attaches to. One that names none is
//!    accepted: attribution is optional per event, and a bare continuation is
//!    what a pre-subagent producer sends. It does not hand the entity to the
//!    parent either: the first writer stays the owner.
//! 10. A tool call belongs to the message its `parentMessageId` names, so a
//!     `TOOL_CALL_START` tagged with one subagent while that message belongs
//!     to another is rejected; an untagged one inherits the message's owner.
//! 11. Steps are scoped to the agent that opened them: a subagent cannot close
//!     the parent's step, or a sibling's, and the same name may be open under
//!     two owners at once.
//! 12. `SUBAGENT_STARTED` names an invocation that is neither active nor
//!     already finished in this run, and a `parentSubagentRunId` that was
//!     started. `SUBAGENT_FINISHED` and `SUBAGENT_ERROR` name an active one.
//! 13. Every started subagent is closed before `RUN_FINISHED` — not before
//!     `RUN_ERROR`, where an unclosed subagent is the expected shape.
//!
//! What is deliberately *not* a rule: that one stream must close before the
//! next opens. Everything here is keyed by id, exactly as the TypeScript
//! verifier keys its `activeMessages` / `activeToolCalls` maps. Two messages
//! may stream at once, two tool calls may stream at once, and a tool call may
//! open inside the message that narrates it — which is what every provider
//! doing parallel tool calls actually sends. Nor must an attributing
//! `subagentRunId` have been announced: attribution without lifecycle events
//! is a supported mode. Events outside these families (state, activity, raw,
//! custom) are unordered and never close anything. A `MESSAGES_SNAPSHOT`
//! seeds ownership from the messages it carries and is authoritative; the
//! `RUN_STARTED` input echo seeds it too, for ids not yet recorded; and a
//! `TOOL_CALL_RESULT` mints the tool message it names under its own
//! attribution.

// The THINKING_* events are deprecated but a verifier still has to recognise
// them.
#![allow(deprecated)]

use std::collections::{HashMap, HashSet};

use crate::{
    Event, EventType, Message, MessageId, ReasoningEncryptedValueSubtype, StepName, SubagentRunId,
    ToolCallId,
};

use crate::client::error::{Error, Result};

/// Who opened an entity: a subagent, or the parent agent when `None`.
type Owner = Option<SubagentRunId>;

fn describe(owner: &Owner) -> String {
    match owner {
        None => "the parent agent".to_owned(),
        Some(id) => format!("subagent {:?}", id.as_str()),
    }
}

/// An ordering state machine for one run's event stream.
///
/// One verifier per run: it is stateful, and its state is that run's progress.
#[derive(Clone, Debug, Default)]
pub struct Verifier {
    started: bool,
    finished: bool,
    /// What is open, by id, with the owner that opened it — several at once
    /// is legal, the same id twice is not. `Vec` rather than a map so a
    /// complaint names whichever was opened first, which is the one a human
    /// is looking for.
    text: Vec<(MessageId, Owner)>,
    tool: Vec<(ToolCallId, Owner)>,
    reasoning: Vec<(MessageId, Owner)>,
    /// Open steps, keyed by owner as well as name.
    steps: Vec<(Owner, StepName)>,
    /// Every text message ever introduced and who owns it: the first writer.
    /// A tool call inherits the owner of the message that carries it, which
    /// may have closed.
    message_owners: HashMap<MessageId, Owner>,
    /// The same for reasoning — the block and the message inside it share an
    /// id and an owner. A bucket of its own, as upstream keeps it, so a
    /// producer that reuses an id across the two kinds is not accused of
    /// contradicting itself.
    reasoning_owners: HashMap<MessageId, Owner>,
    /// Every tool call ever introduced and who owns it.
    tool_call_owners: HashMap<ToolCallId, Owner>,
    /// Every activity ever introduced and who owns it: opened by a snapshot,
    /// continued by deltas against the same id.
    activity_owners: HashMap<MessageId, Owner>,
    subagents: Vec<SubagentRunId>,
    /// Ids closed in this run: an id names one invocation.
    closed_subagents: HashSet<SubagentRunId>,
}

impl Verifier {
    /// A verifier for a stream that has not started yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the run has reached a terminal event.
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Checks one event against the rules, and records it.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`], naming the rule that was broken.
    pub fn verify(&mut self, event: &Event) -> Result<()> {
        let kind = event.event_type();

        if self.finished {
            return Err(Error::protocol(format!(
                "{kind} arrived after the run had already finished"
            )));
        }

        // RAW and CUSTOM are outside the protocol's vocabulary by definition,
        // so they are outside its ordering too.
        if matches!(kind, EventType::Raw | EventType::Custom) {
            return Ok(());
        }

        if !self.started && kind != EventType::RunStarted {
            return Err(Error::protocol(format!(
                "{kind} arrived before RUN_STARTED"
            )));
        }

        match event {
            Event::RunStarted(e) => {
                if self.started {
                    return Err(Error::protocol("RUN_STARTED arrived twice in one stream"));
                }
                self.started = true;
                // The input echo replays history the applier applies, so it
                // seeds ownership like a snapshot does — for ids not yet
                // recorded, since it is history rather than a rewrite.
                if let Some(input) = &e.input {
                    self.seed_owners(&input.messages, false);
                }
            }

            Event::TextMessageStart(e) => {
                let owner = self.claim(kind, &e.message_id, &e.subagent_run_id, false)?;
                self.not_already_open(
                    self.text.iter().map(|(id, _)| id),
                    &e.message_id,
                    "message",
                    kind,
                )?;
                self.text.push((e.message_id.clone(), owner));
            }
            Event::TextMessageContent(e) => {
                self.expect_text(&e.message_id, &e.subagent_run_id, kind)?;
            }
            Event::TextMessageEnd(e) => {
                self.expect_text(&e.message_id, &e.subagent_run_id, kind)?;
                self.text.retain(|(open, _)| open != &e.message_id);
            }

            Event::ToolCallStart(e) => {
                let owner = self.resolve_tool_call_owner(
                    kind,
                    &e.tool_call_id,
                    e.parent_message_id.as_ref(),
                    &e.subagent_run_id,
                )?;
                self.not_already_open(
                    self.tool.iter().map(|(id, _)| id),
                    &e.tool_call_id,
                    "tool call",
                    kind,
                )?;
                self.tool.push((e.tool_call_id.clone(), owner.clone()));
                self.tool_call_owners.insert(e.tool_call_id.clone(), owner);
            }
            Event::ToolCallArgs(e) => {
                self.expect_tool(&e.tool_call_id, &e.subagent_run_id, kind)?;
            }
            Event::ToolCallEnd(e) => {
                self.expect_tool(&e.tool_call_id, &e.subagent_run_id, kind)?;
                self.tool.retain(|(open, _)| open != &e.tool_call_id);
            }
            // The call this answers has to be over. Anything *else* still
            // streaming is none of this event's business — a result arriving
            // while the assistant keeps narrating is ordinary. Its attribution
            // is its own, too: the party that executes a call can differ from
            // the one that requested it.
            Event::ToolCallResult(e) => {
                if self.tool.iter().any(|(open, _)| open == &e.tool_call_id) {
                    return Err(Error::protocol(format!(
                        "{kind} for tool call {:?}, which has not ended yet",
                        e.tool_call_id.as_str()
                    )));
                }
                // A result mints the tool message it names, under its own
                // attribution — so the newest mint wins, and a re-open of
                // that message by someone else has an owner to disagree with.
                self.message_owners
                    .insert(e.message_id.clone(), e.subagent_run_id.clone());
            }

            // The block and the message inside it share an id and claim the
            // same owner: `REASONING_START` under one subagent and
            // `REASONING_MESSAGE_START` under another is a contradiction. The
            // block's bracketing is not otherwise tracked (rule 4 is about the
            // message), only its ownership.
            Event::ReasoningStart(e) => {
                self.claim(kind, &e.message_id, &e.subagent_run_id, true)?;
            }
            Event::ReasoningEnd(e) => {
                if let Some(owner) = self.reasoning_owners.get(&e.message_id) {
                    Self::expect_owner(
                        kind,
                        "reasoning message",
                        e.message_id.as_str(),
                        owner,
                        &e.subagent_run_id,
                    )?;
                }
            }
            Event::ReasoningMessageStart(e) => {
                let owner = self.claim(kind, &e.message_id, &e.subagent_run_id, true)?;
                self.not_already_open(
                    self.reasoning.iter().map(|(id, _)| id),
                    &e.message_id,
                    "reasoning message",
                    kind,
                )?;
                self.reasoning.push((e.message_id.clone(), owner));
            }
            Event::ReasoningMessageContent(e) => {
                self.expect_reasoning(&e.message_id, &e.subagent_run_id, kind)?;
            }
            Event::ReasoningMessageEnd(e) => {
                self.expect_reasoning(&e.message_id, &e.subagent_run_id, kind)?;
                self.reasoning.retain(|(open, _)| open != &e.message_id);
            }
            // Continues an entity by id, and `subtype` says which kind — a
            // tool call's owner lives in a different map from a message's.
            Event::ReasoningEncryptedValue(e) => {
                let (what, owner) = match e.subtype {
                    ReasoningEncryptedValueSubtype::ToolCall => (
                        "tool call",
                        self.tool_call_owners
                            .get(&ToolCallId::new(e.entity_id.clone())),
                    ),
                    // "message" spans both kinds; ids are unique per kind, so
                    // at most one bucket answers.
                    ReasoningEncryptedValueSubtype::Message => {
                        let id = MessageId::new(e.entity_id.clone());
                        (
                            "message",
                            self.message_owners
                                .get(&id)
                                .or_else(|| self.reasoning_owners.get(&id)),
                        )
                    }
                };
                if let Some(owner) = owner {
                    Self::expect_owner(kind, what, &e.entity_id, owner, &e.subagent_run_id)?;
                }
            }

            // An activity is opened by a snapshot and continued by deltas
            // against the same id. Only a *replacing* snapshot re-mints it and
            // so re-owns it; with `replace: false` the applier leaves the
            // existing message where it was, and so does the recorded owner.
            Event::ActivitySnapshot(e) => {
                if e.replace || !self.activity_owners.contains_key(&e.message_id) {
                    self.activity_owners
                        .insert(e.message_id.clone(), e.subagent_run_id.clone());
                }
            }
            Event::ActivityDelta(e) => {
                if let Some(owner) = self.activity_owners.get(&e.message_id) {
                    Self::expect_owner(
                        kind,
                        "activity",
                        e.message_id.as_str(),
                        owner,
                        &e.subagent_run_id,
                    )?;
                }
            }

            Event::StepStarted(e) => {
                let key = (e.subagent_run_id.clone(), e.step_name.clone());
                if self.steps.contains(&key) {
                    return Err(Error::protocol(format!(
                        "STEP_STARTED for {:?}, which is already running under {}",
                        e.step_name.as_str(),
                        describe(&e.subagent_run_id)
                    )));
                }
                self.steps.push(key);
            }
            Event::StepFinished(e) => {
                let key = (e.subagent_run_id.clone(), e.step_name.clone());
                match self.steps.iter().position(|open| open == &key) {
                    Some(index) => {
                        self.steps.remove(index);
                    }
                    None => {
                        return Err(Error::protocol(format!(
                            "STEP_FINISHED for {:?}, which never started under {}",
                            e.step_name.as_str(),
                            describe(&e.subagent_run_id)
                        )));
                    }
                }
            }

            Event::SubagentStarted(e) => {
                let id = &e.subagent_run_id;
                if self.subagents.contains(id) {
                    return Err(Error::protocol(format!(
                        "SUBAGENT_STARTED for subagent {:?}, which is already active",
                        id.as_str()
                    )));
                }
                if self.closed_subagents.contains(id) {
                    return Err(Error::protocol(format!(
                        "SUBAGENT_STARTED for subagent {:?}, which already finished in this run; \
                         an id names one invocation",
                        id.as_str()
                    )));
                }
                if let Some(parent) = &e.parent_subagent_run_id {
                    if !self.subagents.contains(parent) && !self.closed_subagents.contains(parent) {
                        return Err(Error::protocol(format!(
                            "SUBAGENT_STARTED for subagent {:?} names parent {:?}, which was never started",
                            id.as_str(),
                            parent.as_str()
                        )));
                    }
                }
                self.subagents.push(id.clone());
            }
            Event::SubagentFinished(e) => self.close_subagent(&e.subagent_run_id, kind)?,
            Event::SubagentError(e) => self.close_subagent(&e.subagent_run_id, kind)?,

            // Authoritative: the snapshot restates the conversation, so its
            // owners replace whatever was recorded.
            Event::MessagesSnapshot(e) => self.seed_owners(&e.messages, true),

            Event::RunFinished(e) => {
                // Recorded before the checks: the run is over whether or not it
                // ended tidily, and reporting the untidiness twice — once here
                // and again from `finish` — helps nobody.
                self.finished = true;
                self.expect_all_closed("RUN_FINISHED")?;
                if let Some(outcome) = &e.outcome {
                    outcome.validate()?;
                }
            }
            Event::RunError(_) => {
                // A failing run is allowed to abandon whatever it had open —
                // that is what failing means.
                self.finished = true;
            }

            // Chunk events are self-contained; expanding them into brackets is
            // [`crate::client::chunks`]'s job, and it runs before this one.
            _ => {}
        }

        Ok(())
    }

    /// Checks the stream ended where it was supposed to.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] when the transport ended the stream before the agent
    /// finished the run — a truncated response, which otherwise looks exactly
    /// like a short answer.
    pub fn finish(&self) -> Result<()> {
        if !self.started {
            return Err(Error::protocol("the stream ended before RUN_STARTED"));
        }
        if !self.finished {
            return Err(Error::protocol(
                "the stream ended before RUN_FINISHED or RUN_ERROR",
            ));
        }
        Ok(())
    }

    // ---- rules ----------------------------------------------------------

    /// Records who a message belongs to — the first writer — or rejects a
    /// claim that disagrees with the recorded owner, and returns the owner in
    /// force. An untagged claim on an owned message is accepted and does
    /// *not* hand the message to the parent: an absent tag agrees with any
    /// owner, and the applier keeps the message where it was. Upstream's
    /// verifier records the first writer for the same reason.
    fn claim(
        &mut self,
        kind: EventType,
        id: &MessageId,
        tag: &Owner,
        reasoning: bool,
    ) -> Result<Owner> {
        let (what, owners) = if reasoning {
            ("reasoning message", &mut self.reasoning_owners)
        } else {
            ("message", &mut self.message_owners)
        };
        if let Some(owner) = owners.get(id) {
            if tag.is_some() && owner != tag {
                return Err(Error::protocol(format!(
                    "{kind} for {what} {:?} names {}, but the {what} belongs to {}",
                    id.as_str(),
                    describe(tag),
                    describe(owner)
                )));
            }
            return Ok(owner.clone());
        }
        owners.insert(id.clone(), tag.clone());
        Ok(tag.clone())
    }

    /// Records the owners of replayed messages, and of the tool calls they
    /// carry: authoritatively for a `MESSAGES_SNAPSHOT`, which restates the
    /// conversation, and for ids not yet recorded when the `RUN_STARTED` echo
    /// replays history.
    fn seed_owners(&mut self, messages: &[Message], authoritative: bool) {
        for message in messages {
            let owner = message.subagent_run_id().cloned();
            let bucket = match message {
                Message::Activity(_) => &mut self.activity_owners,
                Message::Reasoning(_) => &mut self.reasoning_owners,
                _ => &mut self.message_owners,
            };
            if authoritative || !bucket.contains_key(message.id()) {
                bucket.insert(message.id().clone(), owner.clone());
            }
            if let Message::Assistant(assistant) = message {
                for call in assistant.tool_calls.iter().flatten() {
                    if authoritative || !self.tool_call_owners.contains_key(&call.id) {
                        self.tool_call_owners.insert(call.id.clone(), owner.clone());
                    }
                }
            }
        }
    }

    /// Who a tool call belongs to: its tag, else the owner of the message that
    /// carries it, else whoever introduced it before, else the parent agent —
    /// rejecting a tag that disagrees with the carrying message, and an
    /// asserted owner that disagrees with a recorded one.
    fn resolve_tool_call_owner(
        &self,
        kind: EventType,
        id: &ToolCallId,
        parent_message_id: Option<&MessageId>,
        tag: &Owner,
    ) -> Result<Owner> {
        let inherited = parent_message_id
            .and_then(|parent| self.message_owners.get(parent).map(|owner| (parent, owner)));
        if let Some((parent, owner)) = inherited {
            if tag.is_some() && owner != tag {
                return Err(Error::protocol(format!(
                    "{kind} for tool call {:?} names {}, but its parent message {:?} belongs to {}; \
                     a tool call belongs to the message that carries it",
                    id.as_str(),
                    describe(tag),
                    parent.as_str(),
                    describe(owner)
                )));
            }
        }
        let asserted: Option<Owner> = if tag.is_some() {
            Some(tag.clone())
        } else {
            inherited.map(|(_, owner)| owner.clone())
        };
        if let (Some(asserted), Some(known)) = (&asserted, self.tool_call_owners.get(id)) {
            if asserted != known {
                return Err(Error::protocol(format!(
                    "{kind} for tool call {:?} names {}, but the call belongs to {}",
                    id.as_str(),
                    describe(asserted),
                    describe(known)
                )));
            }
        }
        Ok(asserted
            .or_else(|| self.tool_call_owners.get(id).cloned())
            .unwrap_or(None))
    }

    fn close_subagent(&mut self, id: &SubagentRunId, kind: EventType) -> Result<()> {
        match self.subagents.iter().position(|active| active == id) {
            Some(index) => {
                self.subagents.remove(index);
                self.closed_subagents.insert(id.clone());
                Ok(())
            }
            None => Err(Error::protocol(format!(
                "{kind} for subagent {:?}, which is not active",
                id.as_str()
            ))),
        }
    }

    fn expect_text(&self, id: &MessageId, tag: &Owner, kind: EventType) -> Result<()> {
        match self.text.iter().find(|(open, _)| open == id) {
            None => Err(Error::protocol(format!(
                "{kind} for message {:?}, which was never opened",
                id.as_str()
            ))),
            Some((_, owner)) => Self::expect_owner(kind, "message", id.as_str(), owner, tag),
        }
    }

    fn expect_tool(&self, id: &ToolCallId, tag: &Owner, kind: EventType) -> Result<()> {
        match self.tool.iter().find(|(open, _)| open == id) {
            None => Err(Error::protocol(format!(
                "{kind} for tool call {:?}, which was never opened",
                id.as_str()
            ))),
            Some((_, owner)) => Self::expect_owner(kind, "tool call", id.as_str(), owner, tag),
        }
    }

    fn expect_reasoning(&self, id: &MessageId, tag: &Owner, kind: EventType) -> Result<()> {
        match self.reasoning.iter().find(|(open, _)| open == id) {
            None => Err(Error::protocol(format!(
                "{kind} for reasoning message {:?}, which was never opened",
                id.as_str()
            ))),
            Some((_, owner)) => {
                Self::expect_owner(kind, "reasoning message", id.as_str(), owner, tag)
            }
        }
    }

    /// The whole of the attribution rule for continuations: a tag, when there
    /// is one, names the opener.
    fn expect_owner(
        kind: EventType,
        what: &str,
        id: &str,
        owner: &Owner,
        tag: &Owner,
    ) -> Result<()> {
        if tag.is_some() && owner != tag {
            return Err(Error::protocol(format!(
                "{kind} for {what} {id:?} names {}, but the {what} was opened by {}",
                describe(tag),
                describe(owner)
            )));
        }
        Ok(())
    }

    /// Rejects a start for an id that is already streaming.
    ///
    /// The whole of the concurrency rule: two ids may overlap, one id may not
    /// overlap itself.
    fn not_already_open<'a, T: PartialEq + AsRef<str> + 'a>(
        &self,
        mut open: impl Iterator<Item = &'a T>,
        id: &T,
        what: &str,
        kind: EventType,
    ) -> Result<()> {
        if open.any(|open| open == id) {
            return Err(Error::protocol(format!(
                "{kind} for {what} {:?}, which is already open",
                id.as_ref()
            )));
        }
        Ok(())
    }

    fn expect_all_closed(&self, what: &str) -> Result<()> {
        if let Some((id, _)) = self.text.first() {
            return Err(Error::protocol(format!(
                "{what} arrived while message {:?} was still open",
                id.as_str()
            )));
        }
        if let Some((id, _)) = self.tool.first() {
            return Err(Error::protocol(format!(
                "{what} arrived while tool call {:?} was still open",
                id.as_str()
            )));
        }
        if let Some((id, _)) = self.reasoning.first() {
            return Err(Error::protocol(format!(
                "{what} arrived while reasoning message {:?} was still open",
                id.as_str()
            )));
        }
        if let Some((owner, name)) = self.steps.first() {
            return Err(Error::protocol(format!(
                "{what} arrived while step {:?} was still running under {}",
                name.as_str(),
                describe(owner)
            )));
        }
        if let Some(id) = self.subagents.first() {
            return Err(Error::protocol(format!(
                "{what} arrived while subagent {:?} was still active",
                id.as_str()
            )));
        }
        Ok(())
    }
}

/// Verifies a whole run in one call.
///
/// The streaming form is [`Verifier`]; this is the convenience for recorded
/// streams and tests.
pub fn verify_all<'a>(events: impl IntoIterator<Item = &'a Event>) -> Result<()> {
    let mut verifier = Verifier::new();
    for event in events {
        verifier.verify(event)?;
    }
    verifier.finish()
}
