"""Agentic Chat feature."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from pydantic_ai import Agent


@dataclass
class ChatState:
    """State handler for the agentic chat agent."""
    state: dict[str, Any]


# Create agent with proper dependency type
agent = Agent('openai:gpt-4o-mini', deps_type=ChatState)

# Create AG-UI app with default state
def create_deps() -> ChatState:
    """Create default dependencies for the agent."""
    return ChatState(state={})

app = agent.to_ag_ui(deps=create_deps)


@agent.tool_plain
async def current_time(timezone: str = 'UTC') -> str:
    """Get the current time in ISO format.

    Args:
        timezone: The timezone to use.

    Returns:
        The current time in ISO format string.
    """
    tz: ZoneInfo = ZoneInfo(timezone)
    return datetime.now(tz=tz).isoformat()
