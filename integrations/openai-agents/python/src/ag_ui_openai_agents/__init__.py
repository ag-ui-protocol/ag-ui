"""OpenAI Agents SDK × AG-UI Protocol integration.

Primary API — translators, one per run mode:

    from ag_ui_openai_agents import AGUITranslator, AGUINonStreamingTranslator

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
from .non_streaming_translator import AGUINonStreamingTranslator
from .translator import AGUITranslator

__version__ = "0.1.0"

__all__ = [
    # Public translators (primary API — 2 methods each)
    "AGUITranslator",
    "AGUINonStreamingTranslator",
    # Engine translators (advanced / per-mapping overrides)
    "AGUIToSDKTranslator",
    "SDKToAGUITranslator",
    # Types & helpers
    "TranslatedInput",
    "ClientToolPending",
]
