"""
AWS Strands Integration for AG-UI.

Simple adapter following the Agno pattern.
"""
from .agent import StrandsAgent
from .client_proxy_tool import create_proxy_tool, sync_proxy_tools
from .utils import create_strands_app
from .endpoint import add_strands_fastapi_endpoint, add_ping
from .config import (
    StrandsAgentConfig,
    ToolBehavior,
    ToolCallContext,
    ToolResultContext,
    PredictStateMapping,
)

__all__ = [
    "StrandsAgent",
    "create_proxy_tool",
    "sync_proxy_tools",
    "create_strands_app",
    "add_strands_fastapi_endpoint",
    "add_ping",
    "StrandsAgentConfig",
    "ToolBehavior",
    "ToolCallContext",
    "ToolResultContext",
    "PredictStateMapping",
]

