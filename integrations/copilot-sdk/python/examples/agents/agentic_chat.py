"""Agentic chat agent configuration."""

from typing import Any

from ag_ui_copilot_sdk import CopilotAgent

from .base import define_agent


def create_agentic_chat_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="agentic_chat",
        instructions="You are a helpful assistant. Use declared tools when requested.",
    )
