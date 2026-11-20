//! Two threads on one conversation: bringing together what each of them added.

use std::collections::{HashMap, HashSet, hash_map::Entry};

use crate::client::error::{Error, Result};
use crate::client::transport::Transport;
use crate::{Message, MessageId, ToolCallId};

use super::Thread;

/// What [`Thread::merge_messages_from`] added to a thread, and what it left
/// as it was.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
#[must_use = "`differing` names the messages of the other thread that were not taken"]
pub struct MergeReport {
    /// The messages added, in the order the other thread holds them. Each is
    /// in [`Thread::messages`] now: a tool result behind the message that
    /// holds its call, every other message at the end.
    pub added: Vec<MessageId>,
    /// The ids both threads hold as different messages. This thread's copy
    /// was kept, and the other thread's was not taken. Empty when the two
    /// threads started from the same messages and each only added its own.
    pub differing: Vec<MessageId>,
    /// The tool messages of the other thread that
    /// [`abandon_tool_call`](Thread::abandon_tool_call) made there for a call
    /// this thread holds an answer to, in the order the other thread holds
    /// them. Each stood in for a result the other thread never got, and was
    /// not taken: the call keeps the answer this thread has.
    pub superseded: Vec<MessageId>,
}

/// Merges two copies of one conversation's messages, by message id.
///
/// AG-UI 1.0 makes a message id unique within its thread, so two lists that
/// hold the same conversation agree on which message is which. They differ in
/// what each holds that the other lacks, and that is all this adds: the
/// result is `ours` with the messages of `theirs` it does not hold.
///
/// | A message | In the result |
/// | --- | --- |
/// | only `ours` holds | as it is, in the order `ours` has them |
/// | both hold, the copies equal | once, in the place `ours` gives it |
/// | both hold, the copies different | the copy of `ours`, in the place `ours` gives it |
/// | only `theirs` holds | after every message of `ours`, in the order `theirs` has them |
/// | a tool result, of either list, whose call a message before it holds | directly behind that message, after the tool results and activity messages already behind it |
///
/// Two lists that started from the same messages and each grew at the end
/// therefore merge to: the common start, what `ours` added, what `theirs`
/// added. The result depends on the two lists and nothing else, so the same
/// arguments always give the same list. It is not symmetric: with the
/// arguments swapped, the other list's additions come first and the other
/// list's copies are the ones kept.
///
/// No message of `ours` is changed or left out, so a message one list saw
/// complete and the other only in part stays as `ours` has it. Pass as `ours`
/// the list whose copies should stand.
///
/// The last row is the one rule about a role. A tool result is placed by the
/// call it answers and not by where a list kept it, so that in the result it
/// follows the message that holds its call whichever way the two lists were
/// built: one that arrived after other messages and was kept at the end is
/// put behind its call, in `ours` as in `theirs`. A list whose results stand
/// behind their calls already comes through in its own order. The message
/// that holds a call is the assistant message with that call among its
/// `tool_calls`. Where several hold the id, as with a provider that numbers
/// its calls from zero in every turn, it is the newest one whose call has no
/// result yet, or the newest one when each has. A result whose call no
/// earlier message holds stays in the order of its list.
///
/// A reasoning message stays in front of the reply it led to because the
/// order of each list is kept, and an activity message is merged like any
/// other.
///
/// The function reads ids and nothing else. It does not know which
/// conversation a list belongs to, and it does not refuse a tool call both
/// lists answered: both results are in the list. Use it for a view of two
/// threads while either is still running. For the thread that will send the
/// next request, [`Thread::merge_messages_from`] applies the same rules and
/// checks what a list cannot say.
///
/// Each list is expected to hold an id once, as [`Thread::messages`] does. Of
/// a repeated id the first message is kept.
///
/// ```
/// use ag_ui::Message;
/// use ag_ui::client::merge_messages;
///
/// let start = vec![Message::user("u-1", "Hello"), Message::assistant("a-1", "Hi")];
/// // Two copies of the conversation, each of which went on by itself.
/// let mut ours = start.clone();
/// ours.push(Message::user("u-2", "Write the report"));
/// ours.push(Message::assistant("a-2", "Here it is."));
/// let mut theirs = start.clone();
/// theirs.push(Message::user("u-3", "What time is it?"));
/// theirs.push(Message::assistant("a-3", "Noon."));
///
/// let merged = merge_messages(&ours, &theirs);
/// let ids: Vec<_> = merged.iter().map(|message| message.id().as_str()).collect();
/// assert_eq!(ids, ["u-1", "a-1", "u-2", "a-2", "u-3", "a-3"]);
/// ```
#[must_use]
pub fn merge_messages(ours: &[Message], theirs: &[Message]) -> Vec<Message> {
    merge(ours, theirs, &HashSet::new()).messages
}

