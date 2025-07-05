# src/__init__.py

"""ADK Middleware for AG-UI Protocol

This middleware enables Google ADK agents to be used with the AG-UI protocol.
"""

from .adk_agent import ADKAgent
from .agent_registry import AgentRegistry

__all__ = ['ADKAgent', 'AgentRegistry']

__version__ = "0.1.0"