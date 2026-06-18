# src/ag_ui_adk/heartbeat.py

"""HeartbeatPlugin: keep SSE connections alive during long-running ADK tools.

When an ADK tool runs for tens of seconds (scraping a site, processing a
document, calling a slow external API), no data flows on the SSE stream. Many
infrastructure components treat "no data" as "connection dead" and terminate it
(AWS Lambda/API Gateway ~29s, Cloud Run ~60s, load balancers/CDNs idle
timeouts), cutting agent responses off mid-execution.

``HeartbeatPlugin`` is an ADK ``BasePlugin`` that emits periodic
``ACTIVITY_SNAPSHOT`` events while a tool is running, keeping the stream warm.

Wiring: the middleware binds the in-flight run's AG-UI event queue to a
``ContextVar`` (:func:`set_event_queue`) around ``runner.run_async``. The plugin
— attached to your ADK ``App`` via ``plugins=[HeartbeatPlugin()]`` — reads that
queue from its tool callbacks and pushes ``ACTIVITY_SNAPSHOT`` events onto it.
Each background run is its own ``asyncio.Task`` with its own context copy, so the
binding is naturally per-request isolated.

Plugins are only honored for agents constructed via ``ADKAgent.from_app(...)``
(the component-based constructor has no plugin support), so the heartbeat only
fires for ``from_app`` agents.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from contextvars import ContextVar, Token
from typing import Any, Dict, Optional

from ag_ui.core import ActivitySnapshotEvent, EventType
from google.adk.plugins.base_plugin import BasePlugin

logger = logging.getLogger(__name__)

# The in-flight run's AG-UI event queue. Bound by the middleware around
# runner.run_async so a plugin — which ADK constructs once and shares across all
# requests — can find the queue belonging to the *current* request.
_EVENT_QUEUE: ContextVar[Optional["asyncio.Queue"]] = ContextVar(
    "ag_ui_adk_event_queue", default=None
)


def set_event_queue(queue: Optional["asyncio.Queue"]) -> Token:
    """Bind ``queue`` as the current run's event queue.

    Returns a ``Token`` that :func:`reset_event_queue` can use to restore the
    previous value.
    """
    return _EVENT_QUEUE.set(queue)


def get_event_queue() -> Optional["asyncio.Queue"]:
    """Return the event queue bound for the current run, or ``None`` if unbound."""
    return _EVENT_QUEUE.get()


def reset_event_queue(token: Token) -> None:
    """Undo a previous :func:`set_event_queue` using its ``Token``."""
    try:
        _EVENT_QUEUE.reset(token)
    except (ValueError, LookupError):
        # Token created in a different context (e.g. the set happened in a parent
        # task); fall back to clearing so we never leak a stale queue.
        _EVENT_QUEUE.set(None)


def _build_activity_event(
    activity_type: str,
    status: str,
    tool_name: str,
    *,
    elapsed_seconds: float,
    heartbeat: Optional[int] = None,
    replace: bool = True,
) -> ActivitySnapshotEvent:
    """Construct an ACTIVITY_SNAPSHOT carrying tool-progress info in ``content``.

    ``content`` is the protocol's free-form ``Any`` field; the status/tool_name/
    elapsed_seconds/heartbeat live there rather than as top-level event fields
    (the event schema only defines message_id, activity_type, content, replace).
    """
    content: Dict[str, Any] = {
        "status": status,
        "tool_name": tool_name,
        "elapsed_seconds": round(elapsed_seconds, 1),
    }
    if heartbeat is not None:
        content["heartbeat"] = heartbeat
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT,
        message_id=f"heartbeat_{uuid.uuid4().hex}",
        activity_type=activity_type,
        content=content,
        replace=replace,
    )


async def emit_progress(
    activity_type: str,
    status: str,
    tool_name: str,
    *,
    elapsed_seconds: float = 0.0,
    heartbeat: Optional[int] = None,
    replace: bool = True,
    queue: Optional["asyncio.Queue"] = None,
) -> bool:
    """Emit a single ACTIVITY_SNAPSHOT onto the run's event queue.

    Resolves the target queue from the ``queue`` argument or, if omitted, the
    current :func:`get_event_queue` binding. Returns ``True`` if an event was
    enqueued, or ``False`` when no queue is bound — making it a safe no-op when
    called outside an in-flight run.
    """
    queue = queue if queue is not None else get_event_queue()
    if queue is None:
        return False
    await queue.put(
        _build_activity_event(
            activity_type,
            status,
            tool_name,
            elapsed_seconds=elapsed_seconds,
            heartbeat=heartbeat,
            replace=replace,
        )
    )
    return True


class HeartbeatPlugin(BasePlugin):
    """Emit periodic ACTIVITY_SNAPSHOT heartbeats while ADK tools execute.

    Args:
        name: Plugin identifier (ADK requires plugin names to be unique).
        interval_seconds: Seconds between ``processing`` heartbeats while a tool
            runs. Must be > 0.
        activity_type: ``activity_type`` stamped on emitted events.

    Usage::

        from ag_ui_adk import ADKAgent, HeartbeatPlugin
        from google.adk.apps import App

        app = App(name="my_app", root_agent=agent, plugins=[HeartbeatPlugin()])
        adk_agent = ADKAgent.from_app(app, user_id="user123")
    """

    def __init__(
        self,
        name: str = "heartbeat",
        interval_seconds: float = 5.0,
        activity_type: str = "TOOL_EXECUTION",
    ):
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be positive")
        super().__init__(name=name)
        self.interval_seconds = interval_seconds
        self.activity_type = activity_type
        # Per in-flight tool call. The plugin instance is shared across
        # concurrent requests, so state must be keyed off the tool call — never
        # stored as a single shared attribute.
        self._tasks: Dict[Any, asyncio.Task] = {}

    @staticmethod
    def _key(tool_context: Any) -> Any:
        return getattr(tool_context, "function_call_id", None) or id(tool_context)

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
        queue = get_event_queue()
        if queue is None:
            # No AG-UI stream bound (e.g. plugin used outside the middleware).
            return None

        tool_name = getattr(tool, "name", "tool")
        await emit_progress(
            self.activity_type, "starting", tool_name, elapsed_seconds=0.0, queue=queue
        )

        start = time.monotonic()

        async def _beat() -> None:
            count = 0
            # Bind the queue captured at callback time rather than re-reading the
            # ContextVar here: the var may be reset by the time this task runs.
            while True:
                await asyncio.sleep(self.interval_seconds)
                count += 1
                await emit_progress(
                    self.activity_type,
                    "processing",
                    tool_name,
                    elapsed_seconds=time.monotonic() - start,
                    heartbeat=count,
                    queue=queue,
                )

        self._tasks[self._key(tool_context)] = asyncio.create_task(_beat())
        return None

    async def after_tool_callback(self, *, tool, tool_args, tool_context, result):
        await self._finish(tool, tool_context, "complete")
        return None

    async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error):
        await self._finish(tool, tool_context, "error")
        return None

    async def _finish(self, tool, tool_context, status: str) -> None:
        """Cancel the heartbeat task for this tool call and emit a terminal event."""
        task = self._tasks.pop(self._key(tool_context), None)
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        tool_name = getattr(tool, "name", "tool")
        await emit_progress(self.activity_type, status, tool_name)
