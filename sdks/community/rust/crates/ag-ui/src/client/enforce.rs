//! The compatibility boundary between wire JSON and the closed Rust event enum.
//!
//! The pinned schema describes what this version understands. Unknown additions
//! are removed before deserializing into `Event`; malformed values of fields it
//! does understand are errors. Keeping this step before chunk expansion and
//! verification gives the same decision to every SSE consumer.

use std::collections::VecDeque;

use futures_core::Stream;
use futures_util::StreamExt;
use serde_json::Value;

use crate::Event;
use crate::client::error::{Error, Result};

/// Decodes a wire event after removing material this version does not know.
pub(crate) fn decode(value: Value) -> Result<Option<Event>> {
    let Some(value) = crate::protocol::event(value).map_err(Error::protocol)? else {
        return Ok(None);
    };
    let event: Event = serde_json::from_value(value)?;
    if let Event::RunStarted(started) = &event {
        if let Some(version) = &started.protocol_version {
            let current = (1, 0);
            let declared = version.split_once('.').and_then(|(major, minor)| {
                Some((major.parse::<u64>().ok()?, minor.parse::<u64>().ok()?))
            });
            if declared.is_none_or(|peer| peer > current) {
                eprintln!(
                    "ag-ui: producer declared newer or uninterpretable protocol version {version}"
                );
            }
        }
    }
    Ok(Some(event))
}

/// Applies the same enforcement to every transport. An error stops the run;
/// unknown additions disappear without reaching the typed event stream.
pub(crate) fn stream<S>(raw: S) -> impl Stream<Item = Result<Event>>
where
    S: Stream<Item = Result<Value>>,
{
    futures_util::stream::unfold(
        (Box::pin(raw), false, Legacy::default(), VecDeque::new()),
        |(mut raw, done, mut legacy, mut ready)| async move {
            if done {
                return None;
            }
            loop {
                if let Some(value) = ready.pop_front() {
                    match decode(value) {
                        Ok(Some(event)) => return Some((Ok(event), (raw, false, legacy, ready))),
                        Ok(None) => continue,
                        Err(error) => return Some((Err(error), (raw, true, legacy, ready))),
                    }
                }
                match raw.next().await? {
                    Ok(value) => match legacy.translate(value) {
                        Ok(values) => ready.extend(values),
                        Err(error) => return Some((Err(error), (raw, true, legacy, ready))),
                    },
                    Err(error) => return Some((Err(error), (raw, true, legacy, ready))),
                }
            }
        },
    )
}

#[derive(Default)]
struct Legacy {
    reasoning_id: Option<String>,
    message_id: Option<String>,
}

impl Legacy {
    fn translate(&mut self, mut value: Value) -> Result<Vec<Value>> {
        let Some(tag) = value.get("type").and_then(Value::as_str).map(str::to_owned) else {
            return Ok(vec![value]);
        };
        if tag == "RUN_STARTED" {
            self.reasoning_id = None;
            self.message_id = None;
        }
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
                    eprintln!("ag-ui: retired THINKING_START.title was dropped");
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
        eprintln!("ag-ui: translated retired {tag} to {replacement}");
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
