use crate::types::ids::{MessageId, ToolCallId};
use crate::types::tool::ToolCall;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    // TODO: More suitable to use JsonValue here?
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Developer,
    System,
    Assistant,
    User,
    Tool,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BaseMessage {
    pub id: MessageId,
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeveloperMessage {
    pub id: MessageId,
    #[serde(default = "Role::developer")]
    pub role: Role, // Always Role::Developer
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl DeveloperMessage {
    pub fn new(id: impl Into<MessageId>, content: String) -> Self {
        Self {
            id: id.into(),
            role: Role::Developer,
            content,
            name: None,
        }
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemMessage {
    pub id: MessageId,
    #[serde(default = "Role::system")]
    pub role: Role, // Always Role::System
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl SystemMessage {
    pub fn new(id: impl Into<MessageId>, content: String) -> Self {
        Self {
            id: id.into(),
            role: Role::System,
            content,
            name: None,
        }
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
}

impl AssistantMessage {
    pub fn new(id: impl Into<MessageId>) -> Self {
        Self {
            id: id.into(),
            role: Role::Assistant,
            content: None,
            name: None,
            tool_calls: None,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    pub id: MessageId,
    #[serde(default = "Role::user")]
    pub role: Role, // Always Role::User
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl UserMessage {
    pub fn new(id: impl Into<MessageId>, content: String) -> Self {
        Self {
            id: id.into(),
            role: Role::User,
            content,
            name: None,
        }
    }

    pub fn with_name(mut self, name: String) -> Self {
        self.name = Some(name);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolMessage {
    pub id: MessageId,
    pub content: String,
    #[serde(default = "Role::tool")]
    pub role: Role, // Always Role::Tool
    #[serde(rename = "toolCallId")]
    pub tool_call_id: ToolCallId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolMessage {
    pub fn new(
        id: impl Into<MessageId>,
        content: String,
        tool_call_id: impl Into<ToolCallId>,
    ) -> Self {
        Self {
            id: id.into(),
            content,
            role: Role::Tool,
            tool_call_id: tool_call_id.into(),
            error: None,
        }
    }

    pub fn with_error(mut self, error: String) -> Self {
        self.error = Some(error);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum Message {
    Developer {
        id: MessageId,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    System {
        id: MessageId,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Assistant {
        id: MessageId,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "toolCalls", skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ToolCall>>,
    },
    User {
        id: MessageId,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Tool {
        id: MessageId,
        content: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: ToolCallId,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl Message {
    pub fn new(role: Role, id: impl Into<MessageId>, content: String) -> Self {
        match role {
            Role::Developer => Self::Developer {
                id: id.into(),
                content,
                name: None,
            },
            Role::System => Self::System {
                id: id.into(),
                content,
                name: None,
            },
            Role::Assistant => Self::Assistant {
                id: id.into(),
                content: None,
                name: None,
                tool_calls: None,
            },
            Role::User => Self::User {
                id: id.into(),
                content,
                name: None,
            },
            Role::Tool => Self::Tool {
                id: id.into(),
                content,
                tool_call_id: ToolCallId::random(),
                error: None,
            },
        }
    }
    pub fn id(&self) -> &MessageId {
        match self {
            Message::Developer { id, .. } => id,
            Message::System { id, .. } => id,
            Message::Assistant { id, .. } => id,
            Message::User { id, .. } => id,
            Message::Tool { id, .. } => id,
        }
    }

    pub fn id_mut(&mut self) -> &mut MessageId {
        match self {
            Message::Developer { id, .. } => id,
            Message::System { id, .. } => id,
            Message::Assistant { id, .. } => id,
            Message::User { id, .. } => id,
            Message::Tool { id, .. } => id,
        }
    }

    pub fn role(&self) -> Role {
        match self {
            Message::Developer { .. } => Role::Developer,
            Message::System { .. } => Role::System,
            Message::Assistant { .. } => Role::Assistant,
            Message::User { .. } => Role::User,
            Message::Tool { .. } => Role::Tool,
        }
    }
    pub fn content(&self) -> Option<&str> {
        match self {
            Message::Developer { content, .. } => Some(content),
            Message::System { content, .. } => Some(content),
            Message::User { content, .. } => Some(content),
            Message::Tool { content, .. } => Some(content),
            Message::Assistant { content, .. } => content.as_deref(),
        }
    }

    pub fn content_mut(&mut self) -> Option<&mut String> {
        match self {
            Message::Developer { content, .. }
            | Message::System { content, .. }
            | Message::User { content, .. }
            | Message::Tool { content, .. } => Some(content),
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
