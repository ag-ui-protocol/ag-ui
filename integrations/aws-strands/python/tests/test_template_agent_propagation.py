"""Tests that every Strands Agent __init__ param round-trips to per-thread instances.

Driven by inspect.signature so new Strands params are covered automatically.
"""

from __future__ import annotations

import inspect
import logging
from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import (
    StrandsAgent,
    _AGUI_EXPLICIT_PARAMS,
    _extract_agent_kwargs,
)


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


class _CapturingCore:
    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.tool_registry = ToolRegistry()

    async def stream_async(self, _msg: str):
        if False:
            yield


async def _trigger_thread_creation(ag: StrandsAgent, thread_id: str) -> _CapturingCore:
    async for _ in ag.run(_run_input(thread_id)):
        break
    return ag._agents_by_thread[thread_id]


# Params that require a specific type or that we explicitly handle elsewhere.
# Anything not in this set should round-trip a sentinel MagicMock cleanly.
_UNTESTABLE_VIA_SENTINEL = {
    "model",              # must be a Model-shaped object; we set it separately
    "messages",           # excluded by AG-UI
    "hooks",              # excluded by AG-UI
    "tools",              # handled via tool_registry
    "system_prompt",      # handled explicitly
    "session_manager",    # excluded; see StrandsAgentConfig.session_manager_provider
    "plugins",            # stored as _plugin_registry, not forwarded
    "structured_output_model",  # template Agent rejects a MagicMock sentinel here
    "trace_attributes",         # Strands merges into a dict, losing sentinel identity
}


def _discover_forwardable_params() -> list[str]:
    """Every Agent.__init__ param we expect to auto-forward."""
    sig = inspect.signature(Agent.__init__)
    return [
        n for n in sig.parameters
        if n not in _AGUI_EXPLICIT_PARAMS and n not in _UNTESTABLE_VIA_SENTINEL
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("param_name", _discover_forwardable_params())
async def test_template_param_round_trips(param_name):
    """For each Strands Agent init param, a value set on the template
    must reach the per-thread StrandsAgentCore with the same identity."""
    sentinel = MagicMock(name=f"sentinel-{param_name}")
    try:
        template = Agent(model=_mock_model(), **{param_name: sentinel})
    except (TypeError, ValueError) as e:
        pytest.skip(f"{param_name}: template rejects sentinel ({e})")

    ag = StrandsAgent(template, name="test")
    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, f"thread-{param_name}")

    assert instance.init_kwargs.get(param_name) is sentinel, (
        f"{param_name}: value on template did not round-trip to per-thread agent. "
        f"got kwargs={list(instance.init_kwargs)}"
    )


@pytest.mark.asyncio
async def test_excluded_params_never_forwarded():
    """Params in _AGUI_EXPLICIT_PARAMS are handled elsewhere and must never
    appear in the generic _agent_kwargs forwarding path."""
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test")
    for p in _AGUI_EXPLICIT_PARAMS - {"self"}:
        assert p not in ag._agent_kwargs, f"{p} leaked into _agent_kwargs"


@pytest.mark.asyncio
async def test_session_manager_on_template_is_dropped_and_warns(caplog):
    """Template-level session_manager is the known footgun: drop it, warn loudly."""
    session_manager = MagicMock(name="session_manager")
    template = Agent(model=_mock_model(), session_manager=session_manager)

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        ag = StrandsAgent(template, name="test")

    assert any("session_manager_provider" in m for m in caplog.messages), (
        f"expected a warning pointing to session_manager_provider; got {caplog.messages}"
    )
    assert "session_manager" not in ag._agent_kwargs

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    # #798's explicit kwarg should be None since no provider is configured.
    assert instance.init_kwargs.get("session_manager") is None


def test_extract_agent_kwargs_underscore_fallback():
    """Directly exercises the self._<name> fallback path in _extract_agent_kwargs.

    Covers Strands params stored with an underscore prefix (e.g. retry_strategy
    lives at self._retry_strategy). The parametrized round-trip test above
    often can't cover these because Strands rejects MagicMock sentinels in
    template construction for such params.
    """
    sig = inspect.signature(Agent.__init__)
    candidate = next(
        (
            n
            for n in sig.parameters
            if n not in _AGUI_EXPLICIT_PARAMS and n != "self"
        ),
        None,
    )
    assert candidate, "Agent.__init__ has no forwardable params — test premise broken"

    sentinel = object()
    fake = type("FakeAgent", (), {})()
    setattr(fake, f"_{candidate}", sentinel)
    assert not hasattr(fake, candidate), (
        f"precondition violated: {candidate} must only be set as _{candidate}"
    )

    kwargs = _extract_agent_kwargs(fake)
    assert kwargs.get(candidate) is sentinel, (
        f"underscore fallback did not resolve {candidate}; kwargs={list(kwargs)}"
    )


@pytest.mark.asyncio
async def test_template_session_manager_no_warning_when_provider_set(caplog):
    """With a provider configured, the warning should NOT fire."""
    from ag_ui_strands.config import StrandsAgentConfig

    session_manager = MagicMock(name="session_manager")
    template = Agent(model=_mock_model(), session_manager=session_manager)
    config = StrandsAgentConfig(session_manager_provider=lambda _inp: MagicMock())

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        StrandsAgent(template, name="test", config=config)

    assert not any("session_manager_provider" in m for m in caplog.messages), (
        f"unexpected warning: {caplog.messages}"
    )