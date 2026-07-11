"""
Tests for the OpenAIAgentsAgent wrapper.

Covers orchestration only — the event mapping itself is the translator's job
and has its own coverage:

- ``run`` yields the translator-wrapped stream (RUN_STARTED first,
  RUN_FINISHED last) for one AG-UI request.
- Client-declared tools are merged onto a per-request ``clone`` — the wrapped
  static agent is never mutated; without tools no clone happens.
- ``run_config`` passes through to ``Runner.run_streamed``.
- ``name`` defaults to the SDK agent's name.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    EventType,
    RunAgentInput,
    Tool,
    UserMessage,
)
from agents import Agent, RunConfig
from agents.result import RunResultStreaming

from ag_ui_openai_agents import OpenAIAgentsAgent
import ag_ui_openai_agents.agent as agent_module


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


async def _empty_stream():
    return
    yield  # pragma: no cover — makes this an async generator


@pytest.fixture
def patched_runner(monkeypatch):
    """Replace Runner.run_streamed with a capture that returns an empty stream."""
    calls: list[dict] = []

    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        calls.append({"agent": agent, "input": input, "run_config": run_config})
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)
    return calls


def _collect(wrapper: OpenAIAgentsAgent, run_input: RunAgentInput) -> list:
    async def go():
        return [event async for event in wrapper.run(run_input)]

    return asyncio.run(go())


def test_run_wraps_stream_with_lifecycle(patched_runner):
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    events = _collect(wrapper, _run_input())
    assert events[0].type == EventType.RUN_STARTED
    assert events[-1].type == EventType.RUN_FINISHED
    assert events[0].thread_id == "t1"
    assert events[0].run_id == "r1"


def test_run_without_client_tools_uses_static_agent(patched_runner):
    sdk_agent = Agent(name="assistant", instructions="hi")
    wrapper = OpenAIAgentsAgent(sdk_agent)
    _collect(wrapper, _run_input())
    assert patched_runner[0]["agent"] is sdk_agent


def test_run_merges_client_tools_onto_clone(patched_runner):
    sdk_agent = Agent(name="assistant", instructions="hi")
    wrapper = OpenAIAgentsAgent(sdk_agent)
    _collect(wrapper, _run_input(with_tool=True))
    ran_agent = patched_runner[0]["agent"]
    assert ran_agent is not sdk_agent, "client tools must go on a clone"
    assert [t.name for t in ran_agent.tools] == ["confirm"]
    assert sdk_agent.tools == [], "the static agent must stay untouched"


def test_run_config_passes_through(patched_runner):
    run_config = RunConfig()
    wrapper = OpenAIAgentsAgent(
        Agent(name="assistant", instructions="hi"), run_config=run_config
    )
    _collect(wrapper, _run_input())
    assert patched_runner[0]["run_config"] is run_config


def test_name_defaults_to_agent_name():
    assert OpenAIAgentsAgent(Agent(name="helper", instructions="hi")).name == "helper"
    assert (
        OpenAIAgentsAgent(Agent(name="helper", instructions="hi"), name="api").name
        == "api"
    )
