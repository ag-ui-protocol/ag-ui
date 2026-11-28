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
//! 1. `RUN_STARTED` opens the stream — or `RUN_ERROR` does, for a run that
//!    failed before it began. Nothing else may come first, `RAW` and `CUSTOM`
//!    included.
//! 2. `RUN_FINISHED` and `RUN_ERROR` end the run. Two things may follow: one
//!    `RUN_ERROR` after `RUN_FINISHED`, a failure that surfaced after the run
//!    reported success, which fails the run; and after either, a
//!    `RUN_STARTED`, which begins the next run on the same stream. A
//!    `RUN_STARTED` inside a run that has not ended is rejected.
//! 3. `TEXT_MESSAGE_CONTENT` and `TEXT_MESSAGE_END` require an open message
//!    with the same id, and `TEXT_MESSAGE_START` may not re-open an id that is
//!    already open.
//! 4. The same, for `TOOL_CALL_*`, for `REASONING_MESSAGE_*`, and for the
//!    block `REASONING_START` and `REASONING_END` bracket. A block and the
//!    message inside it may share an id, so each has its own open set: content
//!    naming a block's id has no open message to land in.
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
//! custom) are unordered and close nothing that was opened explicitly. A
//! `MESSAGES_SNAPSHOT`
//! seeds ownership from the messages it carries and is authoritative; the
//! `RUN_STARTED` input echo seeds it too, for ids not yet recorded; and a
//! `TOOL_CALL_RESULT` mints the tool message it names under its own
//! attribution.
//!
//! # Several runs
//!
//! AG-UI 1.0 lets one stream carry several runs in sequence: the run a
//! request asked for, preceded by runs the producer replays. Every rule
//! above that says "open" is about one run. A new run starts with nothing
//! open, whatever a failed run left behind, and may announce again a
//! subagent the run before it suspended. Who owns an id is about the stream:
//! messages accumulate across runs, and a message keeps its first writer.
//!
//! ```
//! use ag_ui::client::verify_all;
//! use ag_ui::Event;
//!
//! verify_all(&[
//!     Event::run_started("thread-1", "run-1"),
//!     Event::run_error("the model provider went away"),
//!     Event::run_started("thread-1", "run-2"),
//!     Event::run_finished_success("thread-1", "run-2"),
//! ])?;
//! # Ok::<(), ag_ui::client::Error>(())
//! ```
//!
//! # Chunks
//!
//! A `*_CHUNK` event is judged as the events it stands for.
//! [`crate::client::chunks`] expands chunks before this stage, so a
//! [`Thread`](crate::client::Thread) never shows it one; a verifier handed a
//! raw stream expands each chunk itself, by the same model, and rejects one
//! that cannot be expanded.
//!
//! # One set of rules
//!
//! The rules are not written here. They are the crate's shared ordering
//! rules, the ones a hosted run checks what it emits by. This module words a
//! rejection for whoever is reading the stream, and differs from the
//! producer's reading in two places, both about what only one end knows:
//!
//! - [`Verifier::finish`] reports a stream that stopped before a terminal
//!   event. Only a reader can see that.
//! - A `TOOL_CALL_RESULT` for a call this stream never introduced is
//!   accepted. A producer rejects one, since it knows every call it answers;
//!   a reader may hold less of the conversation than the producer does.

use crate::ordering::{Broke, Claim, Entity, Open, Ordering, Policy, Violation, describe};
use crate::{Event, EventType};

use crate::client::error::{Error, Result};

/// An ordering state machine for one event stream.
///
/// One verifier per stream: it is stateful, and its state is that stream's
/// progress, through however many runs the stream carries.
#[derive(Clone, Debug)]
pub struct Verifier {
    rules: Ordering,
}

impl Default for Verifier {
    fn default() -> Self {
        Self::new()
    }
}

impl Verifier {
    /// A verifier for a stream that has not started yet.
    pub fn new() -> Self {
        Self {
            rules: Ordering::new(Policy::CONSUMER),
        }
    }

    /// Checks one event against the rules, and records it.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`], naming the rule that was broken.
    pub fn verify(&mut self, event: &Event) -> Result<()> {
        let observed = self.rules.observe(event);
        if observed.is_err() && matches!(event, Event::RunFinished(_)) {
            // The run is over whether or not it ended tidily: the event
            // arrived. Reporting the untidiness twice, once here and again
            // from `finish`, helps nobody.
            self.rules.end_run();
        }
        observed.map_err(|violation| Error::protocol(sentence(&violation)))
    }

