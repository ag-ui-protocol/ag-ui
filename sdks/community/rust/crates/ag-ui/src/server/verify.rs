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
//! | [`RunEnded`] | anything after `RUN_ERROR` except the `RUN_STARTED` of the next run; anything after `RUN_FINISHED` except that or one `RUN_ERROR` |
//! | [`DuplicateRunStarted`] | a `RUN_STARTED` inside a run that has not ended |
//! | [`DuplicateStart`] | opening a message, reasoning block, tool call, step or subagent whose id is already open — or a subagent id that already finished in this run |
//! | [`NotOpen`] | content or a terminator for something that was never opened, including `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` for a subagent that is not active |
//! | [`UnknownId`] | `TOOL_CALL_RESULT` for a call id neither this run nor the history it continues introduced, or a `parentSubagentRunId` that was never started |
//! | [`OutOfOrder`] | `TOOL_CALL_RESULT` before the call's `TOOL_CALL_END`; a first event that is neither `RUN_STARTED` nor `RUN_ERROR` |
//! | [`OpenAtFinish`] | `RUN_FINISHED` while a message, reasoning block, tool call, step or subagent is open |
//! | [`OwnerMismatch`] | a tagged continuation, terminator or re-open whose `subagentRunId` is not the one that opened the entity — a message, reasoning block, tool call, activity, or the entity a `REASONING_ENCRYPTED_VALUE` names; a tool call tagged with one subagent whose parent message belongs to another |
//! | [`MalformedChunk`] | a `*_CHUNK` event that names no id with no chunk stream to continue, opens a tool call without naming the tool, or repeats `role`, `name`, `toolCallName` or `parentMessageId` with a value other than the one its stream was opened with |
//! | [`InvalidOutcome`] | `RUN_FINISHED` with an empty interrupt list or repeated interrupt IDs |
//!
//! `RUN_ERROR` is exempt from [`OpenAtFinish`]: a run that blew up mid-message
//! could not have closed it. When several things are open, the error names
//! one, and the same stream always names the same one: a message before a
//! tool call, before a reasoning message, a reasoning block, a step and a
//! subagent, and of several of a kind the one that was opened first.
//!
//! # After the run ended
//!
//! AG-UI 1.0 lets two things follow a run that ended: one `RUN_ERROR` after
//! `RUN_FINISHED`, a failure that surfaced after the run reported success,
//! and a `RUN_STARTED` after either terminal event, which begins the next
//! run on the same stream. A standalone `EventVerifier` accepts both, so a
//! recorded stream that carries a late failure or several runs in sequence
//! verifies. The next run starts with nothing open, and keeps who owns each
//! id. A hosted run sends neither: its event sink refuses every emit after a
//! terminal event, with [`RunEnded`], whether or not this verifier is
//! compiled in. That is the sink's own rule about what it sends, not the
//! protocol's about what a stream may carry.
//!
//! # Chunks
//!
//! A `*_CHUNK` event is judged as the events it stands for: the end of the
//! chunk stream it closes, the start it implies, its content. So a chunk for
//! an id that is explicitly open is a second start ([`DuplicateStart`]), and
//! an explicit event for an id a chunk opened finds it closed ([`NotOpen`]),
//! because the chunk stream ended when that event arrived. A hosted run's
//! `RUN_FINISHED` closes whatever chunk stream is still open, as a consumer
//! reading it does.
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
//! echo seeds it too, for ids not yet recorded — and in a hosted run so do the
//! request's `messages`, before the first event, whether or not they are
//! echoed; a `TOOL_CALL_RESULT` mints the tool message it names under its own
//! attribution.
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
//! [`MalformedChunk`]: crate::server::Rule::MalformedChunk
//! [`InvalidOutcome`]: crate::server::Rule::InvalidOutcome
//!
//! # What it lets through
//!
//! The deprecated `THINKING_*` family is not tracked at all. State, activity,
//! raw and custom events are unordered — though an activity delta, like any
//! continuation, may not name an owner other than its activity's, and a
//! state, custom or step event ends the chunk stream of whoever sent it.
//!
//! # Cost
//!
//! A handful of maps and one lookup per event. Turning the `verify` feature
//! off replaces the whole state machine with a zero-sized type whose
//! `observe` is an inlined `Ok(())`. In debug builds a rejection additionally
//! carries a dump of everything still open, which is the expensive part and is
//! why it is debug-only.
//!
//! # One set of rules
//!
//! The rules are not written here. They are the crate's shared ordering
//! rules, the ones `client::verify` reads an incoming stream by; this module
//! names the [`Rule`](crate::server::Rule) a rejection broke and words it for
//! whoever emitted the event.

