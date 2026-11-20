//! Always-on translation of retired wire shapes before 1.0 processing.
//!
//! Construct one boundary per stream/run; no protocol-version gate is needed.
//! Diagnostics describe the conversion or loss, never attachment or title values.
//!
//! Raw producers should pass JSON values through this boundary before serde
//! deserialization. A typed `Agent::run` adapter can translate retained legacy
//! variants, but cannot recover unknown fields or variants already discarded or
//! rejected by a third-party deserializer.
use crate::{
    AgentState,
    processing::{self, Diagnostic, DiagnosticCategory, ProcessedEvent, ProcessingError},
};
use serde_json::{Value, json};
use std::collections::HashSet;
use uuid::Uuid;

const LIMIT: usize = 256;

/// Combine diagnostic batches while retaining at most 256 entries and one summary.
/// Existing processing summaries are carried forward, including their omitted count.
pub fn merge_diagnostics(
    target: &mut Vec<Diagnostic>,
    incoming: impl IntoIterator<Item = Diagnostic>,
) {
    // Existing batches produced by either processor have a trailing summary.
    // Remove only that entry, never rebuild the retained diagnostic prefix.
    let mut omitted = if target
        .last()
        .is_some_and(|d| d.category == DiagnosticCategory::DiagnosticLimit)
    {
        omitted_count(&target.pop().unwrap())
    } else {
        0
    };
    for diagnostic in incoming {
        if diagnostic.category == DiagnosticCategory::DiagnosticLimit {
            omitted = omitted.saturating_add(omitted_count(&diagnostic));
        } else if target.len() < LIMIT {
            target.push(diagnostic);
        } else {
            omitted = omitted.saturating_add(1);
        }
    }
    if omitted != 0 {
        target.push(summary(omitted));
    }
}

fn omitted_count(diagnostic: &Diagnostic) -> usize {
    diagnostic
        .message
        .split_whitespace()
        .next()
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(1)
}

fn summary(omitted: usize) -> Diagnostic {
    Diagnostic {
        category: DiagnosticCategory::DiagnosticLimit,
        path: String::new(),
        message: format!("{omitted} more diagnostics omitted"),
    }
}

fn warn(diagnostics: &mut Vec<Diagnostic>, path: &str, message: &str) {
    if diagnostics.len() < LIMIT {
        diagnostics.push(Diagnostic {
            category: DiagnosticCategory::DeprecatedEvent,
            path: path.chars().filter(|c| !c.is_control()).take(256).collect(),
            message: message.into(),
        });
    } else if diagnostics.len() == LIMIT {
        diagnostics.push(summary(1));
    } else {
        // Do not allocate a path/message or move the retained entries after
        // the cap: large attachment lists remain linear in their input size.
        diagnostics[LIMIT] = summary(omitted_count(&diagnostics[LIMIT]).saturating_add(1));
    }
}

/// Translation state is private to a stream, never shared between clients.
#[derive(Debug, Default, Clone)]
pub struct CompatibilityBoundary {
    reasoning_id: Option<String>,
    message_id: Option<String>,
}
impl CompatibilityBoundary {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin another run when reusing a boundary outside the standard client path.
    pub fn reset(&mut self) {
        self.reasoning_id = None;
        self.message_id = None;
    }

    /// Translate understood legacy shapes, then apply canonical 1.0 processing.
    pub fn normalize_event<S: AgentState>(
        &mut self,
        value: Value,
    ) -> Result<ProcessedEvent<S>, ProcessingError> {
        // A rejected opener/closer must not change which legacy ids later
        // continuations refer to when a caller elects to continue after errors.
        let mut candidate = self.clone();
        let processed = candidate.normalize_candidate(value)?;
        if processed.event.is_some() {
            *self = candidate;
        }
        Ok(processed)
    }

    fn normalize_candidate<S: AgentState>(
        &mut self,
        mut value: Value,
    ) -> Result<ProcessedEvent<S>, ProcessingError> {
        let mut diagnostics = Vec::new();
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let replacement = match kind.as_str() {
            "THINKING_START" => Some("REASONING_START"),
            "THINKING_END" => Some("REASONING_END"),
            "THINKING_TEXT_MESSAGE_START" => Some("REASONING_MESSAGE_START"),
            "THINKING_TEXT_MESSAGE_CONTENT" => Some("REASONING_MESSAGE_CONTENT"),
            "THINKING_TEXT_MESSAGE_END" => Some("REASONING_MESSAGE_END"),
            _ => None,
        };
        if let Some(replacement) = replacement {
            warn(
                &mut diagnostics,
                "/type",
                &format!("deprecated {kind} translated to {replacement}"),
            );
            let id = match kind.as_str() {
                "THINKING_START" => {
                    let id = Uuid::new_v4().to_string();
                    self.reasoning_id = Some(id.clone());
                    if value.as_object_mut().unwrap().remove("title").is_some() {
                        warn(
                            &mut diagnostics,
                            "/title",
                            "legacy reasoning title dropped: modern reasoning spans have no title",
                        );
                    }
                    id
                }
                "THINKING_TEXT_MESSAGE_START" => {
                    let id = Uuid::new_v4().to_string();
                    self.message_id = Some(id.clone());
                    value["role"] = json!("reasoning");
                    id
                }
                "THINKING_END" => continuation(self.reasoning_id.take(), &mut diagnostics),
                "THINKING_TEXT_MESSAGE_END" => {
                    continuation(self.message_id.take(), &mut diagnostics)
                }
                _ => continuation(self.message_id.clone(), &mut diagnostics),
            };
            value["type"] = json!(replacement);
            value["messageId"] = json!(id);
        } else if kind == "MESSAGES_SNAPSHOT" {
            merge_diagnostics(&mut diagnostics, upgrade_messages(&mut value, ""));
        } else if kind == "RUN_STARTED" {
            self.reset();
            if let Some(input) = value.get_mut("input") {
                merge_diagnostics(&mut diagnostics, upgrade_messages(input, "/input"));
            }
        }
        let mut processed = processing::normalize_event_typed(value)?;
        merge_diagnostics(&mut diagnostics, processed.diagnostics);
        processed.diagnostics = diagnostics;
        Ok(processed)
    }
}
fn continuation(id: Option<String>, diagnostics: &mut Vec<Diagnostic>) -> String {
    id.unwrap_or_else(|| {
        warn(diagnostics, "/messageId", "legacy continuation has no opener; generated an id that ordering verification will reject");
        Uuid::new_v4().to_string()
    })
}

