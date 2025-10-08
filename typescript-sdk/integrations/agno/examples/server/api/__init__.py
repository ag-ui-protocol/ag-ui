"""Example API for a AG-UI compatible Agno Agent UI."""

from __future__ import annotations

from .agentic_chat import app as agentic_chat_app
from .tool_based_generative_ui import app as tool_based_generative_ui_app

__all__ = [
    'agentic_chat_app',
    'tool_based_generative_ui_app',
]