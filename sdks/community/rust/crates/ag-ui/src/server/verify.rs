//! The ordering state machine.
//!
//! `TEXT_MESSAGE_CONTENT` without a preceding `TEXT_MESSAGE_START` is a bug
//! that currently surfaces as a confused frontend, three network hops from
//! where it was caused. Neither the TypeScript SDK (which verifies on the
//! client) nor the .NET one (which does not verify) catches it on the server.
//! This crate does, on by default.
//!
//! # What it rejects
//!
//! | Rule | Rejected |
//! | --- | --- |
//! | [`RunEnded`] | anything after `RUN_FINISHED` / `RUN_ERROR` |
//! | [`DuplicateRunStarted`] | a second `RUN_STARTED` |
//! | [`DuplicateStart`] | opening a message, reasoning block, tool call, step or subagent whose id is already open — or a subagent id that already finished in this run |
//! | [`NotOpen`] | content or a terminator for something that was never opened, including `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` for a subagent that is not active |
//! | [`UnknownId`] | `TOOL_CALL_RESULT` for a call id that was never introduced, or a `parentSubagentRunId` that was never started |
//! | [`OutOfOrder`] | `TOOL_CALL_RESULT` before the call's `TOOL_CALL_END` |
//! | [`OpenAtFinish`] | `RUN_FINISHED` while a message, reasoning block, tool call, step or subagent is open |
//! | [`OwnerMismatch`] | a tagged continuation, terminator or re-open whose `subagentRunId` is not the one that opened the entity — a message, reasoning block, tool call, activity, or the entity a `REASONING_ENCRYPTED_VALUE` names; a tool call tagged with one subagent whose parent message belongs to another |
//!
//! `RUN_ERROR` is exempt from [`OpenAtFinish`]: a run that blew up mid-message
//! could not have closed it.
//!
//! # Subagents
//!
//! Every entity is opened *by someone* — a subagent, or the parent agent when
//! the opener carries no `subagentRunId` — and the verifier remembers who.
//! A later event that *names* a different owner is rejected; one that names
//! none is accepted, because attribution is optional on every event and a
//! bare continuation is what a pre-subagent producer sends — and it does not
//! hand the entity to the parent either: the first writer stays the owner, as
//! upstream records it. Steps are keyed by owner as well as name, so a
//! subagent cannot close the parent's step, or a sibling's, and two agents may
//! run a step of the same name at once. A `MESSAGES_SNAPSHOT` seeds ownership
//! from the messages it carries and is authoritative; the `RUN_STARTED` input
//! echo seeds it too, for ids not yet recorded; a `TOOL_CALL_RESULT` mints the
//! tool message it names under its own attribution.
//!
//! What is deliberately *not* checked, because the protocol does not require
//! it: that an attributing `subagentRunId` was announced by `SUBAGENT_STARTED`
//! (attribution without lifecycle events is a supported mode), that a
//! subagent's own messages are closed before its `SUBAGENT_FINISHED`, or that
//! events stop after it — a `parentSubagentRunId` may even name a subagent
//! that already finished, since a parent legitimately finishes before its
//! child. What *is* required is that every started subagent is closed before
//! `RUN_FINISHED`.
//!
//! [`RunEnded`]: crate::server::Rule::RunEnded
//! [`DuplicateRunStarted`]: crate::server::Rule::DuplicateRunStarted
//! [`DuplicateStart`]: crate::server::Rule::DuplicateStart
//! [`NotOpen`]: crate::server::Rule::NotOpen
//! [`UnknownId`]: crate::server::Rule::UnknownId
//! [`OutOfOrder`]: crate::server::Rule::OutOfOrder
//! [`OpenAtFinish`]: crate::server::Rule::OpenAtFinish
//! [`OwnerMismatch`]: crate::server::Rule::OwnerMismatch
//!
//! # What it lets through
//!
//! The `*_CHUNK` events are self-contained by design, so a chunk carrying a new
//! id registers that id rather than being rejected for having no start. The
//! deprecated `THINKING_*` family is not tracked at all. State, activity, raw
//! and custom events are unordered — though an activity delta, like any
//! continuation, may not name an owner other than its activity's.
//!
//! # Cost
//!
//! A handful of maps and one lookup per event. Turning the `verify` feature
//! off replaces the whole state machine with a zero-sized type whose
//! `observe` is an inlined `Ok(())`. In debug builds a rejection additionally
//! carries a dump of everything still open, which is the expensive part and is
//! why it is debug-only.

