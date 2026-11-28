//! The ordering and attribution rules of an AG-UI event stream.
//!
//! One state machine, shared by the two ends of a stream. The server runs it
//! over what an agent emits (`server::verify`) and the client over what
//! arrives (`client::verify`); each wraps [`Ordering`] and words a
//! [`Violation`] in its own error type. The rules themselves are here and
//! nowhere else.
//!
//! # The rules
//!
//! 1. A stream opens with `RUN_STARTED`, or with `RUN_ERROR` for a run that
//!    failed before it began. Nothing else comes first.
//! 2. `RUN_FINISHED` and `RUN_ERROR` end the run. Two things may follow: one
//!    `RUN_ERROR` after `RUN_FINISHED`, a failure that surfaced after the run
//!    reported success, and after either a `RUN_STARTED`, which begins the
//!    next run on the same stream. A `RUN_STARTED` inside a run that has not
//!    ended is a nested run, and is rejected.
//! 3. A text message, tool call, reasoning message or reasoning block is
//!    opened once, continued and closed only while open, and closed before
//!    `RUN_FINISHED`. Everything is keyed by id: two ids may overlap, one id
//!    may not overlap itself. A reasoning block and the message inside it may
//!    share an id, so each has its own open set.
//! 4. A `*_CHUNK` event is judged as the events it stands for, by the model
//!    in [`crate::streams`]: the end of whatever it closes, the start it
//!    implies, its content.
//! 5. `TOOL_CALL_RESULT` answers a call that has ended.
//! 6. A step is opened once per owner and finished by the owner that opened
//!    it, before `RUN_FINISHED`.
//! 7. `SUBAGENT_STARTED` names an invocation that is neither active nor
//!    already finished in this run, and a parent that was started.
//!    `SUBAGENT_FINISHED` and `SUBAGENT_ERROR` name an active one, and every
//!    one is closed before `RUN_FINISHED`.
//! 8. An event that *names* a subagent names the owner of what it touches:
//!    the first writer of a message or reasoning id, the owner of the message
//!    that carries a tool call, the snapshot that minted an activity. One
//!    that names none agrees with any owner.
//! 9. An `interrupt` outcome carries at least one interrupt.
//!
//! `RUN_ERROR` is exempt from the "closed before" clauses: a run that failed
//! could not have closed what it had open.
//!
//! # Several runs
//!
//! What is open belongs to a run, and who owns an id belongs to the stream.
//! A new run starts with nothing open — whatever a failed run left behind
//! ended with it — and with no subagent id used yet, so a run may announce
//! again the subagent the run before it suspended. The owners stay: messages
//! accumulate across runs, and an id keeps its first writer.
//!
//! # What an end decides
//!
//! [`Policy`] holds the one rule the two ends answer differently, because
//! they know different things. Everything else is the protocol's.
//!
//! # A rejected event changes nothing
//!
//! [`Ordering::observe`] either accepts an event and records it, or rejects
//! it and leaves the state as it was. A producer does not send an event its
//! verifier rejected, so the state has to keep describing the wire. It also
//! makes the state a pure function of the accepted events: replaying them
//! into a new [`Ordering`] rebuilds it.

// Each end of a stream uses its own half of this API: the producer seeds
// history and reads the open sets, the consumer asks whether the run ended.
// With one end compiled out, the other half has no caller.
#![cfg_attr(
    not(all(feature = "client", feature = "server", feature = "verify")),
    allow(dead_code)
)]

use std::collections::{HashMap, HashSet};

use crate::streams::{ChunkError, Owner, Streams};
use crate::{
    Event, EventType, Message, MessageId, ReasoningEncryptedValueSubtype, StepName, SubagentRunId,
    ToolCallId,
};

/// What one end of a stream decides for itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    /// Whether `TOOL_CALL_RESULT` must answer a call the stream introduced:
    /// by a start, a chunk, a snapshot, the `RUN_STARTED` echo or the history
    /// the rules were seeded with.
    ///
    /// AG-UI 1.0 does not say. A producer knows every call it answers, so one
    /// it never heard of is its own mistake. A consumer may hold less of the
    /// conversation than the producer does, and cannot tell a mistake from a
    /// call it was never shown.
    pub(crate) results_answer_known_calls: bool,
}

impl Policy {
    /// The end that writes the stream.
    pub(crate) const PRODUCER: Self = Self {
        results_answer_known_calls: true,
    };

    /// The end that reads it.
    pub(crate) const CONSUMER: Self = Self {
        results_answer_known_calls: false,
    };
}

/// The id-keyed things a stream opens, continues or owns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entity {
    Message,
    ToolCall,
    ReasoningMessage,
    ReasoningBlock,
    Activity,
}

impl Entity {
    /// What an error calls it.
    pub(crate) const fn noun(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::ToolCall => "tool call",
            Self::ReasoningMessage => "reasoning message",
            Self::ReasoningBlock => "reasoning block",
            Self::Activity => "activity",
        }
    }
}

/// What an error calls an owner.
pub(crate) fn describe(owner: &Owner) -> String {
    match owner {
        None => "the parent agent".to_owned(),
        Some(id) => format!("subagent {:?}", id.as_str()),
    }
}

/// How a tagged event relates to the entity whose owner it contradicts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Claim {
    /// It continues or closes the entity.
    Continues,
    /// It opens an id that already has an owner.
    Opens,
}

/// Something `RUN_FINISHED` found open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Open {
    Entity { entity: Entity, id: String },
    Step { name: String, owner: Owner },
    Subagent { id: String },
}

/// The rule an event broke, and what it broke it with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Broke {
    /// It came first, and is neither `RUN_STARTED` nor `RUN_ERROR`.
    NotStarted,
    /// It came after the run ended.
    RunEnded,
    /// It is a `RUN_STARTED` inside a run that is still active.
    RunStartedTwice,
    /// It opens an id that is already open.
    AlreadyOpen { entity: Entity, id: String },
    /// It continues or closes an id that is not open.
    NotOpen { entity: Entity, id: String },
    /// It names an owner other than the entity's.
    OwnerMismatch {
        entity: Entity,
        id: String,
        owner: Owner,
        named: Owner,
        claim: Claim,
    },
    /// It attributes a tool call to one owner while the message that carries
    /// the call belongs to another.
    ParentMismatch {
        id: String,
        named: Owner,
        parent: String,
        owner: Owner,
    },
    /// It answers a tool call nothing introduced.
    UnknownToolCall { id: String },
    /// It answers a tool call that has not ended.
    ResultBeforeEnd { id: String },
    /// It starts a step its owner already has running.
    StepRunning { name: String, owner: Owner },
    /// It finishes a step its owner does not have running.
    StepNotRunning { name: String, owner: Owner },
    /// It starts a subagent that is active.
    SubagentActive { id: String },
    /// It starts a subagent that already finished in this run.
    SubagentReused { id: String },
    /// It names a parent subagent that was never started.
    UnknownParentSubagent { id: String, parent: String },
    /// It closes a subagent that is not active.
    SubagentNotActive { id: String },
    /// It is a `RUN_FINISHED`, and this is still open.
    StillOpen(Open),
    /// It is a `RUN_FINISHED` with a malformed interrupt list.
    InvalidOutcome(String),
    /// It is a chunk that cannot be read as the events it stands for.
    Chunk(ChunkError),
}