    /// Checks the stream ended where it was supposed to.
    ///
    /// # Errors
    ///
    /// [`Error::Protocol`] when the transport ended the stream before the agent
    /// finished the run it was in — a truncated response, which otherwise
    /// looks exactly like a short answer.
    pub fn finish(&self) -> Result<()> {
        // A stream that opened with RUN_ERROR never started, and is complete.
        if !self.rules.has_opened() {
            return Err(Error::protocol("the stream ended before RUN_STARTED"));
        }
        if !self.rules.has_ended() {
            return Err(Error::protocol(
                "the stream ended before RUN_FINISHED or RUN_ERROR",
            ));
        }
        Ok(())
    }
}

/// A violation as one sentence, for whoever is reading the stream: the event
/// that arrived, then what was wrong with it.
fn sentence(violation: &Violation) -> String {
    let event = violation.event;
    match &violation.broke {
        Broke::NotStarted => format!("{event} arrived before RUN_STARTED"),
        Broke::RunEnded => format!("{event} arrived after the run had already finished"),
        Broke::RunStartedTwice => format!("{event} arrived while a run was still active"),
        Broke::AlreadyOpen { entity, id } => {
            format!(
                "{event} for {} {id:?}, which is already open",
                entity.noun()
            )
        }
        Broke::NotOpen { entity, id } => {
            format!("{event} for {} {id:?}, which is not open", entity.noun())
        }
        Broke::OwnerMismatch {
            entity,
            id,
            owner,
            named,
            claim,
        } => {
            let what = entity.noun();
            let relation = match (claim, entity) {
                (Claim::Continues, _) => format!("the {what} was opened by"),
                (Claim::Opens, Entity::ToolCall) => "the call belongs to".to_owned(),
                (Claim::Opens, _) => format!("the {what} belongs to"),
            };
            format!(
                "{event} for {what} {id:?} names {}, but {relation} {}",
                describe(named),
                describe(owner)
            )
        }
        Broke::ParentMismatch {
            id,
            named,
            parent,
            owner,
        } => format!(
            "{event} for tool call {id:?} names {}, but its parent message {parent:?} belongs to {}; \
             a tool call belongs to the message that carries it",
            describe(named),
            describe(owner)
        ),
        Broke::UnknownToolCall { id } => {
            format!("{event} for tool call {id:?}, which was never started")
        }
        Broke::ResultBeforeEnd { id } => {
            format!("{event} for tool call {id:?}, which has not ended yet")
        }
        Broke::StepRunning { name, owner } => format!(
            "{event} for {name:?}, which is already running under {}",
            describe(owner)
        ),
        Broke::StepNotRunning { name, owner } => format!(
            "{event} for {name:?}, which never started under {}",
            describe(owner)
        ),
        Broke::SubagentActive { id } => {
            format!("{event} for subagent {id:?}, which is already active")
        }
        Broke::SubagentReused { id } => format!(
            "{event} for subagent {id:?}, which already finished in this run; \
             an id names one invocation"
        ),
        Broke::UnknownParentSubagent { id, parent } => {
            format!("{event} for subagent {id:?} names parent {parent:?}, which was never started")
        }
        Broke::SubagentNotActive { id } => {
            format!("{event} for subagent {id:?}, which is not active")
        }
        Broke::StillOpen(Open::Entity { entity, id }) => format!(
            "{event} arrived while {} {id:?} was still open",
            entity.noun()
        ),
        Broke::StillOpen(Open::Step { name, owner }) => format!(
            "{event} arrived while step {name:?} was still running under {}",
            describe(owner)
        ),
        Broke::StillOpen(Open::Subagent { id }) => {
            format!("{event} arrived while subagent {id:?} was still active")
        }
        Broke::InvalidOutcome(detail) => detail.clone(),
        // Already a sentence that begins with the chunk it is about.
        Broke::Chunk(error) => error.to_string(),
    }
}

/// The rejection of a `RUN_STARTED` inside a run that has not ended, for a
/// reader that pairs runs without a [`Verifier`].
pub(crate) fn nested_run_started() -> Error {
    Error::protocol(sentence(&Violation {
        event: EventType::RunStarted,
        broke: Broke::RunStartedTwice,
    }))
}

/// Verifies a whole stream in one call: one run, or several in sequence.
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
