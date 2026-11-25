"""Native GitHub Copilot SDK integration for AG-UI."""

from typing import TYPE_CHECKING, Any

from .agent import AGUITool, CopilotAgent, ToolContext
from .mapper import EventMapper

if TYPE_CHECKING:
    from .endpoint import add_copilot_fastapi_endpoint


def __getattr__(name: str) -> Any:
    # FastAPI ships in the optional [server] extra, so load it only on use.
    if name == "add_copilot_fastapi_endpoint":
        from .endpoint import add_copilot_fastapi_endpoint

        return add_copilot_fastapi_endpoint
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "AGUITool",
    "CopilotAgent",
    "EventMapper",
    "ToolContext",
    "add_copilot_fastapi_endpoint",
]
