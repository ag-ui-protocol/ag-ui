"""Manages tool call state during streaming responses."""

from __future__ import annotations

from ..types import PendingToolCall, ToolCallState


class ToolCallHandler:
    """Manages tool call state during streaming responses.

    Tracks current_tool_call_id and pending state updates to ensure
    proper event sequencing and argument accumulation.
    """

    def __init__(self) -> None:
        """Initialize the handler with empty state."""
        self._state = ToolCallState()

    def start_tool_call(self, call_id: str, name: str) -> None:
        """Start tracking a new tool call.

        Args:
            call_id: Unique identifier for this tool call.
            name: Name of the tool being called.
        """
        self._state.current_call_id = call_id
        self._state.arguments_buffer = ""
        self._state.pending_calls[call_id] = PendingToolCall(
            id=call_id,
            name=name,
            arguments="",
        )

    def append_arguments(self, delta: str) -> None:
        """Append arguments delta to the current tool call.

        Args:
            delta: JSON string chunk to append.
        """
        self._state.arguments_buffer += delta
        current = self._state.current_call_id
        if current and current in self._state.pending_calls:
            self._state.pending_calls[current].arguments += delta

    def end_tool_call(self, call_id: str) -> PendingToolCall | None:
        """End the current tool call and return the completed call data.

        Args:
            call_id: ID of the tool call to end.

        Returns:
            The completed tool call data, or None if not found.
        """
        call = self._state.pending_calls.pop(call_id, None)
        if call and self._state.current_call_id == call_id:
            self._state.current_call_id = None
            self._state.arguments_buffer = ""
        return call

    def get_current_call_id(self) -> str | None:
        """Get the current tool call ID.

        Returns:
            The current tool call ID, or None if no call is in progress.
        """
        return self._state.current_call_id

    def get_pending_calls(self) -> list[PendingToolCall]:
        """Get all pending tool calls.

        Returns:
            List of pending tool calls.
        """
        return list(self._state.pending_calls.values())

    def has_pending_calls(self) -> bool:
        """Check if there are any pending tool calls.

        Returns:
            True if there are pending calls, False otherwise.
        """
        return len(self._state.pending_calls) > 0

    def reset(self) -> None:
        """Reset state for a new run."""
        self._state = ToolCallState()
