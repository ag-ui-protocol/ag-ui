//! Tool definitions and tool calls.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonObject;
use crate::ids::ToolCallId;

/// A tool the agent may call.
///
/// `parameters` is a JSON Schema object describing the call arguments; it is
/// carried verbatim and never interpreted by this crate.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct Tool {
    /// The name the model uses to call this tool.
    pub name: String,
    /// What the tool does — the model reads this to decide when to call it.
    pub description: String,
    /// JSON Schema for the call arguments.
    #[serde(default)]
    pub parameters: Value,
    /// Arbitrary integration-specific metadata (for example an A2UI schema).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub metadata: Option<JsonObject>,
}

impl Tool {
    /// Builds a tool definition from a name, description and parameter schema.
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: impl Into<Value>,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters: parameters.into(),
            metadata: None,
        }
    }
}

/// Discriminator for the kind of call a [`ToolCall`] represents.
///
/// The protocol currently defines exactly one kind. It is modelled as an enum
/// rather than elided so the literal `"type":"function"` stays on the wire.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum ToolCallKind {
    /// A call to a named function with JSON arguments.
    #[default]
    #[serde(rename = "function")]
    Function,
}

/// The function being invoked, with its arguments.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct FunctionCall {
    /// Name of the tool being called.
    pub name: String,
    /// Arguments as a JSON *string* — not a parsed object.
    ///
    /// Providers stream these incrementally and may emit invalid JSON until the
    /// call is complete, so the protocol keeps them unparsed.
    pub arguments: String,
}

/// One tool invocation requested by the assistant.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ToolCall {
    /// Correlates this call with its `TOOL_CALL_*` events and result message.
    pub id: ToolCallId,
    /// Always [`ToolCallKind::Function`].
    #[serde(rename = "type", default)]
    pub kind: ToolCallKind,
    /// The function and its arguments.
    pub function: FunctionCall,
    /// Opaque provider payload for zero-data-retention reasoning modes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_value: Option<String>,
    /// Extra information, open by key. A tool call is not a message, so it
    /// carries its own rather than folding into the assistant message that
    /// owns it: several calls can share one parent, and merging them all into
    /// it would make the result depend on their relative order. Absent or an
    /// object — a JSON `null` is rejected. See [`crate::metadata`].
    #[serde(
        default,
        deserialize_with = "crate::serde_util::reject_null",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub metadata: Option<JsonObject>,
}

impl ToolCall {
    /// Builds a function tool call.
    pub fn new(
        id: impl Into<ToolCallId>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind: ToolCallKind::Function,
            function: FunctionCall {
                name: name.into(),
                arguments: arguments.into(),
            },
            encrypted_value: None,
            metadata: None,
        }
    }
}
