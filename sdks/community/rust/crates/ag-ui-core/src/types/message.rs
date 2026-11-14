use crate::types::MessageContent;
use crate::types::ids::{MessageId, ToolCallId};
use crate::types::tool::ToolCall;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A generated function call from a model
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct FunctionCall {
    pub name: String,
    // TODO: More suitable to use JsonValue here?
    pub arguments: String,
}

/// Message role.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum Role {
    Developer,
    System,
    Assistant,
    User,
    Tool,
    Activity,
    Reasoning,
}

// Utility methods for serde defaults
impl Role {
    pub(crate) fn developer() -> Self {
        Self::Developer
    }
    pub(crate) fn system() -> Self {
        Self::System
    }
    pub(crate) fn assistant() -> Self {
        Self::Assistant
    }
    pub(crate) fn user() -> Self {
        Self::User
    }
    pub(crate) fn tool() -> Self {
        Self::Tool
    }
    pub(crate) fn reasoning() -> Self {
        Self::Reasoning
    }
}

/// A basic message, where the only content should be an optional string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct BaseMessage {
    pub id: MessageId,
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

/// A developer message.
/// Typically for debugging - not to be confused with system messages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct DeveloperMessage {
    pub id: MessageId,
    #[serde(default = "Role::developer")]
    pub role: Role, // Always Role::Developer
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

