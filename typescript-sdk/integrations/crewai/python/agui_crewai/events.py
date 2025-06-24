"""
This file is used to bridge the events from the crewai event bus to the ag-ui event bus.
"""

from crewai.utilities.events.base_events import BaseEvent
from ag_ui.core.events import (
  ToolCallChunkEvent,
  TextMessageChunkEvent,
  CustomEvent,
  StateSnapshotEvent
)

class BridgedToolCallChunkEvent(BaseEvent, ToolCallChunkEvent):
    """Bridged tool call chunk event"""

class BridgedTextMessageChunkEvent(BaseEvent, TextMessageChunkEvent):
    """Bridged text message chunk event"""

class BridgedCustomEvent(BaseEvent, CustomEvent):
    """Bridged custom event"""

class BridgedStateSnapshotEvent(BaseEvent, StateSnapshotEvent):
    """Bridged state snapshot event"""