/// One merge, worked out before anything is changed.
struct Merge {
    messages: Vec<Message>,
    added: Vec<MessageId>,
    differing: Vec<MessageId>,
    /// Tool calls that had a result before the merge added another from the
    /// other list: the call, the result that was there, and the one added.
    answered_twice: Vec<(ToolCallId, MessageId, MessageId)>,
}

/// Merges `theirs` into `ours`, leaving out the messages of `theirs` named in
/// `skip`.
fn merge(ours: &[Message], theirs: &[Message], skip: &HashSet<&MessageId>) -> Merge {
    let mut merged = Merge {
        messages: Vec::with_capacity(ours.len() + theirs.len()),
        added: Vec::new(),
        differing: Vec::new(),
        answered_twice: Vec::new(),
    };
    // The calls some message of the result holds, so that a result with no
    // such message is placed without a search.
    let mut issued = HashSet::new();
    let mut held: HashMap<&MessageId, &Message> = HashMap::with_capacity(ours.len());
    for message in ours {
        if let Entry::Vacant(first) = held.entry(message.id()) {
            first.insert(message);
            place(&mut merged.messages, &mut issued, message);
        }
    }
    let mut met = HashSet::with_capacity(theirs.len());
    for message in theirs {
        if !met.insert(message.id()) || skip.contains(message.id()) {
            continue;
        }
        if let Some(mine) = held.get(message.id()) {
            if *mine != message {
                merged.differing.push(message.id().clone());
            }
            continue;
        }
        merged.added.push(message.id().clone());
        if let Some((call, answer)) = place(&mut merged.messages, &mut issued, message) {
            merged
                .answered_twice
                .push((call, answer, message.id().clone()));
        }
    }
    merged
}

/// Adds `message` to `messages` the way a client adds one it receives: a tool
/// result behind the message that holds its call, anything else at the end.
/// For a result whose call already had one, returns the call and that result.
fn place<'a>(
    messages: &mut Vec<Message>,
    issued: &mut HashSet<&'a ToolCallId>,
    message: &'a Message,
) -> Option<(ToolCallId, MessageId)> {
    issued.extend(calls_of(message));
    let call = match message {
        Message::Tool(result) if issued.contains(&result.tool_call_id) => &result.tool_call_id,
        _ => {
            messages.push(message.clone());
            return None;
        }
    };
    let (at, answer) = place_of_result(messages, call);
    let answer = answer.map(|index| (call.clone(), messages[index].id().clone()));
    messages.insert(at, message.clone());
    answer
}

/// The ids of the tool calls a message holds.
fn calls_of(message: &Message) -> impl Iterator<Item = &ToolCallId> {
    let calls = match message {
        Message::Assistant(assistant) => assistant.tool_calls.as_deref(),
        _ => None,
    };
    calls.into_iter().flatten().map(|call| &call.id)
}

/// Where a result for `call` goes in `messages`, and the index of the result
/// the call already has there, if it has one.
///
/// The reference client's placement for a `TOOL_CALL_RESULT`
/// (`client/src/apply/default.ts`): behind the newest message holding the
/// call that has no result for it yet, or behind the newest holder when each
/// has one; then past the tool and activity messages directly behind that
/// message, so results keep the order they came in. With no holder, the end.
fn place_of_result(messages: &[Message], call: &ToolCallId) -> (usize, Option<usize>) {
    let behind = |holder: usize| {
        let mut at = holder + 1;
        while matches!(
            messages.get(at),
            Some(Message::Tool(_) | Message::Activity(_))
        ) {
            at += 1;
        }
        at
    };
    // Read from the end: the first result met after a holder is the one
    // standing closest behind it.
    let mut answer = None;
    let mut newest = None;
    for (index, message) in messages.iter().enumerate().rev() {
        match message {
            Message::Tool(result) if result.tool_call_id == *call => answer = Some(index),
            _ if calls_of(message).any(|id| id == call) => {
                if answer.is_none() {
                    return (behind(index), None);
                }
                newest.get_or_insert((index, answer.take()));
            }
            _ => {}
        }
    }
    match newest {
        Some((holder, answer)) => (behind(holder), answer),
        None => (messages.len(), None),
    }
}

/// Ids, for an error message.
fn list<'a>(ids: impl Iterator<Item = &'a str>) -> String {
    ids.collect::<Vec<_>>().join(", ")
}

