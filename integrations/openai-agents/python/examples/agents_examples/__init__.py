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

dynamic_system_prompt is registered here too (so DEMOS/health lists it) but
is never run through the generic loop or wrapper — it needs
``context=run_input.context`` on ``Runner.run_streamed``, which neither the
wrapper (``OpenAIAgentsAgent.run()``) nor the shared translator loops pass.
Its own run loop lives next to the agent in
``dynamic_system_prompt.py`` (``stream()``); ``server.py`` and
``.dev/groq_server.py`` both call that function directly from a hand-written
route instead.

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
from .dynamic_system_prompt import agent as dynamic_system_prompt_agent
from .human_in_the_loop import create_human_in_the_loop_agent
from .human_in_the_loop_approval import create_human_in_the_loop_approval_agent
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
        # Same idea as human_in_the_loop (pause for a person before an action
        # happens) but a different mechanism — see
        # human_in_the_loop_approval.py's docstring for the frontend-tool vs
        # SDK-native-approval distinction. Hand-routed, same reason as
        # dynamic_system_prompt below.
        "human_in_the_loop_approval": DemoConfig(agent=create_human_in_the_loop_approval_agent()),
        "tool_based_generative_ui": DemoConfig(agent=create_tool_based_generative_ui_agent()),
        "subagents": DemoConfig(agent=create_subagents_agent()),
        "custom_lifecycle_events": DemoConfig(
            agent=create_custom_lifecycle_events_agent(),
            build_start_custom_event=build_input_usage_event,
            build_end_custom_event=build_output_usage_event,
        ),
        # Same agent singleton dynamic_system_prompt.stream() runs — only
        # registered here so DEMOS/health lists it. Servers route this one by
        # hand (dynamic_system_prompt.stream) instead of through this agent
        # generically, since it needs context= the generic loop can't give it.
        "dynamic_system_prompt": DemoConfig(agent=dynamic_system_prompt_agent),
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
