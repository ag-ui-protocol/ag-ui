"""Generative UI feature.

CopilotKit sends its generative UI guide and component schema as the run's
context (`RunAgentInput.context`). The agent sees them as instructions, so it
can answer with ```a2ui fences or call the `render_ui` frontend tool.
"""

from __future__ import annotations

from ag_ui.core import Context
from pydantic_ai import Agent


agent = Agent('openai:gpt-4o-mini')


def context_instructions(context: list[Context]) -> str | None:
    """The run's context entries as instructions, or None without any."""
    entries = [f'{item.description}:\n{item.value}' for item in context if item.value]
    if not entries:
        return None
    return '## Context from the application\n\n' + '\n\n'.join(entries)
