"""
This module contains the event types for the Agent User Interaction Protocol Python SDK.
"""

from enum import Enum
from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import Field

from .types import ConfiguredBaseModel, Message, State, Role, RunAgentInput

# Text messages can have any role except "tool"
TextMessageRole = Literal["developer", "system", "assistant", "user"]


class EventType(str, Enum):
    """
    The type of event.
    """
    TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
    TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
    TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
    TEXT_MESSAGE_CHUNK = "TEXT_MESSAGE_CHUNK"
    THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START"
    THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT"
    THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END"
    TOOL_CALL_START = "TOOL_CALL_START"
    TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
    TOOL_CALL_END = "TOOL_CALL_END"
    TOOL_CALL_CHUNK = "TOOL_CALL_CHUNK"
    TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
    THINKING_START = "THINKING_START"
    THINKING_END = "THINKING_END"
    STATE_SNAPSHOT = "STATE_SNAPSHOT"
    STATE_DELTA = "STATE_DELTA"
    MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"
    ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT"
    ACTIVITY_DELTA = "ACTIVITY_DELTA"
    RAW = "RAW"
    CUSTOM = "CUSTOM"
    RUN_STARTED = "RUN_STARTED"
    RUN_FINISHED = "RUN_FINISHED"
    RUN_ERROR = "RUN_ERROR"
    STEP_STARTED = "STEP_STARTED"
    STEP_FINISHED = "STEP_FINISHED"


class BaseEvent(ConfiguredBaseModel):
    """
    Base event for all events in the Agent User Interaction Protocol.
    """
    type: EventType
    timestamp: Optional[int] = None
    raw_event: Optional[Any] = None


class TextMessageStartEvent(BaseEvent):
    """
    Event indicating the start of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_START] = EventType.TEXT_MESSAGE_START  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    role: TextMessageRole = "assistant"


class TextMessageContentEvent(BaseEvent):
    """
    Event containing a piece of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CONTENT] = EventType.TEXT_MESSAGE_CONTENT  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    delta: str = Field(min_length=1)


class TextMessageEndEvent(BaseEvent):
    """
    Event indicating the end of a text message.
    """
    type: Literal[EventType.TEXT_MESSAGE_END] = EventType.TEXT_MESSAGE_END  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str

class TextMessageChunkEvent(BaseEvent):
    """
    Event containing a chunk of text message content.
    """
    type: Literal[EventType.TEXT_MESSAGE_CHUNK] = EventType.TEXT_MESSAGE_CHUNK  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: Optional[str] = None
    role: Optional[TextMessageRole] = None
    delta: Optional[str] = None

class ThinkingTextMessageStartEvent(BaseEvent):
    """
    Event indicating the start of a thinking text message.
    """
    type: Literal[EventType.THINKING_TEXT_MESSAGE_START] = EventType.THINKING_TEXT_MESSAGE_START  # pyright: ignore[reportIncompatibleVariableOverride]

class ThinkingTextMessageContentEvent(BaseEvent):
    """
    Event indicating a piece of a thinking text message.
    """
    type: Literal[EventType.THINKING_TEXT_MESSAGE_CONTENT] = EventType.THINKING_TEXT_MESSAGE_CONTENT  # pyright: ignore[reportIncompatibleVariableOverride]
    delta: str = Field(min_length=1)

class ThinkingTextMessageEndEvent(BaseEvent):
    """
    Event indicating the end of a thinking text message.
    """
    type: Literal[EventType.THINKING_TEXT_MESSAGE_END] = EventType.THINKING_TEXT_MESSAGE_END  # pyright: ignore[reportIncompatibleVariableOverride]

class ToolCallStartEvent(BaseEvent):
    """
    Event indicating the start of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_START] = EventType.TOOL_CALL_START  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    tool_call_name: str
    parent_message_id: Optional[str] = None


class ToolCallArgsEvent(BaseEvent):
    """
    Event containing tool call arguments.
    """
    type: Literal[EventType.TOOL_CALL_ARGS] = EventType.TOOL_CALL_ARGS  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    delta: str


class ToolCallEndEvent(BaseEvent):
    """
    Event indicating the end of a tool call.
    """
    type: Literal[EventType.TOOL_CALL_END] = EventType.TOOL_CALL_END  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str

class ToolCallChunkEvent(BaseEvent):
    """
    Event containing a chunk of tool call content.
    """
    type: Literal[EventType.TOOL_CALL_CHUNK] = EventType.TOOL_CALL_CHUNK  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: Optional[str] = None
    tool_call_name: Optional[str] = None
    parent_message_id: Optional[str] = None
    delta: Optional[str] = None

class ToolCallResultEvent(BaseEvent):
    """
    Event containing the result of a tool call.
    """
    message_id: str
    type: Literal[EventType.TOOL_CALL_RESULT] = EventType.TOOL_CALL_RESULT  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_call_id: str
    content: str
    role: Optional[Literal["tool"]] = None

class ThinkingStartEvent(BaseEvent):
    """
    Event indicating the start of a thinking step event.
    """
    type: Literal[EventType.THINKING_START] = EventType.THINKING_START  # pyright: ignore[reportIncompatibleVariableOverride]
    title: Optional[str] = None

class ThinkingEndEvent(BaseEvent):
    """
    Event indicating the end of a thinking step event.
    """
    type: Literal[EventType.THINKING_END] = EventType.THINKING_END  # pyright: ignore[reportIncompatibleVariableOverride]

class StateSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the state.
    """
    type: Literal[EventType.STATE_SNAPSHOT] = EventType.STATE_SNAPSHOT  # pyright: ignore[reportIncompatibleVariableOverride]
    snapshot: State


