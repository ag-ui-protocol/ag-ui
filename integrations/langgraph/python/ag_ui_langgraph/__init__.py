from typing import TYPE_CHECKING

from .agent import (
    LangGraphAgent,
    SUBAGENT_VISIBILITY_ATTRIBUTED,
    SUBAGENT_VISIBILITY_HIDDEN,
    SUBAGENT_VISIBILITY_INLINE,
)
from .types import (
    LangGraphEventTypes,
    CustomEventNames,
    State,
    SchemaKeys,
    ThinkingProcess,
    MessageInProgress,
    RunMetadata,
    MessagesInProgressRecord,
    ToolCall,
    BaseLangGraphPlatformMessage,
    LangGraphPlatformResultMessage,
    LangGraphPlatformActionExecutionMessage,
    LangGraphPlatformMessage,
    PredictStateTool,
    LangGraphReasoning,
)
from .utils import json_safe_stringify, make_json_safe
from .middlewares.state_streaming import StateStreamingMiddleware, StateItem
from .a2ui_tool import (
    get_a2ui_tools,
    A2UIToolParams,
    A2UIGuidelines,
    A2UI_OPERATIONS_KEY,
    BASIC_CATALOG_ID,
)

__all__ = [
    "LangGraphAgent",
    "SUBAGENT_VISIBILITY_ATTRIBUTED",
    "SUBAGENT_VISIBILITY_HIDDEN",
    "SUBAGENT_VISIBILITY_INLINE",
    "get_a2ui_tools",
    "A2UIToolParams",
    "A2UIGuidelines",
    "A2UI_OPERATIONS_KEY",
    "BASIC_CATALOG_ID",
    "LangGraphEventTypes",
    "CustomEventNames",
    "State",
    "SchemaKeys",
    "ThinkingProcess",
    "MessageInProgress",
    "RunMetadata",
    "MessagesInProgressRecord",
    "ToolCall",
    "BaseLangGraphPlatformMessage",
    "LangGraphPlatformResultMessage",
    "LangGraphPlatformActionExecutionMessage",
    "LangGraphPlatformMessage",
    "PredictStateTool",
    "LangGraphReasoning",
    "add_langgraph_fastapi_endpoint",
    "StateStreamingMiddleware",
    "StateItem",
    "json_safe_stringify",
    "make_json_safe"
]

if TYPE_CHECKING:  # pragma: no cover - typing only, runtime uses __getattr__ below
    from .endpoint import add_langgraph_fastapi_endpoint


def __getattr__(name: str):
    # `fastapi` is an optional extra: the endpoint helper is imported lazily
    # so that importing this package (or its middleware/utils submodules)
    # never requires it. Accessing the helper without the extra installed
    # raises the natural ModuleNotFoundError from `.endpoint`.
    if name == "add_langgraph_fastapi_endpoint":
        from .endpoint import add_langgraph_fastapi_endpoint

        return add_langgraph_fastapi_endpoint
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(__all__)