/// One event rejected by the rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Violation {
    /// The type of the event that was observed. For a chunk this is the
    /// chunk, not the event it stood for.
    pub(crate) event: EventType,
    pub(crate) broke: Broke,
}

/// Where the stream is in the lifecycle of the run it is carrying.
///
/// AG-UI 1.0, `events/lifecycle`: idle until the first event, active from
/// `RUN_STARTED`, closed by `RUN_FINISHED`, failed by `RUN_ERROR`, and active
/// again from the `RUN_STARTED` of the next run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Nothing has arrived.
    Idle,
    /// Open without a `RUN_STARTED`: a harness stands in for the run driver
    /// that would have emitted one. A `RUN_STARTED` is still taken, once.
    Assumed,
    Active,
    Finished,
    Failed,
}

/// The ordering state of one event stream, which carries one run or several
/// in sequence.
#[derive(Clone, Debug)]
pub(crate) struct Ordering {
    policy: Policy,
    phase: Phase,
    /// The chunk streams being assembled, for the events that stand for
    /// others.
    streams: Streams,
    /// What is open, by id, with the owner in force, and in opening order,
    /// so a complaint names whichever was opened first.
    text: OpenSet<MessageId, Owner>,
    tool: OpenSet<ToolCallId, Owner>,
    reasoning: OpenSet<MessageId, Owner>,
    /// Open reasoning blocks: what `REASONING_START` opens.
    blocks: OpenSet<MessageId, Owner>,
    /// Open steps, keyed by owner as well as name: a subagent routinely runs
    /// the same graph shape as its parent, and neither closes the other's.
    steps: OpenSet<(Owner, StepName), ()>,
    subagents: OpenSet<SubagentRunId, ()>,
    /// Ids closed in this run: an id names one invocation.
    closed_subagents: HashSet<SubagentRunId>,
    /// Every text message ever introduced and who owns it: the first writer.
    /// A tool call inherits the owner of the message that carries it, which
    /// may have closed.
    message_owners: HashMap<MessageId, Owner>,
    /// The same for reasoning. The block and the message inside it share an
    /// id and an owner; a bucket apart from text, so a producer that reuses
    /// an id across the two kinds is not accused of contradicting itself.
    reasoning_owners: HashMap<MessageId, Owner>,
    /// Every tool call ever introduced and who owns it.
    tool_call_owners: HashMap<ToolCallId, Owner>,
    /// Every activity ever introduced and who owns it: minted by a snapshot,
    /// continued by deltas against the same id.
    activity_owners: HashMap<MessageId, Owner>,
}

/// What is open of one kind, by key, with what it was opened with.
///
/// Kept by key, so that opening, continuing and closing one costs the same
/// however many are open: a producer that opens items and never closes them
/// does not make each later event slower. The order of opening is read only
/// to name what is still open, which ends a run.
#[derive(Clone)]
struct OpenSet<K, V> {
    /// Each open key, with its place in the order of opening.
    by_key: HashMap<K, (u64, V)>,
    /// The place the next one opened takes.
    next: u64,
}

/// In the order of opening, so that two sets holding the same items read
/// the same however the map below them came to hold them.
impl<K: Eq + std::hash::Hash + std::fmt::Debug, V: std::fmt::Debug> std::fmt::Debug
    for OpenSet<K, V>
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_map().entries(self.in_order()).finish()
    }
}

impl<K, V> Default for OpenSet<K, V> {
    fn default() -> Self {
        Self {
            by_key: HashMap::new(),
            next: 0,
        }
    }
}

impl<K: Eq + std::hash::Hash, V> OpenSet<K, V> {
    fn contains(&self, key: &K) -> bool {
        self.by_key.contains_key(key)
    }

    fn get(&self, key: &K) -> Option<&V> {
        self.by_key.get(key).map(|(_, value)| value)
    }

    fn push(&mut self, key: K, value: V) {
        self.by_key.insert(key, (self.next, value));
        self.next += 1;
    }

    /// Closes `key`, handing back its place and value.
    fn remove(&mut self, key: &K) -> Option<(u64, V)> {
        self.by_key.remove(key)
    }

    /// Opens `key` again in the place it had.
    fn restore(&mut self, key: K, place: u64, value: V) {
        self.by_key.insert(key, (place, value));
    }

    fn clear(&mut self) {
        self.by_key.clear();
    }

    /// Everything open, the one opened first first.
    fn in_order(&self) -> Vec<(&K, &V)> {
        let mut open: Vec<_> = self.by_key.iter().collect();
        open.sort_unstable_by_key(|(_, (place, _))| *place);
        open.into_iter()
            .map(|(key, (_, value))| (key, value))
            .collect()
    }

    /// The one opened first.
    fn first(&self) -> Option<(&K, &V)> {
        self.by_key
            .iter()
            .min_by_key(|(_, (place, _))| *place)
            .map(|(key, (_, value))| (key, value))
    }
}

/// A stream ended on the way to judging an event, to be put back if the
/// event is rejected: its place in the order of opening, its id, its owner.
enum Ended {
    Text(u64, MessageId, Owner),
    Tool(u64, ToolCallId, Owner),
    Reasoning(u64, MessageId, Owner),
}

impl Ordering {
    /// The rules for a stream that has not started.
    pub(crate) fn new(policy: Policy) -> Self {
        Self {
            policy,
            phase: Phase::Idle,
            streams: Streams::default(),
            text: OpenSet::default(),
            tool: OpenSet::default(),
            reasoning: OpenSet::default(),
            blocks: OpenSet::default(),
            steps: OpenSet::default(),
            subagents: OpenSet::default(),
            closed_subagents: HashSet::new(),
            message_owners: HashMap::new(),
            reasoning_owners: HashMap::new(),
            tool_call_owners: HashMap::new(),
            activity_owners: HashMap::new(),
        }
    }

    /// Learns the conversation the run continues before its first event: as
    /// history, like the `RUN_STARTED` echo, for ids not yet recorded.
    pub(crate) fn seed(&mut self, history: &[Message]) {
        self.seed_owners(history, false);
        self.streams.seed(history);
    }

    /// Treats the stream as open without a `RUN_STARTED`.
    pub(crate) fn assume_opened(&mut self) {
        if self.phase == Phase::Idle {
            self.phase = Phase::Assumed;
        }
    }

