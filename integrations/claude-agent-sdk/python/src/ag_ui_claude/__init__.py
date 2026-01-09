"""Claude Agent SDK integration for AG-UI Protocol."""

from __future__ import annotations

from .claude_agent import ClaudeAgent
from .event_translator import EventTranslator
from .session_manager import SessionManager
from .endpoint import add_claude_fastapi_endpoint, create_claude_app

__all__ = [
    'ClaudeAgent',
    'add_claude_fastapi_endpoint',
    'create_claude_app',
    'EventTranslator',
    'SessionManager'
]

__version__ = "0.1.0"

