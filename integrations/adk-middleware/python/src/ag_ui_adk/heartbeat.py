# Copyright 2025 AG-UI Protocol Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Heartbeat plugin for SSE connection keep-alive during tool execution."""

from __future__ import annotations

import asyncio
import logging
import threading
import uuid
import weakref
from contextvars import ContextVar, Token
from typing import TYPE_CHECKING, Any, Optional, Union

from ag_ui.core import ActivitySnapshotEvent, BaseEvent, EventType
from google.adk.plugins.base_plugin import BasePlugin

if TYPE_CHECKING:
    from google.adk.tools.base_tool import BaseTool
    from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

# ContextVar stores the AG-UI event queue per async context (per-request).
# Set by ADKAgent._run_adk_in_background before running ADK, cleared after.
_event_queue_var: ContextVar[Optional[asyncio.Queue[Union[BaseEvent, None]]]] = (
    ContextVar("ag_ui_event_queue", default=None)
)


def set_event_queue(
    queue: Optional[asyncio.Queue],
) -> Token[Optional[asyncio.Queue[Union[BaseEvent, None]]]]:
    """Set the AG-UI event queue for the current async context.

    Args:
        queue: The asyncio.Queue for emitting AG-UI events, or None to clear

    Returns:
        Token to restore previous value via reset_event_queue()
    """
    token = _event_queue_var.set(queue)
    if queue is not None:
        logger.debug("Event queue set for heartbeat emission: %s", id(queue))
    return token


def reset_event_queue(
    token: Token[Optional[asyncio.Queue[Union[BaseEvent, None]]]],
) -> None:
    """Restore the event queue to its previous value.

    Args:
        token: Token returned from set_event_queue()
    """
    _event_queue_var.reset(token)
    logger.debug("Event queue restored to previous value")


def get_event_queue() -> Optional[asyncio.Queue]:
    """Get the AG-UI event queue for the current async context."""
    return _event_queue_var.get()


