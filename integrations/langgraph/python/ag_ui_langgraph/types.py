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
    OnToolError = "on_tool_error"
    OnCustomEvent = "on_custom_event"
    OnInterrupt = "on_interrupt"

class CustomEventNames(str, Enum):
    ManuallyEmitMessage = "manually_emit_message"
    ManuallyEmitToolCall = "manually_emit_tool_call"
    ManuallyEmitState = "manually_emit_state"
    Exit = "exit"

State = Dict[str, Any]

SchemaKeys = TypedDict("SchemaKeys", {
    "input": List[str],
    "output": List[str],
    "config": List[str],
    "context": List[str],
})

ThinkingProcess = TypedDict("ThinkingProcess", {
    "index": int,
    "message_id": str,
    "type": NotRequired[Optional[str]],
    "signature": NotRequired[Optional[str]],
})

MessageInProgress = TypedDict("MessageInProgress", {
    "id": str,
    "tool_call_id": NotRequired[Optional[str]],
    "tool_call_name": NotRequired[Optional[str]]
})

RunMetadata = TypedDict("RunMetadata", {
    # Identification
    "id": str,
    "thread_id": NotRequired[Optional[str]],
    # Run mode/flow
    "mode": Literal["start", "continue"],
    # Node tracking
    "node_name": NotRequired[Optional[str]],
    "prev_node_name": NotRequired[Optional[str]],
    # Schema
    "schema_keys": NotRequired[Optional[SchemaKeys]],
    # Streaming state
    "has_function_streaming": NotRequired[bool],
    "model_made_tool_call": NotRequired[bool],
    "state_reliable": NotRequired[bool],
    # Post-run MESSAGES_SNAPSHOT semantics: set True when at least one
    # subgraph-boundary snapshot fires during the stream; the post-run
    # snapshot merges streamed_messages only when this is True.
    "any_mid_stream_merge_fired": NotRequired[bool],
    # Message / state data
    "streamed_messages": NotRequired[List[Any]],
    "manually_emitted_state": NotRequired[Optional[State]],
    # Reasoning / thinking
    "reasoning_process": Optional[ThinkingProcess],
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
    "index": int,
    "signature": NotRequired[Optional[str]],
})
