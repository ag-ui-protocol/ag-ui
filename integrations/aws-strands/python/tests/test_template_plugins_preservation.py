"""Tests that plugins passed to the adapter are forwarded to per-thread instances.

The StrandsAgent adapter constructs a fresh ``strands.Agent`` per ``thread_id``
from a template Agent. ``plugins`` is a valid ``Agent.__init__`` parameter, but
Strands consumes the list during init (registering each plugin's tools and
hooks) and retains only a ``_plugin_registry`` — the original plugin objects
are not stored as ``self.plugins`` / ``self._plugins``, so
``_extract_agent_kwargs`` cannot recover them from the template. The template
Agent never serves a request, so a plugin registered there never runs its
``init_agent`` / before-invocation hooks on the per-thread agents that do.

This silently breaks plugins whose behavior lives in those hooks — most
visibly ``AgentSkills``, whose ``skills`` activation tool leaks through
(tools ARE copied) but reports "skill not found" because no skills were ever
loaded (loading happens in ``init_agent``).

Each test below is written to FAIL on the pre-fix code (plugins dropped) and
PASS once plugins are forwarded to per-thread instances via the explicit
``StrandsAgent(plugins=...)`` kwarg. Mirrors ``test_template_hooks_preservation.py``.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import RunErrorEvent
from strands import Agent
from strands.models.model import Model
from strands.plugins import Plugin
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent


def _mock_model():
    """Build a spec'd Model mock so Strands' isinstance checks succeed."""
    m = MagicMock(spec=Model)
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
    """Replacement for StrandsAgentCore that records constructor kwargs."""

    def __init__(self, **kwargs):
        self.init_kwargs = kwargs
        self.tool_registry = ToolRegistry()

    async def stream_async(self, _msg: str, **_kwargs):
        if False:
            yield


async def _drive_run(ag: StrandsAgent, thread_id: str):
    events = []
    async for ev in ag.run(_run_input(thread_id)):
        events.append(ev)
        if thread_id in ag._agents_by_thread:
            break
    return events


async def _trigger_thread_creation(ag: StrandsAgent, thread_id: str):
    """Drive ag.run() until the per-thread agent is constructed."""
    events = await _drive_run(ag, thread_id)
    run_errors = [ev for ev in events if isinstance(ev, RunErrorEvent)]
    assert not run_errors, (
        f"ag.run() emitted RunErrorEvent(s) before per-thread agent was "
        f"constructed for thread_id={thread_id!r}: {run_errors!r}."
    )
    instance = ag._agents_by_thread.get(thread_id)
    assert instance is not None, (
        f"per-thread agent for thread_id={thread_id!r} was not created by "
        f"ag.run(); _agents_by_thread keys={list(ag._agents_by_thread)!r}."
    )
    return instance


class _InitCountingPlugin(Plugin):
    """Minimal plugin that records how many agents it was initialized on.

    ``init_agent`` is invoked by Strands' plugin registry once per agent the
    plugin is attached to. Counting those calls proves the plugin was not just
    forwarded as a kwarg but actually wired into each per-thread agent.
    """

    def __init__(self):
        super().__init__()
        self.init_count = 0

    @property
    def name(self) -> str:
        return "init-counting-plugin"

    def init_agent(self, agent) -> None:
        self.init_count += 1


@pytest.mark.asyncio
async def test_template_plugins_forwarded_to_per_thread_agent():
    """Plugins passed to StrandsAgent(plugins=...) must be forwarded to every
    per-thread StrandsAgentCore instance.

    Without it, any plugin whose behavior lives in init_agent /
    before-invocation hooks (e.g. AgentSkills) silently never runs, because
    only per-thread agents serve requests, not the template.
    """
    plugin = _InitCountingPlugin()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", plugins=[plugin])

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "plugins" in instance.init_kwargs, (
        "plugins kwarg not passed to per-thread StrandsAgentCore — "
        "any Plugin registered on the wrapper will never run its hooks."
    )
    assert plugin in instance.init_kwargs["plugins"], (
        f"plugin missing from per-thread plugins list; "
        f"got {instance.init_kwargs.get('plugins')}"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "plugins_value,label",
    [
        (None, "plugins kwarg omitted (plugins=None default)"),
        ([], "explicit empty list (plugins=[])"),
    ],
    ids=["default-none", "explicit-empty-list"],
)
async def test_no_plugins_kwarg_is_omitted_for_falsy_input(plugins_value, label):
    """When the caller supplies no plugins (omitting the kwarg or passing []),
    the wrapper must omit the ``plugins`` kwarg entirely when constructing each
    per-thread StrandsAgentCore — not forward ``None`` / ``[]``, which a future
    Strands version might interpret as "disable defaults"."""
    template = Agent(model=_mock_model())
    kwargs = {} if plugins_value is None else {"plugins": plugins_value}
    ag = StrandsAgent(template, name="test", **kwargs)

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "plugins" not in instance.init_kwargs, (
        f"[{label}] expected 'plugins' kwarg to be OMITTED from "
        f"StrandsAgentCore(**kwargs), but it was forwarded with value "
        f"{instance.init_kwargs.get('plugins')!r}"
    )


@pytest.mark.asyncio
async def test_plugins_init_agent_fires_per_thread_with_real_core():
    """Against the real strands.Agent: a plugin passed via
    StrandsAgent(plugins=[...]) must have its ``init_agent`` invoked once per
    per-thread agent — proving the plugin is genuinely wired into each thread,
    not just forwarded as a kwarg."""
    plugin = _InitCountingPlugin()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", plugins=[plugin])

    # Real StrandsAgentCore (no patch): each per-thread construction runs the
    # plugin registry, which calls plugin.init_agent(agent) exactly once.
    await _trigger_thread_creation(ag, "thread-a")
    await _trigger_thread_creation(ag, "thread-b")

    assert plugin.init_count == 2, (
        f"expected plugin.init_agent() to fire once per per-thread agent "
        f"(2 threads); got {plugin.init_count}. Either the plugins kwarg "
        "wasn't forwarded, or Strands changed its plugin-registry semantics."
    )
