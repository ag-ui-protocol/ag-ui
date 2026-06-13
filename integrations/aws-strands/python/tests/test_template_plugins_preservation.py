"""Tests that plugin providers are preserved on per-thread Strands agents."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from strands import Agent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent


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

    async def stream_async(self, _msg: str, **_kwargs):
        if False:
            yield


class _PluginRegistry:
    def __init__(self):
        self.plugins = []

    def add_and_init(self, plugin):
        self.plugins.append(plugin)


class _RegistryOnlyCore(_CapturingCore):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._plugin_registry = _PluginRegistry()


async def _trigger_thread_creation(ag: StrandsAgent, thread_id: str):
    async for _ in ag.run(_run_input(thread_id)):
        if thread_id in ag._agents_by_thread:
            break
    return ag._agents_by_thread[thread_id]


@pytest.mark.asyncio
async def test_plugins_kwarg_forwarded_when_provider_supplied():
    plugin = object()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", plugins=[plugin])

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert instance.init_kwargs.get("plugins") == [plugin]


@pytest.mark.asyncio
async def test_each_thread_receives_independent_plugins_list():
    plugin = object()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", plugins=[plugin])

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance_a = await _trigger_thread_creation(ag, "thread-a")
        instance_b = await _trigger_thread_creation(ag, "thread-b")

    assert instance_a.init_kwargs.get("plugins") == [plugin]
    assert instance_b.init_kwargs.get("plugins") == [plugin]
    assert instance_a.init_kwargs["plugins"] is not instance_b.init_kwargs["plugins"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "plugins_value", [None, []], ids=["default-none", "empty-list"]
)
async def test_plugins_kwarg_omitted_for_falsy_input(plugins_value):
    template = Agent(model=_mock_model())
    kwargs = {} if plugins_value is None else {"plugins": plugins_value}
    ag = StrandsAgent(template, name="test", **kwargs)

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "plugins" not in instance.init_kwargs


@pytest.mark.asyncio
async def test_plugins_registered_via_registry_when_kwarg_unavailable(monkeypatch):
    plugin = object()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", plugins=[plugin])
    monkeypatch.setattr(
        "ag_ui_strands.agent._strands_agent_accepts_kwarg",
        lambda name: False,
    )

    with patch("ag_ui_strands.agent.StrandsAgentCore", _RegistryOnlyCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "plugins" not in instance.init_kwargs
    assert instance._plugin_registry.plugins == [plugin]
