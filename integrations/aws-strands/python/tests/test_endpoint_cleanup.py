"""Deterministic cleanup coverage for the public streaming endpoint."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable
from typing import Any, Protocol, TypeVar

import pytest
from ag_ui.core import EventType, RunAgentInput, RunStartedEvent
from fastapi import FastAPI, Request
from starlette.requests import ClientDisconnect

import ag_ui_strands.endpoint as endpoint_module
from ag_ui_strands.endpoint import add_strands_fastapi_endpoint


_T = TypeVar("_T")
_WAIT_TIMEOUT_SECONDS = 5.0


async def _bounded_wait(awaitable: Awaitable[_T]) -> _T:
    return await asyncio.wait_for(awaitable, timeout=_WAIT_TIMEOUT_SECONDS)


class _EndpointAgent(Protocol):
    def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]: ...


class _CleanupGatedEndpointAgent:
    def __init__(
        self,
        cleanup_error: BaseException | None = None,
        *,
        block_iteration: bool = False,
    ) -> None:
        self.iteration_blocked = asyncio.Event()
        self.allow_iteration = asyncio.Event()
        self.cleanup_started = asyncio.Event()
        self.allow_cleanup = asyncio.Event()
        self.cleanup_finished = asyncio.Event()
        self.active_threads: set[str] = set()
        self.delegates: list[AsyncIterator[Any]] = []
        self.calls = 0
        self.cleanup_error = cleanup_error
        self.block_iteration = block_iteration

    def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        async def stream() -> AsyncIterator[Any]:
            thread_id = input_data.thread_id or "default"
            # This double's own way of making "the claim is still held"
            # observable. The adapter answers a contender with
            # RUN_ERROR/THREAD_BUSY; these tests are about endpoint cleanup,
            # not that contract, and a raise is the sharper signal here.
            if thread_id in self.active_threads:
                raise RuntimeError(f"run already active for thread_id={thread_id!r}")

            self.active_threads.add(thread_id)
            self.calls += 1
            invocation = self.calls
            try:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=thread_id,
                    run_id=input_data.run_id,
                )
                if invocation == 1 and self.block_iteration:
                    self.iteration_blocked.set()
                    await self.allow_iteration.wait()
            finally:
                try:
                    if invocation == 1:
                        self.cleanup_started.set()
                        await self.allow_cleanup.wait()
                        self.cleanup_finished.set()
                        if self.cleanup_error is not None:
                            raise self.cleanup_error
                finally:
                    self.active_threads.discard(thread_id)

        delegate = stream()
        self.delegates.append(delegate)
        return delegate

    async def close_delegates(self) -> None:
        self.allow_cleanup.set()
        for delegate in self.delegates:
            await _bounded_wait(delegate.aclose())


class _CancellationEntryEndpointStream:
    def __init__(
        self,
        owner: "_CancellationEntryEndpointAgent",
        input_data: RunAgentInput,
    ) -> None:
        self._owner = owner
        self._input_data = input_data
        self._invocation: int | None = None
        self._closed = False

    def __aiter__(self) -> "_CancellationEntryEndpointStream":
        return self

    async def __anext__(self) -> Any:
        thread_id = self._input_data.thread_id or "default"
        if self._invocation is None:
            # Same claim-held signal as _CleanupGatedEndpointAgent above.
            if thread_id in self._owner.active_threads:
                raise RuntimeError(f"run already active for thread_id={thread_id!r}")
            self._owner.active_threads.add(thread_id)
            self._owner.calls += 1
            self._invocation = self._owner.calls
            return RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=thread_id,
                run_id=self._input_data.run_id,
            )

        if self._invocation == 1:
            self._owner.iteration_blocked.set()
            await self._owner.allow_iteration.wait()
        raise StopAsyncIteration

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._invocation is None:
            return

        thread_id = self._input_data.thread_id or "default"
        try:
            if self._invocation == 1:
                self._owner.cleanup_started.set()
                await self._owner.allow_cleanup.wait()
                self._owner.cleanup_finished.set()
                raise self._owner.cleanup_error
        finally:
            self._owner.active_threads.discard(thread_id)


class _CancellationEntryEndpointAgent:
    def __init__(self, cleanup_error: RuntimeError) -> None:
        self.iteration_blocked = asyncio.Event()
        self.allow_iteration = asyncio.Event()
        self.cleanup_started = asyncio.Event()
        self.allow_cleanup = asyncio.Event()
        self.cleanup_finished = asyncio.Event()
        self.active_threads: set[str] = set()
        self.cleanup_error = cleanup_error
        self.delegates: list[_CancellationEntryEndpointStream] = []
        self.calls = 0

    def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        delegate = _CancellationEntryEndpointStream(self, input_data)
        self.delegates.append(delegate)
        return delegate

    async def close_delegates(self) -> None:
        self.allow_cleanup.set()
        for delegate in self.delegates:
            await _bounded_wait(delegate.aclose())


def _input(run_id: str) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id=run_id,
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _response(
    agent: _EndpointAgent,
    input_data: RunAgentInput,
):
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/agent")
    route = next(route for route in app.routes if route.path == "/agent")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/agent",
            "headers": [(b"accept", b"text/event-stream")],
        }
    )
    return await route.endpoint(input_data, request)


async def _assert_replacement_succeeds(
    agent: _EndpointAgent,
) -> None:
    replacement = agent.run(_input("run-2"))
    try:
        event = await _bounded_wait(replacement.__anext__())
        assert event.type == EventType.RUN_STARTED
    finally:
        await _bounded_wait(replacement.aclose())


@pytest.mark.asyncio
async def test_body_iterator_close_joins_inner_run_cleanup():
    agent = _CleanupGatedEndpointAgent()
    response = await _response(agent, _input("run-1"))
    body_iterator = response.body_iterator
    assert "RUN_STARTED" in await _bounded_wait(body_iterator.__anext__())

    close_task = asyncio.create_task(body_iterator.aclose())
    try:
        await _bounded_wait(agent.cleanup_started.wait())
        assert not close_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            contender = agent.run(_input("run-contender"))
            await _bounded_wait(contender.__anext__())
    finally:
        agent.allow_cleanup.set()
        await asyncio.gather(close_task, return_exceptions=True)
        await agent.close_delegates()

    assert agent.cleanup_finished.is_set()
    await _assert_replacement_succeeds(agent)


@pytest.mark.asyncio
async def test_response_disconnect_joins_body_and_inner_run_cleanup():
    agent = _CleanupGatedEndpointAgent()
    response = await _response(agent, _input("run-1"))

    async def receive() -> dict[str, Any]:
        raise AssertionError("ASGI 2.4 streaming must not poll receive")

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body" and message["body"]:
            raise OSError("client disconnected")

    response_task = asyncio.create_task(
        response(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.4"},
            },
            receive,
            send,
        )
    )
    response_outcome: BaseException | None = None
    try:
        await _bounded_wait(agent.cleanup_started.wait())
        assert not response_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            contender = agent.run(_input("run-contender"))
            await _bounded_wait(contender.__anext__())
    finally:
        agent.allow_cleanup.set()
        response_outcome = (
            await _bounded_wait(asyncio.gather(response_task, return_exceptions=True))
        )[0]
        await agent.close_delegates()

    assert isinstance(response_outcome, ClientDisconnect)
    assert agent.cleanup_finished.is_set()
    await _assert_replacement_succeeds(agent)


@pytest.mark.asyncio
async def test_encoding_error_break_joins_inner_run_cleanup(
    monkeypatch: pytest.MonkeyPatch,
):
    agent = _CleanupGatedEndpointAgent()
    original_encode = endpoint_module.EventEncoder.encode

    def encode_with_initial_failure(self: Any, event: Any) -> str:
        if event.type == EventType.RUN_STARTED:
            raise ValueError("scripted encoding failure")
        return original_encode(self, event)

    monkeypatch.setattr(
        endpoint_module.EventEncoder, "encode", encode_with_initial_failure
    )
    response = await _response(agent, _input("run-1"))
    body_iterator = response.body_iterator
    assert "ENCODING_ERROR" in await _bounded_wait(body_iterator.__anext__())

    finish_task = asyncio.create_task(body_iterator.__anext__())
    try:
        await _bounded_wait(agent.cleanup_started.wait())
        assert not finish_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            contender = agent.run(_input("run-contender"))
            await _bounded_wait(contender.__anext__())
    finally:
        agent.allow_cleanup.set()
        finish_outcome = (
            await _bounded_wait(asyncio.gather(finish_task, return_exceptions=True))
        )[0]
        await agent.close_delegates()

    assert isinstance(finish_outcome, StopAsyncIteration)
    assert agent.cleanup_finished.is_set()
    await _assert_replacement_succeeds(agent)


@pytest.mark.asyncio
@pytest.mark.parametrize("cancellation_point", ["send", "inner_stream"])
async def test_response_cancellation_wins_over_inner_cleanup_error(
    cancellation_point: str,
    caplog: pytest.LogCaptureFixture,
):
    cleanup_error = RuntimeError("inner stream cleanup failed")
    agent = _CancellationEntryEndpointAgent(cleanup_error)
    response = await _response(agent, _input("run-1"))
    send_blocked = asyncio.Event()
    allow_send = asyncio.Event()

    async def receive() -> dict[str, Any]:
        raise AssertionError("ASGI 2.4 streaming must not poll receive")

    async def send(message: dict[str, Any]) -> None:
        if (
            cancellation_point == "send"
            and message["type"] == "http.response.body"
            and message["body"]
        ):
            send_blocked.set()
            await allow_send.wait()

    response_task = asyncio.create_task(
        response(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.4"},
            },
            receive,
            send,
        )
    )
    cancellation_entry = (
        send_blocked if cancellation_point == "send" else agent.iteration_blocked
    )
    response_outcome: BaseException | None = None
    try:
        await _bounded_wait(cancellation_entry.wait())
        response_task.cancel()
        await _bounded_wait(agent.cleanup_started.wait())
        assert not response_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            contender = agent.run(_input("run-contender"))
            await _bounded_wait(contender.__anext__())
        assert agent.calls == 1
    finally:
        agent.allow_cleanup.set()
        allow_send.set()
        response_outcome = (
            await _bounded_wait(asyncio.gather(response_task, return_exceptions=True))
        )[0]
        await agent.close_delegates()

    assert isinstance(response_outcome, asyncio.CancelledError)
    cleanup_records = [
        record
        for record in caplog.records
        if record.message == "Endpoint stream cleanup failed during caller cancellation"
    ]
    assert len(cleanup_records) == 1
    assert cleanup_records[0].exc_info is not None
    assert cleanup_records[0].exc_info[1] is cleanup_error
    assert agent.cleanup_finished.is_set()
    assert not any(
        "_drain_cleanup.<locals>.capture_cleanup_outcome"
        in task.get_coro().__qualname__
        for task in asyncio.all_tasks()
    )
    await _assert_replacement_succeeds(agent)
    assert agent.calls == 2


@pytest.mark.asyncio
async def test_real_inner_generator_cleanup_cannot_mask_response_cancellation(
    caplog: pytest.LogCaptureFixture,
):
    cleanup_error = RuntimeError("real endpoint generator cleanup failed")
    agent = _CleanupGatedEndpointAgent(
        cleanup_error,
        block_iteration=True,
    )
    response = await _response(agent, _input("run-1"))

    async def receive() -> dict[str, Any]:
        raise AssertionError("ASGI 2.4 streaming must not poll receive")

    async def send(message: dict[str, Any]) -> None:
        del message

    response_task = asyncio.create_task(
        response(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.4"},
            },
            receive,
            send,
        )
    )
    response_outcome: BaseException | None = None
    try:
        await _bounded_wait(agent.iteration_blocked.wait())
        response_task.cancel()
        await _bounded_wait(agent.cleanup_started.wait())
        assert not response_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            contender = agent.run(_input("run-contender"))
            await _bounded_wait(contender.__anext__())
        assert agent.calls == 1
    finally:
        agent.allow_cleanup.set()
        agent.allow_iteration.set()
        response_outcome = (
            await _bounded_wait(asyncio.gather(response_task, return_exceptions=True))
        )[0]
        await agent.close_delegates()

    assert isinstance(response_outcome, asyncio.CancelledError)
    cleanup_records = [
        record
        for record in caplog.records
        if record.message == "Endpoint stream cleanup failed during caller cancellation"
    ]
    assert len(cleanup_records) == 1
    assert cleanup_records[0].exc_info is not None
    assert cleanup_records[0].exc_info[1] is cleanup_error
    assert "CancelledError" in caplog.text
    assert agent.cleanup_finished.is_set()
    assert not any(
        "_drain_cleanup.<locals>.capture_cleanup_outcome"
        in task.get_coro().__qualname__
        for task in asyncio.all_tasks()
    )
    await _assert_replacement_succeeds(agent)
    assert agent.calls == 2