class StateDeltaEvent(BaseEvent):
    """
    Event containing a delta of the state.
    """
    type: Literal[EventType.STATE_DELTA] = EventType.STATE_DELTA  # pyright: ignore[reportIncompatibleVariableOverride]
    delta: List[Any]  # JSON Patch (RFC 6902)


class MessagesSnapshotEvent(BaseEvent):
    """
    Event containing a snapshot of the messages.
    """
    type: Literal[EventType.MESSAGES_SNAPSHOT] = EventType.MESSAGES_SNAPSHOT  # pyright: ignore[reportIncompatibleVariableOverride]
    messages: List[Message]


class ActivitySnapshotEvent(BaseEvent):
    """Event containing a snapshot of an activity message."""

    type: Literal[EventType.ACTIVITY_SNAPSHOT] = EventType.ACTIVITY_SNAPSHOT  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    activity_type: str
    content: Any
    replace: bool = True


class ActivityDeltaEvent(BaseEvent):
    """Event containing a JSON Patch delta for an activity message."""

    type: Literal[EventType.ACTIVITY_DELTA] = EventType.ACTIVITY_DELTA  # pyright: ignore[reportIncompatibleVariableOverride]
    message_id: str
    activity_type: str
    patch: List[Any]


class RawEvent(BaseEvent):
    """
    Event containing a raw event.
    """
    type: Literal[EventType.RAW] = EventType.RAW  # pyright: ignore[reportIncompatibleVariableOverride]
    event: Any
    source: Optional[str] = None


class CustomEvent(BaseEvent):
    """
    Event containing a custom event.
    """
    type: Literal[EventType.CUSTOM] = EventType.CUSTOM  # pyright: ignore[reportIncompatibleVariableOverride]
    name: str
    value: Any


class RunStartedEvent(BaseEvent):
    """
    Event indicating that a run has started.
    """
    type: Literal[EventType.RUN_STARTED] = EventType.RUN_STARTED  # pyright: ignore[reportIncompatibleVariableOverride]
    thread_id: str
    run_id: str
    parent_run_id: Optional[str] = None
    input: Optional[RunAgentInput] = None


class RunFinishedEvent(BaseEvent):
    """
    Event indicating that a run has finished.
    """
    type: Literal[EventType.RUN_FINISHED] = EventType.RUN_FINISHED  # pyright: ignore[reportIncompatibleVariableOverride]
    thread_id: str
    run_id: str
    result: Optional[Any] = None


class RunErrorEvent(BaseEvent):
    """
    Event indicating that a run has encountered an error.
    """
    type: Literal[EventType.RUN_ERROR] = EventType.RUN_ERROR  # pyright: ignore[reportIncompatibleVariableOverride]
    message: str
    code: Optional[str] = None


class StepStartedEvent(BaseEvent):
    """
    Event indicating that a step has started.
    """
    type: Literal[EventType.STEP_STARTED] = EventType.STEP_STARTED  # pyright: ignore[reportIncompatibleVariableOverride]
    step_name: str


class StepFinishedEvent(BaseEvent):
    """
    Event indicating that a step has finished.
    """
    type: Literal[EventType.STEP_FINISHED] = EventType.STEP_FINISHED  # pyright: ignore[reportIncompatibleVariableOverride]
    step_name: str


Event = Annotated[
    Union[
        TextMessageStartEvent,
        TextMessageContentEvent,
        TextMessageEndEvent,
        TextMessageChunkEvent,
        ToolCallStartEvent,
        ToolCallArgsEvent,
        ToolCallEndEvent,
        ToolCallChunkEvent,
        ToolCallResultEvent,
        StateSnapshotEvent,
        StateDeltaEvent,
        MessagesSnapshotEvent,
        ActivitySnapshotEvent,
        ActivityDeltaEvent,
        RawEvent,
        CustomEvent,
        RunStartedEvent,
        RunFinishedEvent,
        RunErrorEvent,
        StepStartedEvent,
        StepFinishedEvent,
    ],
    Field(discriminator="type")
]
