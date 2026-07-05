"""OpenAI Agents SDK × AG-UI Protocol integration."""

from __future__ import annotations
#
# from .agent import OpenAIAgentsAgent
# from .endpoint import add_fastapi_endpoint, create_app
from .translator import (
    AGUIToSDKTranslator,
    ClientToolPending,
    SDKToAGUITranslator,
    StateDiffer,
    TranslatedInput,
)

__version__ = "0.1.0"

__all__ = [
    # Main agent wrapper
    # "OpenAIAgentsAgent",
    # # FastAPI wiring
    # "add_fastapi_endpoint",
    # "create_app",
    # Translators (for advanced / manual use)
    "AGUIToSDKTranslator",
    "SDKToAGUITranslator",
    # Types & helpers
    "TranslatedInput",
    "ClientToolPending",
    "StateDiffer",
]
