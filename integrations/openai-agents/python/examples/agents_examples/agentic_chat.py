"""Agentic chat — plain conversation, no tools.

The baseline demo: exercises ``TEXT_MESSAGE_START/CONTENT/END`` only. Good
first smoke test before trying the tool / multi-agent examples.
"""

from __future__ import annotations

from agents import Agent

from .constants import DEFAULT_MODEL


def create_agentic_chat_agent() -> Agent:
    return Agent(
        name="assistant",
        model=DEFAULT_MODEL,
        instructions="You are a helpful assistant. Be concise.",
    )
