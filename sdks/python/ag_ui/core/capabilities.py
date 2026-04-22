"""
This module contains the agent capability types for the Agent User Interaction Protocol Python SDK.
"""

from typing import Any, Dict, List, Optional

from pydantic import Field

from .types import ConfiguredBaseModel, Tool


class SubAgentInfo(ConfiguredBaseModel):
    """
    Describes a sub-agent that can be invoked by a parent agent.
    """

    name: str = Field(description="Unique name or identifier of the sub-agent.")
    description: Optional[str] = Field(
        default=None,
        description="What this sub-agent specializes in. Helps clients build agent selection UIs.",
    )


class IdentityCapabilities(ConfiguredBaseModel):
    """
    Basic metadata about the agent.

    Useful for discovery UIs, agent marketplaces, and debugging. Set these when you want clients to display agent
    information or when multiple agents are available and users need to pick one.
    """

    name: Optional[str] = Field(
        default=None,
        description="Human-readable name shown in UIs and agent selectors.",
    )
    type: Optional[str] = Field(
        default=None,
        description='The framework or platform powering this agent (e.g., "langgraph", "mastra", "crewai").',
    )
    description: Optional[str] = Field(
        default=None,
        description="What this agent does — helps users and routing logic decide when to use it.",
    )
    version: Optional[str] = Field(
        default=None,
        description='Semantic version of the agent (e.g., "1.2.0"). Useful for compatibility checks.',
    )
    provider: Optional[str] = Field(
        default=None, description="Organization or team that maintains this agent."
    )
    documentation_url: Optional[str] = Field(
        default=None, description="URL to the agent's documentation or homepage."
    )
    metadata: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Arbitrary key-value pairs for integration-specific identity info.",
    )


class TransportCapabilities(ConfiguredBaseModel):
    """
    Declares which transport mechanisms the agent supports.

    Clients use this to pick the best connection strategy. Only set flags to `True` for transports your agent actually
    handles — omit or set `False` for unsupported ones.
    """

    streaming: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent streams responses via SSE. Most agents enable this.",
    )
    websocket: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent accepts persistent WebSocket connections.",
    )
    http_binary: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent supports the AG-UI binary protocol (protobuf over HTTP).",
    )
    push_notifications: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can send async updates via webhooks after a run finishes.",
    )
    resumable: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent supports resuming interrupted streams via sequence numbers.",
    )


class ToolsCapabilities(ConfiguredBaseModel):
    """
    Tool calling capabilities.

    Distinguishes between tools the agent itself provides (listed in `items`) and tools the client passes at runtime
    via `RunAgentInput.tools`. Enable this when your agent can call functions, search the web, execute code, etc.
    """

    supported: Optional[bool] = Field(
        default=None,
        description=(
            "Set `True` if the agent can make tool calls at all. Set `False` to explicitly signal tool calling is "
            "disabled even if items are present."
        ),
    )
    items: Optional[List[Tool]] = Field(
        default=None,
        description=(
            "The tools this agent provides on its own (full JSON Schema definitions). These are distinct from "
            "client-provided tools passed in `RunAgentInput.tools`."
        ),
    )
    parallel_calls: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can invoke multiple tools concurrently within a single step.",
    )
    client_provided: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent accepts and uses tools provided by the client at runtime.",
    )


class OutputCapabilities(ConfiguredBaseModel):
    """
    Output format support.

    Enable `structured_output` when your agent can return responses conforming to a JSON schema, which is useful for
    programmatic consumption.
    """

    structured_output: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can produce structured JSON output matching a provided schema.",
    )
    supported_mime_types: Optional[List[str]] = Field(
        default=None,
        description=(
            'MIME types the agent can produce (e.g., `["text/plain", "application/json"]`). Omit if the agent only '
            "produces plain text."
        ),
    )


class StateCapabilities(ConfiguredBaseModel):
    """
    State and memory management capabilities.

    These tell the client how the agent handles shared state and whether conversation context persists across runs.
    """

    snapshots: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent emits `STATE_SNAPSHOT` events (full state replacement).",
    )
    deltas: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent emits `STATE_DELTA` events (JSON Patch incremental updates).",
    )
    memory: Optional[bool] = Field(
        default=None,
        description=(
            "Set `True` if the agent has long-term memory beyond the current thread (e.g., vector store, knowledge "
            "base, or cross-session recall)."
        ),
    )
    persistent_state: Optional[bool] = Field(
        default=None,
        description=(
            "Set `True` if state is preserved across multiple runs within the same thread. When `False`, state resets "
            "on each run."
        ),
    )


class MultiAgentCapabilities(ConfiguredBaseModel):
    """
    Multi-agent coordination capabilities.

    Enable these when your agent can orchestrate or hand off work to other agents.
    """

    supported: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent participates in any form of multi-agent coordination.",
    )
    delegation: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can delegate subtasks to other agents while retaining control.",
    )
    handoffs: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can transfer the conversation entirely to another agent.",
    )
    sub_agents: Optional[List[SubAgentInfo]] = Field(
        default=None,
        description="List of sub-agents this agent can invoke. Helps clients build agent selection UIs.",
    )