class HeartbeatPlugin(BasePlugin):
    """ADK Plugin that emits periodic heartbeat events during tool execution.

    Extends ADK's BasePlugin to automatically emit ACTIVITY_SNAPSHOT events
    at regular intervals while tools are running, keeping SSE and serverless
    connections alive during long-running operations.
    """

    def __init__(
        self,
        interval_seconds: float = 5.0,
        activity_type: str = "TOOL_EXECUTION",
        name: str = "heartbeat",
    ):
        """Initialize the heartbeat plugin.

        Args:
            interval_seconds: Time between heartbeat events in seconds (must be > 0)
            activity_type: The activity_type field for ACTIVITY_SNAPSHOT events
            name: Plugin identifier for logging
        """
        if interval_seconds <= 0:
            raise ValueError(
                f"interval_seconds must be positive, got {interval_seconds}"
            )
        super().__init__(name=name)
        self.interval_seconds = interval_seconds
        self.activity_type = activity_type

        # Instance-scoped registry to avoid cross-instance interference
        self._active_heartbeats: dict[str, asyncio.Task[None]] = {}
        self._lock = threading.Lock()

        # Fallback mapping for contexts where setattr fails
        # WeakKeyDictionary auto-cleans when ToolContext is garbage collected
        self._context_call_ids: weakref.WeakKeyDictionary[Any, str] = (
            weakref.WeakKeyDictionary()
        )

    def _get_call_id(self, tool_context: "ToolContext") -> Optional[str]:
        """Get call_id from tool_context, checking all storage locations."""
        call_id = getattr(tool_context, "function_call_id", None)
        if call_id:
            return call_id

        call_id = getattr(tool_context, "_heartbeat_call_id", None)
        if call_id:
            return call_id

        return self._context_call_ids.get(tool_context)

    def _store_call_id(self, tool_context: "ToolContext", call_id: str) -> None:
        """Store call_id on tool_context with fallback to WeakKeyDictionary."""
        try:
            setattr(tool_context, "_heartbeat_call_id", call_id)
        except (AttributeError, TypeError):
            # Fallback: store in WeakKeyDictionary
            self._context_call_ids[tool_context] = call_id
            logger.debug("Stored call_id in WeakKeyDictionary fallback: %s", call_id)

    async def before_tool_callback(
        self,
        *,
        tool: "BaseTool",
        tool_args: dict[str, Any],
        tool_context: "ToolContext",
    ) -> Optional[dict]:
        """Start heartbeat task before tool execution."""
        queue = _event_queue_var.get()
        if queue is None:
            return None

        call_id = getattr(tool_context, "function_call_id", None)
        if not call_id:
            call_id = f"call_{uuid.uuid4().hex[:8]}"
            self._store_call_id(tool_context, call_id)

        tool_name = getattr(tool, "name", str(tool))

        async def heartbeat_loop() -> None:
            counter = 0
            message_id = f"heartbeat_{call_id}"

            while True:
                try:
                    await asyncio.sleep(self.interval_seconds)
                    counter += 1

                    event = ActivitySnapshotEvent(
                        type=EventType.ACTIVITY_SNAPSHOT,
                        message_id=message_id,
                        activity_type=self.activity_type,
                        content={
                            "status": "processing",
                            "tool_name": tool_name,
                            "heartbeat": counter,
                            "elapsed_seconds": round(
                                counter * self.interval_seconds, 1
                            ),
                        },
                        replace=True,
                    )
                    await queue.put(event)
                    logger.debug(
                        "Heartbeat %d for tool=%s, call_id=%s",
                        counter,
                        tool_name,
                        call_id,
                    )

                except asyncio.CancelledError:
                    logger.debug("Heartbeat loop cancelled for call_id=%s", call_id)
                    raise
                except Exception as e:
                    logger.warning(
                        "Error emitting heartbeat for call_id=%s: %s", call_id, e
                    )

        task = asyncio.create_task(heartbeat_loop())
        with self._lock:
            self._active_heartbeats[call_id] = task
        logger.debug(
            "Started heartbeat for tool=%s, call_id=%s, interval=%ss",
            tool_name,
            call_id,
            self.interval_seconds,
        )

        try:
            event = ActivitySnapshotEvent(
                type=EventType.ACTIVITY_SNAPSHOT,
                message_id=f"heartbeat_{call_id}",
                activity_type=self.activity_type,
                content={
                    "status": "starting",
                    "tool_name": tool_name,
                },
                replace=True,
            )
            await queue.put(event)
        except Exception as e:
            logger.warning("Error emitting start event: %s", e)

        return None

    async def after_tool_callback(
        self,
        *,
        tool: "BaseTool",
        tool_args: dict[str, Any],
        tool_context: "ToolContext",
        result: dict,
    ) -> Optional[dict]:
        """Stop heartbeat task after successful tool execution."""
        call_id = self._get_call_id(tool_context)
        if not call_id:
            return None

        tool_name = getattr(tool, "name", str(tool))

        with self._lock:
            task = self._active_heartbeats.pop(call_id, None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.debug(
                "Stopped heartbeat for tool=%s, call_id=%s", tool_name, call_id
            )

        queue = _event_queue_var.get()
        if queue:
            try:
                event = ActivitySnapshotEvent(
                    type=EventType.ACTIVITY_SNAPSHOT,
                    message_id=f"heartbeat_{call_id}",
                    activity_type=self.activity_type,
                    content={
                        "status": "complete",
                        "tool_name": tool_name,
                    },
                    replace=True,
                )
                await queue.put(event)
            except Exception as e:
                logger.warning("Error emitting completion event: %s", e)

        return None

    async def on_tool_error_callback(
        self,
        *,
        tool: "BaseTool",
        tool_args: dict[str, Any],
        tool_context: "ToolContext",
        error: Exception,
    ) -> Optional[dict]:
        """Stop heartbeat task when tool execution fails."""
        call_id = self._get_call_id(tool_context)
        if not call_id:
            return None

        tool_name = getattr(tool, "name", str(tool))

        with self._lock:
            task = self._active_heartbeats.pop(call_id, None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.debug(
                "Stopped heartbeat (error) for tool=%s, call_id=%s",
                tool_name,
                call_id,
            )

        queue = _event_queue_var.get()
        if queue:
            try:
                event = ActivitySnapshotEvent(
                    type=EventType.ACTIVITY_SNAPSHOT,
                    message_id=f"heartbeat_{call_id}",
                    activity_type=self.activity_type,
                    content={
                        "status": "error",
                        "tool_name": tool_name,
                        "error": str(error),
                    },
                    replace=True,
                )
                await queue.put(event)
            except Exception as e:
                logger.warning("Error emitting error event: %s", e)

        return None

    async def close(self) -> None:
        """Clean up any remaining heartbeat tasks owned by this instance."""
        with self._lock:
            call_ids = list(self._active_heartbeats.keys())
            tasks = [self._active_heartbeats.pop(cid) for cid in call_ids]
            task_count = len(tasks)

        # Cancel all tasks
        for task in tasks:
            if not task.done():
                task.cancel()

        # Await all cancelled tasks to avoid "Task was destroyed" warnings
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        logger.debug("HeartbeatPlugin closed, cleaned up %d tasks", task_count)


async def emit_progress(
    activity_type: str,
    content: Any,
    message_id: Optional[str] = None,
    replace: bool = True,
) -> bool:
    """Emit a custom progress event during tool execution.

    For tools that need richer progress updates beyond automatic heartbeats.

    Args:
        activity_type: Type of activity (e.g., "EXTRACTION", "SEARCH")
        content: Progress content dict with status and any custom fields
        message_id: Optional message ID (auto-generated if not provided)
        replace: Whether to replace previous activity with same message_id

    Returns:
        True if event was emitted, False if no queue available.
    """
    queue = _event_queue_var.get()
    if queue is None:
        logger.debug("No event queue available for progress emission")
        return False

    event = ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT,
        message_id=message_id or f"progress_{uuid.uuid4().hex[:8]}",
        activity_type=activity_type,
        content=content,
        replace=replace,
    )

    try:
        await queue.put(event)
        logger.debug("Emitted progress: type=%s, content=%s", activity_type, content)
        return True
    except Exception as e:
        logger.warning("Failed to emit progress event: %s", e)
        return False


__all__ = [
    "HeartbeatPlugin",
    "set_event_queue",
    "reset_event_queue",
    "get_event_queue",
    "emit_progress",
]