    /// Ends an active run without a terminal event having been accepted.
    ///
    /// For the reading end, where a rejected `RUN_FINISHED` still arrived:
    /// the run is over whether or not it ended tidily.
    pub(crate) fn end_run(&mut self) {
        if matches!(self.phase, Phase::Assumed | Phase::Active) {
            self.phase = Phase::Finished;
        }
    }

    /// Whether any event has opened the stream.
    pub(crate) fn has_opened(&self) -> bool {
        self.phase != Phase::Idle
    }

    /// Whether a terminal event has ended the run the stream last started.
    pub(crate) fn has_ended(&self) -> bool {
        matches!(self.phase, Phase::Finished | Phase::Failed)
    }

    /// Checks `event` against the rules and records it. A rejected event
    /// leaves the state as it was.
    pub(crate) fn observe(&mut self, event: &Event) -> Result<(), Violation> {
        let at = event.event_type();
        let reject = |broke| Violation { event: at, broke };
        self.admit(at).map_err(reject)?;

        let is_chunk = matches!(
            event,
            Event::TextMessageChunk(_) | Event::ToolCallChunk(_) | Event::ReasoningMessageChunk(_)
        );
        if !is_chunk && self.streams.is_idle() {
            self.apply(event, None).map_err(reject)?;
            // What the chunk model resolves the lane of an untagged event by
            // is what was accepted, and nothing else.
            self.streams.note(event);
            return Ok(());
        }

        // The chunked form: judge the events this one stands for. They are
        // the ends of the streams it closes, which a conforming consumer
        // synthesizes at this point, then the event itself or what a chunk
        // expands to.
        let before = self.streams.checkpoint();
        let mut stood_for = Vec::new();
        let expanded = if is_chunk {
            self.streams.expand_quietly(event.clone(), &mut stood_for)
        } else {
            self.streams.close_for(event, &mut stood_for);
            Ok(())
        };
        let mut ended = Vec::new();
        let judged = expanded.map_err(Broke::Chunk).and_then(|()| {
            for implied in &stood_for {
                self.apply(implied, Some(&mut ended))?;
            }
            if is_chunk {
                Ok(())
            } else {
                self.apply(event, None)
            }
        });
        if judged.is_ok() {
            for implied in &stood_for {
                self.streams.note(implied);
            }
            if !is_chunk {
                self.streams.note(event);
            }
        } else {
            self.streams.rewind(before);
            for entry in ended.into_iter().rev() {
                match entry {
                    Ended::Text(place, id, owner) => self.text.restore(id, place, owner),
                    Ended::Tool(place, id, owner) => self.tool.restore(id, place, owner),
                    Ended::Reasoning(place, id, owner) => {
                        self.reasoning.restore(id, place, owner);
                    }
                }
            }
        }
        judged.map_err(reject)
    }

    // ---- the run lifecycle ----------------------------------------------

    /// Whether an event of this type may arrive in the current phase.
    ///
    /// The one place the run lifecycle is decided: the state diagram of
    /// AG-UI 1.0, `events/lifecycle`.
    fn admit(&self, at: EventType) -> Result<(), Broke> {
        let opens = matches!(at, EventType::RunStarted | EventType::RunError);
        match self.phase {
            Phase::Idle if opens => Ok(()),
            Phase::Idle => Err(Broke::NotStarted),
            Phase::Assumed | Phase::Active => Ok(()),
            // The next run on the same stream.
            Phase::Finished | Phase::Failed if at == EventType::RunStarted => Ok(()),
            // A failure that surfaced after the run reported success.
            Phase::Finished if at == EventType::RunError => Ok(()),
            Phase::Finished | Phase::Failed => Err(Broke::RunEnded),
        }
    }

    /// Forgets what the run that ended had open, for the run that follows it.
    ///
    /// `RUN_FINISHED` found nothing open, so this is what a failed run
    /// abandoned, and what a reader's [`end_run`](Self::end_run) left. The
    /// subagent ids the run used go too: an id names one invocation within a
    /// run, and the next run may announce a suspended one again. The owners
    /// stay, because the messages they describe do.
    fn begin_next_run(&mut self) {
        self.streams.abandon();
        self.text.clear();
        self.tool.clear();
        self.reasoning.clear();
        self.blocks.clear();
        self.steps.clear();
        self.subagents.clear();
        self.closed_subagents.clear();
    }

    // ---- one explicit event ---------------------------------------------

