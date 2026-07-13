"""Example agent factories for the AG-UI × OpenAI Agents SDK server.

Each demo is a ``DemoConfig`` wrapping the SDK agent. ``build_registry()``
assembles the full name → config map the aggregate servers serve, one route per key.

Most demos only set ``agent``. custom_lifecycle_events also sets
``start_custom_event``/``end_custom_event``: optional callables
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
from .dynamic_system_prompt import create_dynamic_system_prompt_agent
from .human_in_the_loop import create_human_in_the_loop_agent
from .human_in_the_loop_approval import create_human_in_the_loop_approval_agent
from .subagents import create_subagents_agent
from .tool_based_generative_ui import create_tool_based_generative_ui_agent


@dataclass(frozen=True)
class DemoConfig:
    """One demo route: the agent to run for it, plus optional lifecycle hooks."""

    agent: Agent
    start_custom_event: CustomEvent | Callable[[], CustomEvent] | None = None
    end_custom_event: CustomEvent | Callable[[], CustomEvent] | None = None


def build_registry() -> dict[str, DemoConfig]:
    """Assemble the demo registry served by ``server.py`` (one route per key)."""
    return {
        "agentic_chat": DemoConfig(agent=create_agentic_chat_agent()),
        "backend_tool_rendering": DemoConfig(agent=create_backend_tool_agent()),
        "human_in_the_loop": DemoConfig(agent=create_human_in_the_loop_agent()),
        # Same idea as human_in_the_loop (pause for a person before an action
        # happens) but a different mechanism — see
        # human_in_the_loop_approval.py's docstring for the frontend-tool vs
        # SDK-native-approval distinction.
        "human_in_the_loop_approval": DemoConfig(agent=create_human_in_the_loop_approval_agent()),
        "tool_based_generative_ui": DemoConfig(agent=create_tool_based_generative_ui_agent()),
        "subagents": DemoConfig(agent=create_subagents_agent()),
        "custom_lifecycle_events": DemoConfig(
            agent=create_custom_lifecycle_events_agent(),
            start_custom_event=build_input_usage_event,
            end_custom_event=build_output_usage_event,
        ),
        "dynamic_system_prompt": DemoConfig(agent=create_dynamic_system_prompt_agent()),
    }


__all__ = [
    "DemoConfig",
    "build_registry",
    "create_agentic_chat_agent",
    "create_backend_tool_agent",
    "create_custom_lifecycle_events_agent",
    "create_human_in_the_loop_agent",
    "create_human_in_the_loop_approval_agent",
    "create_subagents_agent",
    "create_tool_based_generative_ui_agent",
]
