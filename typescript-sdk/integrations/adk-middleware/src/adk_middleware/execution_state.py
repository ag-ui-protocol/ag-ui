# src/adk_middleware/execution_state.py

"""Execution state management for background ADK runs with tool support."""

import asyncio
import time
from typing import Dict, Optional, Any
import logging

logger = logging.getLogger(__name__)


class ExecutionState:
    """Manages the state of a background ADK execution with tool support.
    
    This class tracks:
    - The background asyncio task running the ADK agent
    - Event queue for streaming results to the client
    - Tool futures for pending tool executions
    - Execution timing and completion state
    """
    
    def __init__(
        self,
        task: asyncio.Task,
        thread_id: str,
        event_queue: asyncio.Queue,
        tool_futures: Dict[str, asyncio.Future]
    ):
        """Initialize execution state.
        
        Args:
            task: The asyncio task running the ADK agent
            thread_id: The thread ID for this execution
            event_queue: Queue containing events to stream to client
            tool_futures: Dict mapping tool_call_id to Future objects
        """
        self.task = task
        self.thread_id = thread_id
        self.event_queue = event_queue
        self.tool_futures = tool_futures
        self.start_time = time.time()
        self.is_complete = False
        
        logger.debug(f"Created execution state for thread {thread_id}")
    
    def is_stale(self, timeout_seconds: int) -> bool:
        """Check if this execution has been running too long.
        
        Args:
            timeout_seconds: Maximum execution time in seconds
            
        Returns:
            True if execution has exceeded timeout
        """
        return time.time() - self.start_time > timeout_seconds
    
    def has_pending_tools(self) -> bool:
        """Check if there are pending tool executions.
        
        Returns:
            True if any tool futures are not done
        """
        return any(not future.done() for future in self.tool_futures.values())
    
    def resolve_tool_result(self, tool_call_id: str, result: Any) -> bool:
        """Resolve a tool execution future with the provided result.
        
        Args:
            tool_call_id: The ID of the tool call to resolve
            result: The result from the client-side tool execution
            
        Returns:
            True if the future was found and resolved, False otherwise
        """
        future = self.tool_futures.get(tool_call_id)
        if future and not future.done():
            try:
                future.set_result(result)
                logger.debug(f"Resolved tool future for {tool_call_id}")
                return True
            except Exception as e:
                logger.error(f"Error resolving tool future {tool_call_id}: {e}")
                future.set_exception(e)
                return True
        
        logger.warning(f"No pending tool future found for {tool_call_id}")
        return False
    
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
        
        # Cancel any pending tool futures
        for tool_call_id, future in self.tool_futures.items():
            if not future.done():
                logger.debug(f"Cancelling pending tool future: {tool_call_id}")
                future.cancel()
        
        self.is_complete = True
    
    def get_execution_time(self) -> float:
        """Get the total execution time in seconds.
        
        Returns:
            Time in seconds since execution started
        """
        return time.time() - self.start_time
    
    def get_status(self) -> str:
        """Get a human-readable status of the execution.
        
        Returns:
            Status string describing the current state
        """
        if self.is_complete:
            return "complete"
        elif self.task.done():
            return "task_done"
        elif self.has_pending_tools():
            pending_count = sum(1 for f in self.tool_futures.values() if not f.done())
            return f"waiting_for_tools ({pending_count} pending)"
        else:
            return "running"
    
    def __repr__(self) -> str:
        """String representation of the execution state."""
        return (
            f"ExecutionState(thread_id='{self.thread_id}', "
            f"status='{self.get_status()}', "
            f"runtime={self.get_execution_time():.1f}s, "
            f"tools={len(self.tool_futures)})"
        )