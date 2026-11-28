//! What a conversation owes before another run: an answer to each interrupt
//! it is paused on, a submission the server has not confirmed, and a result
//! for each tool call nothing answered.

use std::collections::HashSet;

use crate::client::{
    error::{Error, Result},
    interrupts::InterruptExt,
    transport::Transport,
};
use crate::{
    Interrupt, Message, MessageId, ResumeEntry, ResumeStatus, RunId, ToolCallId, ToolContent,
    ToolMessage,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Thread;
use super::run::{RunEnd, RunStream};

/// Local observation of an interrupt response submission.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ResumeSubmission {
    /// The request that carried these responses.
    pub run_id: RunId,
    /// Exact answers, retained for reconciliation by the application.
    pub entries: Vec<ResumeEntry>,
    /// Whether a valid terminal response has confirmed the request.
    pub status: SubmissionStatus,
}

/// A submission is never retried automatically.
///
/// A thread holds one from the dispatch of a resume until the requested run
/// reports `RUN_FINISHED`, whatever its outcome. `#[non_exhaustive]`: match
/// with a wildcard arm. A match without one does not compile outside this
/// crate:
///
/// ```compile_fail,E0004
/// use ag_ui::client::SubmissionStatus;
///
/// fn word(status: &SubmissionStatus) -> &'static str {
///     match status {
///         SubmissionStatus::InFlight => "in flight",
///         SubmissionStatus::Unconfirmed => "unconfirmed",
///     }
/// }
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum SubmissionStatus {
    /// Dispatched and still being observed. Restoring this becomes `Unconfirmed`.
    InFlight,
    /// Reading stopped before the requested run reported `RUN_FINISHED`: the
    /// run failed, the stream was cut short or rejected, or it never carried
    /// the requested run. Nothing says whether the agent took the answers.
    Unconfirmed,
}

impl<T, S> Thread<T, S> {
    pub(super) fn unconfirm(&mut self) {
        if let Some(submission) = &mut self.submission {
            submission.status = SubmissionStatus::Unconfirmed;
        }
    }
    pub(super) fn confirm_interrupt_tool_decisions(
        &mut self,
        started_in_run: &HashSet<ToolCallId>,
    ) {
        let Some(submission) = &self.submission else {
            return;
        };
        for interrupt in &self.interrupts {
            if submission
                .entries
                .iter()
                .any(|entry| entry.interrupt_id == interrupt.id)
            {
                if let Some(id) = &interrupt.tool_call_id {
                    if started_in_run.contains(id) {
                        continue;
                    }
                    self.decided_interrupt_tool_call_ids.insert(id.clone());
                }
            }
        }
    }
}

