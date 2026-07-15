"""
Tests for the two-method translator API.

Covers the public translator contract only — engine mappings have their own coverage:

- ``to_openai`` delegates to the inbound engine and populates ``tools``.
- ``AGUITranslator.to_agui`` streams engine output live and appends the
  engine flush, with a fresh engine per call (reusable translator).
- ``to_agui`` always wraps the stream with RUN_STARTED / RUN_FINISHED /
  RUN_ERROR — not optional, thread_id/run_id come straight off run_input.
- ``to_agui`` appends a MESSAGES_SNAPSHOT by default just before
  RUN_FINISHED; snapshot content itself is covered in ``test_snapshot.py``,
  this file only checks the wiring (default on, ``emit_messages_snapshot=False``
  opts out — same for bare iterators, since the snapshot no longer depends
  on ``result.new_items``).
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from agents import FunctionTool
from agents.result import RunResultStreaming

from ag_ui.core import (
    CustomEvent,
    EventType,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    ResumeEntry,
    StateSnapshotEvent,
    Tool,
    UserMessage,
)
from ag_ui_openai_agents import AGUITranslator


def _run_input(
    with_tool: bool = False,
    resume: list[ResumeEntry] | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=[UserMessage(id="m1", role="user", content="hi")],
        tools=[
            Tool(
                name="confirm",
                description="Ask the user to confirm.",
                parameters={"type": "object", "properties": {}},
            )
        ]
        if with_tool
        else [],
        state={},
        context=[],
        forwarded_props=None,
        resume=resume,
    )


def _event(name: str) -> CustomEvent:
    return CustomEvent(type=EventType.CUSTOM, name=name, value=None)


class _StubOutbound:
    """Records lifecycle; one AG-UI event per SDK event + a flush marker."""

    instances = 0

    def __init__(self) -> None:
        type(self).instances += 1
        self._snapshot_messages: list = []

    def translate(self, openai_event):
        return [_event(f"translated:{openai_event}")]

    def finalize(self):
        return [_event("finalized")]

    def build_messages_snapshot(self, run_input=None):
        prior = getattr(run_input, "messages", run_input) or []
        return MessagesSnapshotEvent(
            type=EventType.MESSAGES_SNAPSHOT,
            messages=[*prior, *self._snapshot_messages],
        )


async def _fake_stream(*names: str):
    for name in names:
        yield name


# ── to_openai ────────────────────────────────────────────────────────────


def test_to_openai_translates_messages_and_tools():
    translator = AGUITranslator()
    bundle = translator.to_openai(_run_input(with_tool=True))
    assert bundle.thread_id == "t1"
    assert bundle.messages, "user message should be translated into input items"
    assert len(bundle.tools) == 1
    assert isinstance(bundle.tools[0], FunctionTool)
    assert bundle.tools[0].name == "confirm"
    assert bundle.tools[0].strict_json_schema is False


def test_to_openai_without_tools_leaves_bundle_empty():
    bundle = AGUITranslator().to_openai(_run_input())
    assert bundle.tools == []


def test_to_openai_preserves_resume_entries():
    resume = ResumeEntry(interrupt_id="interrupt-1", status="resolved", payload=True)
    translated = AGUITranslator().to_openai(_run_input(resume=[resume]))

    assert translated.resume == [resume]


# ── AGUITranslator.to_agui (streaming) ───────────────────────────────────


def test_streaming_to_agui_streams_then_finalizes():
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                _fake_stream("a", "b"),
                _run_input(),
                emit_messages_snapshot=False,
                initial_state=None,
                final_state=None,
            )
        ]

    events = asyncio.run(collect())
    assert isinstance(events[0], RunStartedEvent)
    assert isinstance(events[-1], RunFinishedEvent)
    assert [e.name for e in events[1:-1]] == [
        "translated:a",
        "translated:b",
        "finalized",
    ]


def test_streaming_translator_is_reusable_fresh_engine_per_run():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    before = _StubOutbound.instances

    async def one_run():
        return [e async for e in translator.to_agui(_fake_stream("x"), _run_input())]

    asyncio.run(one_run())
    asyncio.run(one_run())
    assert _StubOutbound.instances == before + 2


def test_streaming_to_agui_accepts_run_streaming_result():
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    # spec= makes isinstance(result, RunResultStreaming) True, matching what
    # to_agui actually checks — a bare duck-typed stand-in would not.
    result = MagicMock(spec=RunResultStreaming)
    result.stream_events.return_value = _fake_stream("sdk")
    result.new_items = []

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                result, _run_input(), initial_state=None, final_state=None
            )
        ]

    events = asyncio.run(collect())
    assert isinstance(events[0], RunStartedEvent)
    assert [e.name for e in events[1:3]] == ["translated:sdk", "finalized"]
    assert isinstance(events[3], MessagesSnapshotEvent)
    assert isinstance(events[4], RunFinishedEvent)


# ── AGUITranslator.to_agui (MESSAGES_SNAPSHOT) ───────────────────────────


def test_to_agui_emits_snapshot_by_default():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    result = MagicMock(spec=RunResultStreaming)
    result.stream_events.return_value = _fake_stream()
    result.new_items = []
    run_input = _run_input()

    async def collect():
        return [e async for e in translator.to_agui(result, run_input)]

    events = asyncio.run(collect())
    assert isinstance(events[-1], RunFinishedEvent)
    snapshot = events[-2]
    assert isinstance(snapshot, MessagesSnapshotEvent)
    assert [m.id for m in snapshot.messages] == ["m1"]


def test_to_agui_emit_messages_snapshot_false_opts_out():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    result = MagicMock(spec=RunResultStreaming)
    result.stream_events.return_value = _fake_stream()
    result.new_items = []

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                result, _run_input(), emit_messages_snapshot=False
            )
        ]

    events = asyncio.run(collect())
    assert not any(isinstance(e, MessagesSnapshotEvent) for e in events)


def test_to_agui_emits_snapshot_for_bare_iterator_too():
    # The snapshot is built from the engine's own accumulator, not
    # result.new_items, so a bare stream_events() iterator works the same
    # as passing the RunResultStreaming object itself.
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    async def collect():
        return [e async for e in translator.to_agui(_fake_stream("a"), _run_input())]

    events = asyncio.run(collect())
    assert isinstance(events[-1], RunFinishedEvent)
    assert isinstance(events[-2], MessagesSnapshotEvent)


# ── AGUITranslator.to_agui (lifecycle events) ────────────────────────────


def test_to_agui_wraps_stream_with_lifecycle_events():
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    async def collect():
        return [e async for e in translator.to_agui(_fake_stream("a"), _run_input())]

    events = asyncio.run(collect())
    started, finished = events[0], events[-1]
    assert isinstance(started, RunStartedEvent)
    assert started.thread_id == "t1"
    assert started.run_id == "r1"
    assert isinstance(finished, RunFinishedEvent)
    assert finished.thread_id == "t1"
    assert finished.run_id == "r1"


def test_to_agui_emits_run_error_and_reraises_on_exception():
    class _ExplodingOutbound(_StubOutbound):
        def translate(self, openai_event):
            raise RuntimeError("boom")

    translator = AGUITranslator(outbound_cls=_ExplodingOutbound)
    collected: list = []

    async def collect():
        async for e in translator.to_agui(_fake_stream("a"), _run_input()):
            collected.append(e)

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(collect())

    assert isinstance(collected[0], RunStartedEvent)
    assert isinstance(collected[-1], RunErrorEvent)
    assert collected[-1].message == "boom"


def test_to_agui_emit_run_error_false_suppresses_event_but_still_raises():
    class _ExplodingOutbound(_StubOutbound):
        def translate(self, openai_event):
            raise RuntimeError("boom")

    translator = AGUITranslator(outbound_cls=_ExplodingOutbound)
    collected: list = []

    async def collect():
        async for e in translator.to_agui(
            _fake_stream("a"), _run_input(), emit_run_error=False
        ):
            collected.append(e)

    with pytest.raises(RuntimeError, match="boom"):
        asyncio.run(collect())

    assert isinstance(collected[0], RunStartedEvent)
    assert not any(isinstance(e, RunErrorEvent) for e in collected)


def test_to_agui_run_error_message_overrides_exception_text():
    class _ExplodingOutbound(_StubOutbound):
        def translate(self, openai_event):
            raise RuntimeError("raw internal detail")

    translator = AGUITranslator(outbound_cls=_ExplodingOutbound)
    collected: list = []

    async def collect():
        async for e in translator.to_agui(
            _fake_stream("a"), _run_input(), run_error_message="Agent run failed"
        ):
            collected.append(e)

    with pytest.raises(RuntimeError, match="raw internal detail"):
        asyncio.run(collect())

    error = collected[-1]
    assert isinstance(error, RunErrorEvent)
    assert error.message == "Agent run failed"


def test_to_agui_emits_run_error_on_cancelled_error():
    # asyncio.CancelledError is BaseException, not Exception (3.8+) — a
    # mid-stream timeout/dropped-connection must still surface RUN_ERROR
    # instead of silently ending the stream after whatever was last yielded.
    class _CancelledOutbound(_StubOutbound):
        def translate(self, openai_event):
            raise asyncio.CancelledError()

    translator = AGUITranslator(outbound_cls=_CancelledOutbound)
    collected: list = []

    async def collect():
        async for e in translator.to_agui(_fake_stream("a"), _run_input()):
            collected.append(e)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(collect())

    assert isinstance(collected[0], RunStartedEvent)
    assert isinstance(collected[-1], RunErrorEvent)


# ── AGUITranslator.to_agui (state snapshot) ──────────────────────────────


def test_to_agui_echoes_run_input_state_as_snapshot():
    # Non-empty run_input.state is echoed back as a STATE_SNAPSHOT right
    # after RUN_STARTED — matching the other integrations with no native SDK
    # state.
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    run_input = _run_input().model_copy(update={"state": {"theme": "dark"}})

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                _fake_stream("a"),
                run_input,
                emit_messages_snapshot=False,
                initial_state=run_input.state,
                final_state=None,
            )
        ]

    events = asyncio.run(collect())
    assert isinstance(events[0], RunStartedEvent)
    assert isinstance(events[1], StateSnapshotEvent)
    assert events[1].snapshot == {"theme": "dark"}
    # final_state=None here isolates the initial echo — just the one.
    assert sum(isinstance(e, StateSnapshotEvent) for e in events) == 1


def test_to_agui_empty_run_input_state_still_emits_snapshot():
    # Gated on `is not None`, so an empty {} still echoes as STATE_SNAPSHOT({})
    # — matching aws-strands / claude-agent-sdk.
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                _fake_stream("a"),
                _run_input(),
                emit_messages_snapshot=False,
                initial_state={},
                final_state=None,
            )
        ]

    events = asyncio.run(collect())
    snapshots = [e for e in events if isinstance(e, StateSnapshotEvent)]
    assert len(snapshots) == 1
    assert snapshots[0].snapshot == {}


def test_to_agui_none_state_sources_suppress_both_snapshots():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    run_input = _run_input().model_copy(update={"state": {"x": 1}})

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                _fake_stream("a"),
                run_input,
                emit_messages_snapshot=False,
                initial_state=None,
                final_state=None,
            )
        ]

    events = asyncio.run(collect())
    assert not any(isinstance(e, StateSnapshotEvent) for e in events)


def test_to_agui_emits_final_state_before_messages_snapshot():
    # Pass both sources: state echoes twice — initial right after RUN_STARTED
    # and final in the settled-state slot (#5), just before MESSAGES_SNAPSHOT.
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    run_input = _run_input().model_copy(update={"state": {"theme": "dark"}})

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                _fake_stream("a"),
                run_input,
                initial_state=run_input.state,
                final_state=run_input.state,
            )
        ]

    events = asyncio.run(collect())
    snapshots = [e for e in events if isinstance(e, StateSnapshotEvent)]
    # Two snapshots: initial echo + final settled state, both == run_input.state.
    assert len(snapshots) == 2
    assert all(s.snapshot == {"theme": "dark"} for s in snapshots)
    # Canonical order #5 → #6 → #8: final STATE, then MESSAGES, then RUN_FINISHED.
    assert isinstance(events[-1], RunFinishedEvent)
    assert isinstance(events[-2], MessagesSnapshotEvent)
    assert events[-3] is snapshots[-1]


def test_to_agui_accepts_static_and_lazy_state_sources():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    state = {"status": "starting"}

    async def collect():
        async def stream():
            state["status"] = "complete"
            yield "a"

        return [
            e
            async for e in translator.to_agui(
                stream(),
                _run_input(),
                emit_messages_snapshot=False,
                initial_state={"status": "starting"},
                final_state=lambda: dict(state),
            )
        ]

    events = asyncio.run(collect())
    snapshots = [e.snapshot for e in events if isinstance(e, StateSnapshotEvent)]
    assert snapshots == [{"status": "starting"}, {"status": "complete"}]


def test_to_agui_awaits_async_state_source():
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    async def final_state():
        return {"status": "complete"}

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                _fake_stream("a"),
                _run_input(),
                emit_messages_snapshot=False,
                initial_state=None,
                final_state=final_state,
            )
        ]

    events = asyncio.run(collect())
    snapshots = [e.snapshot for e in events if isinstance(e, StateSnapshotEvent)]
    assert snapshots == [{"status": "complete"}]


def test_to_agui_final_state_none_keeps_only_initial():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    run_input = _run_input().model_copy(update={"state": {"x": 1}})

    async def collect():
        return [
            e
            async for e in translator.to_agui(
                _fake_stream("a"),
                run_input,
                emit_messages_snapshot=False,
                initial_state=run_input.state,
                final_state=None,
            )
        ]

    events = asyncio.run(collect())
    snapshots = [e for e in events if isinstance(e, StateSnapshotEvent)]
    assert len(snapshots) == 1
    # The lone snapshot is the initial echo (right after RUN_STARTED), not a final.
    assert isinstance(events[1], StateSnapshotEvent)