#[cfg(feature = "verify")]
pub(crate) use enabled::Verifier;

/// Standalone protocol ordering and attribution checks, without an event queue.
/// Disabling verification does not expose a permissive no-op version of this API.
#[cfg(feature = "verify")]
pub use enabled::Verifier as EventVerifier;

#[cfg(not(feature = "verify"))]
pub(crate) use disabled::Verifier;

#[cfg(feature = "verify")]
mod enabled {
    use std::fmt::Write as _;

    use crate::ordering::{Broke, Open, Ordering, Policy, Violation, describe};
    use crate::{Event, Message};

    use crate::server::error::{Rule, VerificationError};

    /// Tracks what is open, and who opened it, so misordered events can be
    /// named precisely.
    #[derive(Debug, Clone)]
    pub struct Verifier {
        rules: Ordering,
    }

    impl Default for Verifier {
        fn default() -> Self {
            Self::new()
        }
    }

    impl Verifier {
        /// Creates the ordering state for one stream.
        pub fn new() -> Self {
            Self {
                rules: Ordering::new(Policy::PRODUCER),
            }
        }

        /// Learns the conversation the run continues — the request's
        /// `messages` — before its first event. As history, like the
        /// `RUN_STARTED` echo, which is optional: a resumed run answering a
        /// call the interrupted run opened is answering a call the consumer
        /// already holds, echo or not.
        ///
        /// A hosted run does this itself. A verifier used on its own needs
        /// it when the run answers a tool call an earlier run made, or
        /// continues a message a subagent owns: without the history that
        /// result is one for a call that never started.
        ///
        /// ```
        /// # use ag_ui::{AssistantMessage, Event, Message, ToolCall};
        /// # use ag_ui::server::EventVerifier;
        /// // The request's history: the previous run asked for a search.
        /// let history = [Message::Assistant(AssistantMessage {
        ///     id: "msg-1".into(),
        ///     tool_calls: Some(vec![ToolCall::new("call-1", "search", "{}")]),
        ///     ..Default::default()
        /// })];
        /// let answer = Event::tool_call_result("msg-2", "call-1", "3 results");
        ///
        /// let mut verifier = EventVerifier::new();
        /// verifier.observe(&Event::run_started("thread-1", "run-2"))?;
        /// assert!(verifier.observe(&answer).is_err());
        ///
        /// let mut verifier = EventVerifier::new();
        /// verifier.seed(&history);
        /// verifier.observe(&Event::run_started("thread-1", "run-2"))?;
        /// verifier.observe(&answer)?;
        /// # Ok::<(), ag_ui::server::VerificationError>(())
        /// ```
        pub fn seed(&mut self, history: &[Message]) {
            self.rules.seed(history);
        }