    /// Judges one event in the explicit form and records it. Checks come
    /// before changes, so a rejection leaves nothing behind.
    ///
    /// `ended` is given when the event is a synthesized end: it receives what
    /// the end closed, so the caller can undo it.
    fn apply(&mut self, event: &Event, ended: Option<&mut Vec<Ended>>) -> Result<(), Broke> {
        match event {
            Event::RunStarted(e) => {
                if self.phase == Phase::Active {
                    return Err(Broke::RunStartedTwice);
                }
                if self.has_ended() {
                    self.begin_next_run();
                }
                self.phase = Phase::Active;
                // The input echo replays history the consumer applies, so it
                // seeds ownership like a snapshot does — for ids not yet
                // recorded, since it is history rather than a rewrite.
                if let Some(input) = &e.input {
                    self.seed_owners(&input.messages, false);
                }
            }
            Event::RunFinished(e) => {
                if let Some(open) = self.first_open() {
                    return Err(Broke::StillOpen(open));
                }
                if let Some(error) = e
                    .outcome
                    .as_ref()
                    .and_then(crate::RunOutcome::interrupt_error)
                {
                    return Err(Broke::InvalidOutcome(error));
                }
                self.phase = Phase::Finished;
            }
            // A failing run abandons whatever it had open: that is what
            // failing means.
            Event::RunError(_) => self.phase = Phase::Failed,

            Event::TextMessageStart(e) => {
                let owner = self.claim(Entity::Message, &e.message_id, &e.subagent_run_id)?;
                not_open(&self.text, Entity::Message, &e.message_id)?;
                self.message_owners
                    .entry(e.message_id.clone())
                    .or_insert_with(|| owner.clone());
                self.text.push(e.message_id.clone(), owner);
            }
            Event::TextMessageContent(e) => {
                require(
                    &self.text,
                    Entity::Message,
                    &e.message_id,
                    &e.subagent_run_id,
                )?;
            }
            Event::TextMessageEnd(e) => {
                require(
                    &self.text,
                    Entity::Message,
                    &e.message_id,
                    &e.subagent_run_id,
                )?;
                if let Some((place, owner)) = self.text.remove(&e.message_id) {
                    if let Some(ended) = ended {
                        ended.push(Ended::Text(place, e.message_id.clone(), owner));
                    }
                }
            }

            Event::ToolCallStart(e) => {
                let owner = self.tool_call_owner(
                    &e.tool_call_id,
                    e.parent_message_id.as_ref(),
                    &e.subagent_run_id,
                )?;
                not_open(&self.tool, Entity::ToolCall, &e.tool_call_id)?;
                self.tool_call_owners
                    .insert(e.tool_call_id.clone(), owner.clone());
                self.tool.push(e.tool_call_id.clone(), owner);
            }
            Event::ToolCallArgs(e) => {
                require(
                    &self.tool,
                    Entity::ToolCall,
                    &e.tool_call_id,
                    &e.subagent_run_id,
                )?;
            }
            Event::ToolCallEnd(e) => {
                require(
                    &self.tool,
                    Entity::ToolCall,
                    &e.tool_call_id,
                    &e.subagent_run_id,
                )?;
                if let Some((place, owner)) = self.tool.remove(&e.tool_call_id) {
                    if let Some(ended) = ended {
                        ended.push(Ended::Tool(place, e.tool_call_id.clone(), owner));
                    }
                }
            }
            // The call this answers has to be over. Anything else still
            // streaming is none of this event's business: a result arriving
            // while the assistant keeps narrating is ordinary. Its
            // attribution is its own, too, since whoever executes a call can
            // differ from whoever requested it.
            Event::ToolCallResult(e) => {
                let id = &e.tool_call_id;
                if self.policy.results_answer_known_calls && !self.tool_call_owners.contains_key(id)
                {
                    return Err(Broke::UnknownToolCall {
                        id: id.as_str().to_owned(),
                    });
                }
                if self.tool.contains(id) {
                    return Err(Broke::ResultBeforeEnd {
                        id: id.as_str().to_owned(),
                    });
                }
                // A result mints the tool message it names, under its own
                // attribution. So the newest mint wins, not the first writer,
                // and a re-open of that message by someone else has an owner
                // to disagree with.
                self.message_owners
                    .insert(e.message_id.clone(), e.subagent_run_id.clone());
            }

            // A block is bracketed like everything else, in its own open
            // set. It shares its owner with the message inside it, so
            // `REASONING_START` under one subagent and
            // `REASONING_MESSAGE_START` under another is a contradiction.
            Event::ReasoningStart(e) => {
                let owner =
                    self.claim(Entity::ReasoningMessage, &e.message_id, &e.subagent_run_id)?;
                not_open(&self.blocks, Entity::ReasoningBlock, &e.message_id)?;
                self.reasoning_owners
                    .entry(e.message_id.clone())
                    .or_insert_with(|| owner.clone());
                self.blocks.push(e.message_id.clone(), owner);
            }
            Event::ReasoningEnd(e) => {
                require(
                    &self.blocks,
                    Entity::ReasoningBlock,
                    &e.message_id,
                    &e.subagent_run_id,
                )?;
                self.blocks.remove(&e.message_id);
            }
            Event::ReasoningMessageStart(e) => {
                let owner =
                    self.claim(Entity::ReasoningMessage, &e.message_id, &e.subagent_run_id)?;
                not_open(&self.reasoning, Entity::ReasoningMessage, &e.message_id)?;
                self.reasoning_owners
                    .entry(e.message_id.clone())
                    .or_insert_with(|| owner.clone());
                self.reasoning.push(e.message_id.clone(), owner);
            }
            Event::ReasoningMessageContent(e) => {
                require(
                    &self.reasoning,
                    Entity::ReasoningMessage,
                    &e.message_id,
                    &e.subagent_run_id,
                )?;
            }
            Event::ReasoningMessageEnd(e) => {
                require(
                    &self.reasoning,
                    Entity::ReasoningMessage,
                    &e.message_id,
                    &e.subagent_run_id,
                )?;
                if let Some((place, owner)) = self.reasoning.remove(&e.message_id) {
                    if let Some(ended) = ended {
                        ended.push(Ended::Reasoning(place, e.message_id.clone(), owner));
                    }
                }
            }
            // Continues an entity by id, and `subtype` says which kind: a
            // tool call's owner lives in a different map from a message's.
            Event::ReasoningEncryptedValue(e) => {
                let (entity, owner) = match e.subtype {
                    ReasoningEncryptedValueSubtype::ToolCall => (
                        Entity::ToolCall,
                        self.tool_call_owners
                            .get(&ToolCallId::new(e.entity_id.clone())),
                    ),
                    // "message" spans both kinds; ids are unique per kind, so
                    // at most one bucket answers.
                    ReasoningEncryptedValueSubtype::Message => {
                        let id = MessageId::new(e.entity_id.clone());
                        (
                            Entity::Message,
                            self.message_owners
                                .get(&id)
                                .or_else(|| self.reasoning_owners.get(&id)),
                        )
                    }
                };
                if let Some(owner) = owner {
                    agrees(
                        entity,
                        &e.entity_id,
                        owner,
                        &e.subagent_run_id,
                        Claim::Continues,
                    )?;
                }
            }

            // An activity is minted by a snapshot and continued by deltas
            // against the same id. Only a *replacing* snapshot re-mints it
            // and so re-owns it; with `replace: false` the consumer leaves
            // the existing message where it was, and so does the recorded
            // owner.
            Event::ActivitySnapshot(e) => {
                if e.replace || !self.activity_owners.contains_key(&e.message_id) {
                    self.activity_owners
                        .insert(e.message_id.clone(), e.subagent_run_id.clone());
                }
            }
            Event::ActivityDelta(e) => {
                if let Some(owner) = self.activity_owners.get(&e.message_id) {
                    let named = &e.subagent_run_id;
                    agrees(
                        Entity::Activity,
                        &e.message_id,
                        owner,
                        named,
                        Claim::Continues,
                    )?;
                }
            }

            Event::StepStarted(e) => {
                let key = (e.subagent_run_id.clone(), e.step_name.clone());
                if self.steps.contains(&key) {
                    return Err(Broke::StepRunning {
                        name: key.1.as_str().to_owned(),
                        owner: key.0,
                    });
                }
                self.steps.push(key, ());
            }
            Event::StepFinished(e) => {
                let key = (e.subagent_run_id.clone(), e.step_name.clone());
                if self.steps.remove(&key).is_none() {
                    return Err(Broke::StepNotRunning {
                        name: key.1.as_str().to_owned(),
                        owner: key.0,
                    });
                }
            }

            Event::SubagentStarted(e) => {
                let id = &e.subagent_run_id;
                if self.subagents.contains(id) {
                    return Err(Broke::SubagentActive {
                        id: id.as_str().to_owned(),
                    });
                }
                if self.closed_subagents.contains(id) {
                    return Err(Broke::SubagentReused {
                        id: id.as_str().to_owned(),
                    });
                }
                // A parent may have finished already: it legitimately
                // finishes before its child.
                if let Some(parent) = &e.parent_subagent_run_id {
                    if !self.subagents.contains(parent) && !self.closed_subagents.contains(parent) {
                        return Err(Broke::UnknownParentSubagent {
                            id: id.as_str().to_owned(),
                            parent: parent.as_str().to_owned(),
                        });
                    }
                }
                self.subagents.push(id.clone(), ());
            }
            Event::SubagentFinished(e) => self.close_subagent(&e.subagent_run_id)?,
            Event::SubagentError(e) => self.close_subagent(&e.subagent_run_id)?,

            // Authoritative: the snapshot restates the conversation, so its
            // owners replace whatever was recorded.
            Event::MessagesSnapshot(e) => self.seed_owners(&e.messages, true),

            // Unordered: state, raw and custom events open and close nothing.
            // A chunk never reaches here unexpanded, and the retired
            // THINKING_* family is not tracked: a consumer translates it
            // before this stage and a producer does not send it.
            _ => {}
        }
        Ok(())
    }