#[cfg(feature = "verify")]
pub(crate) use enabled::Verifier;

#[cfg(not(feature = "verify"))]
pub(crate) use disabled::Verifier;

#[cfg(feature = "verify")]
mod enabled {
    use std::collections::{HashMap, HashSet};
    use std::fmt::Write as _;

    use crate::{
        Event, Message, MessageId, ReasoningEncryptedValueSubtype, StepName, SubagentRunId,
        ToolCallId,
    };

    use crate::server::error::{Rule, VerificationError};

    /// Who opened an entity: a subagent, or the parent agent when `None`.
    type Owner = Option<SubagentRunId>;

    /// Builds a rejection, appending the open-entity dump in debug builds.
    fn reject(
        event: &Event,
        rule: Rule,
        detail: impl Into<String>,
        open: impl FnOnce() -> String,
    ) -> VerificationError {
        let mut detail = detail.into();
        if cfg!(debug_assertions) {
            detail.push_str(&open());
        }
        VerificationError::new(event.event_type(), rule, detail)
    }

    fn describe(owner: &Owner) -> String {
        match owner {
            None => "the parent agent".to_owned(),
            Some(id) => format!("subagent {id:?}"),
        }
    }

    /// Tracks what is open, and who opened it, so misordered events can be
    /// named precisely.
    #[derive(Debug, Default)]
    pub(crate) struct Verifier {
        started: bool,
        ended: bool,
        messages: HashMap<MessageId, Owner>,
        reasoning: HashMap<MessageId, Owner>,
        reasoning_messages: HashMap<MessageId, Owner>,
        tool_calls: HashMap<ToolCallId, Owner>,
        /// Every tool call ever introduced — by a start, a chunk or a
        /// snapshot — and who owns it.
        known_tool_calls: HashMap<ToolCallId, Owner>,
        /// Every text message ever introduced and who owns it: the first
        /// writer. A tool call belongs to the message its `parentMessageId`
        /// names, so the owner has to outlive the message being open.
        message_owners: HashMap<MessageId, Owner>,
        /// The same for reasoning — the block and the message inside it share
        /// an id and an owner. A bucket of its own, as upstream keeps it, so
        /// a producer that reuses an id across the two kinds is not accused
        /// of contradicting itself.
        reasoning_owners: HashMap<MessageId, Owner>,
        /// Every activity ever introduced and who owns it. Opened by a
        /// snapshot, continued by deltas against the same id.
        activity_owners: HashMap<MessageId, Owner>,
        /// Open steps, keyed by owner as well as name: a subagent routinely
        /// runs the same graph shape as its parent, and neither may close the
        /// other's step.
        steps: HashSet<(Owner, StepName)>,
        active_subagents: HashSet<SubagentRunId>,
        /// Ids closed in this run. An id names one invocation, so a second
        /// `SUBAGENT_STARTED` for a closed one is a producer bug — but
        /// attribution-only producers, which tag events and never announce,
        /// are not required to have started anything.
        closed_subagents: HashSet<SubagentRunId>,
    }

    impl Verifier {
        pub(crate) fn new() -> Self {
            Self::default()
        }

