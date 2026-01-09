"""
Agentic chat agent configuration.

This module provides a factory function for creating an agentic chat adapter.
The adapter supports all ClaudeAgentOptions from the Claude Agent SDK.
"""

from ag_ui_claude_sdk import ClaudeAgentAdapter
from .constants import DEFAULT_DISALLOWED_TOOLS


def create_agentic_chat_adapter() -> ClaudeAgentAdapter:
    """Create adapter for agentic chat."""
    return ClaudeAgentAdapter(
        name="agentic_chat",
        description="General purpose agentic chat assistant",
        options={
            "model": "claude-haiku-4-5",
            "system_prompt": "You are a helpful assistant with access to tools.",
            "disallowed_tools": list(DEFAULT_DISALLOWED_TOOLS),
        }
    )