    // ---- ownership ------------------------------------------------------

    /// The owner in force for a message or reasoning id an event opens: the
    /// recorded one — the first writer — or the event's own tag when the id
    /// is new. Rejects a tag that disagrees with the recorded owner.
    ///
    /// An untagged opener of an owned id is accepted and does not hand the id
    /// to the parent: an absent tag agrees with any owner, and the consumer
    /// keeps the message where it was.
    fn claim(&self, entity: Entity, id: &MessageId, named: &Owner) -> Result<Owner, Broke> {
        let owners = match entity {
            Entity::Message => &self.message_owners,
            _ => &self.reasoning_owners,
        };
        match owners.get(id) {
            Some(owner) => {
                agrees(entity, id, owner, named, Claim::Opens)?;
                Ok(owner.clone())
            }
            None => Ok(named.clone()),
        }
    }

    /// Who a tool call belongs to: its tag, else the owner of the message
    /// that carries it, else whoever introduced it before, else the parent
    /// agent.
    ///
    /// A tag that disagrees with the carrying message's owner cannot be
    /// represented, since a tool call in a message has no attribution of its
    /// own, and is rejected. So is an asserted owner that disagrees with a
    /// recorded one.
    fn tool_call_owner(
        &self,
        id: &ToolCallId,
        parent_message_id: Option<&MessageId>,
        named: &Owner,
    ) -> Result<Owner, Broke> {
        let inherited = parent_message_id
            .and_then(|parent| self.message_owners.get(parent).map(|owner| (parent, owner)));
        if let Some((parent, owner)) = inherited {
            if named.is_some() && owner != named {
                return Err(Broke::ParentMismatch {
                    id: id.as_str().to_owned(),
                    named: named.clone(),
                    parent: parent.as_str().to_owned(),
                    owner: owner.clone(),
                });
            }
        }
        let asserted: Option<Owner> = if named.is_some() {
            Some(named.clone())
        } else {
            inherited.map(|(_, owner)| owner.clone())
        };
        let known = self.tool_call_owners.get(id);
        if let (Some(asserted), Some(known)) = (&asserted, known) {
            if asserted != known {
                return Err(Broke::OwnerMismatch {
                    entity: Entity::ToolCall,
                    id: id.as_str().to_owned(),
                    owner: known.clone(),
                    named: asserted.clone(),
                    claim: Claim::Opens,
                });
            }
        }
        Ok(asserted.or_else(|| known.cloned()).unwrap_or(None))
    }

    /// Records the owners of replayed messages, and of the tool calls they
    /// carry: authoritatively for a `MESSAGES_SNAPSHOT`, which restates the
    /// conversation, and for ids not yet recorded when history is replayed.
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

    fn close_subagent(&mut self, id: &SubagentRunId) -> Result<(), Broke> {
        match self.subagents.remove(id) {
            Some(_) => {
                self.closed_subagents.insert(id.clone());
                Ok(())
            }
            None => Err(Broke::SubagentNotActive {
                id: id.as_str().to_owned(),
            }),
        }
    }

    // ---- what is open ---------------------------------------------------

    /// The first thing still open, in a fixed order of kinds and, within a
    /// kind, the order things were opened in.
    fn first_open(&self) -> Option<Open> {
        let entity = |entity, id: &str| Open::Entity {
            entity,
            id: id.to_owned(),
        };
        if let Some((id, _)) = self.text.first() {
            return Some(entity(Entity::Message, id.as_str()));
        }
        if let Some((id, _)) = self.tool.first() {
            return Some(entity(Entity::ToolCall, id.as_str()));
        }
        if let Some((id, _)) = self.reasoning.first() {
            return Some(entity(Entity::ReasoningMessage, id.as_str()));
        }
        if let Some((id, _)) = self.blocks.first() {
            return Some(entity(Entity::ReasoningBlock, id.as_str()));
        }
        if let Some(((owner, name), ())) = self.steps.first() {
            return Some(Open::Step {
                name: name.as_str().to_owned(),
                owner: owner.clone(),
            });
        }
        self.subagents.first().map(|(id, ())| Open::Subagent {
            id: id.as_str().to_owned(),
        })
    }

    /// Everything open, by kind and in opening order, for a diagnostic.
    pub(crate) fn open(&self) -> OpenSets<'_> {
        fn ids<K: Eq + std::hash::Hash + AsRef<str>, V>(set: &OpenSet<K, V>) -> Vec<&str> {
            set.in_order()
                .into_iter()
                .map(|(id, _)| id.as_ref())
                .collect()
        }
        OpenSets {
            messages: ids(&self.text),
            tool_calls: ids(&self.tool),
            reasoning_messages: ids(&self.reasoning),
            reasoning_blocks: ids(&self.blocks),
            steps: self
                .steps
                .in_order()
                .into_iter()
                .map(|((owner, name), ())| {
                    (owner.as_ref().map(SubagentRunId::as_str), name.as_str())
                })
                .collect(),
            subagents: self
                .subagents
                .in_order()
                .into_iter()
                .map(|(id, ())| id.as_str())
                .collect(),
        }
    }
}

/// The ids of everything open, by kind and in opening order.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct OpenSets<'a> {
    pub(crate) messages: Vec<&'a str>,
    pub(crate) tool_calls: Vec<&'a str>,
    pub(crate) reasoning_messages: Vec<&'a str>,
    pub(crate) reasoning_blocks: Vec<&'a str>,
    /// Each step with the subagent that runs it, `None` for the parent agent.
    pub(crate) steps: Vec<(Option<&'a str>, &'a str)>,
    pub(crate) subagents: Vec<&'a str>,
}

/// The whole of the attribution rule: a tag, when there is one, names the
/// owner.
fn agrees(
    entity: Entity,
    id: &str,
    owner: &Owner,
    named: &Owner,
    claim: Claim,
) -> Result<(), Broke> {
    if named.is_some() && owner != named {
        return Err(Broke::OwnerMismatch {
            entity,
            id: id.to_owned(),
            owner: owner.clone(),
            named: named.clone(),
            claim,
        });
    }
    Ok(())
}

