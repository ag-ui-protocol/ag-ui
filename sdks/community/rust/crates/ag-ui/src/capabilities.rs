//! What an agent can do — a categorized snapshot for discovery UIs, routing,
//! and debugging.
//!
//! Every field is optional and omission means *not declared*, which is not the
//! same as *unsupported*. Agents fill in only what they mean to advertise.

use serde::{Deserialize, Serialize};

use crate::JsonObject;
use crate::tool::Tool;

/// A sub-agent a parent agent can invoke.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct SubAgentInfo {
    /// Unique name or identifier of the sub-agent.
    pub name: String,
    /// What this sub-agent specializes in. Helps clients build selection UIs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Agent identity and metadata.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct IdentityCapabilities {
    /// Human-readable name shown in UIs and agent selectors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The framework powering this agent, for example `"langgraph"`.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// What this agent does — helps users and routing logic pick it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Semantic version of the agent, for compatibility checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Organization or team that maintains this agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// URL of the agent's documentation or homepage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documentation_url: Option<String>,
    /// Integration-specific identity extras.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub metadata: Option<JsonObject>,
}

/// Transports the agent speaks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct TransportCapabilities {
    /// The agent streams responses over SSE. Most agents set this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    /// The agent accepts persistent WebSocket connections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket: Option<bool>,
    /// The agent supports the AG-UI binary protocol (protobuf over HTTP).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_binary: Option<bool>,
    /// The agent can push async updates via webhooks after a run finishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_notifications: Option<bool>,
    /// The agent supports resuming interrupted streams via sequence numbers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resumable: Option<bool>,
}

/// Tool-calling support, and the tools the agent brings itself.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ToolsCapabilities {
    /// The agent can make tool calls at all. `Some(false)` disables tool
    /// calling explicitly even when `items` is populated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    /// Tools the agent provides on its own, distinct from the client-provided
    /// tools in [`RunAgentInput::tools`](crate::input::RunAgentInput::tools).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<Tool>>,
    /// The agent can invoke several tools concurrently within one step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parallel_calls: Option<bool>,
    /// The agent uses tools the client passes at runtime.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_provided: Option<bool>,
}

/// Output formats the agent can produce.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct OutputCapabilities {
    /// The agent can return JSON matching a supplied schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_output: Option<bool>,
    /// MIME types the agent can produce. Omit when it only produces plain text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_mime_types: Option<Vec<String>>,
}

/// State and memory handling.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct StateCapabilities {
    /// The agent emits `STATE_SNAPSHOT` events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshots: Option<bool>,
    /// The agent emits `STATE_DELTA` events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deltas: Option<bool>,
    /// The agent has long-term memory beyond the current thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<bool>,
    /// State survives across runs within a thread. When `Some(false)`, state
    /// resets each run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistent_state: Option<bool>,
}

/// Multi-agent coordination.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct MultiAgentCapabilities {
    /// The agent takes part in multi-agent coordination at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    /// The agent delegates subtasks while retaining control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<bool>,
    /// The agent can hand the conversation over entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoffs: Option<bool>,
    /// Sub-agents this agent can invoke.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_agents: Option<Vec<SubAgentInfo>>,
}

/// Visibility into the agent's reasoning.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ReasoningCapabilities {
    /// The agent produces reasoning visible to the client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    /// Reasoning is streamed incrementally rather than delivered at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    /// Reasoning is encrypted (zero-data-retention). Clients should expect
    /// opaque `encryptedValue` fields instead of readable content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<bool>,
}

/// Modalities the agent accepts as input.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct MultimodalInputCapabilities {
    /// Images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<bool>,
    /// Audio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<bool>,
    /// Video.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<bool>,
    /// PDF documents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<bool>,
    /// Arbitrary file uploads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<bool>,
}

/// Modalities the agent can produce.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct MultimodalOutputCapabilities {
    /// The agent can generate images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<bool>,
    /// The agent can produce audio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<bool>,
}

/// Multimodal input and output support, split so clients can query each side
/// independently.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct MultimodalCapabilities {
    /// What the agent accepts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<MultimodalInputCapabilities>,
    /// What the agent produces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<MultimodalOutputCapabilities>,
}

/// Execution controls and limits.
///
/// The two caps are integers, not floats. The upstream Zod schema types them as
/// a bare `z.number()`, which is a JavaScript double — but the Python SDK
/// declares them `Optional[int]`, and both an iteration count and a millisecond
/// budget are whole numbers everywhere they are produced. Modelling them as
/// `f64` would re-emit a received `"maxIterations": 10` as `10.0`, so a Rust
/// proxy between two upstream implementations would silently rewrite the
/// payload. They are signed because Python's `int` is: some frameworks spell
/// "no limit" as `-1`, and rejecting that at parse time would fail the whole
/// capabilities document over a value the reference implementations accept.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct ExecutionCapabilities {
    /// The agent can execute code during a run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_execution: Option<bool>,
    /// Code execution is sandboxed. Only meaningful with `code_execution`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandboxed: Option<bool>,
    /// Cap on tool-call / reasoning iterations per run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<i64>,
    /// Wall-clock cap per run, in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_execution_time: Option<i64>,
}

/// Human-in-the-loop support.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct HumanInTheLoopCapabilities {
    /// The agent supports human-in-the-loop interaction at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported: Option<bool>,
    /// The agent pauses for explicit approval before sensitive actions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals: Option<bool>,
    /// Humans can modify the agent's plan mid-execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interventions: Option<bool>,
    /// The agent incorporates user feedback within a thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<bool>,
    /// The agent speaks the interrupt protocol: it emits `RUN_FINISHED` with
    /// [`RunOutcome::Interrupt`](crate::outcome::RunOutcome::Interrupt) and
    /// accepts `resume` entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interrupts: Option<bool>,
    /// Tool-call interrupts accept `editedArgs` in the resume payload. Only
    /// meaningful with `interrupts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approve_with_edits: Option<bool>,
}

/// A typed, categorized snapshot of what an agent supports.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "schemars", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct AgentCapabilities {
    /// Identity and metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<IdentityCapabilities>,
    /// Supported transports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<TransportCapabilities>,
    /// Tool calling and agent-provided tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<ToolsCapabilities>,
    /// Output formats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<OutputCapabilities>,
    /// State and memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<StateCapabilities>,
    /// Multi-agent coordination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_agent: Option<MultiAgentCapabilities>,
    /// Reasoning visibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningCapabilities>,
    /// Multimodal input and output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multimodal: Option<MultimodalCapabilities>,
    /// Execution controls and limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionCapabilities>,
    /// Human-in-the-loop support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human_in_the_loop: Option<HumanInTheLoopCapabilities>,
    /// Escape hatch for capabilities the standard categories do not cover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "schemars",
        schemars(with = "Option<std::collections::BTreeMap<String, serde_json::Value>>")
    )]
    #[cfg_attr(feature = "utoipa", schema(value_type = Option<Object>))]
    pub custom: Option<JsonObject>,
}
