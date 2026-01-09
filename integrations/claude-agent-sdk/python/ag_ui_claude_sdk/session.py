"""Session worker for Claude Agent SDK.

Owns one ClaudeSDKClient per thread in a long-lived background task.
Uses queue-based communication to avoid receive_response() issues
on multi-turn conversations.
"""

import asyncio
import logging
from contextlib import suppress
from typing import Any, AsyncIterator, Optional

logger = logging.getLogger(__name__)

_SHUTDOWN = object()


class WorkerError:
    """Sentinel to signal an error from the background worker."""
    def __init__(self, exception: Exception):
        self.exception = exception


class SessionWorker:
    """Background task owning one ClaudeSDKClient for a thread.

    The task is created by :meth:`start` and runs until :meth:`stop` is
    called (or the client errors out). Request handlers call :meth:`query`
    which bridges to the background task via a pair of asyncio queues.
    """

    def __init__(self, thread_id: str, options: Any):
        self.thread_id = thread_id
        self._options = options
        self._input_queue: asyncio.Queue = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        self._client: Optional[Any] = None
        self.session_id: Optional[str] = None

    async def start(self) -> None:
        """Spawn the background task that owns the SDK client."""
        if self._task is not None:
            return
        self._task = asyncio.create_task(
            self._run(), name=f"session-worker-{self.thread_id}"
        )

    async def _run(self) -> None:
        """Main loop — runs entirely inside one stable async context."""
        from claude_agent_sdk import ClaudeSDKClient, SystemMessage

        client = ClaudeSDKClient(options=self._options)
        self._client = client

        try:
            await client.connect()
            logger.debug(f"Session worker connected for thread={self.thread_id}")

            while True:
                item = await self._input_queue.get()
                if item is _SHUTDOWN:
                    break

                prompt, session_id, output_queue = item
                try:
                    await client.query(prompt, session_id=session_id)
                    async for msg in client.receive_response():
                        if isinstance(msg, SystemMessage):
                            data = getattr(msg, "data", {}) or {}
                            if getattr(msg, "subtype", "") == "init":
                                sid = data.get("session_id")
                                if sid:
                                    self.session_id = sid
                        await output_queue.put(msg)
                except Exception as exc:
                    logger.error(f"Session worker query error for thread={self.thread_id}: {exc}")
                    await output_queue.put(WorkerError(exc))
                finally:
                    await output_queue.put(None)

        except Exception as exc:
            logger.error(f"Session worker fatal error for thread={self.thread_id}: {exc}")
        finally:
            self._client = None
            await self._graceful_disconnect(client)
            logger.debug(f"Session worker disconnected for thread={self.thread_id}")

    @staticmethod
    async def _graceful_disconnect(client: Any) -> None:
        try:
            await client.disconnect()
        except Exception:
            pass

    async def query(self, prompt: str, session_id: str = "default") -> AsyncIterator[Any]:
        """Send prompt to the worker and yield SDK Message objects."""
        output_queue: asyncio.Queue = asyncio.Queue()
        await self._input_queue.put((prompt, session_id, output_queue))
        while True:
            item = await output_queue.get()
            if item is None:
                return
            if isinstance(item, WorkerError):
                raise item.exception
            yield item

    async def interrupt(self) -> None:
        """Forward an interrupt signal to the underlying SDK client."""
        if self._client is not None:
            try:
                await self._client.interrupt()
            except Exception as exc:
                logger.warning(f"Session worker interrupt failed: {exc}")

    async def stop(self) -> None:
        """Signal the worker to shut down and wait for it to finish."""
        if self._task is None:
            return
        await self._input_queue.put(_SHUTDOWN)
        try:
            await asyncio.wait_for(self._task, timeout=15.0)
        except asyncio.TimeoutError:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
        self._task = None
