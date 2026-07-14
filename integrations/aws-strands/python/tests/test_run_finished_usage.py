"""Wiring test: Strands AgentResult usage -> RUN_FINISHED.usage.

Drives the real StrandsAgent.run() with a mocked stream that yields a terminal
`{"result": AgentResult}` event carrying metrics.accumulated_usage.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from ag_ui.core import EventType
from ag_ui_strands.agent import StrandsAgent


class BedrockModel:
    """Model whose class name maps to provider "bedrock" and whose config
    carries a model id."""

    def get_config(self):
        return {"model_id": "claude-sonnet-4"}


class _Metrics:
    def __init__(self, usage):
        self.accumulated_usage = usage


class _Result:
    def __init__(self, usage):
        self.metrics = _Metrics(usage)


class _MockStrandsAgent:
    def __init__(self, events, model=None):
        self.events = events
        self.model = model if model is not None else MagicMock()
        self.system_prompt = "test"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.record_direct_tool_call = True

    async def stream_async(self, _message):
        for event in self.events:
            yield event


def _make_input():
    i = MagicMock()
    i.thread_id = "test-thread"
    i.run_id = "test-run"
    i.state = {}
    i.messages = []
    i.tools = []
    return i


def _build(events, model=None):
    agent = StrandsAgent(_MockStrandsAgent(events, model), name="test", description="test")
    agent._agents_by_thread["test-thread"] = _MockStrandsAgent(events, model)
    return agent


async def _run_finished(agent):
    finished = None
    async for ev in agent.run(_make_input()):
        if ev.type == EventType.RUN_FINISHED:
            finished = ev
    return finished


@pytest.mark.asyncio
async def test_usage_surfaced_and_labelled_on_run_finished():
    events = [
        {"data": "hi"},
        {"result": _Result({"inputTokens": 100, "outputTokens": 50, "totalTokens": 150})},
        {"complete": True},
    ]
    finished = await _run_finished(_build(events, model=BedrockModel()))
    assert finished is not None
    assert finished.usage is not None
    assert len(finished.usage) == 1
    entry = finished.usage[0]
    assert entry.input_tokens == 100
    assert entry.output_tokens == 50
    assert entry.total_tokens == 150
    assert entry.provider == "bedrock"
    assert entry.model == "claude-sonnet-4"


@pytest.mark.asyncio
async def test_no_usage_when_result_absent():
    events = [{"data": "hi"}, {"complete": True}]
    finished = await _run_finished(_build(events))
    assert finished is not None
    assert finished.usage is None
