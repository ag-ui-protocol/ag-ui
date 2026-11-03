use super::{MessageId, ToolCallId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// A known RFC 6902 operation. Additional members are retained verbatim.
/// `extra` cannot shadow fields defined by the chosen operation. Unused members
/// (for example `value` on remove) remain legal RFC 6902 extensions.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
#[non_exhaustive]
pub enum JsonPatchOperation {
    Add {
        path: JsonPointer,
        value: Value,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Remove {
        path: JsonPointer,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Replace {
        path: JsonPointer,
        value: Value,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Move {
        from: JsonPointer,
        path: JsonPointer,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Copy {
        from: JsonPointer,
        path: JsonPointer,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    Test {
        path: JsonPointer,
        value: Value,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}
impl Serialize for JsonPatchOperation {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let (op, path, value, from, extra) = match self {
            Self::Add { path, value, extra } => ("add", path, Some(value), None, extra),
            Self::Remove { path, extra } => ("remove", path, None, None, extra),
            Self::Replace { path, value, extra } => ("replace", path, Some(value), None, extra),
            Self::Move { path, from, extra } => ("move", path, None, Some(from), extra),
            Self::Copy { path, from, extra } => ("copy", path, None, Some(from), extra),
            Self::Test { path, value, extra } => ("test", path, Some(value), None, extra),
        };
        if extra.contains_key("op")
            || extra.contains_key("path")
            || (value.is_some() && extra.contains_key("value"))
            || (from.is_some() && extra.contains_key("from"))
        {
            return Err(serde::ser::Error::custom(
                "patch extension shadows a defined operation field",
            ));
        }
        let mut map = serializer.serialize_map(Some(
            2 + usize::from(value.is_some()) + usize::from(from.is_some()) + extra.len(),
        ))?;
        map.serialize_entry("op", op)?;
        map.serialize_entry("path", path)?;
        if let Some(value) = value {
            map.serialize_entry("value", value)?;
        }
        if let Some(from) = from {
            map.serialize_entry("from", from)?;
        }
        for (key, value) in extra {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct JsonPointer(pub String);
impl<'de> Deserialize<'de> for JsonPointer {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if !value.is_empty() && !value.starts_with('/') {
            return Err(serde::de::Error::custom("JSON Pointer must start with /"));
        }
        let bytes = value.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'~' {
                if bytes.get(i + 1) != Some(&b'0') && bytes.get(i + 1) != Some(&b'1') {
                    return Err(serde::de::Error::custom("bad JSON Pointer escape"));
                }
                i += 1;
            }
            i += 1;
        }
        Ok(Self(value))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
#[non_exhaustive]
pub enum PartSource {
    Data {
        value: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    Url {
        value: String,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    File {
        value: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
#[non_exhaustive]
pub enum ContentPart {
    Text {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_value",
            default
        )]
        metadata: Option<Value>,
    },
    Image {
        source: PartSource,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_value",
            default
        )]
        metadata: Option<Value>,
    },
    Audio {
        source: PartSource,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_value",
            default
        )]
        metadata: Option<Value>,
    },
    Video {
        source: PartSource,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_value",
            default
        )]
        metadata: Option<Value>,
    },
    Document {
        source: PartSource,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_value",
            default
        )]
        metadata: Option<Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[non_exhaustive]
pub enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}
impl From<String> for MessageContent {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}
impl MessageContent {
    pub fn as_text(&self) -> Option<&str> {
        if let Self::Text(s) = self {
            Some(s)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
#[non_exhaustive]
pub enum RunFinishedOutcome {
    Success {
        #[serde(
            rename = "pendingToolCallIds",
            skip_serializing_if = "Option::is_none",
            default,
            deserialize_with = "non_null_option"
        )]
        pending_tool_call_ids: Option<Vec<ToolCallId>>,
    },
    Interrupt {
        #[serde(deserialize_with = "nonempty_interrupts")]
        interrupts: Vec<Interrupt>,
    },
    #[serde(deserialize_with = "empty_outcome")]
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
#[non_exhaustive]
pub enum SubagentFinishedOutcome {
    #[serde(deserialize_with = "empty_outcome")]
    Success,
    Suspended {
        #[serde(
            rename = "interruptIds",
            skip_serializing_if = "Option::is_none",
            default,
            deserialize_with = "non_null_option"
        )]
        interrupt_ids: Option<Vec<String>>,
    },
}

fn nonempty_interrupts<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Interrupt>, D::Error> {
    let interrupts = Vec::deserialize(deserializer)?;
    if interrupts.is_empty() {
        return Err(serde::de::Error::custom(
            "interrupt outcome requires interrupts",
        ));
    }
    Ok(interrupts)
}

// Internally tagged unit variants otherwise ignore unknown fields in Serde.
fn empty_outcome<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Empty {}
    Empty::deserialize(deserializer).map(|_| ())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Interrupt {
    pub id: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<ToolCallId>,
    #[serde(rename = "responseSchema", skip_serializing_if = "Option::is_none")]
    pub response_schema: Option<Map<String, Value>>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(rename = "subagentRunId", skip_serializing_if = "Option::is_none")]
    pub subagent_run_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResumeEntry {
    #[serde(rename = "interruptId")]
    pub interrupt_id: String,
    pub status: ResumeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum ResumeStatus {
    Resolved,
    Cancelled,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum ReasoningEncryptedValueSubtype {
    Message,
    ToolCall,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub input_tokens: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub output_tokens: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub total_tokens: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub reasoning_tokens: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub cached_input_tokens: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub cache_write_input_tokens: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubagentInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<IdentityCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<TransportCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<ToolsCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<OutputCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<StateCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multi_agent: Option<MultiAgentCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multimodal: Option<MultimodalCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human_in_the_loop: Option<HumanInTheLoopCapabilities>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option",
        default
    )]
    pub custom: Option<Map<String, Value>>,
}
macro_rules! capability {
    ($name:ident {$($field:ident : $ty:ty),* $(,)?}) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
        #[serde(rename_all="camelCase", deny_unknown_fields)]
        pub struct $name { $(#[serde(skip_serializing_if="Option::is_none", deserialize_with="non_null_option", default)] pub $field: Option<$ty>,)* }
    }
}
capability!(IdentityCapabilities {name:String, r#type:String, description:String, version:String, provider:String, documentation_url:String, metadata:Map<String, Value>});
capability!(TransportCapabilities {
    streaming: bool,
    websocket: bool,
    http_binary: bool,
    push_notifications: bool,
    resumable: bool
});
capability!(ToolsCapabilities {supported:bool, items:Vec<super::Tool>, parallel_calls:bool, client_provided:bool});
capability!(OutputCapabilities {structured_output:bool, supported_mime_types:Vec<String>});
capability!(StateCapabilities {
    snapshots: bool,
    deltas: bool,
    memory: bool,
    persistent_state: bool
});
capability!(MultiAgentCapabilities {supported:bool, delegation:bool, handoffs:bool, subagents:Vec<SubagentInfo>});
capability!(ReasoningCapabilities {
    supported: bool,
    streaming: bool,
    encrypted: bool
});
capability!(MultimodalInputCapabilities {
    image: bool,
    audio: bool,
    video: bool,
    pdf: bool,
    file: bool
});
capability!(MultimodalOutputCapabilities {
    image: bool,
    audio: bool
});
capability!(MultimodalCapabilities {
    input: MultimodalInputCapabilities,
    output: MultimodalOutputCapabilities
});
capability!(HumanInTheLoopCapabilities {
    supported: bool,
    approvals: bool,
    interventions: bool,
    feedback: bool,
    interrupts: bool,
    approve_with_edits: bool
});
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_execution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandboxed: Option<bool>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub max_iterations: Option<u64>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "safe_unsigned",
        serialize_with = "serialize_safe_unsigned",
        default
    )]
    pub max_execution_time: Option<u64>,
}
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

fn serialize_safe_unsigned<S: serde::Serializer>(
    value: &Option<u64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if value.is_some_and(|count| count > MAX_SAFE_JSON_INTEGER) {
        return Err(serde::ser::Error::custom("outside JSON safe integer range"));
    }
    value.serialize(serializer)
}

fn safe_unsigned<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    let n = u64::deserialize(d)?;
    if n > MAX_SAFE_JSON_INTEGER {
        return Err(serde::de::Error::custom("outside JSON safe integer range"));
    }
    Ok(Some(n))
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActivityMessage {
    pub id: MessageId,
    #[serde(rename = "activityType")]
    pub activity_type: String,
    pub content: Map<String, Value>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option",
        default
    )]
    pub metadata: Option<Map<String, Value>>,
    #[serde(
        rename = "subagentRunId",
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option",
        default
    )]
    pub subagent_run_id: Option<String>,
}
pub fn non_null_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    let value = Value::deserialize(d)?;
    if value.is_null() {
        return Err(serde::de::Error::custom("null is not allowed"));
    }
    Ok(Some(value))
}

pub fn non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
