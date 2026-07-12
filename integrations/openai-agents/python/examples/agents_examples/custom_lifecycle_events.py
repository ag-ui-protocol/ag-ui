"""Custom lifecycle events — manual to_agui() with a CUSTOM event bracketing the run.

Plain chat agent, same as agentic_chat — the point isn't the agent, it's
the two builder functions below. This ``DemoConfig`` sets
``build_start_custom_event``/``build_end_custom_event`` (see
``agents_examples/__init__.py``); the shared run loop in
translator_server.py calls them and forwards the result into
``to_agui()``'s ``start_custom_event``/``end_custom_event`` params, so one
CUSTOM event goes out right after RUN_STARTED and another right before
RUN_FINISHED. Only CustomEvent instances are accepted there; anything else
raises TypeError.

input_usage fires at the start because prompt tokens/cost are known before
the model even runs; output_usage fires at the end because completion
tokens/cost are only known once the run is done. Numbers here are fake —
the point is the event bracketing, not real usage accounting.
"""

from __future__ import annotations

import random

from ag_ui.core import CustomEvent, EventType
from agents import Agent

from .constants import DEFAULT_MODEL


def create_custom_lifecycle_events_agent() -> Agent:
    return Agent(
        name="assistant",
        model=DEFAULT_MODEL,
        instructions="You are a helpful assistant. Be concise.",
    )


def build_input_usage_event() -> CustomEvent:
    tokens = random.randint(20, 120)
    return CustomEvent(
        type=EventType.CUSTOM,
        name="input_usage",
        value={"tokens": tokens, "cost_usd": round(tokens * 0.00000015, 6)},
    )


def build_output_usage_event() -> CustomEvent:
    tokens = random.randint(120, 480)
    return CustomEvent(
        type=EventType.CUSTOM,
        name="output_usage",
        value={"tokens": tokens, "cost_usd": round(tokens * 0.0000006, 6)},
    )