/// Rejects a start for an id that is already open. The whole of the
/// concurrency rule: two ids may overlap, one id may not overlap itself.
fn not_open<T: Eq + std::hash::Hash + AsRef<str>>(
    open: &OpenSet<T, Owner>,
    entity: Entity,
    id: &T,
) -> Result<(), Broke> {
    if open.contains(id) {
        return Err(Broke::AlreadyOpen {
            entity,
            id: id.as_ref().to_owned(),
        });
    }
    Ok(())
}

/// Checks that an id is open, for an event that continues or closes it, and
/// that the event agrees with its opener about who owns it.
fn require<T: Eq + std::hash::Hash + AsRef<str>>(
    open: &OpenSet<T, Owner>,
    entity: Entity,
    id: &T,
    named: &Owner,
) -> Result<(), Broke> {
    let Some(owner) = open.get(id) else {
        return Err(Broke::NotOpen {
            entity,
            id: id.as_ref().to_owned(),
        });
    };
    agrees(entity, id.as_ref(), owner, named, Claim::Continues)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RunAgentInput, TextMessageRole};

    fn started(policy: Policy) -> Ordering {
        let mut rules = Ordering::new(policy);
        rules.observe(&Event::run_started("t", "r")).unwrap();
        rules
    }

    fn broke(rules: &mut Ordering, event: Event) -> Broke {
        rules
            .observe(&event)
            .expect_err("the event breaks a rule")
            .broke
    }

    fn text_chunk(id: Option<&str>, delta: &str) -> Event {
        Event::text_message_chunk(id.map(MessageId::new), Some(delta.to_owned()))
    }

    fn start(id: &str) -> Event {
        Event::text_message_start(id, TextMessageRole::Assistant)
    }

    #[test]
    fn the_lifecycle_is_the_one_in_the_specification() {
        // Idle: only RUN_STARTED and RUN_ERROR open a stream.
        let mut rules = Ordering::new(Policy::CONSUMER);
        assert_eq!(broke(&mut rules, start("m1")), Broke::NotStarted);
        assert!(!rules.has_opened(), "a rejected first event opens nothing");
        rules.observe(&Event::run_error("unreachable")).unwrap();
        assert!(rules.has_ended());

        // Active: a second RUN_STARTED is a nested run.
        let mut rules = started(Policy::CONSUMER);
        assert_eq!(
            broke(&mut rules, Event::run_started("t", "r2")),
            Broke::RunStartedTwice
        );

        // Closed: one late RUN_ERROR or the next run, and nothing else.
        rules.observe(&Event::run_finished("t", "r")).unwrap();
        assert_eq!(broke(&mut rules, start("m1")), Broke::RunEnded);
        assert_eq!(
            broke(&mut rules, Event::run_finished("t", "r")),
            Broke::RunEnded
        );
        rules.observe(&Event::run_error("while flushing")).unwrap();

        // Failed: the next run, and nothing else.
        assert_eq!(
            broke(&mut rules, Event::run_error("again")),
            Broke::RunEnded
        );
        assert_eq!(broke(&mut rules, start("m1")), Broke::RunEnded);
        assert!(rules.has_ended());
        rules.observe(&Event::run_started("t", "r2")).unwrap();
        assert!(!rules.has_ended());
        rules.observe(&start("m1")).unwrap();

        // Closed again, and the run after it starts straight away.
        rules.observe(&Event::text_message_end("m1")).unwrap();
        rules.observe(&Event::run_finished("t", "r2")).unwrap();
        rules.observe(&Event::run_started("t", "r3")).unwrap();
        assert_eq!(
            broke(&mut rules, Event::run_started("t", "r4")),
            Broke::RunStartedTwice
        );
    }

    #[test]
    fn a_new_run_starts_with_nothing_open_and_keeps_the_owners() {
        for policy in [Policy::PRODUCER, Policy::CONSUMER] {
            let mut rules = started(policy);
            for event in [
                Event::subagent_started("s1", "researcher"),
                Event::subagent_started("s2", "writer"),
                Event::subagent_finished_success("s2"),
                start("m1").with_subagent_run_id("s1"),
                Event::tool_call_start("c1", "search"),
                Event::reasoning_start("r1"),
                Event::reasoning_message_start("r1"),
                Event::step_started("plan"),
                text_chunk(Some("m2"), "a"),
                // The failed run abandons all of it.
                Event::run_error("the model hung up"),
                Event::run_started("t", "r2"),
            ] {
                rules.observe(&event).unwrap();
            }
            assert_eq!(rules.open(), OpenSets::default(), "{policy:?}");

            // Nothing the failed run opened can be continued ...
            assert!(matches!(
                broke(&mut rules, Event::text_message_content("m1", "x")),
                Broke::NotOpen { .. }
            ));
            assert!(matches!(
                broke(&mut rules, text_chunk(None, "b")),
                Broke::Chunk(ChunkError::NothingOpen { .. })
            ));
            assert!(matches!(
                broke(&mut rules, Event::step_finished("plan")),
                Broke::StepNotRunning { .. }
            ));
            assert!(matches!(
                broke(&mut rules, Event::subagent_finished_success("s1")),
                Broke::SubagentNotActive { .. }
            ));
            // ... each id may be opened again, a finished subagent's included ...
            for event in [
                Event::step_started("plan"),
                Event::step_finished("plan"),
                Event::subagent_started("s2", "writer"),
                Event::subagent_finished_success("s2"),
            ] {
                rules.observe(&event).unwrap();
            }
            // ... and the first writer of an id is still its owner.
            assert!(matches!(
                broke(&mut rules, start("m1").with_subagent_run_id("s2")),
                Broke::OwnerMismatch { .. }
            ));
            rules
                .observe(&Event::tool_call_result("m3", "c1", "ok"))
                .expect("a call the run before introduced is known");
            rules.observe(&Event::run_finished("t", "r2")).unwrap();
        }
    }

    #[test]
    fn a_rejected_run_started_changes_nothing() {
        let mut rules = started(Policy::PRODUCER);
        rules.observe(&start("m1")).unwrap();
        rules.observe(&text_chunk(Some("m2"), "a")).unwrap();
        let before = format!("{rules:?}");
        assert_eq!(
            broke(&mut rules, Event::run_started("t", "r2")),
            Broke::RunStartedTwice
        );
        assert_eq!(format!("{rules:?}"), before);
    }

    #[test]
    fn both_ends_reach_the_same_verdict_except_where_the_policy_says() {
        let result = || Event::tool_call_result("m1", "c-unseen", "ok");
        assert_eq!(
            broke(&mut started(Policy::PRODUCER), result()),
            Broke::UnknownToolCall {
                id: "c-unseen".into()
            }
        );
        started(Policy::CONSUMER).observe(&result()).unwrap();
    }

    #[test]
    fn history_makes_a_call_known() {
        let history = [Message::Assistant(crate::AssistantMessage {
            id: "a1".into(),
            tool_calls: Some(vec![crate::ToolCall::new("c1", "search", "{}")]),
            ..Default::default()
        })];
        let result = Event::tool_call_result("m1", "c1", "ok");

        let mut seeded = Ordering::new(Policy::PRODUCER);
        seeded.seed(&history);
        seeded.observe(&Event::run_started("t", "r")).unwrap();
        seeded.observe(&result).unwrap();

        let mut input = RunAgentInput::new("t", "r");
        input.messages = history.to_vec();
        let mut echo = crate::RunStartedEvent::new("t", "r");
        echo.input = Some(Box::new(input));
        let mut echoed = Ordering::new(Policy::PRODUCER);
        echoed.observe(&Event::RunStarted(echo)).unwrap();
        echoed.observe(&result).unwrap();
    }

    #[test]
    fn a_chunk_is_judged_as_the_events_it_stands_for() {
        let mut rules = started(Policy::PRODUCER);
        rules.observe(&text_chunk(Some("m1"), "a")).unwrap();
        assert_eq!(rules.open().messages, ["m1"]);
        // The violation names the chunk the producer sent.
        let unnamed = Event::tool_call_chunk(Some("c1".into()), None, Some("{}".into()));
        let violation = rules.observe(&unnamed).unwrap_err();
        assert_eq!(violation.event, EventType::ToolCallChunk);
        assert!(matches!(
            violation.broke,
            Broke::Chunk(ChunkError::Unnamed { .. })
        ));
        // CUSTOM ends the stream, so a chunk naming no id has nothing left.
        rules
            .observe(&Event::custom("note", serde_json::json!(1)))
            .unwrap();
        assert!(rules.open().messages.is_empty());
        assert!(matches!(
            broke(&mut rules, text_chunk(None, "b")),
            Broke::Chunk(ChunkError::NothingOpen { .. })
        ));
        rules.observe(&Event::run_finished("t", "r")).unwrap();
    }

    #[test]
    fn the_two_spellings_do_not_mix_within_one_item() {
        // A chunk naming an explicitly opened message opens it a second time.
        let mut rules = started(Policy::CONSUMER);
        rules.observe(&start("m1")).unwrap();
        assert_eq!(
            broke(&mut rules, text_chunk(Some("m1"), "a")),
            Broke::AlreadyOpen {
                entity: Entity::Message,
                id: "m1".into()
            }
        );

        // An explicit event ends the chunk stream, then finds nothing open.
        let mut rules = started(Policy::CONSUMER);
        rules.observe(&text_chunk(Some("m1"), "a")).unwrap();
        assert_eq!(
            broke(&mut rules, Event::text_message_content("m1", "b")),
            Broke::NotOpen {
                entity: Entity::Message,
                id: "m1".into()
            }
        );
    }

    #[test]
    fn a_rejected_event_leaves_the_state_as_it_was() {
        let mut rules = started(Policy::PRODUCER);
        rules.observe(&Event::step_started("plan")).unwrap();
        rules.observe(&text_chunk(Some("m1"), "a")).unwrap();
        rules
            .observe(&text_chunk(Some("m2"), "b").with_subagent_run_id("s1"))
            .unwrap();
        let before = format!("{rules:?}");

        // RUN_FINISHED would end both chunk streams, and is refused for the
        // step. Neither stream ended: the event was never sent.
        assert!(matches!(
            broke(&mut rules, Event::run_finished("t", "r")),
            Broke::StillOpen(Open::Step { .. })
        ));
        assert_eq!(format!("{rules:?}"), before);
        // So is an explicit end for the chunk-opened message.
        assert!(matches!(
            broke(&mut rules, Event::text_message_end("m1")),
            Broke::NotOpen { .. }
        ));
        assert_eq!(format!("{rules:?}"), before);

        rules.observe(&text_chunk(None, " more")).unwrap();
        rules.observe(&Event::step_finished("plan")).unwrap();
        rules.observe(&Event::run_finished("t", "r")).unwrap();
    }

    #[test]
    fn the_state_is_rebuilt_by_replaying_what_was_accepted() {
        let events = [
            Event::run_started("t", "r"),
            Event::subagent_started("s1", "researcher"),
            start("m1").with_subagent_run_id("s1"),
            Event::tool_call_chunk(Some("c1".into()), Some("search".into()), None),
            Event::step_started("plan"),
        ];
        let mut rules = Ordering::new(Policy::PRODUCER);
        for event in &events {
            rules.observe(event).unwrap();
        }
        let mut replayed = Ordering::new(Policy::PRODUCER);
        for event in &events {
            replayed.observe(event).unwrap();
        }
        assert_eq!(rules.open(), replayed.open());
        assert_eq!(rules.clone().open(), rules.open());
        // Whichever was opened first is the one a complaint names.
        assert_eq!(
            broke(&mut replayed, Event::run_finished("t", "r")),
            Broke::StillOpen(Open::Entity {
                entity: Entity::Message,
                id: "m1".into()
            })
        );
    }

    #[test]
    fn an_interrupt_outcome_names_an_interrupt() {
        let mut rules = started(Policy::PRODUCER);
        assert_eq!(
            broke(
                &mut rules,
                Event::run_finished_interrupt("t", "r", Vec::new())
            ),
            Broke::InvalidOutcome(
                "RUN_FINISHED outcome `interrupt` requires at least one interrupt".into()
            )
        );
        assert!(!rules.has_ended());
    }

    /// Who owns what: one stream per clause of the attribution rule, with
    /// the index of the event that must be rejected, or `None` for a stream
    /// that passes whole.
    fn ownership() -> Vec<(&'static str, Vec<Event>, Option<usize>)> {
        use crate::{
            ActivitySnapshotEvent, AssistantMessage, JsonObject, PatchOperation, RunStartedEvent,
            ToolCall, ToolCallStartEvent,
        };
        let tagged = |event: Event, id: &str| event.with_subagent_run_id(id);
        let call_in = |message: &str, id: &str| {
            let mut start = ToolCallStartEvent::new(id, "search");
            start.parent_message_id = Some(message.into());
            Event::ToolCallStart(start)
        };
        let activity = |id: &str, replace: bool| {
            let mut event = ActivitySnapshotEvent::new(id, "progress", JsonObject::new());
            event.replace = replace;
            Event::ActivitySnapshot(event)
        };
        let delta =
            |id: &str| Event::activity_delta(id, "progress", vec![PatchOperation::add("/step", 1)]);
        let history = |owner: Option<&str>| {
            Message::Assistant(AssistantMessage {
                id: "h1".into(),
                content: Some("earlier".into()),
                tool_calls: Some(vec![ToolCall::new("hc1", "search", "{}")]),
                subagent_run_id: owner.map(Into::into),
                ..Default::default()
            })
        };
        let echo = |messages: Vec<Message>| {
            let mut input = RunAgentInput::new("t", "r");
            input.messages = messages;
            let mut started = RunStartedEvent::new("t", "r");
            started.input = Some(Box::new(input));
            Event::RunStarted(started)
        };
        let value = |subtype, id: &str| Event::reasoning_encrypted_value(subtype, id, "x");
        let run = || Event::run_started("t", "r");
        let done = || Event::run_finished_success("t", "r");
        vec![
            (
                "a tagged continuation must name the opener",
                vec![
                    run(),
                    tagged(start("m1"), "s1"),
                    tagged(Event::text_message_content("m1", "x"), "s2"),
                ],
                Some(2),
            ),
            (
                "the first writer keeps the id through an untagged re-open",
                vec![
                    run(),
                    tagged(start("m1"), "s1"),
                    tagged(Event::text_message_end("m1"), "s1"),
                    start("m1"),
                    tagged(Event::text_message_content("m1", "x"), "s1"),
                    Event::text_message_end("m1"),
                    tagged(call_in("m1", "c1"), "s1"),
                    tagged(Event::tool_call_end("c1"), "s1"),
                    done(),
                ],
                None,
            ),
            (
                "and a sibling still may not continue it",
                vec![
                    run(),
                    tagged(start("m1"), "s1"),
                    tagged(Event::text_message_end("m1"), "s1"),
                    start("m1"),
                    tagged(Event::text_message_content("m1", "x"), "s2"),
                ],
                Some(4),
            ),
            (
                "a tool call belongs to the message that carries it",
                vec![
                    run(),
                    tagged(start("m1"), "s1"),
                    tagged(call_in("m1", "c1"), "s2"),
                ],
                Some(2),
            ),
            (
                "an untagged call inherits, so a sibling cannot continue it",
                vec![
                    run(),
                    tagged(start("m1"), "s1"),
                    call_in("m1", "c1"),
                    tagged(Event::tool_call_args("c1", "{}"), "s2"),
                ],
                Some(3),
            ),
            (
                "the echo seeds ownership",
                vec![echo(vec![history(Some("s1"))]), tagged(start("h1"), "s2")],
                Some(1),
            ),
            (
                "the echo seeds tool calls too",
                vec![
                    echo(vec![history(Some("s1"))]),
                    tagged(Event::tool_call_start("hc1", "search"), "s2"),
                ],
                Some(1),
            ),
            (
                "a snapshot is authoritative over the echo",
                vec![
                    echo(vec![history(Some("s1"))]),
                    Event::messages_snapshot(vec![history(None)]),
                    tagged(start("h1"), "s1"),
                ],
                Some(2),
            ),
            (
                "a result mints its message under its own attribution",
                vec![
                    run(),
                    Event::tool_call_start("c1", "search"),
                    Event::tool_call_end("c1"),
                    tagged(Event::tool_call_result("m2", "c1", "ok"), "s1"),
                    start("m2"),
                    tagged(Event::text_message_end("m2"), "s2"),
                ],
                Some(5),
            ),
            (
                "a reasoning block and its message share an owner",
                vec![
                    run(),
                    tagged(Event::reasoning_start("r1"), "s1"),
                    tagged(Event::reasoning_message_start("r1"), "s2"),
                ],
                Some(2),
            ),
            (
                "a text message and a reasoning message may share an id",
                vec![
                    run(),
                    tagged(start("x"), "s1"),
                    tagged(Event::text_message_end("x"), "s1"),
                    tagged(Event::reasoning_message_start("x"), "s2"),
                    tagged(Event::reasoning_message_end("x"), "s2"),
                    done(),
                ],
                None,
            ),
            (
                "an encrypted value names the owner of its tool call",
                vec![
                    run(),
                    tagged(Event::tool_call_start("c1", "search"), "s1"),
                    tagged(Event::tool_call_end("c1"), "s1"),
                    tagged(value(ReasoningEncryptedValueSubtype::ToolCall, "c1"), "s2"),
                ],
                Some(3),
            ),
            (
                "an encrypted value names the owner of its reasoning message",
                vec![
                    run(),
                    tagged(Event::reasoning_message_start("r1"), "s1"),
                    tagged(Event::reasoning_message_end("r1"), "s1"),
                    tagged(value(ReasoningEncryptedValueSubtype::Message, "r1"), "s2"),
                ],
                Some(3),
            ),
            (
                "an activity delta names the owner of the activity",
                vec![
                    run(),
                    tagged(activity("a1", true), "s1"),
                    delta("a1"),
                    activity("a1", false),
                    tagged(delta("a1"), "s2"),
                ],
                Some(4),
            ),
            (
                "a replacing snapshot re-owns the activity",
                vec![
                    run(),
                    tagged(activity("a1", true), "s1"),
                    tagged(activity("a1", true), "s2"),
                    tagged(delta("a1"), "s2"),
                    done(),
                ],
                None,
            ),
            (
                "steps are keyed by owner",
                vec![
                    run(),
                    Event::step_started("plan"),
                    tagged(Event::step_started("plan"), "s1"),
                    tagged(Event::step_finished("plan"), "s1"),
                    tagged(Event::step_finished("plan"), "s2"),
                ],
                Some(4),
            ),
            (
                "concurrent subagents interleave under their own tags",
                vec![
                    run(),
                    Event::subagent_started("s1", "researcher"),
                    Event::subagent_started("s2", "researcher"),
                    tagged(start("m1"), "s1"),
                    tagged(start("m2"), "s2"),
                    tagged(Event::text_message_content("m1", "a"), "s1"),
                    tagged(Event::text_message_content("m2", "b"), "s2"),
                    tagged(Event::text_message_end("m2"), "s2"),
                    Event::subagent_finished_success("s2"),
                    tagged(Event::text_message_end("m1"), "s1"),
                    Event::subagent_finished_success("s1"),
                    done(),
                ],
                None,
            ),
            (
                "a run may not finish with a subagent active",
                vec![run(), Event::subagent_started("s1", "researcher"), done()],
                Some(2),
            ),
        ]
    }

    #[test]
    fn every_clause_of_the_attribution_rule_holds_at_both_ends() {
        for policy in [Policy::PRODUCER, Policy::CONSUMER] {
            for (name, events, expected) in ownership() {
                let mut rules = Ordering::new(policy);
                let rejected = events
                    .iter()
                    .position(|event| rules.observe(event).is_err());
                assert_eq!(rejected, expected, "{policy:?}, {name}: {events:?}");
            }
        }
    }
}