impl<T: Transport, S> Thread<T, S> {
    /// Answer the single outstanding interrupt. All pending IDs must be answered.
    pub fn resume(
        &mut self,
        interrupt: &Interrupt,
        payload: impl Into<Value>,
    ) -> Result<RunStream<'_, T, S>> {
        self.resume_many([interrupt.resolve(payload)])
    }
    /// Decline the single outstanding interrupt. This is not execution cancellation.
    ///
    /// An expired interrupt can still be declined: that is how a thread moves
    /// past a question nobody answered in time.
    pub fn decline(&mut self, interrupt: &Interrupt) -> Result<RunStream<'_, T, S>> {
        self.resume_many([interrupt.cancel()])
    }
    /// Answer every pending question exactly once. Expiry is checked against the
    /// stored interrupt: an expired one can only be cancelled. Response schemas
    /// are retained for the application/server to validate; this
    /// transport-neutral API does not execute arbitrary schemas.
    ///
    /// # Expiry
    ///
    /// AG-UI 1.0 leaves the format of `expiresAt` open, so whether an
    /// interrupt has expired is the consumer's reading of it. An interrupt
    /// has expired when its `expiresAt` names an instant that is now or
    /// earlier. Two forms name one: a date and time with its UTC offset, as
    /// RFC 3339 writes it (`2026-01-31T12:00:00Z`,
    /// `2026-01-31T21:00:00.5+09:00`), and a date alone (`2026-01-31`), read
    /// as the start of that day in UTC.
    ///
    /// Any other value is not evidence of expiry, a date and time with no
    /// offset included: the interrupt can be answered, the stream yields one
    /// [`Update::Warning`](super::Update::Warning) naming it when the answer
    /// is sent, and the agent, which enforces expiry in any case, decides.
    pub fn resume_many(
        &mut self,
        entries: impl IntoIterator<Item = ResumeEntry>,
    ) -> Result<RunStream<'_, T, S>> {
        let entries: Vec<_> = entries.into_iter().collect();
        self.preflight(Some(&entries), None)?;
        self.start(None, Some(entries))
    }
    pub(super) fn preflight(
        &self,
        resume: Option<&[ResumeEntry]>,
        message: Option<&Message>,
    ) -> Result<()> {
        if self.thread_id.as_str().is_empty() {
            return Err(Error::Request("thread ID must not be empty".into()));
        }
        if self.submission.is_some() {
            return Err(Error::Request("an unconfirmed submission requires reconciliation with server state before another run".into()));
        }
        match resume {
            None if !self.interrupts.is_empty() => {
                return Err(Error::PendingInterrupts(
                    self.interrupts
                        .iter()
                        .map(|interrupt| interrupt.id.clone())
                        .collect(),
                ));
            }
            Some(entries) => validate_responses(&self.interrupts, entries, true)?,
            None => {}
        }
        let mut pending_tools = self.unanswered_tool_calls();
        if let Some(Message::Tool(answer)) = message {
            // The new answer enters the request on first poll. Check that
            // prospective history without inserting it during preflight.
            pending_tools.retain(|id| id != &answer.tool_call_id);
        }
        if resume.is_some() {
            // A matching resume entry answers the interrupt, including an
            // approval concerning this tool call. It needs no ToolMessage.
            let approval_ids: HashSet<_> = self
                .interrupts
                .iter()
                .filter_map(|interrupt| interrupt.tool_call_id.as_ref())
                .collect();
            pending_tools.retain(|id| !approval_ids.contains(id));
        }
        if !pending_tools.is_empty() {
            return Err(Error::UnansweredToolCalls(pending_tools));
        }
        if let Some(id) = &self.next_run_id {
            if id.as_str().is_empty() || self.run_ids.contains(id) {
                return Err(Error::Request(format!(
                    "run ID {id} is empty or already used"
                )));
            }
        }
        Ok(())
    }
    /// Tool calls the next run must answer first, in call order.
    ///
    /// Every call in the transcript that no later tool message answers: the
    /// frontend calls a run left for the application, and calls a failed or
    /// aborted run never answered. `send`, `run` and `resume_many` refuse to
    /// start a run while one is listed — AG-UI 1.0 requires a thread that
    /// continues to answer each one first, and many models reject a history
    /// with a dangling call. Answer one with a tool message
    /// ([`push_message`](Thread::push_message) or [`send_message`](Self::send_message)),
    /// or give it up with [`abandon_tool_call`](Self::abandon_tool_call). A call
    /// a pending interrupt concerns is answered by resuming that interrupt.
    ///
    /// ```
    /// use ag_ui::client::{Thread, transport::ReplayTransport};
    /// use ag_ui::{AssistantMessage, Message, ToolCall};
    ///
    /// let call = Message::Assistant(AssistantMessage {
    ///     id: "m-1".into(),
    ///     tool_calls: Some(vec![ToolCall::new("call-1", "pick_file", "{}")]),
    ///     ..Default::default()
    /// });
    /// let mut thread = Thread::<_>::builder(ReplayTransport::new([]), "thread-1")
    ///     .messages(vec![call])
    ///     .build()?;
    /// assert_eq!(thread.unanswered_tool_calls(), ["call-1"]);
    /// assert!(thread.send("Hello").is_err());
    ///
    /// thread.push_message(Message::tool("m-2", "call-1", "report.pdf"))?;
    /// assert!(thread.unanswered_tool_calls().is_empty());
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
    pub fn unanswered_tool_calls(&self) -> Vec<ToolCallId> {
        self.unanswered_tool_calls_in(self.messages(), &self.decided_interrupt_tool_call_ids)
    }

    /// The same preflight applies before committing a proposed history merge.
    pub(super) fn unanswered_tool_calls_in(
        &self,
        messages: &[Message],
        decided: &HashSet<ToolCallId>,
    ) -> Vec<ToolCallId> {
        // Read the ordered transcript, because an answer preceding a call does
        // not answer that call. A server-side TOOL_CALL_RESULT is already a tool
        // message here, so it clears the same debt as a frontend response.
        let mut pending = Vec::new();
        let mut seen = HashSet::new();
        let mut answered = HashSet::new();
        for message in messages {
            match message {
                Message::Assistant(assistant) => {
                    for call in assistant.tool_calls.iter().flatten() {
                        answered.remove(&call.id);
                        if seen.insert(call.id.clone()) {
                            pending.push(call.id.clone());
                        }
                    }
                }
                Message::Tool(tool) => {
                    answered.insert(tool.tool_call_id.clone());
                }
                _ => {}
            }
        }
        if let Some(RunEnd::SuccessWithPendingToolCalls {
            pending_tool_call_ids,
            ..
        }) = &self.last_run_end
        {
            for id in pending_tool_call_ids {
                if seen.insert(id.clone()) {
                    pending.push(id.clone());
                }
            }
        }
        let explicit_pending = match &self.last_run_end {
            Some(RunEnd::SuccessWithPendingToolCalls {
                pending_tool_call_ids,
                ..
            }) => pending_tool_call_ids.iter().collect::<HashSet<_>>(),
            _ => HashSet::new(),
        };
        pending.retain(|id| {
            !answered.contains(id) && (!decided.contains(id) || explicit_pending.contains(id))
        });
        pending
    }
    /// Give up an unanswered tool call, answering it with a tool message whose
    /// `content` and `error` both carry `reason`.
    ///
    /// For a call nobody will execute, such as one a failed or aborted run left
    /// behind. AG-UI 1.0 answers such a call rather than dropping it: a failure
    /// is still an answer, as a tool message with `error` set. The call and its
    /// answer both stay in [`messages`](Thread::messages) and in a snapshot,
    /// and the next run sends them. Nothing is sent now.
    ///
    /// Rejects a call that is not in [`unanswered_tool_calls`](Self::unanswered_tool_calls),
    /// and one a pending interrupt concerns: resume or decline that interrupt
    /// instead.
    ///
    /// ```
    /// # use ag_ui::client::{RunEnd, Thread, transport::ReplayTransport};
    /// # use ag_ui::{Event, Message};
    /// # let transport = ReplayTransport::with_runs([
    /// #     vec![
    /// #         Event::run_started("thread-1", "run-1"),
    /// #         Event::tool_call_start("call-1", "lookup"),
    /// #         Event::run_error("the model provider went away"),
    /// #     ],
    /// #     vec![
    /// #         Event::run_started("thread-1", "run-2"),
    /// #         Event::run_finished_success("thread-1", "run-2"),
    /// #     ],
    /// # ]).matching_requests();
    /// # let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    /// # rt.block_on(async {
    /// let mut thread = Thread::<_>::new(transport, "thread-1");
    /// let report = thread.send("look it up").unwrap().collect_report().await;
    /// assert!(matches!(report.end, RunEnd::Failed { .. }));
    ///
    /// // The failed run left `call-1` without a result, so nothing can follow it ...
    /// assert!(thread.send("try again").is_err());
    /// for call in thread.unanswered_tool_calls() {
    ///     thread.abandon_tool_call(&call, "not run: the run that made this call failed").unwrap();
    /// }
    /// // ... until it is answered, and the answer stays in the transcript.
    /// assert!(matches!(thread.messages().last(), Some(Message::Tool(answer)) if answer.error.is_some()));
    /// let report = thread.send("try again").unwrap().collect_report().await;
    /// assert_eq!(report.end, RunEnd::Success { result: None });
    /// # });
    /// ```
    pub fn abandon_tool_call(&mut self, id: &ToolCallId, reason: impl Into<String>) -> Result<()> {
        if !self.unanswered_tool_calls().contains(id) {
            return Err(Error::Request(format!(
                "tool call {id} is not awaiting an answer"
            )));
        }
        if let Some(interrupt) = self
            .interrupts
            .iter()
            .find(|interrupt| interrupt.tool_call_id.as_ref() == Some(id))
        {
            return Err(Error::Request(format!(
                "tool call {id} awaits the decision of interrupt {}; resume or decline it instead",
                interrupt.id
            )));
        }
        let reason = reason.into();
        let message_id = MessageId::new(self.fresh_id(false)?);
        self.applier.push_message(Message::Tool(ToolMessage {
            id: message_id.clone(),
            content: ToolContent::Text(reason.clone()),
            tool_call_id: id.clone(),
            error: Some(reason),
            ..Default::default()
        }));
        // Remembered as a stand-in: a merge leaves it out when the other
        // thread holds the result this one never got.
        self.abandoned.insert(message_id);
        Ok(())
    }
}

