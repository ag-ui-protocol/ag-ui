"""Tests for StrandsAgent template kwarg propagation to new thread instances.

StrandsAgent.__init__ currently captures only four attributes from the template
agent (model, system_prompt, tools, record_direct_tool_call).  All other
constructor parameters — trace_attributes, agent_id, conversation_manager,
state — are silently discarded, so every new thread starts with default values
regardless of what was configured on the template.

Each test below is written to FAIL with the current code and PASS after the fix.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mock_model():
    return MagicMock()


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
    """Run the agent far enough to create the thread instance, then return it."""
    inp = _run_input(thread_id)
    async for _ in ag.run(inp):
        break  # one event is enough; thread is created before any yield
    return ag._agents_by_thread[thread_id]


# ---------------------------------------------------------------------------
# Static tests — check _agent_kwargs at construction time (no async needed)
# ---------------------------------------------------------------------------

class TestTemplateKwargsCapture:
    """StrandsAgent.__init__ must capture all relevant template attributes."""

    def test_trace_attributes_captured(self):
        """trace_attributes from the template must appear in _agent_kwargs."""
        template = Agent(model=_mock_model(), trace_attributes={"env": "prod"})
        ag = StrandsAgent(template, name="test")

        assert "trace_attributes" in ag._agent_kwargs, (
            "trace_attributes not captured — new threads will lose observability config"
        )
        assert ag._agent_kwargs["trace_attributes"] == {"env": "prod"}

    def test_agent_id_captured(self):
        """agent_id from the template must appear in _agent_kwargs."""
        template = Agent(model=_mock_model(), agent_id="my-agent-id")
        ag = StrandsAgent(template, name="test")

        assert "agent_id" in ag._agent_kwargs, (
            "agent_id not captured — new threads will get the default 'default' id"
        )
        assert ag._agent_kwargs["agent_id"] == "my-agent-id"

    def test_initial_state_captured(self):
        """Initial state from the template must be preserved for new threads."""
        template = Agent(model=_mock_model(), state={"greeting": "hello", "count": 0})
        ag = StrandsAgent(template, name="test")

        assert "state" in ag._agent_kwargs, (
            "state not captured — new threads always start with empty state"
        )


# ---------------------------------------------------------------------------
# Runtime tests — confirm new thread instances are created with the right kwargs
# ---------------------------------------------------------------------------

class TestNewThreadUsesTemplateKwargs:
    """When StrandsAgentCore is instantiated for a new thread it must receive
    all template kwargs, not just the four currently hard-coded ones."""

    @pytest.mark.asyncio
    async def test_new_thread_receives_trace_attributes(self):
        """New thread instance must be constructed with the template trace_attributes."""
        template = Agent(model=_mock_model(), trace_attributes={"env": "prod"})
        ag = StrandsAgent(template, name="test")

        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            instance = await _trigger_thread_creation(ag, "trace-thread")

        assert instance.init_kwargs.get("trace_attributes") == {"env": "prod"}, (
            f"trace_attributes not passed to new thread. Got: {instance.init_kwargs}"
        )

    @pytest.mark.asyncio
    async def test_new_thread_receives_agent_id(self):
        """New thread instance must be constructed with the template agent_id."""
        template = Agent(model=_mock_model(), agent_id="my-agent-id")
        ag = StrandsAgent(template, name="test")

        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            instance = await _trigger_thread_creation(ag, "id-thread")

        assert instance.init_kwargs.get("agent_id") == "my-agent-id", (
            f"agent_id not passed to new thread. Got: {instance.init_kwargs}"
        )

    @pytest.mark.asyncio
    async def test_new_thread_receives_initial_state(self):
        """New thread instance must be constructed with the template initial state."""
        template = Agent(model=_mock_model(), state={"greeting": "hello"})
        ag = StrandsAgent(template, name="test")

        with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
            instance = await _trigger_thread_creation(ag, "state-thread")

        assert "state" in instance.init_kwargs, (
            f"state not passed to new thread. Got: {instance.init_kwargs}"
        )
