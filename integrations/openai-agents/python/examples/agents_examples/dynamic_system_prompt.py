"""Dynamic system prompt — reply language driven by the AG-UI ``context`` channel.

The point of this demo: **context needs no special AG-UI class.** The frontend
sends a language choice (English / Arabic / German) over the AG-UI ``context``
channel — a plain ``list[Context]`` of ``{description, value}`` items on
``RunAgentInput.context``. This example folds it into the system prompt with the
OpenAI Agents SDK's own native feature: ``Agent.instructions`` accepting a
callable ``(RunContextWrapper, Agent) -> str``, re-run every turn.

Not registered in ``build_registry()``: ``server.py``'s wrapper
(``OpenAIAgentsAgent``) and ``translator_server.py``'s shared ``_stream()``
both call ``Runner.run_streamed`` without ``context=``, so neither ever
forwards ``RunAgentInput.context`` to the SDK — ``to_sdk()`` hands it back on
``TranslatedInput.context``, but nothing in those two shared loops passes it
on. Rather than change either shared loop for one demo, ``stream()`` below
is this demo's own run loop — the same three calls those servers make
(``to_sdk`` / ``Runner.run_streamed`` / ``to_agui``), translator-driven, no
``OpenAIAgentsAgent`` wrapper and no FastAPI in this file, plus the one line
those loops skip: ``context=translated.context``, passed straight through as
the SDK's own ``context=`` and read back via ``RunContextWrapper.context`` in
``dynamic_instructions``. ``.dev/groq_server.py`` (gitignored, local Groq
dev) just calls ``stream()`` from its own route. No ``AGUIContext`` anywhere:
this demo has no state, only context, and context is just a list to read.
"""

from __future__ import annotations

from typing import AsyncIterator

from agents import Agent, Runner, RunContextWrapper
from ag_ui.core import BaseEvent, Context, RunAgentInput

from ag_ui_openai_agents import AGUITranslator

from .constants import DEFAULT_MODEL

BASE_INSTRUCTIONS = (
    "You are a helpful, concise assistant. Answer the user's questions directly."
)

# Fallback when the frontend hasn't picked a language yet.
DEFAULT_LANGUAGE = "English"


def _read_language(ctx: RunContextWrapper[list[Context]]) -> str:
    """Pull the reply language out of the AG-UI context list.

    ``ctx.context`` here IS the raw ``list[Context]`` the client sent —
    each item a ``{description, value}`` pair, nothing wrapping it. We match
    the item whose description mentions "language" and use its value.
    """
    items = ctx.context or []
    for item in items:
        if "language" in (item.description or "").lower():
            return item.value or DEFAULT_LANGUAGE
    return DEFAULT_LANGUAGE


def dynamic_instructions(ctx: RunContextWrapper[list[Context]], agent: Agent) -> str:
    """Native SDK dynamic-instructions hook: build the prompt fresh each turn,
    baking in whatever language the frontend currently has selected."""
    language = _read_language(ctx)
    return (
        f"{BASE_INSTRUCTIONS}\n"
        f"Always reply in {language}, no matter what language the user writes in. "
        f"Every word of your response must be in {language}."
    )


def create_dynamic_system_prompt_agent() -> Agent:
    return Agent(
        name="multilingual_assistant",
        model=DEFAULT_MODEL,
        instructions=dynamic_instructions,
    )


agent = create_dynamic_system_prompt_agent()

# Reusable — to_sdk is stateless, to_agui spins up a fresh engine per call.
_translator = AGUITranslator()


async def stream(body: RunAgentInput) -> AsyncIterator[BaseEvent]:
    """Run this demo for one AG-UI request, translator by hand, and yield AG-UI events.

    Any server can call this directly — it owns the HTTP/SSE plumbing, this
    owns the run loop. The one line that makes the demo work:
    ``context=translated.context``, forwarded to ``Runner.run_streamed`` so
    ``dynamic_instructions`` can read it back.
    """
    translated = _translator.to_sdk(body)

    run_agent = agent
    if translated.tools:
        run_agent = run_agent.clone(tools=[*agent.tools, *translated.tools])

    result = Runner.run_streamed(
        run_agent,
        input=translated.messages,
        context=translated.context,
    )
    async for event in _translator.to_agui(result, body):
        yield event
