"""OpenAI Agents SDK × AG-UI Protocol integration.

Serve an agent (highest level — wrapper + FastAPI helper):

    from agents import Agent
    from ag_ui_openai_agents import (
        OpenAIAgentsAgent,
        add_openai_agents_fastapi_endpoint,
    )

    agent = OpenAIAgentsAgent(Agent(name="assistant", instructions="..."))
    add_openai_agents_fastapi_endpoint(app, agent, "/")

Compose it yourself (mid level — the streaming translator):

    from ag_ui_openai_agents import AGUITranslator

Advanced (per-mapping overrides) — the engine layer:

    from ag_ui_openai_agents.engine import AGUIToOpenAITranslator, OpenAIToAGUITranslator
"""

from __future__ import annotations

from .agent import OpenAIAgentsAgent
from .endpoint import add_openai_agents_fastapi_endpoint
from .engine import (
    AGUIToOpenAITranslator,
    ClientToolPending,
    OpenAIToAGUITranslator,
    TranslatedInput,
)
from .translator import AGUITranslator

__version__ = "0.1.0"

__all__ = [
    # Serve an agent (highest level)
    "OpenAIAgentsAgent",
    "add_openai_agents_fastapi_endpoint",
    # Public translator (primary API — 2 methods)
    "AGUITranslator",
    # Engine translators (advanced / per-mapping overrides)
    "AGUIToOpenAITranslator",
    "OpenAIToAGUITranslator",
    # Types & helpers
    "TranslatedInput",
    "ClientToolPending",
]
