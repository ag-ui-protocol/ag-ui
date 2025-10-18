"""API modules for ADK middleware examples."""

from .agentic_chat import app as agentic_chat_app
from .tool_based_generative_ui import app as tool_based_generative_ui_app
from .human_in_the_loop import app as human_in_the_loop_app
from .shared_state import app as shared_state_app
from .predictive_state_updates import app as predictive_state_updates_app
from .backend_tool_rendering import app as backend_tool_rendering_app

__all__ = [
    "agentic_chat_app",
    "tool_based_generative_ui_app",
    "human_in_the_loop_app",
    "shared_state_app",
    "predictive_state_updates_app",
    "backend_tool_rendering_app",
]
