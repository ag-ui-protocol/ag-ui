"""Example agent factories for the AG-UI × OpenAI Agents SDK server.

Each demo is a ``DemoConfig`` wrapping the SDK agent. ``build_registry()``
assembles the full name → config map ``server.py`` serves, one route per key.

Stateful demos (shared_state, agentic_generative_ui,
predictive_state_updates) are shelved together with ``AGUIContext`` —
see ``.dev/shelved/``.
"""

from __future__ import annotations

from dataclasses import dataclass

from agents import Agent

from .agentic_chat import create_agentic_chat_agent
from .backend_tool_rendering import create_backend_tool_agent
from .handoff import create_handoff_agent
from .human_in_the_loop import create_human_in_the_loop_agent
from .subagents import create_subagents_agent
from .tool_based_generative_ui import create_tool_based_generative_ui_agent


@dataclass(frozen=True)
class DemoConfig:
    """One demo route: the agent to run for it."""

    agent: Agent


def build_registry() -> dict[str, DemoConfig]:
    """Assemble the demo registry served by ``server.py`` (one route per key)."""
    return {
        "agentic_chat": DemoConfig(agent=create_agentic_chat_agent()),
        "backend_tool_rendering": DemoConfig(agent=create_backend_tool_agent()),
        "human_in_the_loop": DemoConfig(agent=create_human_in_the_loop_agent()),
        "tool_based_generative_ui": DemoConfig(agent=create_tool_based_generative_ui_agent()),
        "handoff": DemoConfig(agent=create_handoff_agent()),
        "subagents": DemoConfig(agent=create_subagents_agent()),
    }


__all__ = [
    "DemoConfig",
    "build_registry",
    "create_agentic_chat_agent",
    "create_backend_tool_agent",
    "create_handoff_agent",
    "create_human_in_the_loop_agent",
    "create_subagents_agent",
    "create_tool_based_generative_ui_agent",
]
