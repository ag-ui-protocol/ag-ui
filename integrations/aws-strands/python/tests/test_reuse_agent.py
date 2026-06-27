"""Tests for ``StrandsAgentConfig.reuse_agent``.

When set, the adapter runs the wrapped Agent directly instead of cloning a
fresh per-thread ``StrandsAgentCore``. The clone exists to isolate concurrent
threads in a shared process; in a per-invocation / per-session-isolated runtime
(e.g. AWS Bedrock AgentCore microVMs) it is redundant and its only observable
effect is dropping constructs that ``_extract_agent_kwargs`` cannot round-trip —
notably ``plugins``, which Strands keeps in a private ``_plugin_registry``.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


def _mock_model():
    m = MagicMock()
    m.stateful = False
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


class _FakeAgent:
    """Minimal stand-in exposing the surface ``StrandsAgent.run()`` touches."""

    def __init__(self):
        self.model = _mock_model()
        self.system_prompt = None
        self.tool_registry = ToolRegistry()
        self.messages: list = []
        self.state = MagicMock()
        self._session_manager = None
        # Sentinel for a construct the lossy clone path would NOT preserve.
        self._plugin_registry = MagicMock(name="plugin_registry")
        self.stream_calls: list = []

    async def stream_async(self, prompt):
        self.stream_calls.append(prompt)
        if False:  # make this an async generator that yields nothing
            yield


@pytest.mark.asyncio
async def test_reuse_agent_runs_template_without_cloning():
    """reuse_agent=True runs the wrapped instance and never builds a clone."""
    template = _FakeAgent()
    ag = StrandsAgent(
        template, name="test", config=StrandsAgentConfig(reuse_agent=True)
    )

    def _boom(*args, **kwargs):
        raise AssertionError(
            "StrandsAgentCore must not be constructed when reuse_agent=True"
        )

    with patch("ag_ui_strands.agent.StrandsAgentCore", _boom):
        async for _ in ag.run(_run_input("t1")):
            pass

    # No clone built; the per-thread pool stays empty.
    assert ag._agents_by_thread == {}
    # The wrapped instance is what actually ran.
    assert template.stream_calls, "the wrapped template agent should have been run"
    # It is the exact instance passed in, so its _plugin_registry — which the
    # clone path silently drops — is intact.
    assert ag._template_agent is template
    assert template._plugin_registry is not None


@pytest.mark.asyncio
async def test_reuse_agent_reuses_same_instance_across_turns():
    """Successive runs on the same wrapper reuse the one wrapped Agent."""
    template = _FakeAgent()
    ag = StrandsAgent(
        template, name="test", config=StrandsAgentConfig(reuse_agent=True)
    )

    with patch("ag_ui_strands.agent.StrandsAgentCore") as core:
        async for _ in ag.run(_run_input("t1")):
            pass
        async for _ in ag.run(_run_input("t1")):
            pass
        core.assert_not_called()

    assert len(template.stream_calls) == 2
    assert ag._agents_by_thread == {}


@pytest.mark.asyncio
async def test_reuse_agent_suppresses_template_session_manager_warning(caplog):
    """Under reuse_agent the template's own session_manager is honoured
    natively, so the 'will be ignored' footgun warning must NOT fire."""
    session_manager = MagicMock(name="session_manager")
    template = Agent(model=_mock_model(), session_manager=session_manager)

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        StrandsAgent(
            template, name="test", config=StrandsAgentConfig(reuse_agent=True)
        )

    assert not any("session_manager_provider" in m for m in caplog.messages), (
        f"unexpected warning under reuse_agent: {caplog.messages}"
    )


@pytest.mark.asyncio
async def test_default_still_clones_per_thread():
    """Without the flag, behaviour is unchanged: a per-thread clone is built."""
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")  # default config: reuse_agent=False

    captured = {}

    class _CapturingCore:
        def __init__(self, **kwargs):
            captured["built"] = True
            self.tool_registry = ToolRegistry()

        async def stream_async(self, _msg):
            if False:
                yield

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        async for _ in ag.run(_run_input("t1")):
            break

    assert captured.get("built"), "default path must still construct a per-thread clone"
    assert "t1" in ag._agents_by_thread
