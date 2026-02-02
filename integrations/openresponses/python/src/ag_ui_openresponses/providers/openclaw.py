"""OpenClaw provider."""

from __future__ import annotations

import os
from typing import Any, TYPE_CHECKING

from .base import Provider

if TYPE_CHECKING:
    from ag_ui.core import RunAgentInput, Tool
    from ..types import OpenResponsesAgentConfig
    from openai.types.responses import FunctionToolParam


class OpenClawProvider(Provider):
    default_model: str | None = "openclaw"

    def build_headers(self, config: OpenResponsesAgentConfig) -> dict[str, str]:
        headers = dict(config.headers or {})
        if config.openclaw:
            if config.openclaw.agent_id:
                headers["x-openclaw-agent-id"] = config.openclaw.agent_id
            if config.openclaw.session_key:
                headers["x-openclaw-session-key"] = config.openclaw.session_key
        return headers

    def resolve_model(self, input_data: RunAgentInput, config: OpenResponsesAgentConfig) -> str:
        fp = input_data.forwarded_props if hasattr(input_data, "forwarded_props") else None
        if fp and isinstance(fp, dict) and "model" in fp:
            return str(fp["model"])
        # OpenClaw agent routing via forwarded_props agent_id
        if fp and isinstance(fp, dict) and "agent_id" in fp:
            return f"openclaw:{fp['agent_id']}"
        return config.default_model or self.default_model or "openclaw"

    def translate_tools(
        self, tools: list[Tool], config: OpenResponsesAgentConfig
    ) -> list[FunctionToolParam | dict[str, Any]] | None:
        if not tools:
            return None

        use_nested = config.openclaw is not None and config.openclaw.use_nested_tool_format

        if not use_nested:
            return super().translate_tools(tools, config)

        result: list[dict[str, Any]] = []
        for tool in tools:
            result.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": tool.parameters or {},
                },
            })
        return result

    def default_user_id(self, input_data: RunAgentInput) -> str | None:
        return os.environ.get("USER", "user")
