"""
Tests for the two-method translator API.

Covers the public translator contract only — engine mappings have their own coverage:

- ``to_sdk`` delegates to the inbound engine and populates ``tools``.
- ``AGUITranslator.to_agui`` streams engine output live and appends the
  engine flush, with a fresh engine per call (reusable translator).
- ``to_agui`` appends a MESSAGES_SNAPSHOT by default; snapshot content
  itself is covered in ``test_snapshot.py``, this file only checks the
  wiring (default on given a ``run_input``, ``emit_messages_snapshot=False``
  opts out, no ``run_input`` means no snapshot — same for bare iterators,
  since the snapshot no longer depends on ``result.new_items``).
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from ag_ui.core import (
    CustomEvent,
    EventType,
    MessagesSnapshotEvent,
    RunAgentInput,
    Tool,
    UserMessage,
)
from agents import FunctionTool
from agents.result import RunResultStreaming

from ag_ui_openai_agents import AGUITranslator


def _run_input(with_tool: bool = False) -> RunAgentInput:
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
    )


def _event(name: str) -> CustomEvent:
    return CustomEvent(type=EventType.CUSTOM, name=name, value=None)


class _StubOutbound:
    """Records lifecycle; one AG-UI event per SDK event + a flush marker."""

    instances = 0

    def __init__(self) -> None:
        type(self).instances += 1
        self._snapshot_messages: list = []

    def translate(self, sdk_event):
        return [_event(f"translated:{sdk_event}")]

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


# ── to_sdk ───────────────────────────────────────────────────────────────


def test_to_sdk_translates_messages_and_tools():
    translator = AGUITranslator()
    bundle = translator.to_sdk(_run_input(with_tool=True))
    assert bundle.thread_id == "t1"
    assert bundle.messages, "user message should be translated into input items"
    assert len(bundle.tools) == 1
    assert isinstance(bundle.tools[0], FunctionTool)
    assert bundle.tools[0].name == "confirm"


def test_to_sdk_without_tools_leaves_bundle_empty():
    bundle = AGUITranslator().to_sdk(_run_input())
    assert bundle.tools == []


# ── AGUITranslator.to_agui (streaming) ───────────────────────────────────


def test_streaming_to_agui_streams_then_finalizes():
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    async def collect():
        return [e async for e in translator.to_agui(_fake_stream("a", "b"))]

    events = asyncio.run(collect())
    assert [e.name for e in events] == ["translated:a", "translated:b", "finalized"]


def test_streaming_translator_is_reusable_fresh_engine_per_run():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    before = _StubOutbound.instances

    async def one_run():
        return [e async for e in translator.to_agui(_fake_stream("x"))]

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
        return [e async for e in translator.to_agui(result, run_input=_run_input())]

    events = asyncio.run(collect())
    assert [e.name for e in events[:2]] == ["translated:sdk", "finalized"]
    assert isinstance(events[2], MessagesSnapshotEvent)


# ── AGUITranslator.to_agui (MESSAGES_SNAPSHOT) ───────────────────────────


def test_to_agui_emits_snapshot_by_default():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    result = MagicMock(spec=RunResultStreaming)
    result.stream_events.return_value = _fake_stream()
    result.new_items = []
    run_input = _run_input()

    async def collect():
        return [e async for e in translator.to_agui(result, run_input=run_input)]

    events = asyncio.run(collect())
    snapshot = events[-1]
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
                result, run_input=_run_input(), emit_messages_snapshot=False
            )
        ]

    events = asyncio.run(collect())
    assert not any(isinstance(e, MessagesSnapshotEvent) for e in events)


def test_to_agui_skips_snapshot_without_run_input():
    translator = AGUITranslator(outbound_cls=_StubOutbound)
    result = MagicMock(spec=RunResultStreaming)
    result.stream_events.return_value = _fake_stream()
    result.new_items = []

    async def collect():
        return [e async for e in translator.to_agui(result)]

    events = asyncio.run(collect())
    assert not any(isinstance(e, MessagesSnapshotEvent) for e in events)


def test_to_agui_emits_snapshot_for_bare_iterator_too():
    # The snapshot is built from the engine's own accumulator, not
    # result.new_items, so a bare stream_events() iterator works the same
    # as passing the RunResultStreaming object itself.
    translator = AGUITranslator(outbound_cls=_StubOutbound)

    async def collect():
        return [
            e
            async for e in translator.to_agui(_fake_stream("a"), run_input=_run_input())
        ]

    events = asyncio.run(collect())
    assert isinstance(events[-1], MessagesSnapshotEvent)
