"""Translates OpenResponses SSE events to AG-UI events."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from ag_ui.core import (
    BaseEvent,
    EventType,
    RunErrorEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)

from ..types import OpenResponsesSSEEvent
from .tool_call_handler import ToolCallHandler

logger = logging.getLogger(__name__)


class EventTranslator:
    """Translates OpenResponses SSE events to AG-UI BaseEvents.

    Key patterns:
    - Consistent message_id tracking across text events
    - Consistent tool_call_id tracking across tool events
    - Proper event sequencing (START -> CONTENT/ARGS -> END)
    """

    def __init__(self) -> None:
        """Initialize the translator."""
        self._current_message_id: str | None = None
        self._message_counter: int = 0
        self._response_id: str | None = None

    def translate(
        self,
        event: OpenResponsesSSEEvent,
        tool_call_handler: ToolCallHandler,
    ) -> list[BaseEvent]:
        """Translate an OpenResponses SSE event to AG-UI events.

        May return multiple events for a single SSE event.

        Args:
            event: The OpenResponses SSE event to translate.
            tool_call_handler: Handler for tracking tool call state.

        Returns:
            List of AG-UI events (may be empty).
        """
        events: list[BaseEvent] = []

        event_type = event.type

        if event_type == "response.created":
            # Capture response_id for stateful mode
            self._response_id = event.data.get("response", {}).get("id")
            logger.debug(f"Response created with id: {self._response_id}")

        elif event_type == "response.in_progress":
            # Could emit a custom "in progress" event if needed
            pass

        elif event_type == "response.output_item.added":
            item = event.data.get("item", {})
            item_type = item.get("type")

            if item_type == "function_call":
                # Tool call starting
                tool_call_id = (
                    item.get("call_id")
                    or item.get("id")
                    or self._generate_tool_call_id()
                )
                tool_name = item.get("name", "")
                tool_call_handler.start_tool_call(tool_call_id, tool_name)
                events.append(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=tool_call_id,
                        tool_call_name=tool_name,
                        parent_message_id=self._current_message_id,
                    )
                )

            elif item_type == "message" and item.get("role") == "assistant":
                # Text message starting
                self._current_message_id = item.get("id") or self._generate_message_id()
                events.append(
                    TextMessageStartEvent(
                        type=EventType.TEXT_MESSAGE_START,
                        message_id=self._current_message_id,
                        role="assistant",
                    )
                )

        elif event_type == "response.output_text.delta":
            # Ensure we have a message ID (start event may have been missed)
            if not self._current_message_id:
                self._current_message_id = self._generate_message_id()
                events.append(
                    TextMessageStartEvent(
                        type=EventType.TEXT_MESSAGE_START,
                        message_id=self._current_message_id,
                        role="assistant",
                    )
                )

            delta = event.data.get("delta", "")
            if delta:
                events.append(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=self._current_message_id,
                        delta=delta,
                    )
                )

        elif event_type == "response.output_text.done":
            if self._current_message_id:
                events.append(
                    TextMessageEndEvent(
                        type=EventType.TEXT_MESSAGE_END,
                        message_id=self._current_message_id,
                    )
                )

        elif event_type == "response.output_item.done":
            done_item = event.data.get("item", {})
            if done_item.get("type") == "function_call":
                tool_call_id = done_item.get("call_id") or done_item.get("id")
                if tool_call_id:
                    tool_call = tool_call_handler.end_tool_call(tool_call_id)
                    if tool_call:
                        events.append(
                            ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=tool_call.id,
                            )
                        )

        elif event_type == "response.function_call_arguments.delta":
            delta = event.data.get("delta", "")
            current_call_id = tool_call_handler.get_current_call_id()
            if delta and current_call_id:
                tool_call_handler.append_arguments(delta)
                events.append(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=current_call_id,
                        delta=delta,
                    )
                )

        elif event_type == "response.completed":
            # Reset state for next run
            self._current_message_id = None
            logger.debug("Response completed")

        elif event_type == "response.failed":
            error_data = event.data.get("error", {})
            error_message = error_data.get("message", "Unknown error")
            error_code = error_data.get("code")
            events.append(
                RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=error_message,
                    code=error_code,
                )
            )

        return events

    def get_response_id(self) -> str | None:
        """Get the response ID from the current/last response.

        Returns:
            The response ID, or None if not available.
        """
        return self._response_id

    def build_state_snapshot(self, additional_state: dict[str, Any] | None = None) -> StateSnapshotEvent:
        """Build a STATE_SNAPSHOT event with response_id.

        Args:
            additional_state: Additional state to include in snapshot.

        Returns:
            StateSnapshotEvent with openresponses_state.
        """
        state: dict[str, Any] = {}

        openresponses_state: dict[str, Any] = {}
        if self._response_id:
            openresponses_state["response_id"] = self._response_id

        if openresponses_state:
            state["openresponses_state"] = openresponses_state

        if additional_state:
            state.update(additional_state)

        return StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot=state,
        )

    def reset(self) -> None:
        """Reset translator state for a new run."""
        self._current_message_id = None
        self._message_counter = 0
        self._response_id = None

    def _generate_message_id(self) -> str:
        """Generate a unique message ID."""
        self._message_counter += 1
        timestamp = int(time.time() * 1000)
        return f"msg_{self._message_counter}_{timestamp}"

    def _generate_tool_call_id(self) -> str:
        """Generate a unique tool call ID."""
        timestamp = int(time.time() * 1000)
        unique = uuid.uuid4().hex[:7]
        return f"call_{timestamp}_{unique}"
