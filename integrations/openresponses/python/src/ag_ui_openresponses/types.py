"""Type definitions for AG-UI OpenResponses integration."""

from __future__ import annotations

import copy
from dataclasses import dataclass, field, fields
from enum import Enum
from typing import Any, Literal, TypedDict


# ─────────────────────────────────────────────────────────────────────────────
# Provider Types
# ─────────────────────────────────────────────────────────────────────────────


class ProviderType(str, Enum):
    """Supported provider types."""

    OPENAI = "openai"
    AZURE = "azure"
    HUGGINGFACE = "huggingface"
    OPENCLAW = "openclaw"
    CUSTOM = "custom"


# ─────────────────────────────────────────────────────────────────────────────
# Configuration Types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class OpenClawProviderConfig:
    """OpenClaw-specific configuration extensions.

    Attributes:
        agent_id: Agent ID for routing (alternative to model prefix).
                  Maps to x-openclaw-agent-id header.
        session_key: Session key for conversation continuity.
                     Maps to x-openclaw-session-key header.
        use_nested_tool_format: Use the Chat Completions-style nested tool format
                                ({type, function: {name, description, parameters}})
                                instead of the flat OpenResponses format.
                                Defaults to True.
    """

    agent_id: str | None = None
    session_key: str | None = None
    use_nested_tool_format: bool = True


@dataclass
class AzureProviderConfig:
    """Azure OpenAI-specific configuration extensions.

    Attributes:
        api_version: Azure API version (required).
        deployment_name: Azure deployment name.
    """

    api_version: str
    deployment_name: str | None = None


@dataclass
class OpenResponsesAgentConfig:
    """Configuration for an OpenResponses-compatible agent.

    Attributes:
        base_url: Base URL of the OpenResponses-compatible endpoint.
                  Examples:
                  - OpenAI: "https://api.openai.com/v1"
                  - Azure: "https://my-resource.openai.azure.com"
                  - OpenClaw: "http://localhost:18789"
        api_key: API key or bearer token for authentication.
        default_model: Default model identifier. Provider-specific formats:
                       - OpenAI: "gpt-4o", "o3-mini"
                       - Azure: deployment name
                       - OpenClaw: "openclaw:main", "openclaw:work" (agent routing)
        headers: Additional headers to include in all requests.
        timeout_seconds: Request timeout in seconds. Defaults to 120.
        max_retries: Maximum retries on transient failures. Defaults to 3.
        provider: Provider hint for provider-specific behavior.
                  Auto-detected from base_url if not specified.
        openclaw: OpenClaw-specific configuration.
        azure: Azure-specific configuration.
    """

    base_url: str | None = None
    api_key: str | None = None
    default_model: str | None = None
    headers: dict[str, str] | None = None
    timeout_seconds: float = 120.0
    max_retries: int = 3
    provider: ProviderType | None = None
    openclaw: OpenClawProviderConfig | None = None
    azure: AzureProviderConfig | None = None


def merge_runtime_config(
    base: OpenResponsesAgentConfig,
    runtime: dict[str, Any],
) -> OpenResponsesAgentConfig:
    """Merge runtime configuration from forwarded_props into a base config.

    Runtime values override base values. Nested dicts for ``openclaw`` and
    ``azure`` are converted to their respective dataclass types.

    Args:
        base: The static/base configuration.
        runtime: Dictionary of runtime overrides (from ``forwarded_props``).

    Returns:
        A new ``OpenResponsesAgentConfig`` with merged values.
    """
    merged = copy.copy(base)
    field_names = {f.name for f in fields(OpenResponsesAgentConfig)}

    for key, value in runtime.items():
        if key not in field_names:
            continue
        if key == "openclaw" and isinstance(value, dict):
            value = OpenClawProviderConfig(**value)
        elif key == "azure" and isinstance(value, dict):
            value = AzureProviderConfig(**value)
        elif key == "provider" and isinstance(value, str):
            value = ProviderType(value)
        object.__setattr__(merged, key, value)

    return merged


# ─────────────────────────────────────────────────────────────────────────────
# OpenResponses API Types (re-exported from OpenAI SDK)
# ─────────────────────────────────────────────────────────────────────────────

# Import types from OpenAI SDK to avoid duplication
from openai.types.responses import (
    FunctionToolParam,
    ResponseCreateParams,
    ToolParam,
)

# Re-export for convenience
__all_sdk_types__ = ["FunctionToolParam", "ResponseCreateParams", "ToolParam"]


# ─────────────────────────────────────────────────────────────────────────────
# Internal Types - SSE Events
# ─────────────────────────────────────────────────────────────────────────────


class OpenResponsesEventType(str, Enum):
    """OpenResponses SSE event types."""

    RESPONSE_CREATED = "response.created"
    RESPONSE_IN_PROGRESS = "response.in_progress"
    RESPONSE_OUTPUT_ITEM_ADDED = "response.output_item.added"
    RESPONSE_CONTENT_PART_ADDED = "response.content_part.added"
    RESPONSE_OUTPUT_TEXT_DELTA = "response.output_text.delta"
    RESPONSE_OUTPUT_TEXT_DONE = "response.output_text.done"
    RESPONSE_CONTENT_PART_DONE = "response.content_part.done"
    RESPONSE_OUTPUT_ITEM_DONE = "response.output_item.done"
    RESPONSE_FUNCTION_CALL_ARGS_DELTA = "response.function_call_arguments.delta"
    RESPONSE_COMPLETED = "response.completed"
    RESPONSE_FAILED = "response.failed"


@dataclass
class OpenResponsesSSEEvent:
    """Parsed SSE event from OpenResponses stream."""

    type: str
    data: dict[str, Any] = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Tool Call State
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class PendingToolCall:
    """Represents a tool call in progress."""

    id: str
    name: str
    arguments: str = ""


@dataclass
class ToolCallState:
    """State for tracking tool calls during streaming."""

    pending_calls: dict[str, PendingToolCall] = field(default_factory=dict)
    current_call_id: str | None = None
    arguments_buffer: str = ""
