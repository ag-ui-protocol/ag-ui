"""RunAgentInput.context must reach per-thread Strands agent state.

Mirrors the langgraph integration where tools read context off agent state.
Tools running on Strands read it via ``strands_agent.state.get("agui_context")``.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands.agent.state import AgentState
from strands.tools.registry import ToolRegistry

from ag_ui.core import Context, RunAgentInput, UserMessage

try:
    from strands.types.json_dict import JSONSerializableDict  # strands <2.0
except ImportError:
    try:
        from strands.types import JSONSerializableDict  # strands >=2.0 (reorganized)
    except ImportError:
        class JSONSerializableDict(dict):  # type: ignore[no-redef]
            def set(self, key, value): self[key] = value  # noqa: E704

from ag_ui_strands.agent import StrandsAgent


def _mock_model():
    m = MagicMock()
    m.stateful = False
    return m


class _CapturingCore:
    """Stand-in for StrandsAgentCore that records ``state.set`` writes."""

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.tool_registry = ToolRegistry()
        self.state = AgentState()

    async def stream_async(self, _msg: str):
        if False:
            yield


def _run_input(context, thread_id="t-ctx"):
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content="hello")],
        tools=[],
        context=context,
        forwarded_props={},
    )


async def _drive_one_event(ag: StrandsAgent, run_input: RunAgentInput) -> _CapturingCore:
    async for _ in ag.run(run_input):
        break
    return ag._agents_by_thread[run_input.thread_id]


@pytest.mark.asyncio
async def test_context_forwarded_to_agent_state():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")

    ctx = [
        Context(description="catalog", value='{"items":["a","b"]}'),
        Context(description="user_id", value="u-42"),
    ]

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive_one_event(ag, _run_input(ctx))

    stored = instance.state.get("agui_context")
    assert stored == [
        {"description": "catalog", "value": '{"items":["a","b"]}'},
        {"description": "user_id", "value": "u-42"},
    ], f"expected context forwarded to state, got {stored!r}"


@pytest.mark.asyncio
async def test_empty_context_writes_empty_list():
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _drive_one_event(ag, _run_input([]))

    assert instance.state.get("agui_context") == []