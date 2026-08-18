"""Deterministic concurrency coverage for wrapper-local Strands runs."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Sequence
from dataclasses import dataclass, field
from types import MethodType
from typing import Any, TypeVar
from unittest.mock import MagicMock

import pytest
from ag_ui.core import EventType, RunAgentInput
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import (
    StrandsAgent,
    _cancellation_from_exception_chain,
)
from ag_ui_strands.config import StrandsAgentConfig


_T = TypeVar("_T")
_WAIT_TIMEOUT_SECONDS = 5.0


async def _bounded_wait(awaitable: Awaitable[_T]) -> _T:
    return await asyncio.wait_for(awaitable, timeout=_WAIT_TIMEOUT_SECONDS)


async def _cancel_and_await(*tasks: asyncio.Task[Any]) -> None:
    for task in tasks:
        if not task.done():
            task.cancel()
    await _bounded_wait(asyncio.gather(*tasks, return_exceptions=True))


async def _bounded_task(task: asyncio.Task[_T]) -> _T:
    try:
        return await _bounded_wait(asyncio.shield(task))
    finally:
        if not task.done():
            await _cancel_and_await(task)


@dataclass
class _FakeAgentResult:
    stop_reason: str = "end_turn"
    message: dict[str, Any] = field(
        default_factory=lambda: {"role": "assistant", "content": []}
    )
    metrics: Any = None
    state: Any = field(default_factory=dict)
    interrupts: Sequence[Any] | None = None
    structured_output: Any = None


class _State:
    def __init__(self) -> None:
        self.values: dict[str, Any] = {}
        self.set_calls: list[tuple[str, Any]] = []

    def get(self, key: str | None = None) -> Any:
        return dict(self.values) if key is None else self.values.get(key)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value
        self.set_calls.append((key, value))


class _InterruptState:
    activated = False
    interrupts: dict[str, Any] = {}


class _BlockingInnerAgent:
    def __init__(
        self,
        *,
        block_invocations: set[int] | None = None,
    ) -> None:
        self.state = _State()
        self._interrupt_state = _InterruptState()
        self.tool_registry = ToolRegistry()
        self.messages: list[dict[str, Any]] = []
        self.invocation_count = 0
        self._block_invocations = set(block_invocations or set())
        self._entered: dict[int, asyncio.Event] = {}
        self._release: dict[int, asyncio.Event] = {}

    def entered(self, invocation: int) -> asyncio.Event:
        return self._entered.setdefault(invocation, asyncio.Event())

    def release(self, invocation: int) -> None:
        self._release.setdefault(invocation, asyncio.Event()).set()

    async def stream_async(self, prompt: Any):
        del prompt
        self.invocation_count += 1
        invocation = self.invocation_count
        self.entered(invocation).set()
        if invocation in self._block_invocations:
            await self._release.setdefault(invocation, asyncio.Event()).wait()
        yield {"result": _FakeAgentResult()}


class _SuspendedInnerAgent(_BlockingInnerAgent):
    """Keep a strong reference to a child stream suspended at its yield."""

    def __init__(self) -> None:
        super().__init__()
        self.cleanup_finished = asyncio.Event()
        self.streams: list[Any] = []

    def stream_async(self, prompt: Any) -> AsyncIterator[Any]:
        del prompt
        self.invocation_count += 1
        self.entered(self.invocation_count).set()

        async def stream() -> AsyncIterator[Any]:
            try:
                yield {"data": "streamed"}
                yield {"result": _FakeAgentResult()}
            finally:
                self.cleanup_finished.set()

        child_stream = stream()
        self.streams.append(child_stream)
        return child_stream


class _CleanupGatedRun:
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
        self.delegates: list[AsyncIterator[Any]] = []
        self.calls = 0
        self.cleanup_error = cleanup_error
        self.block_iteration = block_iteration

    def run_unlocked(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        del input_data
        self.calls += 1
        invocation = self.calls

        async def stream() -> AsyncIterator[Any]:
            try:
                yield ("first-event" if invocation == 1 else "replacement-event")
                if invocation == 1 and self.block_iteration:
                    self.iteration_blocked.set()
                    await self.allow_iteration.wait()
            finally:
                if invocation == 1:
                    self.cleanup_started.set()
                    await self.allow_cleanup.wait()
                    self.cleanup_finished.set()
                    if self.cleanup_error is not None:
                        raise self.cleanup_error

        delegate = stream()
        self.delegates.append(delegate)
        return delegate


def test_cancellation_recovery_includes_suppressed_exception_context():
    cancellation = asyncio.CancelledError()

    try:
        raise cancellation
    except asyncio.CancelledError:
        try:
            raise RuntimeError("masked cancellation") from None
        except RuntimeError as error:
            masked_error = error

    assert masked_error.__suppress_context__
    assert masked_error.__context__ is cancellation
    assert _cancellation_from_exception_chain(masked_error) is cancellation


def test_cancellation_recovery_prefers_context_over_cleanup_cancellation():
    caller_cancellation = asyncio.CancelledError("caller")
    cleanup_cancellation = asyncio.CancelledError("cleanup child")

    try:
        raise caller_cancellation
    except asyncio.CancelledError:
        try:
            raise RuntimeError("masked cancellation") from cleanup_cancellation
        except RuntimeError as error:
            masked_error = error

    assert masked_error.__cause__ is cleanup_cancellation
    assert masked_error.__context__ is caller_cancellation
    assert _cancellation_from_exception_chain(masked_error) is caller_cancellation


class _CancellationEntryStream:
    def __init__(
        self,
        owner: "_CancellationEntryRun",
        invocation: int,
    ) -> None:
        self._owner = owner
        self._invocation = invocation
        self._yielded = False
        self._closed = False

    def __aiter__(self) -> "_CancellationEntryStream":
        return self

    async def __anext__(self) -> Any:
        if not self._yielded:
            self._yielded = True
            return "first-event" if self._invocation == 1 else "replacement-event"
        if self._invocation == 1:
            self._owner.iteration_blocked.set()
            await self._owner.allow_iteration.wait()
        raise StopAsyncIteration

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._invocation != 1:
            return

        self._owner.cleanup_started.set()
        if self._owner.cleanup_self_cancels:
            current_task = asyncio.current_task()
            assert current_task is not None
            current_task.cancel()
            try:
                await asyncio.sleep(0)
            finally:
                self._owner.cleanup_finished.set()
            return

        await self._owner.allow_cleanup.wait()
        self._owner.cleanup_finished.set()
        if self._owner.cleanup_error is not None:
            raise self._owner.cleanup_error


class _CancellationEntryRun:
    def __init__(
        self,
        cleanup_error: BaseException | None = None,
        *,
        cleanup_self_cancels: bool = False,
    ) -> None:
        self.iteration_blocked = asyncio.Event()
        self.allow_iteration = asyncio.Event()
        self.cleanup_started = asyncio.Event()
        self.allow_cleanup = asyncio.Event()
        self.cleanup_finished = asyncio.Event()
        self.cleanup_error = cleanup_error
        self.cleanup_self_cancels = cleanup_self_cancels
        self.streams: list[_CancellationEntryStream] = []
        self.calls = 0

    def run_unlocked(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        del input_data
        self.calls += 1
        stream = _CancellationEntryStream(self, self.calls)
        self.streams.append(stream)
        return stream


def _template_agent() -> MagicMock:
    template = MagicMock()
    template.model = MagicMock()
    template.system_prompt = "You are helpful"
    template.tool_registry.registry = {}
    template.record_direct_tool_call = True
    template._session_manager = None
    return template


def _build_agent(
    inners: dict[str, _BlockingInnerAgent],
) -> StrandsAgent:
    adapter = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )
    adapter._agents_by_thread.update(inners)
    return adapter


def _input(thread_id: str, run_id: str) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _collect(adapter: StrandsAgent, input_data: RunAgentInput) -> list[Any]:
    return [event async for event in adapter.run(input_data)]


@pytest.mark.asyncio
async def test_same_thread_overlap_is_rejected_before_second_strands_invocation():
    inner = _BlockingInnerAgent(block_invocations={1})
    adapter = _build_agent({"thread-1": inner})
    first = asyncio.create_task(_collect(adapter, _input("thread-1", "run-1")))

    try:
        await _bounded_wait(inner.entered(1).wait())
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            await _bounded_wait(_collect(adapter, _input("thread-1", "run-2")))
        assert inner.invocation_count == 1
    finally:
        inner.release(1)
        await _bounded_task(first)


@pytest.mark.asyncio
async def test_different_threads_can_enter_strands_concurrently():
    inner_a = _BlockingInnerAgent(block_invocations={1})
    inner_b = _BlockingInnerAgent(block_invocations={1})
    adapter = _build_agent({"a": inner_a, "b": inner_b})
    run_a = asyncio.create_task(_collect(adapter, _input("a", "run-a")))
    run_b = asyncio.create_task(_collect(adapter, _input("b", "run-b")))

    try:
        await _bounded_wait(
            asyncio.gather(inner_a.entered(1).wait(), inner_b.entered(1).wait())
        )
        assert inner_a.invocation_count == 1
        assert inner_b.invocation_count == 1
    finally:
        inner_a.release(1)
        inner_b.release(1)
        try:
            run_results = await _bounded_wait(
                asyncio.gather(run_a, run_b, return_exceptions=True)
            )
        finally:
            await _cancel_and_await(run_a, run_b)
        for result in run_results:
            if isinstance(result, BaseException):
                raise result


@pytest.mark.asyncio
async def test_cancellation_releases_same_thread_claim():
    inner = _BlockingInnerAgent(block_invocations={1, 2})
    adapter = _build_agent({"thread-1": inner})
    first = asyncio.create_task(_collect(adapter, _input("thread-1", "run-1")))

    try:
        await _bounded_wait(inner.entered(1).wait())
    except (Exception, asyncio.CancelledError):
        await _cancel_and_await(first)
        raise
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await _bounded_task(first)

    replacement = asyncio.create_task(_collect(adapter, _input("thread-1", "run-2")))
    try:
        await _bounded_wait(inner.entered(2).wait())
        assert inner.invocation_count == 2
    finally:
        inner.release(2)
        await _bounded_task(replacement)


@pytest.mark.asyncio
async def test_async_generator_close_releases_same_thread_claim():
    inner = _BlockingInnerAgent()
    adapter = _build_agent({"thread-1": inner})
    run = adapter.run(_input("thread-1", "run-1"))

    first_event = await _bounded_wait(run.__anext__())
    assert first_event.type == EventType.RUN_STARTED
    await _bounded_wait(run.aclose())

    events = await _bounded_wait(_collect(adapter, _input("thread-1", "run-2")))
    assert events[-1].type == EventType.RUN_FINISHED
    assert inner.invocation_count == 1


@pytest.mark.asyncio
async def test_async_generator_close_closes_suspended_strands_stream():
    inner = _SuspendedInnerAgent()
    adapter = _build_agent({"thread-1": inner})
    run = adapter.run(_input("thread-1", "run-1"))

    while True:
        event = await _bounded_wait(run.__anext__())
        if event.type == EventType.TEXT_MESSAGE_START:
            break

    [child_stream] = inner.streams
    assert child_stream.ag_running is False
    assert child_stream.ag_frame is not None

    await _bounded_wait(run.aclose())

    assert inner.cleanup_finished.is_set()
    assert child_stream.ag_frame is None
    events = await _bounded_wait(_collect(adapter, _input("thread-1", "run-2")))
    assert events[-1].type == EventType.RUN_FINISHED


@pytest.mark.asyncio
async def test_async_generator_close_holds_claim_until_delegate_cleanup_finishes():
    adapter = _build_agent({})
    scripted = _CleanupGatedRun()
    adapter._run_unlocked = scripted.run_unlocked
    run = adapter.run(_input("thread-1", "run-1"))
    assert await _bounded_wait(run.__anext__()) == "first-event"

    close_task = asyncio.create_task(run.aclose())
    cleanup_wait = asyncio.create_task(scripted.cleanup_started.wait())
    try:
        completed, _ = await _bounded_wait(
            asyncio.wait(
                {close_task, cleanup_wait},
                return_when=asyncio.FIRST_COMPLETED,
            )
        )
        assert cleanup_wait in completed, (
            "delegate cleanup must start before the outer run releases its claim"
        )
        assert not close_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            await _bounded_wait(_collect(adapter, _input("thread-1", "run-contender")))
        assert scripted.calls == 1
    finally:
        scripted.allow_cleanup.set()
        try:
            await _bounded_task(close_task)
        finally:
            await _cancel_and_await(cleanup_wait)
            for delegate in scripted.delegates:
                await _bounded_wait(delegate.aclose())

    assert scripted.cleanup_finished.is_set()
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]
    assert scripted.calls == 2


@pytest.mark.asyncio
async def test_cancelled_close_drains_delegate_before_releasing_claim():
    adapter = _build_agent({})
    scripted = _CleanupGatedRun()
    adapter._run_unlocked = scripted.run_unlocked
    run = adapter.run(_input("thread-1", "run-1"))
    assert await _bounded_wait(run.__anext__()) == "first-event"

    close_task = asyncio.create_task(run.aclose())
    await _bounded_wait(scripted.cleanup_started.wait())
    try:
        for contender_run_id in ("run-contender-1", "run-contender-2"):
            close_task.cancel()
            with pytest.raises(
                RuntimeError,
                match=r"run already active for thread_id='thread-1'",
            ):
                await _bounded_wait(
                    _collect(adapter, _input("thread-1", contender_run_id))
                )
            assert not close_task.done()
            assert not scripted.cleanup_finished.is_set()
            assert scripted.calls == 1
    finally:
        scripted.allow_cleanup.set()
        try:
            with pytest.raises(asyncio.CancelledError):
                await _bounded_task(close_task)
        finally:
            for delegate in scripted.delegates:
                await _bounded_wait(delegate.aclose())

    assert scripted.cleanup_finished.is_set()
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]
    assert scripted.calls == 2


@pytest.mark.asyncio
async def test_cancelled_close_preserves_cancellation_when_cleanup_fails(
    caplog: pytest.LogCaptureFixture,
):
    adapter = _build_agent({})
    cleanup_error = RuntimeError("delegate cleanup failed after cancellation")
    scripted = _CleanupGatedRun(cleanup_error)
    adapter._run_unlocked = scripted.run_unlocked
    run = adapter.run(_input("thread-1", "run-1"))
    assert await _bounded_wait(run.__anext__()) == "first-event"

    close_task = asyncio.create_task(run.aclose())
    await _bounded_wait(scripted.cleanup_started.wait())
    try:
        for contender_run_id in ("run-contender-1", "run-contender-2"):
            close_task.cancel()
            with pytest.raises(
                RuntimeError,
                match=r"run already active for thread_id='thread-1'",
            ):
                await _bounded_wait(
                    _collect(adapter, _input("thread-1", contender_run_id))
                )
            assert not close_task.done()
            assert not scripted.cleanup_finished.is_set()
            assert scripted.calls == 1
    finally:
        scripted.allow_cleanup.set()

    with pytest.raises(asyncio.CancelledError):
        await _bounded_task(close_task)

    cleanup_records = [
        record
        for record in caplog.records
        if record.message == "Run cleanup failed during caller cancellation"
    ]
    assert len(cleanup_records) == 1
    cleanup_record = cleanup_records[0]
    assert cleanup_record.exc_info is not None
    assert cleanup_record.exc_info[1] is cleanup_error
    assert scripted.cleanup_finished.is_set()
    assert not any(
        "_close_run_stream_and_release.<locals>.cleanup" in task.get_coro().__qualname__
        for task in asyncio.all_tasks()
    )
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]
    assert scripted.calls == 2


@pytest.mark.asyncio
async def test_cancellation_entering_cleanup_wins_over_cleanup_error(
    caplog: pytest.LogCaptureFixture,
):
    adapter = _build_agent({})
    cleanup_error = RuntimeError("cleanup failed after run cancellation")
    scripted = _CancellationEntryRun(cleanup_error)
    adapter._run_unlocked = scripted.run_unlocked
    run = adapter.run(_input("thread-1", "run-1"))
    assert await _bounded_wait(run.__anext__()) == "first-event"

    next_task = asyncio.create_task(run.__anext__())
    await _bounded_wait(scripted.iteration_blocked.wait())
    next_task.cancel()
    await _bounded_wait(scripted.cleanup_started.wait())
    try:
        assert not next_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            await _bounded_wait(_collect(adapter, _input("thread-1", "run-contender")))
        assert scripted.calls == 1
    finally:
        scripted.allow_cleanup.set()

    with pytest.raises(asyncio.CancelledError):
        await _bounded_task(next_task)

    cleanup_records = [
        record
        for record in caplog.records
        if record.message == "Run cleanup failed during caller cancellation"
    ]
    assert len(cleanup_records) == 1
    assert cleanup_records[0].exc_info is not None
    assert cleanup_records[0].exc_info[1] is cleanup_error
    assert scripted.cleanup_finished.is_set()
    assert not any(
        "_drain_cleanup.<locals>.capture_cleanup_outcome"
        in task.get_coro().__qualname__
        for task in asyncio.all_tasks()
    )
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]
    assert scripted.calls == 2


@pytest.mark.asyncio
async def test_real_generator_cleanup_cannot_mask_initiating_cancellation(
    caplog: pytest.LogCaptureFixture,
):
    adapter = _build_agent({})
    cleanup_error = RuntimeError("real generator cleanup failed")
    scripted = _CleanupGatedRun(
        cleanup_error,
        block_iteration=True,
    )
    adapter._run_unlocked = scripted.run_unlocked
    run = adapter.run(_input("thread-1", "run-1"))
    assert await _bounded_wait(run.__anext__()) == "first-event"

    next_task = asyncio.create_task(run.__anext__())
    await _bounded_wait(scripted.iteration_blocked.wait())
    next_task.cancel()
    await _bounded_wait(scripted.cleanup_started.wait())
    try:
        assert not next_task.done()
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='thread-1'",
        ):
            await _bounded_wait(_collect(adapter, _input("thread-1", "run-contender")))
        assert scripted.calls == 1
    finally:
        scripted.allow_cleanup.set()

    with pytest.raises(asyncio.CancelledError):
        await _bounded_task(next_task)

    cleanup_records = [
        record
        for record in caplog.records
        if record.message == "Run cleanup failed during caller cancellation"
    ]
    assert len(cleanup_records) == 1
    assert cleanup_records[0].exc_info is not None
    assert cleanup_records[0].exc_info[1] is cleanup_error
    assert "CancelledError" in caplog.text
    assert scripted.cleanup_finished.is_set()
    assert not any(
        "_drain_cleanup.<locals>.capture_cleanup_outcome"
        in task.get_coro().__qualname__
        for task in asyncio.all_tasks()
    )
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]
    assert scripted.calls == 2


@pytest.mark.asyncio
async def test_cleanup_task_cancellation_is_not_logged_as_caller_cancellation(
    caplog: pytest.LogCaptureFixture,
):
    adapter = _build_agent({})
    scripted = _CancellationEntryRun(cleanup_self_cancels=True)
    adapter._run_unlocked = scripted.run_unlocked
    run = adapter.run(_input("thread-1", "run-1"))
    assert await _bounded_wait(run.__anext__()) == "first-event"

    with pytest.raises(asyncio.CancelledError):
        await _bounded_wait(run.aclose())

    assert scripted.cleanup_finished.is_set()
    assert not any(
        record.message == "Run cleanup failed during caller cancellation"
        for record in caplog.records
    )
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]
    assert scripted.calls == 2


@pytest.mark.asyncio
async def test_delegate_close_error_is_propagated_and_releases_claim():
    adapter = _build_agent({})
    delegates: list[AsyncIterator[Any]] = []
    calls = 0

    def scripted_run_unlocked(
        self: StrandsAgent, input_data: RunAgentInput
    ) -> AsyncIterator[Any]:
        nonlocal calls
        del self, input_data
        calls += 1
        invocation = calls

        async def stream() -> AsyncIterator[Any]:
            try:
                yield "first-event" if invocation == 1 else "replacement-event"
            finally:
                if invocation == 1:
                    raise RuntimeError("delegate cleanup failed")

        delegate = stream()
        delegates.append(delegate)
        return delegate

    adapter._run_unlocked = MethodType(scripted_run_unlocked, adapter)
    run = adapter.run(_input("thread-1", "run-1"))
    assert await _bounded_wait(run.__anext__()) == "first-event"

    try:
        with pytest.raises(RuntimeError, match="delegate cleanup failed"):
            await _bounded_wait(run.aclose())
    finally:
        for delegate in delegates:
            try:
                await _bounded_wait(delegate.aclose())
            except RuntimeError as exc:
                assert str(exc) == "delegate cleanup failed"
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]


@pytest.mark.asyncio
async def test_unhandled_exception_releases_same_thread_claim():
    adapter = _build_agent({"thread-1": _BlockingInnerAgent()})
    calls = 0

    async def scripted_run_unlocked(
        self: StrandsAgent, input_data: RunAgentInput
    ) -> AsyncIterator[Any]:
        nonlocal calls
        del self, input_data
        calls += 1
        if calls == 1:
            raise RuntimeError("scripted failure")
        yield "replacement-event"

    adapter._run_unlocked = MethodType(scripted_run_unlocked, adapter)

    with pytest.raises(RuntimeError, match="scripted failure"):
        await _bounded_wait(_collect(adapter, _input("thread-1", "run-1")))
    assert await _bounded_wait(_collect(adapter, _input("thread-1", "run-2"))) == [
        "replacement-event"
    ]


@pytest.mark.asyncio
async def test_empty_thread_id_uses_default_claim_key():
    inner = _BlockingInnerAgent(block_invocations={1})
    adapter = _build_agent({"default": inner})
    first = asyncio.create_task(_collect(adapter, _input("", "run-1")))

    try:
        await _bounded_wait(inner.entered(1).wait())
        with pytest.raises(
            RuntimeError,
            match=r"run already active for thread_id='default'",
        ):
            await _bounded_wait(_collect(adapter, _input("", "run-2")))
        assert inner.invocation_count == 1
    finally:
        inner.release(1)
        await _bounded_task(first)
