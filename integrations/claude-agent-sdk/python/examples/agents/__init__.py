"""
Example agent configurations for AG-UI Claude SDK integration.

Each agent module provides a factory function that creates a configured
ClaudeAgentAdapter for different use cases.
"""

from .agentic_chat import create_agentic_chat_adapter
from .backend_tool_rendering import create_backend_tool_adapter

__all__ = ["create_agentic_chat_adapter", "create_backend_tool_adapter"]
