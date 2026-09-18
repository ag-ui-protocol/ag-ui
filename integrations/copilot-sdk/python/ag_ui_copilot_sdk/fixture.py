"""Explicit, text-only synthetic SDK test double for offline agentic-chat CI."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any
from uuid import UUID

from copilot.session_events import SessionEvent

GREETING_CHUNKS = (
    "hello from the synthetic Copilot SDK fixture, ",
    "with no model request ",
    "or credentials used.",
)


class FixtureSession:
    def __init__(self, session_id: str, on_event: Callable[[SessionEvent], None]):
        self.session_id = session_id
        self.handlers = {on_event}
        self.task: asyncio.Task[None] | None = None
        self.closed = False
        self.turn = 0
        self.sequence = 0

    def on(self, handler: Callable[[SessionEvent], None]) -> Callable[[], None]:
        self.handlers.add(handler)
        return lambda: self.handlers.discard(handler)

    def _emit(self, kind: str, data: dict[str, Any]) -> None:
        self.sequence += 1
        event = SessionEvent.from_dict(
            {
                "id": str(UUID(int=self.sequence)),
                "timestamp": "2026-01-01T00:00:00Z",
                "parentId": None,
                "type": kind,
                "data": data,
            }
        )
        for handler in self.handlers.copy():
            handler(event)

    async def _respond(self, message_id: str) -> None:
        self._emit("assistant.message_start", {"messageId": message_id})
        for chunk in GREETING_CHUNKS:
            await asyncio.sleep(0.02)
            self._emit("assistant.message_delta", {"messageId": message_id, "deltaContent": chunk})
        self._emit(
            "assistant.message", {"messageId": message_id, "content": "".join(GREETING_CHUNKS)}
        )
        self._emit("session.idle", {})

    async def send(self, prompt: str) -> str:
        if self.closed:
            raise RuntimeError("Synthetic session is closed")
        if self.task is not None and not self.task.done():
            raise RuntimeError("Synthetic session already has an active turn")
        self.turn += 1
        message_id = f"fixture-message-{self.turn}"
        self.task = asyncio.create_task(self._respond(message_id))
        return message_id

    async def abort(self) -> None:
        if self.task is not None:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            finally:
                self.task = None

    async def disconnect(self) -> None:
        self.closed = True
        try:
            await self.abort()
        finally:
            self.handlers.clear()


class FixtureClient:
    """No runtime process, network client, credentials, or authentication stubs."""

    def __init__(self):
        self.started = False
        self.sessions: list[FixtureSession] = []
        self.session_count = 0

    async def start(self) -> None:
        self.started = True

    async def create_session(
        self, *, on_event: Callable[[SessionEvent], None], **options: Any
    ) -> FixtureSession:
        if not self.started:
            raise RuntimeError("Synthetic client is not started")
        self.sessions = [session for session in self.sessions if not session.closed]
        self.session_count += 1
        session = FixtureSession(f"fixture-session-{self.session_count}", on_event)
        self.sessions.append(session)
        return session

    async def stop(self) -> None:
        try:
            await asyncio.gather(*(session.disconnect() for session in self.sessions))
        finally:
            self.sessions.clear()
            self.started = False

    async def force_stop(self) -> None:
        await self.stop()