        /// Observes the events a run has already sent, in order, so that the
        /// checks carry on from where the run is.
        ///
        /// This is how a verifier is made for a run that continues somewhere
        /// else: in another process, or after the one that was driving it
        /// stopped. Replay what was sent, then [`observe`](Self::observe)
        /// what is sent next. The continuation sends no `RUN_STARTED`: the
        /// one that was sent is among the events replayed, and a second
        /// inside the same run is rejected.
        ///
        /// [`seed`](Self::seed) the history first when the run has one. What
        /// is replayed may also begin with the runs that came before on the
        /// same stream: the checks then stand in the last run it starts.
        ///
        /// ```
        /// # use ag_ui::{Event, TextMessageRole};
        /// # use ag_ui::server::{EventVerifier, Rule};
        /// // What the store holds of the run so far.
        /// let sent = [
        ///     Event::run_started("thread-1", "run-1"),
        ///     Event::text_message_start("msg-1", TextMessageRole::Assistant),
        ///     Event::text_message_content("msg-1", "Hello"),
        /// ];
        ///
        /// let mut verifier = EventVerifier::new();
        /// verifier.replay(&sent)?;
        ///
        /// // The run is where it was left: started, with `msg-1` open.
        /// let again = verifier.observe(&Event::run_started("thread-1", "run-1"));
        /// assert_eq!(again.unwrap_err().rule, Rule::DuplicateRunStarted);
        /// let early = verifier.observe(&Event::run_finished_success("thread-1", "run-1"));
        /// assert_eq!(early.unwrap_err().rule, Rule::OpenAtFinish);
        ///
        /// verifier.observe(&Event::text_message_content("msg-1", " world"))?;
        /// verifier.observe(&Event::text_message_end("msg-1"))?;
        /// verifier.observe(&Event::run_finished_success("thread-1", "run-1"))?;
        /// # Ok::<(), ag_ui::server::VerificationError>(())
        /// ```
        ///
        /// # Cost
        ///
        /// One [`observe`](Self::observe) per event, and nothing is copied or
        /// serialized. What the verifier keeps grows with the ids a run
        /// introduces, not with the number of its events.
        ///
        /// # Errors
        ///
        /// The first event that breaks a rule, as `observe` reports it. The
        /// events before it stay observed.
        pub fn replay<'a>(
            &mut self,
            events: impl IntoIterator<Item = &'a Event>,
        ) -> Result<(), VerificationError> {
            events.into_iter().try_for_each(|event| self.observe(event))
        }

        /// Treats the stream as opened, for a sink the run driver is not
        /// behind: `RunContext::new` emits no `RUN_STARTED`.
        pub(crate) fn assume_opened(&mut self) {
            self.rules.assume_opened();
        }

        /// Checks `event` against the state machine and folds it in.
        pub fn observe(&mut self, event: &Event) -> Result<(), VerificationError> {
            let observed = self.rules.observe(event);
            observed.map_err(|violation| self.reject(&violation))
        }

        /// Names the rule a violation broke, appending the open-entity dump
        /// in debug builds.
        fn reject(&self, violation: &Violation) -> VerificationError {
            let mut detail = detail(&violation.broke);
            if cfg!(debug_assertions) {
                detail.push_str(&self.dump());
            }
            VerificationError::new(violation.event, rule(&violation.broke), detail)
        }