pub(super) fn validate_responses(
    pending: &[Interrupt],
    entries: &[ResumeEntry],
    expiry: bool,
) -> Result<()> {
    if pending.is_empty() {
        return Err(Error::Request("there are no pending interrupts".into()));
    }
    let mut seen = HashSet::new();
    for entry in entries {
        if !seen.insert(&entry.interrupt_id) {
            return Err(Error::Request(format!(
                "duplicate interrupt ID {}",
                entry.interrupt_id
            )));
        }
        let interrupt = pending
            .iter()
            .find(|interrupt| interrupt.id == entry.interrupt_id)
            .ok_or_else(|| {
                Error::Request(format!("unknown interrupt ID {}", entry.interrupt_id))
            })?;
        // Expiry ends answering, not abandoning: an interrupt nobody answered
        // in time is cancelled, which is how the thread moves past it. Only
        // an `expiresAt` that names an instant is evidence of expiry.
        if expiry && entry.status == ResumeStatus::Resolved {
            let expires = interrupt.expires_at.as_deref().and_then(instant);
            if expires.is_some_and(|expires| expires <= now_unix_nanos()) {
                return Err(Error::Request(format!(
                    "interrupt {} has expired; it can only be declined",
                    interrupt.id
                )));
            }
        }
    }
    if seen.len() != pending.len() {
        return Err(Error::Request(
            "every pending interrupt must be answered exactly once".into(),
        ));
    }
    Ok(())
}

