"""
Example agent configurations for AG-UI Claude SDK integration.

Each agent module provides a factory function that creates a configured
ClaudeAgentAdapter for different use cases.
"""

from .agentic_chat import create_agentic_chat_adapter
from .backend_tool_rendering import create_backend_tool_adapter
from .shared_state import create_shared_state_adapter
from .human_in_the_loop import create_human_in_the_loop_adapter
from .tool_based_generative_ui import create_tool_based_generative_ui_adapter

__all__ = [
    "create_agentic_chat_adapter",
    "create_backend_tool_adapter",
    "create_shared_state_adapter",
    "create_human_in_the_loop_adapter",
    "create_tool_based_generative_ui_adapter",
]
