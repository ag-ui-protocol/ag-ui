//! The compatibility boundary between wire JSON and the closed Rust event enum.
//!
//! The pinned schema describes what this version understands. Unknown additions
//! are removed before deserializing into `Event`; malformed values of fields it
//! does understand are errors. Keeping this step before chunk expansion and
//! verification gives the same decision to every SSE consumer.
//!
//! Whatever is removed or translated on the way becomes a warning in the
//! stream, ahead of the event it concerns, once per run for each distinct
//! text. A `Thread` records each one; the plain event streams drop them unless
//! their caller asks for them.
//!
//! Events that were never JSON take [`typed`] instead: an `Event` holds
//! nothing this version does not know, so the schema walk is skipped.

use std::collections::{HashSet, VecDeque};
use std::pin::Pin;

use futures_core::Stream;
use futures_util::StreamExt;
use serde_json::Value;

use crate::client::error::{Error, Result};
use crate::{Event, InputContent, Message, ToolContent, UserContent};

/// What the boundary hands on: an event, or a warning about something it
/// removed or translated.
pub(crate) enum Checked {
    Event(Event),
    Warning(String),
}

/// A boxed [`checked`] stream, `Send` where an `EventStream` is.
#[cfg(not(target_family = "wasm"))]
pub(crate) type CheckedStream = Pin<Box<dyn Stream<Item = Result<Checked>> + Send>>;

/// A boxed [`checked`] stream, `Send` where an `EventStream` is.
#[cfg(target_family = "wasm")]
pub(crate) type CheckedStream = Pin<Box<dyn Stream<Item = Result<Checked>>>>;

/// Decodes a wire event after removing material this version does not know,
/// pushing a warning for each thing removed.
pub(crate) fn decode(value: Value, warnings: &mut Vec<String>) -> Result<Option<Event>> {
    let Some(value) = crate::protocol::event(value, warnings).map_err(Error::protocol)? else {
        return Ok(None);
    };
    let event: Event = serde_json::from_value(value)?;
    note_version(&event, warnings);
    Ok(Some(event))
}

/// Warns when `RUN_STARTED` declares a protocol version newer than this one.
fn note_version(event: &Event, warnings: &mut Vec<String>) {
    let Event::RunStarted(started) = event else {
        return;
    };
    let Some(version) = &started.protocol_version else {
        return;
    };
    let current = (1, 0);
    let declared = version
        .split_once('.')
        .and_then(|(major, minor)| Some((major.parse::<u64>().ok()?, minor.parse::<u64>().ok()?)));
    if declared.is_none_or(|peer| peer > current) {
        warnings.push(format!(
            "producer declared newer or uninterpretable protocol version \"{}\"",
            crate::protocol::excerpt(version, false)
        ));
    }
}

/// Applies the same enforcement to every transport, discarding its warnings.
/// An error stops the run; unknown additions disappear without reaching the
/// typed event stream.
pub(crate) fn stream<S>(raw: S) -> impl Stream<Item = Result<Event>>
where
    S: Stream<Item = Result<Value>>,
{
    events(raw, |_| {})
}

/// [`stream`], handing each warning to `on_warning` as it is reached.
pub(crate) fn events<S, F>(raw: S, on_warning: F) -> impl Stream<Item = Result<Event>>
where
    S: Stream<Item = Result<Value>>,
    F: FnMut(String),
{
    unchecked(checked(raw), on_warning)
}

/// Takes the warnings out of a checked stream, handing each to `on_warning`.
pub(crate) fn unchecked<S, F>(checked: S, mut on_warning: F) -> impl Stream<Item = Result<Event>>
where
    S: Stream<Item = Result<Checked>>,
    F: FnMut(String),
{
    checked.filter_map(move |item| {
        std::future::ready(match item {
            Ok(Checked::Event(event)) => Some(Ok(event)),
            Ok(Checked::Warning(warning)) => {
                on_warning(warning);
                None
            }
            Err(error) => Some(Err(error)),
        })
    })
}

/// The distinct warnings remembered in one run. Past this many, a new warning
/// is still delivered but not remembered, so what a producer can make the
/// boundary hold stays bounded however long the run.
pub(crate) const REMEMBERED: usize = 256;

