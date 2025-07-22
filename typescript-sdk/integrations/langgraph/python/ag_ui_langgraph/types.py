from __future__ import annotations

from typing import Any, Dict, List, Literal, TypedDict, Union
from enum import Enum

from typing_extensions import NotRequired


class LangGraphEventTypes(str, Enum):
    OnChainStart = "on_chain_start"
    OnChainStream = "on_chain_stream"
    OnChainEnd = "on_chain_end"
    OnChatModelStart = "on_chat_model_start"
    OnChatModelStream = "on_chat_model_stream"
    OnChatModelEnd = "on_chat_model_end"
    OnToolStart = "on_tool_start"
    OnToolEnd = "on_tool_end"
    OnCustomEvent = "on_custom_event"
    OnInterrupt = "on_interrupt"

class CustomEventNames(str, Enum):
    ManuallyEmitMessage = "manually_emit_message"
    ManuallyEmitToolCall = "manually_emit_tool_call"
    ManuallyEmitState = "manually_emit_state"
    Exit = "exit"

State = Dict[str, Any]

SchemaKeys = TypedDict("SchemaKeys", {
    "input": NotRequired[List[str] | None],
    "output": NotRequired[List[str] | None],
    "config": NotRequired[List[str] | None],
})

ThinkingProcess = TypedDict("ThinkingProcess", {
    "index": int,
    "type": NotRequired[Literal['text'] | None],
})

MessageInProgress = TypedDict("MessageInProgress", {
    "id": str,
    "tool_call_id": NotRequired[str | None],
    "tool_call_name": NotRequired[str | None]
})

RunMetadata = TypedDict("RunMetadata", {
    "id": str,
    "schema_keys": NotRequired[SchemaKeys | None],
    "node_name": NotRequired[str | None],
    "prev_node_name": NotRequired[str | None],
    "exiting_node": NotRequired[bool],
    "manually_emitted_state": NotRequired[State | None],
    "thread_id": NotRequired[ThinkingProcess | None],
    "thinking_process": NotRequired[str | None],
})

MessagesInProgressRecord = Dict[str, MessageInProgress | None]

ToolCall = TypedDict("ToolCall", {
    "id": str,
    "name": str,
    "args": Dict[str, Any]
})

class BaseLangGraphPlatformMessage(TypedDict):
    content: str
    role: str
    additional_kwargs: NotRequired[Dict[str, Any]]
    type: str
    id: str

class LangGraphPlatformResultMessage(BaseLangGraphPlatformMessage):
    tool_call_id: str
    name: str

class LangGraphPlatformActionExecutionMessage(BaseLangGraphPlatformMessage):
    tool_calls: List[ToolCall]

LangGraphPlatformMessage = Union[
    LangGraphPlatformActionExecutionMessage,
    LangGraphPlatformResultMessage,
    BaseLangGraphPlatformMessage,
]

PredictStateTool = TypedDict("PredictStateTool", {
    "tool": str,
    "state_key": str,
    "tool_argument": str
})

LangGraphReasoning = TypedDict("LangGraphReasoning", {
    "type": str,
    "text": str,
    "index": int
})
