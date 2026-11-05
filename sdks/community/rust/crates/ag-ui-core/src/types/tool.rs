use crate::types::ids::ToolCallId;
use crate::types::message::FunctionCall;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolCall {
    pub id: ToolCallId,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<serde_json::Map<String, JsonValue>>,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
}

impl ToolCall {
    pub fn new(id: impl Into<ToolCallId>, function: FunctionCall) -> Self {
        Self {
            id: id.into(),
            call_type: "function".to_string(),
            function,
            metadata: None,
            encrypted_value: None,
        }
    }
}

/// A tool definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Tool {
    /// The tool name
    pub name: String,
    /// The tool description
    pub description: String,
    /// The tool parameters
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

impl Tool {
    pub fn new(name: String, description: String, parameters: JsonValue) -> Self {
        Self {
            name,
            description,
            parameters: Some(parameters),
            metadata: None,
        }
    }
}