/// The boundary with its warnings in the stream, each ahead of the event it
/// concerns and each text once per run. An error is the last item.
pub(crate) fn checked<S>(raw: S) -> impl Stream<Item = Result<Checked>>
where
    S: Stream<Item = Result<Value>>,
{
    futures_util::stream::unfold(Boundary::new(raw), |mut boundary| async move {
        loop {
            if let Some(item) = boundary.out.pop_front() {
                return Some((item, boundary));
            }
            let mut warnings = Vec::new();
            if let Some(value) = boundary.ready.pop_front() {
                let decoded = decode(value, &mut warnings);
                boundary.warn(warnings);
                match decoded {
                    Ok(Some(event)) => boundary.out.push_back(Ok(Checked::Event(event))),
                    Ok(None) => {}
                    Err(error) => boundary.fail(error),
                }
                continue;
            }
            match boundary.raw.as_mut()?.next().await? {
                Ok(value) => {
                    // A later run on the same stream reports its own warnings.
                    if value.get("type").and_then(Value::as_str) == Some("RUN_STARTED") {
                        boundary.delivered.clear();
                    }
                    let translated = boundary.legacy.translate(value, &mut warnings);
                    boundary.warn(warnings);
                    match translated {
                        Ok(values) => boundary.ready.extend(values),
                        Err(error) => boundary.fail(error),
                    }
                }
                Err(error) => boundary.fail(error),
            }
        }
    })
}

/// Typed events under the same contract as [`checked`], minus the schema
/// walk: an `Event` holds nothing to remove. What 1.0 retired still takes the
/// wire path, so there is one translation: a `THINKING_*` event, and an event
/// carrying a `binary` content part. A newer declared protocol version is
/// still reported.
pub(crate) fn typed<S>(events: S) -> impl Stream<Item = Result<Checked>>
where
    S: Stream<Item = Result<Event>>,
{
    futures_util::stream::unfold(Boundary::new(events), |mut boundary| async move {
        loop {
            if let Some(item) = boundary.out.pop_front() {
                return Some((item, boundary));
            }
            match boundary.raw.as_mut()?.next().await? {
                Ok(event) => boundary.typed(event),
                Err(error) => boundary.fail(error),
            }
        }
    })
}

/// What [`checked`] and [`typed`] carry between polls.
struct Boundary<S> {
    raw: Option<Pin<Box<S>>>,
    legacy: Legacy,
    /// Translated values waiting to be decoded.
    ready: VecDeque<Value>,
    /// Items waiting to be handed on.
    out: VecDeque<Result<Checked>>,
    /// Warnings handed on in this run, up to [`REMEMBERED`] of them.
    delivered: HashSet<String>,
}

impl<S> Boundary<S> {
    fn new(raw: S) -> Self {
        Self {
            raw: Some(Box::pin(raw)),
            legacy: Legacy::default(),
            ready: VecDeque::new(),
            out: VecDeque::new(),
            delivered: HashSet::new(),
        }
    }

    /// Hands on one typed event as it is, unless it is, or carries, something
    /// 1.0 retired.
    fn typed(&mut self, event: Event) {
        let mut warnings = Vec::new();
        if matches!(event, Event::RunStarted(_)) {
            // A later run on the same stream reports its own warnings.
            self.delivered.clear();
            self.legacy = Legacy::default();
        }
        if !event.is_deprecated() && !carries_legacy_content(&event) {
            note_version(&event, &mut warnings);
            self.warn(warnings);
            self.out.push_back(Ok(Checked::Event(event)));
            return;
        }
        let translated = serde_json::to_value(&event)
            .map_err(Error::from)
            .and_then(|value| self.legacy.translate(value, &mut warnings))
            .and_then(|values| {
                let mut events = Vec::with_capacity(values.len());
                for value in values {
                    events.extend(decode(value, &mut warnings)?);
                }
                Ok(events)
            });
        self.warn(warnings);
        match translated {
            Ok(events) => self
                .out
                .extend(events.into_iter().map(|event| Ok(Checked::Event(event)))),
            Err(error) => self.fail(error),
        }
    }

    /// Hands on each warning whose text this run has not delivered yet. A
    /// legacy producer would otherwise repeat one per reasoning token.
    fn warn(&mut self, warnings: Vec<String>) {
        for warning in warnings {
            if self.delivered.contains(&warning) {
                continue;
            }
            if self.delivered.len() < REMEMBERED {
                self.delivered.insert(warning.clone());
            }
            self.out.push_back(Ok(Checked::Warning(warning)));
        }
    }

    fn fail(&mut self, error: Error) {
        self.out.push_back(Err(error));
        self.raw = None;
        self.ready.clear();
    }
}