/// One warning for each interrupt `entries` answer whose `expiresAt` the
/// thread cannot read as a date, for the request that sends the answers.
pub(super) fn unread_expiries(pending: &[Interrupt], entries: &[ResumeEntry]) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| entry.status == ResumeStatus::Resolved)
        .filter_map(|entry| {
            let interrupt = pending
                .iter()
                .find(|interrupt| interrupt.id == entry.interrupt_id)?;
            let timestamp = interrupt.expires_at.as_deref()?;
            instant(timestamp).is_none().then(|| {
                format!(
                    "interrupt \"{}\" carries an expiresAt this thread does not read as a date, \
                     \"{}\": the answer is sent as in time, and the agent decides whether it is",
                    crate::protocol::excerpt(&interrupt.id, false),
                    crate::protocol::excerpt(timestamp, false)
                )
            })
        })
        .collect()
}

/// The instant an `expiresAt` names, in nanoseconds since the Unix epoch, or
/// `None` for a value that names none this thread can compare with now.
///
/// AG-UI 1.0 leaves the format open (`basic/patterns/interrupt-resume`:
/// "whether an interrupt has expired is the judging consumer's own reading
/// of it — the reference reads it as a date and treats now-or-earlier as
/// expired") and names ISO 8601 as the convention. Two forms are read, the
/// two the reference reads the same in every time zone:
///
/// - a date and time with its UTC offset, as RFC 3339 writes it;
/// - a date alone, `YYYY-MM-DD`, as the start of that day in UTC, which is
///   what ECMAScript makes of it.
///
/// A date and time with no offset is not read. The reference reads it in the
/// viewer's own time zone, so there is no reading that agrees with it
/// everywhere, and 1.0 names no zone. Nor is anything else: a value that
/// cannot be read is not evidence of expiry (1.0, the schema: "a value that
/// is not one leaves the interrupt looking permanently unexpired"), and the
/// agent enforces expiry whatever the consumer makes of the value.
fn instant(timestamp: &str) -> Option<i128> {
    use jiff::civil::{Date, Time, date};

    let (calendar, rest) = timestamp.split_at_checked(10)?;
    if calendar.as_bytes()[4] != b'-' || calendar.as_bytes()[7] != b'-' {
        return None;
    }
    let calendar: Date = calendar.parse().ok()?;
    let midnight = calendar.duration_since(date(1970, 1, 1)).as_secs();
    if rest.is_empty() {
        return Some(i128::from(midnight) * 1_000_000_000);
    }

    let rest = rest.strip_prefix(['T', 't', ' '])?;
    let (clock, zone) = rest.split_at(rest.find(['Z', 'z', '+', '-', '−'])?);
    let offset = match zone {
        "Z" | "z" => 0,
        _ => {
            let digits = zone.strip_prefix(['+', '-', '−'])?;
            let (hour, minute) = digits.split_once(':')?;
            if hour.len() != 2
                || minute.len() != 2
                || !digits.bytes().all(|b| b == b':' || b.is_ascii_digit())
            {
                return None;
            }
            let (hour, minute) = (hour.parse::<i64>().ok()?, minute.parse::<i64>().ok()?);
            if hour > 23 || minute > 59 {
                return None;
            }
            let seconds = (hour * 60 + minute) * 60;
            if zone.starts_with('+') {
                seconds
            } else {
                -seconds
            }
        }
    };

    let (hms, fraction) = clock.split_at_checked(8)?;
    if hms.as_bytes()[2] != b':' || hms.as_bytes()[5] != b':' {
        return None;
    }
    if !fraction.is_empty() {
        let digits = fraction.strip_prefix('.')?;
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    // RFC 3339 allows more fractional digits than the nanosecond clock stores.
    let time: Time = clock.get(..clock.len().min(18))?.parse().ok()?;
    let utc =
        i64::from(time.hour()) * 3600 + i64::from(time.minute()) * 60 + i64::from(time.second())
            - offset;
    let nanos = if hms.ends_with(":60") {
        // Jiff constrains :60 to :59. Only the end of a UTC month can leap.
        // A negative UTC time-of-day here falls on the previous local date.
        let ends_month = if utc < 0 {
            calendar.day() == 1
        } else {
            calendar.day() == calendar.days_in_month()
        };
        if utc.rem_euclid(86_400) != 86_399 || !ends_month {
            return None;
        }
        999_999_999
    } else {
        time.subsec_nanosecond()
    };
    Some(i128::from(midnight + utc) * 1_000_000_000 + i128::from(nanos))
}

#[cfg(not(target_family = "wasm"))]
fn now_unix_nanos() -> i128 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    }
}
#[cfg(target_family = "wasm")]
fn now_unix_nanos() -> i128 {
    (js_sys::Date::now() * 1_000_000.0) as i128
}

#[cfg(test)]
mod expiry_tests {
    use super::instant;

    #[test]
    fn expiry_preserves_nanoseconds_and_validates_utc_leap_seconds() {
        assert_eq!(instant("1969-12-31T23:59:59.999999999Z"), Some(-1));
        assert_eq!(
            instant("1970-01-01 00:00:00.123456789123z"),
            Some(123_456_789)
        );
        assert_eq!(instant("1970-01-01T23:59:00+23:59"), Some(0));
        assert_eq!(instant("1969-12-31T00:01:00−23:59"), Some(0));
        assert_eq!(
            instant("2017-01-01T08:59:60+09:00"),
            instant("2016-12-31T23:59:59.999999999Z")
        );
        for invalid in [
            "2017-01-02T08:59:60+09:00",
            "2000-01-01T24:00:00Z",
            "1970-01-01T00:00:00+24:00",
            "1970-01-01T00:00:00+00:60",
            "1970-01-01T00:00:00.123456789xZ",
            "1970-01-01T00:00:00Z[UTC]",
        ] {
            assert_eq!(instant(invalid), None, "{invalid}");
        }
    }
}