        /// Debug-build-only dump of everything currently open.
        fn dump(&self) -> String {
            let open = self.rules.open();
            let mut out = String::new();
            let mut push = |label: &str, mut values: Vec<String>| {
                if !values.is_empty() {
                    values.sort();
                    let _ = write!(out, " {label}={values:?}");
                }
            };
            let strings = |ids: &[&str]| ids.iter().map(|id| (*id).to_owned()).collect();
            push("messages", strings(&open.messages));
            push("reasoning", strings(&open.reasoning_blocks));
            push("reasoning_messages", strings(&open.reasoning_messages));
            push("tool_calls", strings(&open.tool_calls));
            push(
                "steps",
                open.steps
                    .iter()
                    .map(|(owner, name)| match owner {
                        None => (*name).to_owned(),
                        Some(id) => format!("{id}/{name}"),
                    })
                    .collect(),
            );
            push("subagents", strings(&open.subagents));
            if out.is_empty() {
                " [nothing open]".to_owned()
            } else {
                format!(" [open:{out}]")
            }
        }
    }

    /// The rule a violation is reported under.
    fn rule(broke: &Broke) -> Rule {
        match broke {
            Broke::RunEnded => Rule::RunEnded,
            Broke::RunStartedTwice => Rule::DuplicateRunStarted,
            Broke::AlreadyOpen { .. }
            | Broke::StepRunning { .. }
            | Broke::SubagentActive { .. }
            | Broke::SubagentReused { .. } => Rule::DuplicateStart,
            Broke::NotOpen { .. }
            | Broke::StepNotRunning { .. }
            | Broke::SubagentNotActive { .. } => Rule::NotOpen,
            Broke::UnknownToolCall { .. } | Broke::UnknownParentSubagent { .. } => Rule::UnknownId,
            Broke::NotStarted | Broke::ResultBeforeEnd { .. } => Rule::OutOfOrder,
            Broke::StillOpen(_) => Rule::OpenAtFinish,
            Broke::OwnerMismatch { .. } | Broke::ParentMismatch { .. } => Rule::OwnerMismatch,
            Broke::InvalidOutcome(_) => Rule::InvalidOutcome,
            Broke::Chunk(_) => Rule::MalformedChunk,
        }
    }

    /// What specifically was wrong, for whoever emitted the event.
    fn detail(broke: &Broke) -> String {
        match broke {
            Broke::NotStarted => {
                "the run has not started: RUN_STARTED or RUN_ERROR comes first".to_owned()
            }
            Broke::RunEnded => "the run already ended".to_owned(),
            Broke::RunStartedTwice => "the run already started".to_owned(),
            Broke::AlreadyOpen { entity, id } => {
                format!("{} {id:?} is already open", entity.noun())
            }
            Broke::NotOpen { entity, id } => format!("{} {id:?} is not open", entity.noun()),
            Broke::OwnerMismatch {
                entity,
                id,
                owner,
                named,
                ..
            } => format!(
                "{} {id:?} belongs to {}, not {}",
                entity.noun(),
                describe(owner),
                describe(named)
            ),
            Broke::ParentMismatch {
                id,
                named,
                parent,
                owner,
            } => format!(
                "tool call {id:?} is tagged {} but its parent message {parent:?} belongs to {}; \
                 a tool call belongs to the message that carries it",
                describe(named),
                describe(owner)
            ),
            Broke::UnknownToolCall { id } => format!("tool call {id:?} was never started"),
            Broke::ResultBeforeEnd { id } => format!("tool call {id:?} has no TOOL_CALL_END yet"),
            Broke::StepRunning { name, owner } => {
                format!("step {name:?} is already open under {}", describe(owner))
            }
            Broke::StepNotRunning { name, owner } => {
                format!("step {name:?} is not open under {}", describe(owner))
            }
            Broke::SubagentActive { id } => format!("subagent {id:?} is already active"),
            Broke::SubagentReused { id } => {
                format!("subagent {id:?} already finished in this run; an id names one invocation")
            }
            Broke::UnknownParentSubagent { parent, .. } => {
                format!("parent subagent {parent:?} was never started")
            }
            Broke::SubagentNotActive { id } => format!("subagent {id:?} is not active"),
            Broke::StillOpen(Open::Entity { entity, id }) => {
                format!("{} {id:?} is still open", entity.noun())
            }
            Broke::StillOpen(Open::Step { name, owner }) => {
                format!("step {name:?} is still open under {}", describe(owner))
            }
            Broke::StillOpen(Open::Subagent { id }) => format!("subagent {id:?} is still active"),
            Broke::InvalidOutcome(detail) => detail.clone(),
            Broke::Chunk(error) => error.to_string(),
        }
    }
}

#[cfg(not(feature = "verify"))]
mod disabled {
    use crate::{Event, Message};

    use crate::server::error::VerificationError;

    /// The `verify` feature is off: every check compiles away.
    #[derive(Clone, Debug, Default)]
    pub(crate) struct Verifier;

    impl Verifier {
        #[inline]
        pub(crate) fn new() -> Self {
            Self
        }

        #[inline]
        pub(crate) fn seed(&mut self, _history: &[Message]) {}

        #[inline]
        pub(crate) fn assume_opened(&mut self) {}

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
