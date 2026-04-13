"""Type definitions for Langroid AG-UI integration."""

from typing import Any, Dict, Optional, Callable, AsyncIterator, Awaitable
from typing_extensions import TypedDict
from dataclasses import dataclass, field

from ag_ui.core import RunAgentInput


StatePayload = Dict[str, Any]


@dataclass
class ToolCallContext:
    """Context passed to tool call hooks."""
    
    input_data: RunAgentInput
    tool_name: str
    tool_call_id: str
    tool_input: Any
    args_str: str


@dataclass
class ToolResultContext(ToolCallContext):
    """Context passed to tool result hooks."""
    
    result_data: Any
    message_id: str


StateFromArgs = Callable[[ToolCallContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
StateFromResult = Callable[[ToolResultContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
StateContextBuilder = Callable[[RunAgentInput, str], str]


@dataclass
class ToolBehavior:
    """Configuration for tool-specific handling."""
    
    state_from_args: Optional[StateFromArgs] = None
    state_from_result: Optional[StateFromResult] = None


class LangroidAgentConfig(TypedDict, total=False):
    """Configuration for Langroid agent behavior."""
    tool_behaviors: Dict[str, ToolBehavior]
    state_context_builder: Optional[StateContextBuilder]


async def maybe_await(value: Any) -> Any:
    """Await coroutine-like values produced by hook callables."""
    import inspect
    if inspect.isawaitable(value):
        return await value
    return value

