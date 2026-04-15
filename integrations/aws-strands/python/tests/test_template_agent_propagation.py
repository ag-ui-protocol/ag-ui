"""Tests for StrandsAgent template kwarg propagation to new thread instances."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_model():
    m = MagicMock()
    m.stateful = False  # prevent Strands from rejecting conversation_manager
    return m


def _run_input(thread_id: str = "t1"):
    from ag_ui.core import RunAgentInput, UserMessage
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


class _CapturingCore:
    """Replacement for StrandsAgentCore that records constructor kwargs."""

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.tool_registry = ToolRegistry()

    async def stream_async(self, _msg: str):
        if False:
            yield


async def _trigger_thread_creation(ag: StrandsAgent, thread_id: str) -> "_CapturingCore":
    inp = _run_input(thread_id)
    async for _ in ag.run(inp):
        break
    return ag._agents_by_thread[thread_id]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def _make_template():
    """One Agent with every hardcoded kwarg set to a non-default value."""
    conversation_manager = MagicMock()
    template = Agent(
        model=_mock_model(),
        trace_attributes={"env": "prod"},
        agent_id="my-agent-id",
        state={"count": 0},
        conversation_manager=conversation_manager,
    )
    return template, conversation_manager


class TestExcludedParams:
    """Params that must never appear in _agent_kwargs or be forwarded to new threads."""

    @pytest.mark.asyncio
    async def test_excluded_params_not_forwarded(self):
        from ag_ui_strands.agent import _AGUI_EXPLICIT_PARAMS

        template = Agent(model=_mock_model(), hooks=[MagicMock()])
        ag = StrandsAgent(template, name="test")

        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            instance = await _trigger_thread_creation(ag, "excluded-thread")

        for param in _AGUI_EXPLICIT_PARAMS - {"self"}:
            assert param not in ag._agent_kwargs, f"{param} should not be in _agent_kwargs"


class TestTemplateKwargsCapture:
    """All hardcoded template attributes must appear in _agent_kwargs after __init__."""

    def test_all_hardcoded_kwargs_captured(self):
        template, conversation_manager = _make_template()
        ag = StrandsAgent(template, name="test")

        assert ag._agent_kwargs.get("trace_attributes") == {"env": "prod"}
        assert ag._agent_kwargs.get("agent_id") == "my-agent-id"
        assert "state" in ag._agent_kwargs
        assert ag._agent_kwargs.get("conversation_manager") is conversation_manager


class TestNewThreadUsesTemplateKwargs:
    """New per-thread StrandsAgentCore instances must receive all hardcoded template kwargs."""

    @pytest.mark.asyncio
    async def test_all_hardcoded_kwargs_forwarded_to_new_thread(self):
        template, conversation_manager = _make_template()
        ag = StrandsAgent(template, name="test")

        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            instance = await _trigger_thread_creation(ag, "thread-1")

        kwargs = instance.init_kwargs
        assert kwargs.get("trace_attributes") == {"env": "prod"}, f"got: {kwargs}"
        assert kwargs.get("agent_id") == "my-agent-id", f"got: {kwargs}"
        assert "state" in kwargs, f"got: {kwargs}"
        assert kwargs.get("conversation_manager") is conversation_manager, f"got: {kwargs}"