/// Upgrade the `messages` field of an input or snapshot without touching opaque data.
/// `path` is the JSON pointer to that enclosing object (usually empty or `/input`).
pub fn upgrade_messages(value: &mut Value, path: &str) -> Vec<Diagnostic> {
    upgrade_messages_with_warnings(value, path, true)
}

/// Upgrade outgoing request attachments silently when conversion is lossless.
/// Unconvertible parts still emit a diagnostic, matching the transport boundary.
pub fn upgrade_outgoing_messages(value: &mut Value, path: &str) -> Vec<Diagnostic> {
    upgrade_messages_with_warnings(value, path, false)
}

fn upgrade_messages_with_warnings(
    value: &mut Value,
    path: &str,
    warn_conversions: bool,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    if let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) {
        for (index, message) in messages.iter_mut().enumerate() {
            merge_diagnostics(
                &mut diagnostics,
                upgrade_message_content_with_warnings(
                    message,
                    &format!("{path}/messages/{index}"),
                    warn_conversions,
                ),
            );
        }
    }
    diagnostics
}

fn nonempty(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Upgrade legacy binary parts, preserving filenames and intentional repeats.
/// Only mirrors of ORIGINAL modern parts are removed. Id-only parts stay legacy
/// for subsequent validation, with an explicit diagnostic explaining the loss.
pub fn upgrade_message_content(message: &mut Value, path: &str) -> Vec<Diagnostic> {
    upgrade_message_content_with_warnings(message, path, true)
}

fn upgrade_message_content_with_warnings(
    message: &mut Value,
    path: &str,
    warn_conversions: bool,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return diagnostics;
    };
    let mut modern = HashSet::new();
    for part in content.iter() {
        let Some(kind @ ("image" | "audio" | "video" | "document")) =
            part.get("type").and_then(Value::as_str)
        else {
            continue;
        };
        let Some(source) = part.get("source") else {
            continue;
        };
        if let (Some(source_type), Some(value), Some(mime)) = (
            source.get("type").and_then(Value::as_str),
            source.get("value").and_then(Value::as_str),
            source.get("mimeType").and_then(Value::as_str),
        ) {
            modern.insert((kind, source_type, value, mime, None));
            if let Some(filename) = part
                .get("metadata")
                .and_then(|m| m.get("filename"))
                .and_then(Value::as_str)
            {
                modern.insert((kind, source_type, value, mime, Some(filename)));
            }
        }
    }
    let mut upgraded = Vec::with_capacity(content.len());
    for (index, part) in content.iter().enumerate() {
        if part.get("type").and_then(Value::as_str) != Some("binary") {
            upgraded.push(part.clone());
            continue;
        }
        let Some(mime) = part.get("mimeType").and_then(Value::as_str) else {
            upgraded.push(part.clone());
            continue;
        };
        let part_path = format!("{path}/content/{index}");
        let source = nonempty(part.get("data"))
            .map(|s| ("data", s))
            .or_else(|| nonempty(part.get("url")).map(|s| ("url", s)));
        let Some((source_type, value)) = source else {
            warn(
                &mut diagnostics,
                &part_path,
                "legacy binary part has no data or url; cannot convert and a modern peer cannot accept it",
            );
            upgraded.push(part.clone());
            continue;
        };
        let kind = if mime.starts_with("image/") {
            "image"
        } else if mime.starts_with("audio/") {
            "audio"
        } else if mime.starts_with("video/") {
            "video"
        } else {
            "document"
        };
        let filename = nonempty(part.get("filename"));
        if modern.contains(&(kind, source_type, value, mime, filename)) {
            if warn_conversions {
                warn(
                    &mut diagnostics,
                    &part_path,
                    "legacy binary mirror removed; original modern media part retains its content and filename",
                );
            }
            continue;
        }
        if warn_conversions {
            warn(
                &mut diagnostics,
                &part_path,
                "legacy binary part translated to modern media content",
            );
        }
        let mut converted = json!({"type": kind, "source": {"type": source_type, "value": value, "mimeType": mime}});
        if let Some(filename) = filename {
            converted["metadata"] = json!({"filename": filename});
        }
        upgraded.push(converted);
    }
    *content = upgraded;
    diagnostics
}