impl<T: Transport, S> Thread<T, S> {
    /// Adds the messages another thread of the same conversation holds and
    /// this one lacks, by the rules of [`merge_messages`]: this thread's
    /// messages are kept as they are, the other's follow them in the other
    /// thread's order, and a tool result stands behind the message that holds
    /// its call.
    ///
    /// This is how two runs that were in flight together on one conversation
    /// come back to one thread, which then sends the next request; see the
    /// [module docs](super#two-runs-at-once). Nothing is sent, and `other` is
    /// not changed. Draw the conversation again afterwards, as after
    /// [`Update::Messages`](super::Update::Messages): a message may have been
    /// added between two this thread held.
    ///
    /// # What the merge takes, leaves and refuses
    ///
    /// | Of the other thread | After the merge |
    /// | --- | --- |
    /// | a message this thread lacks | added |
    /// | a message both hold | this thread's copy; an id whose copies differ is in [`MergeReport::differing`] |
    /// | a tool message [`abandon_tool_call`](Thread::abandon_tool_call) made there, for a call this thread holds an answer to | left out, and named in [`MergeReport::superseded`] |
    /// | the subagents it lists ([`subagents`](Thread::subagents)) | added where this thread lacks the invocation |
    /// | the run ids it used | refused for a run of this thread too |
    /// | a tool call an interrupt decided there | stays decided here, when its message was added |
    /// | its state | not read: this thread's [`raw_state`](Thread::raw_state) is unchanged |
    /// | pending interrupts, a resume submission, unanswered tool calls, a request in flight | the merge is refused, and likewise when this thread has any |
    ///
    /// State is the application's to settle. AG-UI 1.0 does not say what two
    /// runs open at once on one thread do to the state they share, so nothing
    /// here chooses: read [`raw_state`](Thread::raw_state) of both threads and
    /// call [`set_state`](Thread::set_state) with the value the next run
    /// should start from.
    ///
    /// Both threads must be at rest, each able to start a run of its own.
    /// What a thread still owes belongs to the thread that owes it: an
    /// interrupt is answered where its submission is tracked, and a tool call
    /// is answered before another turn stands between the call and its
    /// result. Settle those first, on the thread that has them, with
    /// [`resume`](Thread::resume), a tool message or
    /// [`abandon_tool_call`](Thread::abandon_tool_call). Both threads were at
    /// rest, so the merged one can take the next request, and
    /// [`send`](Thread::send) checks it as it checks any other.
    ///
    /// A tool call that both threads answered, each with a message of its
    /// own, is refused as well: a call has one result, and choosing between
    /// two is not this method's to do. A stand-in is not a result. A thread
    /// remembers the tool messages its `abandon_tool_call` made, and so does
    /// its [snapshot](Thread::snapshot), so a stand-in on the other thread
    /// gives way to the answer this thread holds. The other way round, a
    /// stand-in here and a result there, is refused, because a merge
    /// changes and removes nothing of this thread's: merge this thread into
    /// the other one instead, where the result stands and the stand-in gives
    /// way.
    ///
    /// ```
    /// use ag_ui::Message;
    /// use ag_ui::client::{Thread, transport::ReplayTransport};
    ///
    /// let start = vec![Message::user("u-1", "Hello"), Message::assistant("a-1", "Hi")];
    /// let thread = |added: [Message; 2]| {
    ///     let mut messages = start.clone();
    ///     messages.extend(added);
    ///     Thread::<_>::builder(ReplayTransport::new([]), "thread-1")
    ///         .messages(messages)
    ///         .build()
    /// };
    /// let mut main = thread([
    ///     Message::user("u-2", "Write the report"),
    ///     Message::assistant("a-2", "Here it is."),
    /// ])?;
    /// let side = thread([
    ///     Message::user("u-3", "What time is it?"),
    ///     Message::assistant("a-3", "Noon."),
    /// ])?;
    ///
    /// let merged = main.merge_messages_from(&side)?;
    /// assert_eq!(merged.added, ["u-3", "a-3"]);
    /// assert!(merged.differing.is_empty());
    /// let ids: Vec<_> = main.messages().iter().map(|message| message.id().as_str()).collect();
    /// assert_eq!(ids, ["u-1", "a-1", "u-2", "a-2", "u-3", "a-3"]);
    /// // Merging again adds nothing: every message is held now.
    /// assert!(main.merge_messages_from(&side)?.added.is_empty());
    /// # Ok::<(), ag_ui::client::Error>(())
    /// ```
    ///
    /// # Errors
    ///
    /// [`Error::Merge`], with nothing changed, when the two threads have
    /// different thread ids, when either is not at rest, when a tool call
    /// has a result on each thread, and when this thread gave up a call the
    /// other holds a result for.
    pub fn merge_messages_from<U: Transport, R>(
        &mut self,
        other: &Thread<U, R>,
    ) -> Result<MergeReport> {
        if self.thread_id != other.thread_id {
            return Err(Error::Merge(format!(
                "thread {:?} is another conversation than thread {:?}",
                other.thread_id.as_str(),
                self.thread_id.as_str()
            )));
        }
        self.at_rest("this thread")?;
        other.at_rest("the other thread")?;

        // A stand-in the other thread made for a call this thread holds an
        // answer to is left out: the call has its answer here. Told from a
        // result by the record `abandon_tool_call` keeps, not by what the
        // message says.
        let answered: HashSet<&ToolCallId> = self
            .messages()
            .iter()
            .filter_map(|message| match message {
                Message::Tool(answer) => Some(&answer.tool_call_id),
                _ => None,
            })
            .collect();
        let superseded: Vec<&MessageId> = other
            .messages()
            .iter()
            .filter(|message| match message {
                Message::Tool(stand_in) => {
                    other.abandoned.contains(&stand_in.id)
                        && answered.contains(&stand_in.tool_call_id)
                        && self.applier.message(&stand_in.id).is_none()
                }
                _ => false,
            })
            .map(Message::id)
            .collect();
        let skip: HashSet<&MessageId> = superseded.iter().copied().collect();

        let merged = merge(self.messages(), other.messages(), &skip);
        if let Some((call, here, there)) = merged
            .answered_twice
            .iter()
            .find(|(_, here, _)| self.applier.message(here).is_some())
        {
            // Giving a call up here does not undo a result there, and a merge
            // changes and removes nothing of this thread's: the result is
            // merged the other way.
            if self.abandoned.contains(here) {
                return Err(Error::Merge(format!(
                    "tool call {call} was given up on this thread, with message {here}, and has \
                     a result on the other thread, message {there}: merge this thread into the \
                     one that holds the result"
                )));
            }
            return Err(Error::Merge(format!(
                "tool call {call} has a result on each thread, message {here} on this one and \
                 message {there} on the other"
            )));
        }

        let superseded = superseded.into_iter().cloned().collect();
        // An interrupt's decision stands in for a tool message, and is kept
        // by call id. It travels with the call it decided. So does a
        // stand-in's record, with the stand-in.
        for id in &merged.added {
            if other.abandoned.contains(id) {
                self.abandoned.insert(id.clone());
            }
            let Some(message) = other.applier.message(id) else {
                continue;
            };
            for call in calls_of(message) {
                if other.decided_interrupt_tool_call_ids.contains(call) {
                    self.decided_interrupt_tool_call_ids.insert(call.clone());
                } else {
                    self.decided_interrupt_tool_call_ids.remove(call);
                }
            }
        }
        self.applier = std::mem::take(&mut self.applier).with_messages(merged.messages);
        self.run_ids.extend(other.run_ids.iter().cloned());
        let announced: Vec<_> = other
            .subagents()
            .iter()
            .filter(|subagent| self.subagent(&subagent.run_id).is_none())
            .cloned()
            .collect();
        if !announced.is_empty() {
            let mut subagents = self.subagents().to_vec();
            subagents.extend(announced);
            let interrupts = self.applier.interrupts().to_vec();
            self.applier.restore_auxiliary(subagents, interrupts);
        }
        Ok(MergeReport {
            added: merged.added,
            differing: merged.differing,
            superseded,
        })
    }

    /// Refuses a merge while this thread owes something only it can settle.
    fn at_rest(&self, which: &str) -> Result<()> {
        let owes = if self.active_run_id.is_some() {
            "has a request in flight, and is merged once its stream has ended".to_owned()
        } else if self.submission.is_some() {
            "holds an unconfirmed resume submission, which is reconciled with the server before \
             the thread is merged"
                .to_owned()
        } else if !self.interrupts.is_empty() {
            format!(
                "is paused on interrupts {}, which are answered on the thread that holds them \
                 before it is merged",
                list(
                    self.interrupts
                        .iter()
                        .map(|interrupt| interrupt.id.as_str())
                )
            )
        } else {
            let calls = self.unanswered_tool_calls();
            if calls.is_empty() {
                return Ok(());
            }
            format!(
                "has unanswered tool calls {}, which are answered or abandoned on the thread \
                 that holds them before it is merged",
                list(calls.iter().map(ToolCallId::as_str))
            )
        };
        Err(Error::Merge(format!("{which} {owes}")))
    }
}
