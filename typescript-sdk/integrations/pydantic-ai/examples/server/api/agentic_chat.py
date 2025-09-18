"""Agentic Chat feature."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from pydantic_ai import Agent


@dataclass
class State:
    pass


@dataclass
class Deps
    """Dependencies that implement StateHandler protocol."""
    state: State


# Create agent with proper dependency type
agent = Agent[str, Deps]('openai:gpt-4o-mini', deps_type=Deps)

# Create AG-UI app with proper dataclass instance
deps_instance = Deps(state=State())
app = agent.to_ag_ui(deps=deps_instance)


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