class ReasoningCapabilities(ConfiguredBaseModel):
    """
    Reasoning and thinking capabilities.

    Enable these when your agent exposes its internal thought process (e.g., chain-of-thought, extended thinking).
    """

    supported: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent produces reasoning/thinking tokens visible to the client.",
    )
    streaming: Optional[bool] = Field(
        default=None,
        description="Set `True` if reasoning tokens are streamed incrementally (vs. returned all at once).",
    )
    encrypted: Optional[bool] = Field(
        default=None,
        description=(
            "Set `True` if reasoning content is encrypted (zero-data-retention mode). Clients should expect opaque "
            "`encrypted_value` fields instead of readable content."
        ),
    )


class MultimodalInputCapabilities(ConfiguredBaseModel):
    """
    Modalities the agent can accept as input.

    Clients use this to show/hide file upload buttons, audio recorders, image pickers, etc.
    """

    image: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can process image inputs (e.g., screenshots, photos).",
    )
    audio: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can process audio inputs (speech, recordings).",
    )
    video: Optional[bool] = Field(
        default=None, description="Set `True` if the agent can process video inputs."
    )
    pdf: Optional[bool] = Field(
        default=None, description="Set `True` if the agent can process PDF documents."
    )
    file: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can process arbitrary file uploads.",
    )


class MultimodalOutputCapabilities(ConfiguredBaseModel):
    """
    Modalities the agent can produce as output.

    Clients use this to anticipate rich content in the agent's response.
    """

    image: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can generate images as part of its response.",
    )
    audio: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can produce audio output (text-to-speech, audio files).",
    )


class MultimodalCapabilities(ConfiguredBaseModel):
    """
    Multimodal input and output support.

    Organized into `input` and `output` sub-objects so clients can independently query what the agent accepts versus
    what it produces.
    """

    input: Optional[MultimodalInputCapabilities] = Field(
        default=None,
        description="Modalities the agent can accept as input (images, audio, video, PDFs, files).",
    )
    output: Optional[MultimodalOutputCapabilities] = Field(
        default=None,
        description="Modalities the agent can produce as output (images, audio).",
    )


class ExecutionCapabilities(ConfiguredBaseModel):
    """
    Execution control and limits.

    Declare these so clients can set expectations about how long or how many steps an agent run might take.
    """

    code_execution: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent can execute code (e.g., Python, JavaScript) during a run.",
    )
    sandboxed: Optional[bool] = Field(
        default=None,
        description=(
            "Set `True` if code execution happens in a sandboxed/isolated environment. Only meaningful when "
            "`code_execution` is `True`."
        ),
    )
    max_iterations: Optional[int] = Field(
        default=None,
        description=(
            "Maximum number of tool-call/reasoning iterations the agent will perform per run. Helps clients display "
            "progress or set timeout expectations."
        ),
    )
    max_execution_time: Optional[int] = Field(
        default=None,
        description="Maximum wall-clock time (in milliseconds) the agent will run before timing out.",
    )


class HumanInTheLoopCapabilities(ConfiguredBaseModel):
    """
    Human-in-the-loop interaction support.

    Enable these when your agent can pause execution to request human input, approval, or feedback before continuing.
    """

    supported: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent supports any form of human-in-the-loop interaction.",
    )
    approvals: Optional[bool] = Field(
        default=None,
        description=(
            "Set `True` if the agent can pause and request explicit approval before performing sensitive actions "
            "(e.g., sending emails, deleting data)."
        ),
    )
    interventions: Optional[bool] = Field(
        default=None,
        description="Set `True` if the agent allows humans to intervene and modify its plan mid-execution.",
    )
    feedback: Optional[bool] = Field(
        default=None,
        description=(
            "Set `True` if the agent can incorporate user feedback (thumbs up/down, corrections) to improve its "
            "behavior within the current session."
        ),
    )


class AgentCapabilities(ConfiguredBaseModel):
    """
    A categorized snapshot of an agent's current capabilities.

    All fields are optional — agents only declare what they support. Omitted fields mean the capability is not declared
    (unknown), not that it's unsupported.

    The `custom` field is an escape hatch for integration-specific capabilities that don't fit into the standard
    categories.
    """

    identity: Optional[IdentityCapabilities] = Field(
        default=None, description="Agent identity and metadata."
    )
    transport: Optional[TransportCapabilities] = Field(
        default=None,
        description="Supported transport mechanisms (SSE, WebSocket, binary, etc.).",
    )
    tools: Optional[ToolsCapabilities] = Field(
        default=None,
        description="Tools the agent provides and tool calling configuration.",
    )
    output: Optional[OutputCapabilities] = Field(
        default=None,
        description="Output format support (structured output, MIME types).",
    )
    state: Optional[StateCapabilities] = Field(
        default=None,
        description="State and memory management (snapshots, deltas, persistence).",
    )
    multi_agent: Optional[MultiAgentCapabilities] = Field(
        default=None,
        description="Multi-agent coordination (delegation, handoffs, sub-agents).",
    )
    reasoning: Optional[ReasoningCapabilities] = Field(
        default=None,
        description="Reasoning and thinking support (chain-of-thought, encrypted thinking).",
    )
    multimodal: Optional[MultimodalCapabilities] = Field(
        default=None,
        description="Multimodal input/output support (images, audio, video, files).",
    )
    execution: Optional[ExecutionCapabilities] = Field(
        default=None,
        description="Execution control and limits (code execution, timeouts, iteration caps).",
    )
    human_in_the_loop: Optional[HumanInTheLoopCapabilities] = Field(
        default=None,
        description="Human-in-the-loop support (approvals, interventions, feedback).",
    )
    custom: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Integration-specific capabilities not covered by the standard categories.",
    )
