//! AG-UI 1.0 wire processing, separate from representation-only serde parsing.
//!
//! Unknown protocol material is stripped with bounded, path-aware diagnostics;
//! malformed known values fail. Opaque JSON and RFC 6902 extension members are
//! never traversed. This module does not validate cross-event ordering.
use crate::{AgentState, event::Event, types::RunAgentInput};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The version declared by this SDK, independent of any peer declaration.
pub const PROTOCOL_VERSION: &str = "1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCategory {
    UnknownField,
    UnknownVariant,
    UnknownEnumValue,
    OptionalNull,
    NewerMinorVersion,
    UninterpretableVersion,
    UnsupportedMajorVersion,
    InvalidValue,
    DeprecatedEvent,
    PatchNotApplied,
    MissingTarget,
    DiagnosticLimit,
}

/// Paths use RFC 6901 JSON pointers. Messages never include opaque payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub category: DiagnosticCategory,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{category:?} at {path}: {message}")]
pub struct ProcessingError {
    pub category: DiagnosticCategory,
    pub path: String,
    pub message: String,
}
impl ProcessingError {
    fn invalid(path: &str, message: &str) -> Self {
        Self {
            category: DiagnosticCategory::InvalidValue,
            path: bounded(path, 256),
            message: bounded(message, 192),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcessedInput {
    /// Canonical wire representation. An omitted state remains omitted on encode.
    pub input: RunAgentInput,
    /// Omitted or whole-null input state starts from {}, never Value::default().
    pub effective_state: Value,
    pub diagnostics: Vec<Diagnostic>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessedEvent<S: AgentState = Value> {
    /// None means the unrecognised event (or required union material) was dropped.
    pub event: Option<Event<S>>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Apply tolerant producer-ingress processing before accepting a request.
pub fn normalize_run_input(mut value: Value) -> Result<ProcessedInput, ProcessingError> {
    let mut ctx = Context::new(false);
    if !ctx.object(&mut value, Kind::Input, "")? {
        return Err(ProcessingError::invalid("", "run input cannot be dropped"));
    }
    ctx.version(value.get("protocolVersion"), "/protocolVersion", true)?;
    let effective_state = value
        .get("state")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let input = serde_json::from_value(value)
        .map_err(|_| ProcessingError::invalid("", "canonical input cannot be represented"))?;
    Ok(ProcessedInput {
        input,
        effective_state,
        diagnostics: ctx.diagnostics,
    })
}

/// Normalize a received event before application delivery. This does not translate
/// retired THINKING events or other 0.x shapes; they are unknown in this 1.0 lane.
pub fn normalize_event(value: Value) -> Result<ProcessedEvent, ProcessingError> {
    normalize_event_typed(value)
}

/// Normalize directly into the application's state type, avoiding a second JSON tree.
pub fn normalize_event_typed<S: AgentState>(
    mut value: Value,
) -> Result<ProcessedEvent<S>, ProcessingError> {
    let mut ctx = Context::new(false);
    let keep = ctx.object(&mut value, Kind::Event, "")?;
    if keep && value.get("type").and_then(Value::as_str) == Some("RUN_STARTED") {
        ctx.version(value.get("protocolVersion"), "/protocolVersion", false)?;
    }
    let event =
        if keep {
            Some(serde_json::from_value(value).map_err(|_| {
                ProcessingError::invalid("", "canonical event cannot be represented")
            })?)
        } else {
            None
        };
    Ok(ProcessedEvent {
        event,
        diagnostics: ctx.diagnostics,
    })
}

/// Construct the HTTP request projection without mutating application history.
/// Activity messages are UI-only; a consumer declares its own version.
pub fn prepare_run_input<S: Serialize, F: Serialize>(
    input: &RunAgentInput<S, F>,
) -> Result<ProcessedInput, ProcessingError> {
    let value = serde_json::to_value(input)
        .map_err(|_| ProcessingError::invalid("", "input serialization failed"))?;
    prepare_run_input_value(value)
}

/// Prepare a raw request before converting it to the modern typed input surface.
/// This is the entry point for legacy binary attachments, which are deliberately
/// absent from the 1.0 producer union. It never mutates application history.
pub fn prepare_run_input_value(mut value: Value) -> Result<ProcessedInput, ProcessingError> {
    let compatibility_diagnostics = crate::compatibility::upgrade_outgoing_messages(&mut value, "");
    // Validate before filtering so invalid constructed activity messages are not hidden.
    let mut ctx = Context::new(true);
    ctx.object(&mut value, Kind::Input, "")?;
    value["protocolVersion"] = Value::String(PROTOCOL_VERSION.into());
    if let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) {
        messages.retain(|message| message.get("role").and_then(Value::as_str) != Some("activity"));
    }
    let mut prepared = normalize_run_input(value)?;
    crate::history::keep_tool_results_with_calls(&mut prepared.input.messages);
    crate::compatibility::merge_diagnostics(&mut prepared.diagnostics, compatibility_diagnostics);
    Ok(prepared)
}

/// Validate a directly constructed producer event and omit optional whole JSON
/// nulls. Unlike ingress, invalid/unknown material is never repaired or stripped.
/// The result is the exact canonical payload to serialize; no version is added.
pub fn normalize_producer_event<S: AgentState>(event: &Event<S>) -> Result<Value, ProcessingError> {
    // These fields flatten onto the same wire key. Reject ambiguity before serde
    // can overwrite it while creating a Value.
    let duplicate_attribution = match event {
        Event::SubagentStarted(e) => e.base.subagent_run_id.is_some(),
        Event::SubagentFinished(e) => e.base.subagent_run_id.is_some(),
        Event::SubagentError(e) => e.base.subagent_run_id.is_some(),
        _ => false,
    };
    if duplicate_attribution {
        return Err(ProcessingError::invalid(
            "/subagentRunId",
            "duplicate base and invocation attribution",
        ));
    }
    let mut value = serde_json::to_value(event)
        .map_err(|_| ProcessingError::invalid("", "event serialization failed"))?;
    Context::new(true).object(&mut value, Kind::Event, "")?;
    Ok(value)
}

fn bounded(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}
fn pointer(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}
#[derive(Clone, Copy)]
enum Kind {
    Input,
    Event,
    Message,
    Part,
    Source,
    ToolCall,
    Function,
    Tool,
    Ambient,
    Resume,
    Interrupt,
    Usage,
    Outcome,
    SubOutcome,
    Patch,
}
#[derive(Clone, Copy)]
enum Rule {
    String,
    Bool,
    Any,
    NonNullAny,
    Object,
    Integer(bool),
    Pointer,
    Constant(&'static str),
    Enum(&'static [&'static str]),
    StrictEnum(&'static [&'static str]),
    Content,
    Nested(Kind),
    List(Kind),
    Strings,
}
#[derive(Clone, Copy)]
struct Field {
    name: &'static str,
    rule: Rule,
    required: bool,
    null_shim: bool,
}
fn req(name: &'static str, rule: Rule) -> Field {
    Field {
        name,
        rule,
        required: true,
        null_shim: false,
    }
}
fn opt(name: &'static str, rule: Rule) -> Field {
    Field {
        name,
        rule,
        required: false,
        null_shim: false,
    }
}
fn nullable(name: &'static str, rule: Rule) -> Field {
    Field {
        name,
        rule,
        required: false,
        null_shim: true,
    }
}
struct Context {
    strict: bool,
    diagnostics: Vec<Diagnostic>,
    suppressed_diagnostics: usize,
}
impl Context {
    fn new(strict: bool) -> Self {
        Self {
            strict,
            diagnostics: Vec::new(),
            suppressed_diagnostics: 0,
        }
    }
    fn warn(&mut self, category: DiagnosticCategory, path: &str, message: &str) {
        const MAX_DIAGNOSTICS: usize = 256;
        if self.diagnostics.len() >= MAX_DIAGNOSTICS {
            self.suppressed_diagnostics += 1;
            let summary = Diagnostic {
                category: DiagnosticCategory::DiagnosticLimit,
                path: String::new(),
                message: format!("{} more diagnostics omitted", self.suppressed_diagnostics),
            };
            if self.diagnostics.len() == MAX_DIAGNOSTICS {
                self.diagnostics.push(summary);
            } else {
                self.diagnostics[MAX_DIAGNOSTICS] = summary;
            }
            return;
        }
        self.diagnostics.push(Diagnostic {
            category,
            path: bounded(path, 256),
            message: bounded(message, 192),
        });
    }
    fn unknown(
        &mut self,
        category: DiagnosticCategory,
        path: &str,
        message: &str,
    ) -> Result<bool, ProcessingError> {
        if self.strict {
            return Err(ProcessingError {
                category,
                path: bounded(path, 256),
                message: bounded(message, 192),
            });
        }
        self.warn(category, path, message);
        Ok(false)
    }
    fn version(
        &mut self,
        value: Option<&Value>,
        path: &str,
        reject_major: bool,
    ) -> Result<(), ProcessingError> {
        let Some(value) = value else {
            return Ok(());
        };
        let raw = value
            .as_str()
            .ok_or_else(|| ProcessingError::invalid(path, "expected string"))?;
        let version = raw.split_once('.').and_then(|(major, minor)| {
            if major.is_empty()
                || minor.is_empty()
                || !major.bytes().all(|b| b.is_ascii_digit())
                || !minor.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            Some((major.parse::<u64>().ok()?, minor.parse::<u64>().ok()?))
        });
        match version {
            Some((1, 0)) => {}
            Some((1, _)) => self.warn(
                DiagnosticCategory::NewerMinorVersion,
                path,
                &format!("newer minor protocol version {}", bounded(raw, 64)),
            ),
            Some(_) if !reject_major => self.warn(
                DiagnosticCategory::UnsupportedMajorVersion,
                path,
                "unsupported producer major version; proceeding with known 1.0 material",
            ),
            Some(_) => {
                return Err(ProcessingError {
                    category: DiagnosticCategory::UnsupportedMajorVersion,
                    path: path.into(),
                    message: "unsupported protocol major version".into(),
                });
            }
            None => self.warn(
                DiagnosticCategory::UninterpretableVersion,
                path,
                "cannot interpret protocol version; proceeding with 1.0 rules",
            ),
        }
        Ok(())
    }
    fn discriminator<'a>(
        &self,
        value: &'a Value,
        key: &str,
        path: &str,
    ) -> Result<&'a str, ProcessingError> {
        value.get(key).and_then(Value::as_str).ok_or_else(|| {
            ProcessingError::invalid(&pointer(path, key), "required string discriminator")
        })
    }
    fn object(
        &mut self,
        value: &mut Value,
        kind: Kind,
        path: &str,
    ) -> Result<bool, ProcessingError> {
        if !value.is_object() {
            return Err(ProcessingError::invalid(path, "expected object"));
        }
        let (fields, open) = match kind {
            Kind::Input => (
                vec![
                    req("threadId", Rule::String),
                    req("runId", Rule::String),
                    req("messages", Rule::List(Kind::Message)),
                    opt("protocolVersion", Rule::String),
                    opt("parentRunId", Rule::String),
                    nullable("state", Rule::Any),
                    opt("tools", Rule::List(Kind::Tool)),
                    opt("context", Rule::List(Kind::Ambient)),
                    nullable("forwardedProps", Rule::Any),
                    opt("resume", Rule::List(Kind::Resume)),
                ],
                false,
            ),
            Kind::Event => {
                let name = self.discriminator(value, "type", path)?;
                let mut fields = vec![
                    req("type", Rule::String),
                    opt("timestamp", Rule::Integer(false)),
                    nullable("rawEvent", Rule::Any),
                    opt("metadata", Rule::Object),
                ];
                let attributable = !matches!(
                    name,
                    "RUN_STARTED"
                        | "RUN_FINISHED"
                        | "RUN_ERROR"
                        | "MESSAGES_SNAPSHOT"
                        | "SUBAGENT_STARTED"
                        | "SUBAGENT_FINISHED"
                        | "SUBAGENT_ERROR"
                );
                if attributable {
                    fields.push(nullable("subagentRunId", Rule::String));
                }
                let mut specific = match name {
                    "TEXT_MESSAGE_START" => vec![
                        req("messageId", Rule::String),
                        opt(
                            "role",
                            Rule::StrictEnum(&["developer", "system", "assistant", "user"]),
                        ),
                        opt("name", Rule::String),
                    ],
                    "TEXT_MESSAGE_CONTENT" | "REASONING_MESSAGE_CONTENT" => {
                        vec![req("messageId", Rule::String), req("delta", Rule::String)]
                    }
                    "TEXT_MESSAGE_END"
                    | "REASONING_START"
                    | "REASONING_END"
                    | "REASONING_MESSAGE_END" => vec![req("messageId", Rule::String)],
                    "TEXT_MESSAGE_CHUNK" => vec![
                        opt("messageId", Rule::String),
                        opt(
                            "role",
                            Rule::StrictEnum(&["developer", "system", "assistant", "user"]),
                        ),
                        opt("delta", Rule::String),
                        opt("name", Rule::String),
                    ],
                    "REASONING_MESSAGE_CHUNK" => {
                        vec![opt("messageId", Rule::String), opt("delta", Rule::String)]
                    }
                    "REASONING_MESSAGE_START" => vec![
                        req("messageId", Rule::String),
                        req("role", Rule::Constant("reasoning")),
                    ],
                    "REASONING_ENCRYPTED_VALUE" => vec![
                        req("subtype", Rule::Enum(&["message", "tool-call"])),
                        req("entityId", Rule::String),
                        req("encryptedValue", Rule::String),
                    ],
                    "TOOL_CALL_START" => vec![
                        req("toolCallId", Rule::String),
                        req("toolCallName", Rule::String),
                        nullable("parentMessageId", Rule::String),
                    ],
                    "TOOL_CALL_ARGS" => {
                        vec![req("toolCallId", Rule::String), req("delta", Rule::String)]
                    }
                    "TOOL_CALL_END" => vec![req("toolCallId", Rule::String)],
                    "TOOL_CALL_CHUNK" => vec![
                        opt("toolCallId", Rule::String),
                        opt("toolCallName", Rule::String),
                        nullable("parentMessageId", Rule::String),
                        opt("delta", Rule::String),
                    ],
                    "TOOL_CALL_RESULT" => vec![
                        req("messageId", Rule::String),
                        req("toolCallId", Rule::String),
                        req("content", Rule::Content),
                        nullable("role", Rule::Constant("tool")),
                    ],
                    "STATE_SNAPSHOT" => vec![req("snapshot", Rule::Any)],
                    "STATE_DELTA" => vec![req("delta", Rule::List(Kind::Patch))],
                    "MESSAGES_SNAPSHOT" => vec![req("messages", Rule::List(Kind::Message))],
                    "ACTIVITY_SNAPSHOT" => vec![
                        req("messageId", Rule::String),
                        req("activityType", Rule::String),
                        req("content", Rule::Object),
                        opt("replace", Rule::Bool),
                    ],
                    "ACTIVITY_DELTA" => vec![
                        req("messageId", Rule::String),
                        req("activityType", Rule::String),
                        req("patch", Rule::List(Kind::Patch)),
                    ],
                    "RAW" => vec![req("event", Rule::Any), opt("source", Rule::String)],
                    "CUSTOM" => vec![req("name", Rule::String), req("value", Rule::Any)],
                    "RUN_STARTED" => vec![
                        req("threadId", Rule::String),
                        req("runId", Rule::String),
                        opt("protocolVersion", Rule::String),
                        nullable("parentRunId", Rule::String),
                        nullable("input", Rule::Nested(Kind::Input)),
                    ],
                    "RUN_FINISHED" => vec![
                        req("threadId", Rule::String),
                        req("runId", Rule::String),
                        nullable("result", Rule::Any),
                        nullable("outcome", Rule::Nested(Kind::Outcome)),
                        opt("usage", Rule::List(Kind::Usage)),
                    ],
                    "RUN_ERROR" => vec![
                        req("message", Rule::String),
                        opt("code", Rule::String),
                        nullable("usage", Rule::List(Kind::Usage)),
                    ],
                    "STEP_STARTED" | "STEP_FINISHED" => vec![req("stepName", Rule::String)],
                    "SUBAGENT_STARTED" => vec![
                        req("subagentRunId", Rule::String),
                        req("name", Rule::String),
                        opt("description", Rule::String),
                        opt("parentSubagentRunId", Rule::String),
                        opt("parentToolCallId", Rule::String),
                        opt("parentMessageId", Rule::String),
                    ],
                    "SUBAGENT_FINISHED" => vec![
                        req("subagentRunId", Rule::String),
                        nullable("result", Rule::Any),
                        opt("outcome", Rule::Nested(Kind::SubOutcome)),
                    ],
                    "SUBAGENT_ERROR" => vec![
                        req("subagentRunId", Rule::String),
                        req("message", Rule::String),
                        opt("code", Rule::String),
                    ],
                    _ => {
                        return self.unknown(
                            DiagnosticCategory::UnknownVariant,
                            &pointer(path, "type"),
                            &format!("unknown event type {}", bounded(name, 64)),
                        );
                    }
                };
                fields.append(&mut specific);
                (fields, false)
            }
            Kind::Message => {
                let role = self.discriminator(value, "role", path)?;
                let mut fields = vec![
                    req("id", Rule::String),
                    req("role", Rule::String),
                    opt("metadata", Rule::Object),
                    opt("subagentRunId", Rule::String),
                ];
                if role != "activity" {
                    fields.push(opt("encryptedValue", Rule::String));
                }
                if matches!(role, "developer" | "system" | "assistant" | "user") {
                    fields.push(opt("name", Rule::String));
                }
                match role {
                    "developer" | "system" | "reasoning" => {
                        fields.push(req("content", Rule::String))
                    }
                    "assistant" => {
                        fields.push(opt("content", Rule::String));
                        fields.push(opt("toolCalls", Rule::List(Kind::ToolCall)));
                    }
                    "user" => fields.push(req("content", Rule::Content)),
                    "tool" => {
                        fields.push(req("content", Rule::Content));
                        fields.push(req("toolCallId", Rule::String));
                        fields.push(opt("error", Rule::String));
                    }
                    "activity" => {
                        fields.push(req("content", Rule::Object));
                        fields.push(req("activityType", Rule::String));
                    }
                    _ => {
                        return self.unknown(
                            DiagnosticCategory::UnknownVariant,
                            &pointer(path, "role"),
                            "unknown message role",
                        );
                    }
                }
                (fields, false)
            }
            Kind::Part => {
                let name = self.discriminator(value, "type", path)?;
                let mut fields = vec![
                    req("type", Rule::String),
                    opt("id", Rule::String),
                    if name == "text" {
                        opt("metadata", Rule::NonNullAny)
                    } else {
                        nullable("metadata", Rule::Any)
                    },
                ];
                match name {
                    "text" => fields.push(req("text", Rule::String)),
                    "image" | "audio" | "video" | "document" => {
                        fields.push(req("source", Rule::Nested(Kind::Source)))
                    }
                    _ => {
                        return self.unknown(
                            DiagnosticCategory::UnknownVariant,
                            &pointer(path, "type"),
                            "unknown content part type",
                        );
                    }
                }
                (fields, false)
            }
            Kind::Source => {
                let name = self.discriminator(value, "type", path)?;
                let mut fields = vec![req("type", Rule::String), req("value", Rule::String)];
                match name {
                    "data" => fields.push(req("mimeType", Rule::String)),
                    "url" => fields.push(opt("mimeType", Rule::String)),
                    "file" => {
                        fields.push(opt("mimeType", Rule::String));
                        fields.push(nullable("provider", Rule::String));
                    }
                    _ => {
                        return self.unknown(
                            DiagnosticCategory::UnknownVariant,
                            &pointer(path, "type"),
                            "unknown media source type",
                        );
                    }
                }
                (fields, false)
            }
            Kind::ToolCall => (
                vec![
                    req("id", Rule::String),
                    req("type", Rule::Constant("function")),
                    req("function", Rule::Nested(Kind::Function)),
                    opt("metadata", Rule::Object),
                    opt("encryptedValue", Rule::String),
                ],
                false,
            ),
            Kind::Function => (
                vec![req("name", Rule::String), req("arguments", Rule::String)],
                false,
            ),
            Kind::Tool => (
                vec![
                    req("name", Rule::String),
                    req("description", Rule::String),
                    nullable("parameters", Rule::Any),
                    opt("metadata", Rule::Object),
                ],
                false,
            ),
            Kind::Ambient => (
                vec![req("description", Rule::String), req("value", Rule::String)],
                false,
            ),
            Kind::Resume => (
                vec![
                    req("interruptId", Rule::String),
                    req("status", Rule::Enum(&["resolved", "cancelled"])),
                    nullable("payload", Rule::Any),
                    opt("metadata", Rule::Object),
                ],
                false,
            ),
            Kind::Interrupt => (
                vec![
                    req("id", Rule::String),
                    req("reason", Rule::String),
                    opt("message", Rule::String),
                    opt("toolCallId", Rule::String),
                    opt("responseSchema", Rule::Object),
                    opt("expiresAt", Rule::String),
                    opt("metadata", Rule::Object),
                    opt("subagentRunId", Rule::String),
                ],
                false,
            ),
            Kind::Usage => (
                vec![
                    nullable("provider", Rule::String),
                    opt("model", Rule::String),
                    opt("inputTokens", Rule::Integer(true)),
                    opt("outputTokens", Rule::Integer(true)),
                    opt("totalTokens", Rule::Integer(true)),
                    nullable("reasoningTokens", Rule::Integer(true)),
                    nullable("cachedInputTokens", Rule::Integer(true)),
                    nullable("cacheWriteInputTokens", Rule::Integer(true)),
                ],
                false,
            ),
            Kind::Outcome | Kind::SubOutcome => {
                let name = self.discriminator(value, "type", path)?;
                let mut fields = vec![req("type", Rule::String)];
                match (kind, name) {
                    (Kind::Outcome, "success") => {
                        fields.push(nullable("pendingToolCallIds", Rule::Strings))
                    }
                    (Kind::Outcome, "interrupt") => {
                        fields.push(req("interrupts", Rule::List(Kind::Interrupt)))
                    }
                    (Kind::Outcome, "cancelled") | (Kind::SubOutcome, "success") => {}
                    (Kind::SubOutcome, "suspended") => {
                        fields.push(opt("interruptIds", Rule::Strings))
                    }
                    _ => {
                        return self.unknown(
                            DiagnosticCategory::UnknownVariant,
                            &pointer(path, "type"),
                            "unknown outcome type",
                        );
                    }
                }
                (fields, false)
            }
            Kind::Patch => {
                let name = self.discriminator(value, "op", path)?;
                let mut fields = vec![req("op", Rule::String), req("path", Rule::Pointer)];
                match name {
                    "add" | "replace" | "test" => fields.push(req("value", Rule::Any)),
                    "move" | "copy" => fields.push(req("from", Rule::Pointer)),
                    "remove" => {}
                    _ => {
                        return self.unknown(
                            DiagnosticCategory::UnknownVariant,
                            &pointer(path, "op"),
                            "unknown patch operation",
                        );
                    }
                }
                (fields, true)
            }
        };
        let object = value.as_object_mut().expect("checked object");
        if !open {
            let unknown: Vec<_> = object
                .keys()
                .filter(|key| !fields.iter().any(|f| f.name == key.as_str()))
                .cloned()
                .collect();
            for key in unknown {
                self.unknown(
                    DiagnosticCategory::UnknownField,
                    &pointer(path, &key),
                    "unknown protocol field removed",
                )?;
                object.remove(&key);
            }
        }
        let mut keep = true;
        for field in fields {
            let child_path = pointer(path, field.name);
            if (field.null_shim || (self.strict && matches!(field.rule, Rule::NonNullAny)))
                && object.get(field.name).is_some_and(Value::is_null)
            {
                object.remove(field.name);
                // Optional state null has normative omission semantics. Other
                // accepted whole-null compatibility shims remain observable.
                if !(self.strict || matches!(kind, Kind::Input) && field.name == "state") {
                    self.warn(
                        DiagnosticCategory::OptionalNull,
                        &child_path,
                        "optional whole null omitted",
                    );
                }
            }
            match object.get_mut(field.name) {
                None if field.required => {
                    return Err(ProcessingError::invalid(
                        &child_path,
                        "required field missing",
                    ));
                }
                None => {}
                Some(child) => {
                    if !self.rule(child, field.rule, &child_path)? {
                        object.remove(field.name);
                        if field.required {
                            keep = false;
                        }
                    }
                }
            }
        }
        if matches!(kind, Kind::Outcome)
            && object.get("type").and_then(Value::as_str) == Some("interrupt")
            && object
                .get("interrupts")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
        {
            return Err(ProcessingError::invalid(
                &pointer(path, "interrupts"),
                "interrupt outcome requires at least one interrupt",
            ));
        }
        Ok(keep)
    }
    fn rule(&mut self, value: &mut Value, rule: Rule, path: &str) -> Result<bool, ProcessingError> {
        let valid = match rule {
            Rule::Any => true,
            Rule::NonNullAny => !value.is_null(),
            Rule::String => value.is_string(),
            Rule::Bool => value.is_boolean(),
            Rule::Object => value.is_object(),
            Rule::Integer(unsigned) => {
                // JSON Schema integer is mathematical: 1.0 and 1e0 are valid
                // integer spellings. Canonical typed storage uses an i64.
                let integer = value.as_i64().or_else(|| {
                    value
                        .as_f64()
                        .filter(|n| {
                            n.fract() == 0.0
                                && (-9_007_199_254_740_991_f64..=9_007_199_254_740_991_f64)
                                    .contains(n)
                        })
                        .map(|n| n as i64)
                });
                if let Some(n) = integer.filter(|n| {
                    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(n)
                        && (!unsigned || *n >= 0)
                }) {
                    *value = Value::from(n);
                    true
                } else {
                    false
                }
            }
            Rule::Pointer => {
                serde_json::from_value::<crate::types::JsonPointer>(value.clone()).is_ok()
            }
            Rule::Constant(expected) => value.as_str() == Some(expected),
            // Canonical Python/TypeScript text roles reject unknown present values.
            Rule::StrictEnum(options) => value.as_str().is_some_and(|v| options.contains(&v)),
            Rule::Enum(options) => {
                let text = value
                    .as_str()
                    .ok_or_else(|| ProcessingError::invalid(path, "expected string"))?;
                if !options.contains(&text) {
                    return self.unknown(
                        DiagnosticCategory::UnknownEnumValue,
                        path,
                        "unrecognised enum value removed",
                    );
                }
                true
            }
            Rule::Nested(kind) => return self.object(value, kind, path),
            Rule::Content if value.is_string() => true,
            Rule::Content => return self.rule(value, Rule::List(Kind::Part), path),
            Rule::List(kind) => {
                let items = value
                    .as_array_mut()
                    .ok_or_else(|| ProcessingError::invalid(path, "expected array"))?;
                let mut retained = Vec::with_capacity(items.len());
                for (index, mut item) in std::mem::take(items).into_iter().enumerate() {
                    if self.object(&mut item, kind, &pointer(path, &index.to_string()))? {
                        retained.push(item);
                    }
                }
                *items = retained;
                true
            }
            Rule::Strings => {
                let items = value
                    .as_array()
                    .ok_or_else(|| ProcessingError::invalid(path, "expected array"))?;
                for (index, item) in items.iter().enumerate() {
                    if !item.is_string() {
                        return Err(ProcessingError::invalid(
                            &pointer(path, &index.to_string()),
                            "expected string",
                        ));
                    }
                }
                true
            }
        };
        if valid {
            Ok(true)
        } else {
            Err(ProcessingError::invalid(path, "malformed known value"))
        }
    }
}
