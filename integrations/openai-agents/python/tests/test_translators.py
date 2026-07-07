"""
Tests for the two-method translator API.

Covers the public translator contract only — engine mappings have their own coverage:

- ``to_sdk`` delegates to the inbound engine and populates ``tools``.
- ``AGUITranslator.to_agui`` streams engine output live and appends the
  engine flush, with a fresh engine per call (reusable translator).
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from ag_ui.core import CustomEvent, EventType, RunAgentInput, Tool, UserMessage
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

    def translate(self, sdk_event):
        return [_event(f"translated:{sdk_event}")]

    def finalize(self):
        return [_event("finalized")]


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

    async def collect():
        return [e async for e in translator.to_agui(result)]

    events = asyncio.run(collect())
    assert [e.name for e in events] == ["translated:sdk", "finalized"]
