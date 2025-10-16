# src/ag_ui_adk/execution_state.py

"""Execution state management for background ADK runs with tool support."""

import asyncio
import time
from typing import Optional, Set
import logging

logger = logging.getLogger(__name__)


class ExecutionState:
    """Manages the state of a background ADK execution.

    This class tracks:
    - The background asyncio task running the ADK agent
    - Event queue for streaming results to the client
    - Execution timing and completion state
    """

    def __init__(
        self,
        task: asyncio.Task,
        thread_id: str,
        event_queue: asyncio.Queue
    ):
        """Initialize execution state.

        Args:
            task: The asyncio task running the ADK agent
            thread_id: The thread ID for this execution
            event_queue: Queue containing events to stream to client
        """
        self.task = task
        self.thread_id = thread_id
        self.event_queue = event_queue
        self.start_time = time.time()
        self.is_complete = False
        self.pending_tool_calls: Set[str] = set()  # Track outstanding tool call IDs for HITL

        logger.debug(f"Created execution state for thread {thread_id}")

    def is_stale(self, timeout_seconds: int) -> bool:
        """Check if this execution has been running too long.

        Args:
            timeout_seconds: Maximum execution time in seconds

        Returns:
            True if execution has exceeded timeout
        """
        return time.time() - self.start_time > timeout_seconds

    async def cancel(self):
        """Cancel the execution and clean up resources."""
        logger.info(f"Cancelling execution for thread {self.thread_id}")

        # Cancel the background task
        if not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

        self.is_complete = True

    def get_execution_time(self) -> float:
        """Get the total execution time in seconds.

        Returns:
            Time in seconds since execution started
        """
        return time.time() - self.start_time

    def add_pending_tool_call(self, tool_call_id: str):
        """Add a tool call ID to the pending set.

        Args:
            tool_call_id: The tool call ID to track
        """
        self.pending_tool_calls.add(tool_call_id)
        logger.debug(f"Added pending tool call {tool_call_id} to thread {self.thread_id}")

    def remove_pending_tool_call(self, tool_call_id: str):
        """Remove a tool call ID from the pending set.

        Args:
            tool_call_id: The tool call ID to remove
        """
        self.pending_tool_calls.discard(tool_call_id)
        logger.debug(f"Removed pending tool call {tool_call_id} from thread {self.thread_id}")

    def has_pending_tool_calls(self) -> bool:
        """Check if there are outstanding tool calls waiting for responses.

        Returns:
            True if there are pending tool calls (HITL scenario)
        """
        return len(self.pending_tool_calls) > 0

    def get_status(self) -> str:
        """Get a human-readable status of the execution.

        Returns:
            Status string describing the current state
        """
        if self.is_complete:
            if self.has_pending_tool_calls():
                return "complete_awaiting_tools"
            else:
                return "complete"
        elif self.task.done():
            return "task_done"
        else:
            return "running"

    def __repr__(self) -> str:
        """String representation of the execution state."""
        return (
            f"ExecutionState(thread_id='{self.thread_id}', "
            f"status='{self.get_status()}', "
            f"runtime={self.get_execution_time():.1f}s)"
        )