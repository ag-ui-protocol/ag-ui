"""Configuration primitives for customizing Strands agent behavior."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Optional,
)

from ag_ui.core import RunAgentInput


StatePayload = Dict[str, Any]


@dataclass
class ToolCallContext:
    """Context passed to tool call hooks."""

    input_data: RunAgentInput
    tool_name: str
    tool_use_id: str
    tool_input: Any
    args_str: str


@dataclass
class ToolResultContext(ToolCallContext):
    """Context passed to tool result hooks."""

    result_data: Any
    message_id: str


ArgsStreamer = Callable[[ToolCallContext], AsyncIterator[str]]
StateFromArgs = Callable[[ToolCallContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
StateFromResult = Callable[[ToolResultContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
CustomResultHandler = Callable[[ToolResultContext], AsyncIterator[Any]]
StateContextBuilder = Callable[[RunAgentInput, str], str]


@dataclass
class PredictStateMapping:
    """Declarative mapping telling the UI how to predict state from tool args."""

    state_key: str
    tool: str
    tool_argument: str

    def to_payload(self) -> Dict[str, str]:
        return {
            "state_key": self.state_key,
            "tool": self.tool,
            "tool_argument": self.tool_argument,
        }


@dataclass
class ToolBehavior:
    """Declarative configuration for tool-specific handling."""

    skip_messages_snapshot: bool = False
    continue_after_frontend_call: bool = False
    stop_streaming_after_result: bool = False
    predict_state: Optional[Iterable[PredictStateMapping]] = None
    args_streamer: Optional[ArgsStreamer] = None
    state_from_args: Optional[StateFromArgs] = None
    state_from_result: Optional[StateFromResult] = None
    custom_result_handler: Optional[CustomResultHandler] = None


@dataclass
class StrandsAgentConfig:
    """Top-level configuration for the Strands agent adapter."""

    tool_behaviors: Dict[str, ToolBehavior] = field(default_factory=dict)
    state_context_builder: Optional[StateContextBuilder] = None


async def maybe_await(value: Any) -> Any:
    """Await coroutine-like values produced by hook callables."""

    if inspect.isawaitable(value):
        return await value
    return value


def normalize_predict_state(value: Optional[Iterable[PredictStateMapping]]) -> List[PredictStateMapping]:
    """Normalize predict state config into a concrete list."""

    if value is None:
        return []
    if isinstance(value, PredictStateMapping):
        return [value]
    return list(value)

