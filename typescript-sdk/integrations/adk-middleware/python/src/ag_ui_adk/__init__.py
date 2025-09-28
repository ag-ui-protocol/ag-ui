# src/__init__.py

"""ADK Middleware for AG-UI Protocol

This middleware enables Google ADK agents to be used with the AG-UI protocol.
"""

from .adk_agent import ADKAgent
from .event_translator import EventTranslator
from .session_manager import SessionManager
from .endpoint import add_adk_fastapi_endpoint, create_adk_app

__all__ = ['ADKAgent', 'add_adk_fastapi_endpoint', 'create_adk_app', 'EventTranslator', 'SessionManager']

__version__ = "0.1.0"