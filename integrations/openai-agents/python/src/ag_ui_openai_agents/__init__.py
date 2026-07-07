"""OpenAI Agents SDK × AG-UI Protocol integration.

Primary API — the streaming translator:

    from ag_ui_openai_agents import AGUITranslator

Advanced (per-mapping overrides) — the engine layer:

    from ag_ui_openai_agents.engine import AGUIToSDKTranslator, SDKToAGUITranslator
"""

from __future__ import annotations

from .engine import (
    AGUIToSDKTranslator,
    ClientToolPending,
    SDKToAGUITranslator,
    TranslatedInput,
)
from .translator import AGUITranslator

__version__ = "0.1.0"

__all__ = [
    # Public translator (primary API — 2 methods)
    "AGUITranslator",
    # Engine translators (advanced / per-mapping overrides)
    "AGUIToSDKTranslator",
    "SDKToAGUITranslator",
    # Types & helpers
    "TranslatedInput",
    "ClientToolPending",
]
