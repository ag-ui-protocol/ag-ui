"""Example agent factories for the AG-UI × OpenAI Agents SDK server.

Each demo is a ``DemoConfig`` wrapping the SDK agent. ``build_registry()``
assembles the full name → config map both servers serve, one route per key.

Most demos only set ``agent`` — translator_server.py's shared run loop calls
plain ``to_agui(result, body)`` for those. custom_lifecycle_events also sets
``build_start_custom_event``/``build_end_custom_event``: optional callables
returning a ``CustomEvent``, which the shared loop forwards into
``to_agui(..., start_custom_event=..., end_custom_event=...)`` when present.
No if-branch keyed by demo name, no separate router — one generic loop,
one optional per-demo hook.

Stateful demos (shared_state, agentic_generative_ui,
predictive_state_updates) are shelved together with ``AGUIContext`` —
see ``.dev/shelved/``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from agents import Agent
from ag_ui.core import CustomEvent

from .agentic_chat import create_agentic_chat_agent
from .backend_tool_rendering import create_backend_tool_agent
from .custom_lifecycle_events import (
    build_input_usage_event,
    build_output_usage_event,
    create_custom_lifecycle_events_agent,
)
from .handoff import create_handoff_agent
from .human_in_the_loop import create_human_in_the_loop_agent
from .subagents import create_subagents_agent
from .tool_based_generative_ui import create_tool_based_generative_ui_agent


@dataclass(frozen=True)
class DemoConfig:
    """One demo route: the agent to run for it, plus optional lifecycle hooks."""

    agent: Agent
    build_start_custom_event: Callable[[], CustomEvent] | None = None
    build_end_custom_event: Callable[[], CustomEvent] | None = None


def build_registry() -> dict[str, DemoConfig]:
    """Assemble the demo registry served by ``server.py`` (one route per key)."""
    return {
        "agentic_chat": DemoConfig(agent=create_agentic_chat_agent()),
        "backend_tool_rendering": DemoConfig(agent=create_backend_tool_agent()),
        "human_in_the_loop": DemoConfig(agent=create_human_in_the_loop_agent()),
        "tool_based_generative_ui": DemoConfig(agent=create_tool_based_generative_ui_agent()),
        "handoff": DemoConfig(agent=create_handoff_agent()),
        "subagents": DemoConfig(agent=create_subagents_agent()),
        "custom_lifecycle_events": DemoConfig(
            agent=create_custom_lifecycle_events_agent(),
            build_start_custom_event=build_input_usage_event,
            build_end_custom_event=build_output_usage_event,
        ),
    }


__all__ = [
    "DemoConfig",
    "build_registry",
    "create_agentic_chat_agent",
    "create_backend_tool_agent",
    "create_custom_lifecycle_events_agent",
    "create_handoff_agent",
    "create_human_in_the_loop_agent",
    "create_subagents_agent",
    "create_tool_based_generative_ui_agent",
]
