from typing import TypedDict, Optional, List, Any, Dict, Union, Literal
from typing_extensions import NotRequired
from enum import Enum

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
    "input": NotRequired[Optional[List[str]]],
    "output": NotRequired[Optional[List[str]]],
    "config": NotRequired[Optional[List[str]]]
})

ThinkingProcess = TypedDict("ThinkingProcess", {
    "index": int,
    "type": NotRequired[Optional[Literal['text']]],
})

MessageInProgress = TypedDict("MessageInProgress", {
    "id": str,
    "tool_call_id": NotRequired[Optional[str]],
    "tool_call_name": NotRequired[Optional[str]]
})

RunMetadata = TypedDict("RunMetadata", {
    "id": str,
    "schema_keys": NotRequired[Optional[SchemaKeys]],
    "node_name": NotRequired[Optional[str]],
    "prev_node_name": NotRequired[Optional[str]],
    "exiting_node": NotRequired[bool],
    "manually_emitted_state": NotRequired[Optional[State]],
    "thread_id": NotRequired[Optional[ThinkingProcess]],
    "thinking_process": NotRequired[Optional[str]]
})

MessagesInProgressRecord = Dict[str, Optional[MessageInProgress]]

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
