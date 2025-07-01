from typing import Literal, List, Any
from crewai.utilities.events import (
    FlowStartedEvent,
    FlowFinishedEvent,
    MethodExecutionStartedEvent,
    MethodExecutionFinishedEvent
)
from crewai.utilities.events.base_event_listener import BaseEventListener
from crewai.utilities.events.base_events import BaseEvent

from ag_ui.core import EventType, Message, State

from .sdk import (
    litellm_messages_to_ag_ui_messages,
    BridgedTextMessageChunkEvent,
    BridgedToolCallChunkEvent,
    BridgedCustomEvent,
    BridgedStateSnapshotEvent,
)

class EnterpriseRunStartedEvent(BaseEvent):
    """Enterprise run started event"""
    type: Literal[EventType.RUN_STARTED]

class EnterpriseRunFinishedEvent(BaseEvent):
    """Enterprise run finished event"""
    type: Literal[EventType.RUN_FINISHED]

class EnterpriseStepStartedEvent(BaseEvent):
    """Enterprise step started event"""
    type: Literal[EventType.STEP_STARTED]

class EnterpriseStepFinishedEvent(BaseEvent):
    """Enterprise step finished event"""
    type: Literal[EventType.STEP_FINISHED]

class EnterpriseMessagesSnapshotEvent(BaseEvent):
    """Enterprise messages snapshot event"""
    type: Literal[EventType.MESSAGES_SNAPSHOT]
    messages: List[Message]

class EnterpriseStateSnapshotEvent(BaseEvent):
    """Enterprise state snapshot event"""
    type: Literal[EventType.STATE_SNAPSHOT]
    snapshot: State

class EnterpriseTextMessageChunkEvent(BaseEvent):
    """Enterprise text message chunk event"""
    type: Literal[EventType.TEXT_MESSAGE_CHUNK]
    message_id: str
    role: Literal["assistant"]
    delta: str

class EnterpriseToolCallChunkEvent(BaseEvent):
    """Enterprise tool call chunk event"""
    type: Literal[EventType.TOOL_CALL_CHUNK]
    tool_call_id: str
    tool_call_name: str
    delta: str

class EnterpriseCustomEvent(BaseEvent):
    """Enterprise custom event"""
    type: Literal[EventType.CUSTOM]
    name: str
    value: Any

class CrewEnterpriseEventListener(BaseEventListener):
    """
    This class is used to produce custom events when running a crewai flow on CrewAI Enterprise.
    NOTE: These listeners only fire when the Flow is not run on enterprise.
    """
    def setup_listeners(self, crewai_event_bus):
        @crewai_event_bus.on(FlowStartedEvent)
        def _(source, event):  # pylint: disable=unused-argument
            crewai_event_bus.emit(
                source,
                EnterpriseRunStartedEvent(
                  type=EventType.RUN_STARTED
                )
            )

        @crewai_event_bus.on(FlowFinishedEvent)
        def _(source, event):  # pylint: disable=unused-argument
            crewai_event_bus.emit(
                source,
                EnterpriseRunFinishedEvent(
                  type=EventType.RUN_FINISHED
                )
            )

        @crewai_event_bus.on(MethodExecutionStartedEvent)
        def _(source, event):  # pylint: disable=unused-argument
            crewai_event_bus.emit(
                source,
                EnterpriseStepStartedEvent(
                  type=EventType.STEP_STARTED,
                  step_name=event.method_name
                )
            )

        @crewai_event_bus.on(MethodExecutionFinishedEvent)
        def _(source, event):
            messages = litellm_messages_to_ag_ui_messages(source.state.messages)

            crewai_event_bus.emit(
                source,
                EnterpriseMessagesSnapshotEvent(
                  type=EventType.MESSAGES_SNAPSHOT,
                  messages=messages
                )
            )

            crewai_event_bus.emit(
                source,
                EnterpriseStateSnapshotEvent(
                  type=EventType.STATE_SNAPSHOT,
                  snapshot=source.state
                )
            )

            crewai_event_bus.emit(
                source,
                EnterpriseStepFinishedEvent(
                  type=EventType.STEP_FINISHED,
                  step_name=event.method_name
                )
            )

        @crewai_event_bus.on(BridgedTextMessageChunkEvent)
        def _(source, event):  # pylint: disable=unused-argument
            crewai_event_bus.emit(
                source,
                EnterpriseTextMessageChunkEvent(
                  type=EventType.TEXT_MESSAGE_CHUNK,
                  message_id=event.message_id,
                  role=event.role,
                  delta=event.delta
                )
            )

        @crewai_event_bus.on(BridgedToolCallChunkEvent)
        def _(source, event):  # pylint: disable=unused-argument
            crewai_event_bus.emit(
                source,
                EnterpriseToolCallChunkEvent(
                  type=EventType.TOOL_CALL_CHUNK,
                  tool_call_id=event.tool_call_id,
                  tool_call_name=event.tool_call_name,
                  delta=event.delta
                )
            )


        @crewai_event_bus.on(BridgedCustomEvent)
        def _(source, event):  # pylint: disable=unused-argument
            crewai_event_bus.emit(
                source,
                EnterpriseCustomEvent(
                  type=EventType.CUSTOM,
                  name=event.name,
                  value=event.value
                )
            )

        @crewai_event_bus.on(BridgedStateSnapshotEvent)
        def _(source, event):  # pylint: disable=unused-argument
            crewai_event_bus.emit(
                source,
                EnterpriseStateSnapshotEvent(
                  type=EventType.STATE_SNAPSHOT,
                  snapshot=event.snapshot
                )
            )