/// Whether a typed event holds a retired `binary` content part in one of the
/// places the wire path translates it: the messages of `MESSAGES_SNAPSHOT`
/// and of the `RUN_STARTED` input echo, and the content of `TOOL_CALL_RESULT`.
fn carries_legacy_content(event: &Event) -> bool {
    let binary = |parts: &[InputContent]| {
        parts
            .iter()
            .any(|part| matches!(part, InputContent::Binary(_)))
    };
    let in_messages = |messages: &[Message]| {
        messages.iter().any(|message| match message {
            Message::User(user) => {
                matches!(&user.content, UserContent::Parts(parts) if binary(parts))
            }
            Message::Tool(tool) => {
                matches!(&tool.content, ToolContent::Parts(parts) if binary(parts))
            }
            _ => false,
        })
    };
    match event {
        Event::MessagesSnapshot(snapshot) => in_messages(&snapshot.messages),
        Event::RunStarted(started) => started
            .input
            .as_ref()
            .is_some_and(|input| in_messages(&input.messages)),
        Event::ToolCallResult(result) => {
            matches!(&result.content, ToolContent::Parts(parts) if binary(parts))
        }
        _ => false,
    }
}

#[derive(Default)]
struct Legacy {
    reasoning_id: Option<String>,
    message_id: Option<String>,
    /// Registered optional nulls already reported in this run.
    noticed: crate::protocol::Noticed,
}

impl Legacy {
    fn translate(&mut self, mut value: Value, warnings: &mut Vec<String>) -> Result<Vec<Value>> {
        let Some(tag) = value.get("type").and_then(Value::as_str).map(str::to_owned) else {
            return Ok(vec![value]);
        };
        if tag == "RUN_STARTED" {
            self.reasoning_id = None;
            self.message_id = None;
            self.noticed = Default::default();
        }
        // Before the retired shapes below, so a translation sees the event
        // without them, as a 1.0 producer would have written it.
        crate::protocol::omit_event_nulls(&mut value, &tag, &mut self.noticed, warnings);
        // The retired `binary` content part, which enforcement would drop.
        crate::message::upgrade_legacy_event_content(&mut value, &tag, warnings);
        if !is_legacy_reasoning_tag(&tag) {
            return Ok(vec![value]);
        }
        // Validate the retired shape before translation: compatibility must
        // never turn a malformed known value into an apparently valid one.
        let _: Event = serde_json::from_value(value.clone())?;
        let mut before = Vec::new();
        let (replacement, generated) = match tag.as_str() {
            "THINKING_START" => {
                let id = crate::client::thread::random_id()?;
                self.reasoning_id = Some(id.clone());
                if value
                    .as_object_mut()
                    .and_then(|v| v.remove("title"))
                    .is_some()
                {
                    warnings.push("retired THINKING_START.title was dropped".to_owned());
                }
                ("REASONING_START", id)
            }
            "THINKING_TEXT_MESSAGE_START" => {
                let id = match &self.reasoning_id {
                    Some(id) => id.clone(),
                    None => crate::client::thread::random_id()?,
                };
                self.message_id = Some(id.clone());
                value["role"] = Value::String("reasoning".to_owned());
                ("REASONING_MESSAGE_START", id)
            }
            "THINKING_TEXT_MESSAGE_CONTENT" => {
                let id = match &self.message_id {
                    Some(id) => id.clone(),
                    None => {
                        let id = match &self.reasoning_id {
                            Some(id) => id.clone(),
                            None => crate::client::thread::random_id()?,
                        };
                        self.message_id = Some(id.clone());
                        before.push(serde_json::json!({
                            "type": "REASONING_MESSAGE_START",
                            "messageId": id,
                            "role": "reasoning"
                        }));
                        id
                    }
                };
                ("REASONING_MESSAGE_CONTENT", id)
            }
            "THINKING_TEXT_MESSAGE_END" => {
                let id = match self.message_id.take() {
                    Some(id) => id,
                    None => {
                        let id = match &self.reasoning_id {
                            Some(id) => id.clone(),
                            None => crate::client::thread::random_id()?,
                        };
                        before.push(serde_json::json!({
                            "type": "REASONING_MESSAGE_START",
                            "messageId": id,
                            "role": "reasoning"
                        }));
                        id
                    }
                };
                ("REASONING_MESSAGE_END", id)
            }
            "THINKING_END" => {
                let id = match self.reasoning_id.take() {
                    Some(id) => id,
                    None => crate::client::thread::random_id()?,
                };
                if let Some(message_id) = self.message_id.take() {
                    before.push(serde_json::json!({
                        "type": "REASONING_MESSAGE_END",
                        "messageId": message_id
                    }));
                }
                ("REASONING_END", id)
            }
            _ => unreachable!(),
        };
        value["type"] = Value::String(replacement.to_owned());
        value["messageId"] = Value::String(generated);
        warnings.push(format!("translated retired {tag} to {replacement}"));
        before.push(value);
        Ok(before)
    }
}

fn is_legacy_reasoning_tag(tag: &str) -> bool {
    matches!(
        tag,
        "THINKING_START"
            | "THINKING_END"
            | "THINKING_TEXT_MESSAGE_START"
            | "THINKING_TEXT_MESSAGE_CONTENT"
            | "THINKING_TEXT_MESSAGE_END"
    )
}
