"""Builds OpenResponses API requests from AG-UI input."""

from __future__ import annotations

import json
import logging
from typing import Any

from ag_ui.core import Message, RunAgentInput, Tool
from openai.types.responses import FunctionToolParam, ResponseCreateParams

from ..types import (
    OpenResponsesAgentConfig,
    ProviderType,
)

logger = logging.getLogger(__name__)


class RequestBuilder:
    """Builds OpenResponses API requests from AG-UI RunAgentInput."""

    def __init__(self, config: OpenResponsesAgentConfig) -> None:
        """Initialize with configuration.

        Args:
            config: Agent configuration.
        """
        self._config = config

    def build(self, input_data: RunAgentInput) -> dict[str, Any]:
        """Build an OpenResponses request from AG-UI input.

        Args:
            input_data: The AG-UI input data.

        Returns:
            OpenResponses request body as dict (compatible with ResponseCreateParams).
        """
        messages = list(input_data.messages) if input_data.messages else []
        tools = list(input_data.tools) if input_data.tools else []
        state = input_data.state if hasattr(input_data, "state") else {}
        if state is None:
            state = {}

        # Check for previous_response_id in state for stateful mode
        openresponses_state = state.get("openresponses_state", {}) if isinstance(state, dict) else {}
        previous_response_id = openresponses_state.get("response_id")

        request: dict[str, Any] = {
            "model": self._resolve_model(input_data),
            "stream": True,
        }

        # Build input - if we have previous_response_id, only send new messages
        if previous_response_id:
            request["previous_response_id"] = previous_response_id
            # Only send the latest user message when using stateful mode
            new_messages = self._get_new_messages(messages)
            if new_messages:
                request["input"] = self._translate_messages(new_messages)
        else:
            # Send full message history
            request["input"] = self._translate_messages(messages)

        # Add optional fields
        instructions = self._build_instructions(messages, input_data)
        if instructions:
            request["instructions"] = instructions

        translated_tools = self._translate_tools(tools)
        if translated_tools:
            request["tools"] = translated_tools

        # Check for max_tokens in context or forwarded_props
        max_tokens = self._get_max_tokens(input_data)
        if max_tokens:
            request["max_output_tokens"] = max_tokens

        return request

    def _resolve_model(self, input_data: RunAgentInput) -> str:
        """Resolve the model to use for this request.

        Args:
            input_data: The AG-UI input data.

        Returns:
            Model identifier string.
        """
        # Check for model in forwarded_props
        forwarded = input_data.forwarded_props if hasattr(input_data, "forwarded_props") else None
        if forwarded and isinstance(forwarded, dict) and "model" in forwarded:
            return str(forwarded["model"])

        # Check for OpenClaw agent routing in forwarded_props
        if (
            forwarded
            and isinstance(forwarded, dict)
            and "agent_id" in forwarded
            and self._config.provider == ProviderType.OPENCLAW
        ):
            return f"openclaw:{forwarded['agent_id']}"

        # Use default model from config
        return self._config.default_model or "gpt-4o"

    def _get_new_messages(self, messages: list[Message]) -> list[Message]:
        """Get only new messages for stateful mode.

        When using previous_response_id, we only need to send messages
        that came after the last assistant response.

        Args:
            messages: Full message list.

        Returns:
            New messages to send.
        """
        # Find the last assistant message and return everything after
        last_assistant_idx = -1
        for i, msg in enumerate(messages):
            if msg.role == "assistant":
                last_assistant_idx = i

        if last_assistant_idx >= 0:
            return messages[last_assistant_idx + 1 :]

        # No assistant messages yet, send the last user message
        for msg in reversed(messages):
            if msg.role == "user":
                return [msg]

        return messages

    def _translate_messages(self, messages: list[Message]) -> list[dict[str, Any]]:
        """Translate AG-UI messages to OpenResponses items.

        Args:
            messages: List of AG-UI messages.

        Returns:
            List of OpenResponses item parameters.
        """
        items: list[dict[str, Any]] = []

        for message in messages:
            role = message.role

            # Skip system messages - they go to instructions
            if role in ("system", "developer"):
                continue

            if role == "tool":
                # Tool results become function_call_output items
                tool_call_id = getattr(message, "tool_call_id", "") or ""
                content = message.content
                output = content if isinstance(content, str) else json.dumps(content)
                items.append({
                    "type": "function_call_output",
                    "call_id": tool_call_id,
                    "output": output,
                })
            else:
                # Regular messages (user, assistant)
                items.append({
                    "type": "message",
                    "role": self._map_role(role),
                    "content": self._translate_content(message.content),
                })

        return items

    def _map_role(self, role: str) -> str:
        """Map AG-UI role to OpenResponses role.

        Args:
            role: AG-UI role string.

        Returns:
            OpenResponses role string.
        """
        role_map = {
            "system": "system",
            "developer": "developer",
            "assistant": "assistant",
        }
        return role_map.get(role, "user")

    def _translate_content(self, content: Any) -> str | list[dict[str, Any]]:
        """Translate message content to OpenResponses format.

        Args:
            content: Message content (string or multimodal parts).

        Returns:
            String content or list of content parts.
        """
        if isinstance(content, str):
            return content

        if not isinstance(content, list):
            return str(content)

        # Handle multimodal content
        parts: list[dict[str, Any]] = []
        for part in content:
            if isinstance(part, str):
                parts.append({"type": "input_text", "text": part})
            elif isinstance(part, dict):
                translated = self._translate_content_part(part)
                if translated:
                    parts.append(translated)
            elif hasattr(part, "type"):
                # Pydantic model
                translated = self._translate_content_part_model(part)
                if translated:
                    parts.append(translated)

        return parts if parts else ""

    def _translate_content_part(self, part: dict[str, Any]) -> dict[str, Any] | None:
        """Translate a single content part dict.

        Args:
            part: Content part dictionary.

        Returns:
            Translated content part or None.
        """
        part_type = part.get("type", "")

        if part_type == "text":
            return {"type": "input_text", "text": part.get("text", "")}

        if part_type == "binary":
            mime_type = part.get("mime_type", "")
            is_image = mime_type.startswith("image/")

            source: dict[str, Any] = {"media_type": mime_type}
            if part.get("url"):
                source["type"] = "url"
                source["url"] = part["url"]
            elif part.get("data"):
                source["type"] = "base64"
                source["data"] = part["data"]

            if is_image:
                return {"type": "input_image", "source": source}
            else:
                if part.get("filename"):
                    source["filename"] = part["filename"]
                return {"type": "input_file", "source": source}

        return None

    def _translate_content_part_model(self, part: Any) -> dict[str, Any] | None:
        """Translate a Pydantic content part model.

        Args:
            part: Content part Pydantic model.

        Returns:
            Translated content part or None.
        """
        part_type = getattr(part, "type", "")

        if part_type == "text":
            return {"type": "input_text", "text": getattr(part, "text", "")}

        if part_type == "binary":
            mime_type = getattr(part, "mime_type", "")
            is_image = mime_type.startswith("image/")

            source: dict[str, Any] = {"media_type": mime_type}
            if getattr(part, "url", None):
                source["type"] = "url"
                source["url"] = part.url
            elif getattr(part, "data", None):
                source["type"] = "base64"
                source["data"] = part.data

            if is_image:
                return {"type": "input_image", "source": source}
            else:
                if getattr(part, "filename", None):
                    source["filename"] = part.filename
                return {"type": "input_file", "source": source}

        return None

    def _build_instructions(
        self, messages: list[Message], input_data: RunAgentInput
    ) -> str | None:
        """Build instructions from system messages and context.

        Args:
            messages: List of AG-UI messages.
            input_data: Full input data.

        Returns:
            Combined instructions string, or None.
        """
        # Collect system/developer messages
        system_messages = []
        for msg in messages:
            if msg.role in ("system", "developer"):
                content = msg.content
                if isinstance(content, str) and content:
                    system_messages.append(content)

        system_text = "\n\n".join(system_messages) if system_messages else ""

        # Check for additional instructions in context
        context_instructions = ""
        if input_data.context:
            for ctx in input_data.context:
                if hasattr(ctx, "description") and "instruction" in ctx.description.lower():
                    context_instructions = getattr(ctx, "value", "")
                    break

        if system_text and context_instructions:
            return f"{system_text}\n\n{context_instructions}"
        return system_text or context_instructions or None

    def _translate_tools(
        self, tools: list[Tool]
    ) -> list[FunctionToolParam | dict[str, Any]] | None:
        """Translate AG-UI tools to OpenResponses format.

        Uses FunctionToolParam from OpenAI SDK (flat structure) by default.
        When OpenClawProviderConfig.use_nested_tool_format is True, uses the
        Chat Completions-style nested format instead.

        Args:
            tools: List of AG-UI tool definitions.

        Returns:
            List of OpenResponses tool definitions, or None.
        """
        if not tools:
            return None

        use_nested = (
            self._config.openclaw is not None
            and self._config.openclaw.use_nested_tool_format
        )

        result: list[FunctionToolParam | dict[str, Any]] = []
        for tool in tools:
            if use_nested:
                result.append({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description or "",
                        "parameters": tool.parameters or {},
                    },
                })
            else:
                result.append(
                    FunctionToolParam(
                        type="function",
                        name=tool.name,
                        description=tool.description or "",
                        parameters=tool.parameters or {},
                    )
                )
        return result

    def _get_max_tokens(self, input_data: RunAgentInput) -> int | None:
        """Get max tokens from input data.

        Args:
            input_data: The AG-UI input data.

        Returns:
            Max tokens value or None.
        """
        forwarded = input_data.forwarded_props if hasattr(input_data, "forwarded_props") else None
        if forwarded and isinstance(forwarded, dict):
            if "max_tokens" in forwarded:
                return int(forwarded["max_tokens"])
            if "max_output_tokens" in forwarded:
                return int(forwarded["max_output_tokens"])
        return None

