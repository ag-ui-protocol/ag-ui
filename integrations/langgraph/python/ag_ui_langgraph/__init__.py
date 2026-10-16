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


def __getattr__(name):
    # FastAPI is an optional dependency — only the HTTP endpoint helper needs it.
    # PEP 562-style helper: add_langgraph_fastapi_endpoint may not be called by
    # the importer; only raise an error if they actually call, not just import.
    if name == "add_langgraph_fastapi_endpoint":
        try:
            from .endpoint import add_langgraph_fastapi_endpoint
            return add_langgraph_fastapi_endpoint
        except ImportError as ex:
            return _error_raising_fastapi_endpoint(ex)

    # __getattr__ is the last line of defense: if we're here, it's only
    # because the symbol doesn't resolve through normal means: let it fail
    raise AttributeError(name, __name__)

def _error_raising_fastapi_endpoint(ex: ImportError):
    name_of_failed_import = ex.name or ""
    error_class = type(ex)

    error_msg = f"{error_class.__name__} loading add_langgraph_fastapi_endpoint: {ex}"
    # Special case for fastapi: show install advice
    if isinstance(ex, ModuleNotFoundError) and "fastapi" == name_of_failed_import:
        error_msg = "fastapi not installed: pip install ag-ui-langgraph[fastapi]"

    def add_langgraph_fastapi_endpoint(app, agent, path='/', **kwargs):
        raise error_class(
            error_msg,
            name=name_of_failed_import,
        )
    return add_langgraph_fastapi_endpoint
