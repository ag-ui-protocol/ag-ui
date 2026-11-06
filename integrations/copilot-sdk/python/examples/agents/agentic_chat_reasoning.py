"""Reasoning deltas from the runtime stream as AG-UI REASONING_* events."""

from typing import Any

from ag_ui_copilot_sdk import CopilotAgent

from .base import define_agent


def create_agentic_chat_reasoning_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="agentic_chat_reasoning",
        instructions="You are a helpful assistant. Think carefully before you answer.",
        session_options={"reasoning_effort": "medium"},
    )