impl DeveloperMessage {
    pub fn new(id: impl Into<MessageId>, content: String) -> Self {
        Self {
            id: id.into(),
            role: Role::Developer,
            content,
            name: None,
            metadata: None,
            encrypted_value: None,
            subagent_run_id: None,
        }
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

/// A system message. This is usually where the system prompt goes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SystemMessage {
    pub id: MessageId,
    #[serde(default = "Role::system")]
    pub role: Role, // Always Role::System
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

impl SystemMessage {
    pub fn new(id: impl Into<MessageId>, content: String) -> Self {
        Self {
            id: id.into(),
            role: Role::System,
            content,
            name: None,
            metadata: None,
            encrypted_value: None,
            subagent_run_id: None,
        }
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

/// An assistant message (ie, from the model).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct AssistantMessage {
    pub id: MessageId,
    #[serde(default = "Role::assistant")]
    pub role: Role, // Always Role::Assistant
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "toolCalls", skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

impl AssistantMessage {
    pub fn new(id: impl Into<MessageId>) -> Self {
        Self {
            id: id.into(),
            role: Role::Assistant,
            content: None,
            name: None,
            tool_calls: None,
            metadata: None,
            encrypted_value: None,
            subagent_run_id: None,
        }
    }

    pub fn with_content(mut self, content: String) -> Self {
        self.content = Some(content);
        self
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }

    pub fn with_tool_calls(mut self, tool_calls: Vec<ToolCall>) -> Self {
        self.tool_calls = Some(tool_calls);
        self
    }
}

/// A user message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct UserMessage {
    pub id: MessageId,
    #[serde(default = "Role::user")]
    pub role: Role, // Always Role::User
    pub content: MessageContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

impl UserMessage {
    pub fn new(id: impl Into<MessageId>, content: String) -> Self {
        Self {
            id: id.into(),
            role: Role::User,
            content: content.into(),
            name: None,
            metadata: None,
            encrypted_value: None,
            subagent_run_id: None,
        }
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

/// A tool call result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolMessage {
    pub id: MessageId,
    pub content: MessageContent,
    #[serde(default = "Role::tool")]
    pub role: Role, // Always Role::Tool
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

impl ToolMessage {
    pub fn new(
        id: impl Into<MessageId>,
        content: String,
        tool_call_id: impl Into<ToolCallId>,
    ) -> Self {
        Self {
            id: id.into(),
            content: content.into(),
            role: Role::Tool,
            tool_call_id: tool_call_id.into(),
            error: None,
            metadata: None,
            encrypted_value: None,
            subagent_run_id: None,
        }
    }

    pub fn with_error(mut self, error: String) -> Self {
        self.error = Some(error);
        self
    }
}

/// A materialized reasoning message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ReasoningMessage {
    pub id: MessageId,
    #[serde(default = "Role::reasoning")]
    pub role: Role,
    pub content: String,
    #[serde(
        rename = "encryptedValue",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub encrypted_value: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}

/// Represents the different type of messages that you might receive, but as an enum.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
#[non_exhaustive]
pub enum Message {
    Developer {
        id: MessageId,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        metadata: Option<Map<String, Value>>,
        #[serde(
            rename = "subagentRunId",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        subagent_run_id: Option<String>,
        #[serde(
            rename = "encryptedValue",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        encrypted_value: Option<String>,
    },
    System {
        id: MessageId,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        metadata: Option<Map<String, Value>>,
        #[serde(
            rename = "subagentRunId",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        subagent_run_id: Option<String>,
        #[serde(
            rename = "encryptedValue",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        encrypted_value: Option<String>,
    },
    Assistant {
        id: MessageId,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "toolCalls", skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ToolCall>>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        metadata: Option<Map<String, Value>>,
        #[serde(
            rename = "subagentRunId",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        subagent_run_id: Option<String>,
        #[serde(
            rename = "encryptedValue",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        encrypted_value: Option<String>,
    },
    User {
        id: MessageId,
        content: MessageContent,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        metadata: Option<Map<String, Value>>,
        #[serde(
            rename = "subagentRunId",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        subagent_run_id: Option<String>,
        #[serde(
            rename = "encryptedValue",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        encrypted_value: Option<String>,
    },
    Activity {
        id: MessageId,
        #[serde(rename = "activityType")]
        activity_type: String,
        content: serde_json::Map<String, serde_json::Value>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        metadata: Option<Map<String, Value>>,
        #[serde(
            rename = "subagentRunId",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        subagent_run_id: Option<String>,
    },
    Reasoning {
        id: MessageId,
        content: String,
        #[serde(
            rename = "encryptedValue",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        encrypted_value: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        metadata: Option<Map<String, Value>>,
        #[serde(
            rename = "subagentRunId",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        subagent_run_id: Option<String>,
    },
    Tool {
        id: MessageId,
        content: MessageContent,
        #[serde(rename = "toolCallId")]
        tool_call_id: ToolCallId,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        metadata: Option<Map<String, Value>>,
        #[serde(
            rename = "subagentRunId",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        subagent_run_id: Option<String>,
        #[serde(
            rename = "encryptedValue",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "super::non_null_option",
            default
        )]
        encrypted_value: Option<String>,
    },
}

impl Message {
    pub fn new<S: AsRef<str>>(role: Role, id: impl Into<MessageId>, content: S) -> Self {
        match role {
            Role::Developer => Self::Developer {
                id: id.into(),
                content: content.as_ref().to_string(),
                name: None,
                metadata: None,
                subagent_run_id: None,
                encrypted_value: None,
            },
            Role::System => Self::System {
                id: id.into(),
                content: content.as_ref().to_string(),
                name: None,
                metadata: None,
                subagent_run_id: None,
                encrypted_value: None,
            },
            Role::Assistant => Self::Assistant {
                id: id.into(),
                content: Some(content.as_ref().to_string()),
                name: None,
                tool_calls: None,
                metadata: None,
                subagent_run_id: None,
                encrypted_value: None,
            },
            Role::User => Self::User {
                id: id.into(),
                content: content.as_ref().to_string().into(),
                name: None,
                metadata: None,
                subagent_run_id: None,
                encrypted_value: None,
            },
            Role::Activity => Self::Activity {
                id: id.into(),
                activity_type: String::new(),
                content: serde_json::Map::new(),
                metadata: None,
                subagent_run_id: None,
            },
            Role::Reasoning => Self::Reasoning {
                id: id.into(),
                content: content.as_ref().to_string(),
                encrypted_value: None,
                metadata: None,
                subagent_run_id: None,
            },
            Role::Tool => Self::Tool {
                id: id.into(),
                content: content.as_ref().to_string().into(),
                tool_call_id: ToolCallId::random(),
                error: None,
                metadata: None,
                subagent_run_id: None,
                encrypted_value: None,
            },
        }
    }

    /// Returns a User message with a random ID and the given content
    pub fn new_user<S: AsRef<str>>(content: S) -> Self {
        Self::new(Role::User, MessageId::random(), content)
    }

    /// Returns a Tool message with a random ID and the given content
    pub fn new_tool<S: AsRef<str>>(content: S) -> Self {
        Self::new(Role::Tool, MessageId::random(), content)
    }

    /// Returns a System message with a random ID and the given content
    pub fn new_system<S: AsRef<str>>(content: S) -> Self {
        Self::new(Role::System, MessageId::random(), content)
    }

    /// Returns an Assistant message with a random ID and the given content
    pub fn new_assistant<S: AsRef<str>>(content: S) -> Self {
        Self::new(Role::Assistant, MessageId::random(), content)
    }

    /// Returns a Developer message with a random ID and the given content
    pub fn new_developer<S: AsRef<str>>(content: S) -> Self {
        Self::new(Role::Developer, MessageId::random(), content)
    }

    /// The subagent that owns this message, if any.
    pub fn subagent_run_id(&self) -> Option<&String> {
        match self {
            Message::Developer {
                subagent_run_id, ..
            }
            | Message::System {
                subagent_run_id, ..
            }
            | Message::Assistant {
                subagent_run_id, ..
            }
            | Message::User {
                subagent_run_id, ..
            }
            | Message::Activity {
                subagent_run_id, ..
            }
            | Message::Reasoning {
                subagent_run_id, ..
            }
            | Message::Tool {
                subagent_run_id, ..
            } => subagent_run_id.as_ref(),
        }
    }

    pub fn id(&self) -> &MessageId {
        match self {
            Message::Developer { id, .. } => id,
            Message::System { id, .. } => id,
            Message::Assistant { id, .. } => id,
            Message::User { id, .. } => id,
            Message::Tool { id, .. } => id,
            Message::Activity { id, .. } => id,
            Message::Reasoning { id, .. } => id,
        }
    }

    pub fn id_mut(&mut self) -> &mut MessageId {
        match self {
            Message::Developer { id, .. } => id,
            Message::System { id, .. } => id,
            Message::Assistant { id, .. } => id,
            Message::User { id, .. } => id,
            Message::Tool { id, .. } => id,
            Message::Activity { id, .. } => id,
            Message::Reasoning { id, .. } => id,
        }
    }

    pub fn role(&self) -> Role {
        match self {
            Message::Developer { .. } => Role::Developer,
            Message::System { .. } => Role::System,
            Message::Assistant { .. } => Role::Assistant,
            Message::User { .. } => Role::User,
            Message::Tool { .. } => Role::Tool,
            Message::Activity { .. } => Role::Activity,
            Message::Reasoning { .. } => Role::Reasoning,
        }
    }
    pub fn content(&self) -> Option<&str> {
        match self {
            Message::Developer { content, .. } => Some(content),
            Message::System { content, .. } => Some(content),
            Message::User { content, .. } => content.as_text(),
            Message::Tool { content, .. } => content.as_text(),
            Message::Reasoning { content, .. } => Some(content),
            Message::Activity { .. } => None,
            Message::Assistant { content, .. } => content.as_deref(),
        }
    }

    pub fn content_mut(&mut self) -> Option<&mut String> {
        match self {
            Message::Developer { content, .. }
            | Message::System { content, .. }
            | Message::Reasoning { content, .. } => Some(content),
            Message::Tool { content, .. } => {
                if let MessageContent::Text(text) = content {
                    Some(text)
                } else {
                    None
                }
            }
            Message::User { content, .. } => {
                if let MessageContent::Text(text) = content {
                    Some(text)
                } else {
                    None
                }
            }
            Message::Activity { .. } => None,
            Message::Assistant { content, .. } => {
                if content.is_none() {
                    *content = Some(String::new());
                }
                content.as_mut()
            }
        }
    }

    pub fn tool_calls(&self) -> Option<&[ToolCall]> {
        match self {
            Message::Assistant { tool_calls, .. } => tool_calls.as_deref(),
            _ => None,
        }
    }

    pub fn tool_calls_mut(&mut self) -> Option<&mut Vec<ToolCall>> {
        match self {
            Message::Assistant { tool_calls, .. } => {
                if tool_calls.is_none() {
                    *tool_calls = Some(Vec::new());
                }
                tool_calls.as_mut()
            }
            _ => None,
        }
    }
}

impl FunctionCall {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(name: String, arguments: String) -> Self {
        Self { name, arguments }
    }
}

impl BaseMessage {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(id: impl Into<MessageId>, role: Role) -> Self {
        Self {
            id: id.into(),
            role,
            content: None,
            name: None,
            metadata: None,
            encrypted_value: None,
            subagent_run_id: None,
        }
    }
}

impl ReasoningMessage {
    /// Creates a value with the required fields and no optional extensions.
    pub fn new(id: impl Into<MessageId>, content: String) -> Self {
        Self {
            id: id.into(),
            role: Role::Reasoning,
            content,
            encrypted_value: None,
            metadata: None,
            subagent_run_id: None,
        }
    }
}