        /// Checks `event` against the state machine and folds it in.
        pub(crate) fn observe(&mut self, event: &Event) -> Result<(), VerificationError> {
            if self.ended {
                return Err(self.fail(event, Rule::RunEnded, "the run already ended"));
            }

            match event {
                Event::RunStarted(payload) => {
                    if self.started {
                        return Err(self.fail(
                            event,
                            Rule::DuplicateRunStarted,
                            "the run already started",
                        ));
                    }
                    self.started = true;
                    // The input echo replays history the consumer applies, so
                    // it seeds ownership like a snapshot does — for ids not
                    // yet recorded, since it is history rather than a rewrite.
                    if let Some(input) = &payload.input {
                        self.seed_owners(&input.messages, false);
                    }
                }
                Event::RunFinished(_) => {
                    if let Some(detail) = self.first_open() {
                        return Err(self.fail(event, Rule::OpenAtFinish, detail));
                    }
                    self.ended = true;
                }
                Event::RunError(_) => self.ended = true,

                Event::TextMessageStart(payload) => {
                    self.open(
                        event,
                        Kind::Message,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::TextMessageContent(payload) => {
                    self.require(
                        event,
                        Kind::Message,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::TextMessageEnd(payload) => {
                    self.close(
                        event,
                        Kind::Message,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::TextMessageChunk(payload) => {
                    if let Some(id) = &payload.message_id {
                        // Self-contained: a chunk needs no bracketing events,
                        // but it still says who the message belongs to.
                        self.messages.remove(id);
                        self.claim(event, Kind::Message, id, &payload.subagent_run_id)?;
                    }
                }

                Event::ReasoningStart(payload) => {
                    self.open(
                        event,
                        Kind::Reasoning,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::ReasoningEnd(payload) => {
                    self.close(
                        event,
                        Kind::Reasoning,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::ReasoningMessageStart(payload) => {
                    self.open(
                        event,
                        Kind::ReasoningMessage,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::ReasoningMessageContent(payload) => {
                    self.require(
                        event,
                        Kind::ReasoningMessage,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::ReasoningMessageEnd(payload) => {
                    self.close(
                        event,
                        Kind::ReasoningMessage,
                        &payload.message_id,
                        &payload.subagent_run_id,
                    )?;
                }
                Event::ReasoningMessageChunk(payload) => {
                    if let Some(id) = &payload.message_id {
                        self.reasoning_messages.remove(id);
                        self.claim(event, Kind::ReasoningMessage, id, &payload.subagent_run_id)?;
                    }
                }

                Event::ToolCallStart(payload) => {
                    let id = &payload.tool_call_id;
                    let owner = self.resolve_tool_call_owner(
                        event,
                        id,
                        payload.parent_message_id.as_ref(),
                        &payload.subagent_run_id,
                    )?;
                    if self.tool_calls.contains_key(id) {
                        return Err(self.fail(
                            event,
                            Rule::DuplicateStart,
                            format!("tool call {id:?} is already open"),
                        ));
                    }
                    self.tool_calls.insert(id.clone(), owner.clone());
                    self.known_tool_calls.insert(id.clone(), owner);
                }
                Event::ToolCallArgs(payload) => {
                    self.require_tool_call(event, &payload.tool_call_id, &payload.subagent_run_id)?;
                }
                Event::ToolCallEnd(payload) => {
                    self.require_tool_call(event, &payload.tool_call_id, &payload.subagent_run_id)?;
                    self.tool_calls.remove(&payload.tool_call_id);
                }
                Event::ToolCallChunk(payload) => {
                    if let Some(id) = &payload.tool_call_id {
                        let owner = self.resolve_tool_call_owner(
                            event,
                            id,
                            payload.parent_message_id.as_ref(),
                            &payload.subagent_run_id,
                        )?;
                        self.tool_calls.remove(id);
                        self.known_tool_calls.insert(id.clone(), owner);
                    }
                }
                // A result's attribution is its own — the party that executes
                // a call can differ from the one that requested it — so the
                // owner is not checked here, only the call's state.
                Event::ToolCallResult(payload) => {
                    let id = &payload.tool_call_id;
                    if !self.known_tool_calls.contains_key(id) {
                        return Err(self.fail(
                            event,
                            Rule::UnknownId,
                            format!("tool call {id:?} was never started"),
                        ));
                    }
                    if self.tool_calls.contains_key(id) {
                        return Err(self.fail(
                            event,
                            Rule::OutOfOrder,
                            format!("tool call {id:?} has no TOOL_CALL_END yet"),
                        ));
                    }
                    // A result mints the tool message it names, under its own
                    // attribution — so the newest mint wins, not the first
                    // writer, and a re-open of that message by someone else
                    // has an owner to disagree with.
                    self.message_owners
                        .insert(payload.message_id.clone(), payload.subagent_run_id.clone());
                }

                // An activity is opened by a snapshot and continued by deltas
                // against the same id. Only a *replacing* snapshot re-mints
                // it and so re-owns it; with `replace: false` the consumer
                // leaves the existing message where it was, and so does the
                // recorded owner.
                Event::ActivitySnapshot(payload) => {
                    let id = &payload.message_id;
                    if payload.replace || !self.activity_owners.contains_key(id) {
                        self.activity_owners
                            .insert(id.clone(), payload.subagent_run_id.clone());
                    }
                }
                Event::ActivityDelta(payload) => {
                    if let Some(owner) = self.activity_owners.get(&payload.message_id) {
                        let tag = &payload.subagent_run_id;
                        if tag.is_some() && owner != tag {
                            return Err(self.fail(
                                event,
                                Rule::OwnerMismatch,
                                format!(
                                    "activity {:?} belongs to {}, not {}",
                                    payload.message_id,
                                    describe(owner),
                                    describe(tag)
                                ),
                            ));
                        }
                    }
                }

                // Continues an entity by id, and `subtype` says which kind —
                // a tool call's owner lives in a different map from a
                // message's.
                Event::ReasoningEncryptedValue(payload) => {
                    let tag = &payload.subagent_run_id;
                    let (what, owner) = match payload.subtype {
                        ReasoningEncryptedValueSubtype::ToolCall => (
                            "tool call",
                            self.known_tool_calls
                                .get(&ToolCallId::new(payload.entity_id.clone())),
                        ),
                        // "message" spans both kinds; ids are unique per kind,
                        // so at most one bucket answers.
                        ReasoningEncryptedValueSubtype::Message => {
                            let id = MessageId::new(payload.entity_id.clone());
                            (
                                "message",
                                self.message_owners
                                    .get(&id)
                                    .or_else(|| self.reasoning_owners.get(&id)),
                            )
                        }
                    };
                    if let Some(owner) = owner {
                        if tag.is_some() && owner != tag {
                            return Err(self.fail(
                                event,
                                Rule::OwnerMismatch,
                                format!(
                                    "{what} {:?} belongs to {}, not {}",
                                    payload.entity_id,
                                    describe(owner),
                                    describe(tag)
                                ),
                            ));
                        }
                    }
                }

                Event::StepStarted(payload) => {
                    let key = (payload.subagent_run_id.clone(), payload.step_name.clone());
                    if self.steps.contains(&key) {
                        return Err(self.fail(
                            event,
                            Rule::DuplicateStart,
                            format!(
                                "step {:?} is already open under {}",
                                payload.step_name,
                                describe(&payload.subagent_run_id)
                            ),
                        ));
                    }
                    self.steps.insert(key);
                }
                Event::StepFinished(payload) => {
                    let key = (payload.subagent_run_id.clone(), payload.step_name.clone());
                    if !self.steps.remove(&key) {
                        return Err(self.fail(
                            event,
                            Rule::NotOpen,
                            format!(
                                "step {:?} is not open under {}",
                                payload.step_name,
                                describe(&payload.subagent_run_id)
                            ),
                        ));
                    }
                }

                Event::SubagentStarted(payload) => {
                    let id = &payload.subagent_run_id;
                    if self.active_subagents.contains(id) {
                        return Err(self.fail(
                            event,
                            Rule::DuplicateStart,
                            format!("subagent {id:?} is already active"),
                        ));
                    }
                    if self.closed_subagents.contains(id) {
                        return Err(self.fail(
                            event,
                            Rule::DuplicateStart,
                            format!(
                                "subagent {id:?} already finished in this run; an id names one invocation"
                            ),
                        ));
                    }
                    if let Some(parent) = &payload.parent_subagent_run_id {
                        if !self.active_subagents.contains(parent)
                            && !self.closed_subagents.contains(parent)
                        {
                            return Err(self.fail(
                                event,
                                Rule::UnknownId,
                                format!("parent subagent {parent:?} was never started"),
                            ));
                        }
                    }
                    self.active_subagents.insert(id.clone());
                }
                Event::SubagentFinished(payload) => {
                    self.close_subagent(event, &payload.subagent_run_id)?;
                }
                Event::SubagentError(payload) => {
                    self.close_subagent(event, &payload.subagent_run_id)?;
                }

                // Authoritative: the snapshot restates the conversation, so its
                // owners replace whatever was recorded.
                Event::MessagesSnapshot(payload) => {
                    self.seed_owners(&payload.messages, true);
                }

                _ => {}
            }

            Ok(())
        }

        /// Records the owners of replayed messages, and of the tool calls
        /// they carry: authoritatively for a `MESSAGES_SNAPSHOT`, which
        /// restates the conversation, and for ids not yet recorded when the
        /// `RUN_STARTED` echo replays history.
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
                        if authoritative || !self.known_tool_calls.contains_key(&call.id) {
                            self.known_tool_calls.insert(call.id.clone(), owner.clone());
                        }
                    }
                }
            }
        }

        /// Records who `id` belongs to — the first writer — or rejects a claim
        /// that disagrees with the recorded owner, and returns the owner in
        /// force.
        ///
        /// An untagged claim on an owned message is accepted and does *not*
        /// hand the message to the parent: attribution is optional per
        /// event, so an absent tag agrees with any owner, and the consumer
        /// keeps the message where it was. Upstream's verifier records the
        /// first writer for the same reason.
        fn claim(
            &mut self,
            event: &Event,
            kind: Kind,
            id: &MessageId,
            tag: &Owner,
        ) -> Result<Owner, VerificationError> {
            if let Some(owner) = self.owners(kind).get(id).cloned() {
                if tag.is_some() && &owner != tag {
                    return Err(self.fail(
                        event,
                        Rule::OwnerMismatch,
                        format!(
                            "{} {id:?} belongs to {}, not {}",
                            kind.owner_noun(),
                            describe(&owner),
                            describe(tag)
                        ),
                    ));
                }
                return Ok(owner);
            }
            self.owners_mut(kind).insert(id.clone(), tag.clone());
            Ok(tag.clone())
        }

        /// The owner bucket an id of this kind claims through.
        fn owners(&self, kind: Kind) -> &HashMap<MessageId, Owner> {
            match kind {
                Kind::Message => &self.message_owners,
                Kind::Reasoning | Kind::ReasoningMessage => &self.reasoning_owners,
            }
        }

        fn owners_mut(&mut self, kind: Kind) -> &mut HashMap<MessageId, Owner> {
            match kind {
                Kind::Message => &mut self.message_owners,
                Kind::Reasoning | Kind::ReasoningMessage => &mut self.reasoning_owners,
            }
        }

        /// Who a tool call belongs to: the tag when it carries one, otherwise
        /// the owner of the message that carries the call, otherwise whoever
        /// introduced the call before, otherwise the parent agent.
        ///
        /// A tag that disagrees with the parent message's owner cannot be
        /// represented faithfully — `ToolCall` carries no attribution of its
        /// own — and is rejected, as is an asserted owner that disagrees with
        /// a recorded one.
        fn resolve_tool_call_owner(
            &self,
            event: &Event,
            id: &ToolCallId,
            parent_message_id: Option<&MessageId>,
            tag: &Owner,
        ) -> Result<Owner, VerificationError> {
            let inherited = parent_message_id
                .and_then(|parent| self.message_owners.get(parent).map(|owner| (parent, owner)));
            if let Some((parent, owner)) = inherited {
                if tag.is_some() && owner != tag {
                    return Err(self.fail(
                        event,
                        Rule::OwnerMismatch,
                        format!(
                            "tool call {id:?} is tagged {} but its parent message {parent:?} belongs to {}; \
                             a tool call belongs to the message that carries it",
                            describe(tag),
                            describe(owner)
                        ),
                    ));
                }
            }
            let asserted: Option<Owner> = if tag.is_some() {
                Some(tag.clone())
            } else {
                inherited.map(|(_, owner)| owner.clone())
            };
            if let (Some(asserted), Some(known)) = (&asserted, self.known_tool_calls.get(id)) {
                if asserted != known {
                    return Err(self.fail(
                        event,
                        Rule::OwnerMismatch,
                        format!(
                            "tool call {id:?} belongs to {}, not {}",
                            describe(known),
                            describe(asserted)
                        ),
                    ));
                }
            }
            Ok(asserted
                .or_else(|| self.known_tool_calls.get(id).cloned())
                .unwrap_or(None))
        }

        fn require_tool_call(
            &self,
            event: &Event,
            id: &ToolCallId,
            tag: &Owner,
        ) -> Result<(), VerificationError> {
            match self.tool_calls.get(id) {
                None => Err(self.fail(
                    event,
                    Rule::NotOpen,
                    format!("tool call {id:?} is not open"),
                )),
                Some(owner) if tag.is_some() && owner != tag => Err(self.fail(
                    event,
                    Rule::OwnerMismatch,
                    format!(
                        "tool call {id:?} belongs to {}, not {}",
                        describe(owner),
                        describe(tag)
                    ),
                )),
                Some(_) => Ok(()),
            }
        }

        fn close_subagent(
            &mut self,
            event: &Event,
            id: &SubagentRunId,
        ) -> Result<(), VerificationError> {
            if !self.active_subagents.remove(id) {
                return Err(self.fail(
                    event,
                    Rule::NotOpen,
                    format!("subagent {id:?} is not active"),
                ));
            }
            self.closed_subagents.insert(id.clone());
            Ok(())
        }

        /// Opens an entity under the owner in force for its id — the first
        /// writer's, so an untagged re-open of a subagent's message keeps
        /// checking its continuations against that subagent.
        ///
        /// A reasoning block and the message inside it share an id and
        /// claim the same owner, so `REASONING_START` under one subagent and
        /// `REASONING_MESSAGE_START` under another is a contradiction here,
        /// as it is upstream.
        fn open(
            &mut self,
            event: &Event,
            kind: Kind,
            id: &MessageId,
            tag: &Owner,
        ) -> Result<(), VerificationError> {
            let owner = self.claim(event, kind, id, tag)?;
            if self.map(kind).contains_key(id) {
                return Err(self.fail(
                    event,
                    Rule::DuplicateStart,
                    format!("{} {id:?} is already open", kind.noun()),
                ));
            }
            self.map_mut(kind).insert(id.clone(), owner);
            Ok(())
        }

        fn require(
            &self,
            event: &Event,
            kind: Kind,
            id: &MessageId,
            tag: &Owner,
        ) -> Result<(), VerificationError> {
            match self.map(kind).get(id) {
                None => Err(self.fail(
                    event,
                    Rule::NotOpen,
                    format!("{} {id:?} is not open", kind.noun()),
                )),
                Some(owner) if tag.is_some() && owner != tag => Err(self.fail(
                    event,
                    Rule::OwnerMismatch,
                    format!(
                        "{} {id:?} belongs to {}, not {}",
                        kind.noun(),
                        describe(owner),
                        describe(tag)
                    ),
                )),
                Some(_) => Ok(()),
            }
        }

        fn close(
            &mut self,
            event: &Event,
            kind: Kind,
            id: &MessageId,
            tag: &Owner,
        ) -> Result<(), VerificationError> {
            self.require(event, kind, id, tag)?;
            self.map_mut(kind).remove(id);
            Ok(())
        }

        fn map(&self, kind: Kind) -> &HashMap<MessageId, Owner> {
            match kind {
                Kind::Message => &self.messages,
                Kind::Reasoning => &self.reasoning,
                Kind::ReasoningMessage => &self.reasoning_messages,
            }
        }

        fn map_mut(&mut self, kind: Kind) -> &mut HashMap<MessageId, Owner> {
            match kind {
                Kind::Message => &mut self.messages,
                Kind::Reasoning => &mut self.reasoning,
                Kind::ReasoningMessage => &mut self.reasoning_messages,
            }
        }

        fn fail(&self, event: &Event, rule: Rule, detail: impl Into<String>) -> VerificationError {
            reject(event, rule, detail, || self.dump())
        }

        /// The first thing still open at `RUN_FINISHED`, if any.
        fn first_open(&self) -> Option<String> {
            if let Some(id) = self.messages.keys().next() {
                return Some(format!("message {id:?} is still open"));
            }
            if let Some(id) = self.reasoning_messages.keys().next() {
                return Some(format!("reasoning message {id:?} is still open"));
            }
            if let Some(id) = self.reasoning.keys().next() {
                return Some(format!("reasoning block {id:?} is still open"));
            }
            if let Some(id) = self.tool_calls.keys().next() {
                return Some(format!("tool call {id:?} is still open"));
            }
            if let Some((owner, name)) = self.steps.iter().next() {
                return Some(format!(
                    "step {name:?} is still open under {}",
                    describe(owner)
                ));
            }
            if let Some(id) = self.active_subagents.iter().next() {
                return Some(format!("subagent {id:?} is still active"));
            }
            None
        }

        /// Debug-build-only dump of everything currently open.
        fn dump(&self) -> String {
            let mut out = String::new();
            let mut push = |label: &str, values: Vec<String>| {
                if !values.is_empty() {
                    let _ = write!(out, " {label}={:?}", values);
                }
            };
            push("messages", strings(self.messages.keys()));
            push("reasoning", strings(self.reasoning.keys()));
            push(
                "reasoning_messages",
                strings(self.reasoning_messages.keys()),
            );
            push("tool_calls", strings(self.tool_calls.keys()));
            push(
                "steps",
                strings(self.steps.iter().map(|(owner, name)| match owner {
                    None => name.to_string(),
                    Some(id) => format!("{id}/{name}"),
                })),
            );
            push("subagents", strings(self.active_subagents.iter()));
            if out.is_empty() {
                " [nothing open]".to_owned()
            } else {
                format!(" [open:{out}]")
            }
        }
    }

    fn strings<T: ToString>(values: impl Iterator<Item = T>) -> Vec<String> {
        let mut values: Vec<String> = values.map(|value| value.to_string()).collect();
        values.sort();
        values
    }

    /// The three id-keyed things a message id can open.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Kind {
        Message,
        Reasoning,
        ReasoningMessage,
    }

    impl Kind {
        const fn noun(self) -> &'static str {
            match self {
                Self::Message => "message",
                Self::Reasoning => "reasoning block",
                Self::ReasoningMessage => "reasoning message",
            }
        }

        /// What an owner complaint calls the entity: the block and the
        /// message inside it are one owned thing.
        const fn owner_noun(self) -> &'static str {
            match self {
                Self::Message => "message",
                Self::Reasoning | Self::ReasoningMessage => "reasoning message",
            }
        }
    }
}

#[cfg(not(feature = "verify"))]
mod disabled {
    use crate::Event;

    use crate::server::error::VerificationError;

    /// The `verify` feature is off: every check compiles away.
    #[derive(Debug, Default)]
    pub(crate) struct Verifier;

    impl Verifier {
        #[inline]
        pub(crate) fn new() -> Self {
            Self
        }

        #[inline]
        pub(crate) fn observe(&mut self, _event: &Event) -> Result<(), VerificationError> {
            Ok(())
        }
    }
}

#[cfg(all(test, feature = "verify"))]
mod tests {
    use super::*;
    use crate::{Event, TextMessageRole};

    use crate::server::error::Rule;

    fn verifier() -> Verifier {
        let mut verifier = Verifier::new();
        verifier
            .observe(&Event::run_started("t", "r"))
            .expect("RUN_STARTED must be accepted");
        verifier
    }

    #[test]
    fn a_well_formed_run_passes() {
        let mut verifier = verifier();
        for event in [
            Event::step_started("plan"),
            Event::text_message_start("m1", TextMessageRole::Assistant),
            Event::text_message_content("m1", "hi"),
            Event::text_message_end("m1"),
            Event::tool_call_start("c1", "search"),
            Event::tool_call_args("c1", "{}"),
            Event::tool_call_end("c1"),
            Event::tool_call_result("m2", "c1", "ok"),
            Event::step_finished("plan"),
            Event::run_finished_success("t", "r"),
        ] {
            verifier
                .observe(&event)
                .unwrap_or_else(|error| panic!("{event:?} should be accepted: {error}"));
        }
    }

    #[test]
    fn debug_builds_include_the_open_dump() {
        let mut verifier = verifier();
        verifier
            .observe(&Event::text_message_start("m1", TextMessageRole::Assistant))
            .expect("start");
        let error = verifier
            .observe(&Event::text_message_content("m2", "hi"))
            .expect_err("m2 was never opened");
        assert_eq!(error.rule, Rule::NotOpen);
        assert!(
            error.detail.contains("m1"),
            "debug dump should name the open message: {}",
            error.detail
        );
    }

    #[test]
    fn the_dump_names_open_subagents_and_owned_steps() {
        let mut verifier = verifier();
        verifier
            .observe(&Event::subagent_started("s1", "researcher"))
            .expect("start");
        verifier
            .observe(&Event::step_started("plan").with_subagent_run_id("s1"))
            .expect("a subagent's step");
        let error = verifier
            .observe(&Event::run_finished_success("t", "r"))
            .expect_err("the step and the subagent are open");
        assert_eq!(error.rule, Rule::OpenAtFinish);
        assert!(error.detail.contains("s1/plan"), "{}", error.detail);
        assert!(error.detail.contains("subagents"), "{}", error.detail);
    }
}
