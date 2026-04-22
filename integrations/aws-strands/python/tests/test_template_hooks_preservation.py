"""Tests that hooks registered on the template Agent are preserved on per-thread instances.

The StrandsAgent adapter constructs a fresh ``strands.Agent`` per ``thread_id``
from a template Agent. Previously, hook providers registered on the template
(for loop caps, observability, policy enforcement, etc.) were silently dropped
on every per-thread instance — the template itself never serves a request, so
hooks registered there never fired in production.

Each test below is written to FAIL on the pre-fix code (hooks dropped) and
PASS once hooks are forwarded to per-thread instances.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import RunErrorEvent
from strands import Agent
from strands.hooks import HookProvider
from strands.hooks.events import BeforeToolCallEvent
from strands.models.model import Model
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent


def _mock_model():
    """Build a spec'd Model mock so Strands' isinstance checks succeed.

    Using ``spec=Model`` ensures the mock reports as a ``Model`` instance,
    avoiding confusing failures if Strands ever tightens its type checks
    during Agent construction.

    ``stateful`` is verified present on ``strands.models.model.Model`` as
    of the installed Strands version (alongside ``get_config``, ``stream``,
    ``structured_output``, ``update_config``). Setting it to ``False``
    avoids MagicMock returning a truthy child mock for the attribute and
    confusing Agent constructor branches that key off statefulness.
    """
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
        # ``**_kwargs`` intentionally swallows future additions (e.g.
        # ``invocation_state`` in newer Strands versions) so this stub
        # doesn't TypeError the moment Strands adds a new parameter.
        if False:
            yield


async def _drive_run(ag: StrandsAgent, thread_id: str):
    """Consume ag.run() events until the per-thread agent exists.

    Returns the list of yielded events so callers can inspect them
    (e.g. to surface a ``RunErrorEvent`` before asserting the dict key
    is populated).
    """
    events = []
    async for ev in ag.run(_run_input(thread_id)):
        events.append(ev)
        # Early-exit as soon as the per-thread agent exists so tests stay
        # fast, but don't assume a specific yield order — if it's missing
        # we keep consuming events until the stream ends.
        if thread_id in ag._agents_by_thread:
            break
    return events


async def _trigger_thread_creation(ag: StrandsAgent, thread_id: str):
    """Drive ag.run() until the per-thread agent is constructed.

    We consume every yielded event rather than breaking on the first one —
    if the adapter ever re-orders construction relative to its initial yield,
    this keeps the test informative instead of crashing with ``KeyError``.

    If the adapter's outer except handler catches a construction failure
    and emits ``RunErrorEvent``, surface that first — otherwise the
    "construction order" diagnostic below is misleading and hides the
    real error.
    """
    events = await _drive_run(ag, thread_id)
    run_errors = [ev for ev in events if isinstance(ev, RunErrorEvent)]
    assert not run_errors, (
        f"ag.run() emitted RunErrorEvent(s) before per-thread agent was "
        f"constructed for thread_id={thread_id!r}: {run_errors!r}. The "
        "per-thread dict will not be populated; fix the underlying "
        "construction failure before debugging the 'construction order' path."
    )
    instance = ag._agents_by_thread.get(thread_id)
    assert instance is not None, (
        f"per-thread agent for thread_id={thread_id!r} was not created by "
        f"ag.run(); _agents_by_thread keys={list(ag._agents_by_thread)!r}. "
        "The adapter's run() method may have changed its construction order."
    )
    return instance


class _LoggingHooks(HookProvider):
    """Minimal hook provider used to verify callbacks reach per-thread agents."""

    def __init__(self):
        self.registrations = 0

    def register_hooks(self, registry):
        self.registrations += 1
        registry.add_callback(BeforeToolCallEvent, lambda e: None)


@pytest.mark.asyncio
async def test_template_hooks_forwarded_to_per_thread_agent():
    """Hook providers passed to StrandsAgent(hooks=...) must be forwarded
    to every per-thread StrandsAgentCore instance.

    This is the minimum contract: without it, any observability / loop-cap /
    policy-enforcement hook the caller registers silently never fires because
    only per-thread agents serve requests, not the template.
    """
    provider = _LoggingHooks()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", hooks=[provider])

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "hooks" in instance.init_kwargs, (
        "hooks kwarg not passed to per-thread StrandsAgentCore — "
        "any HookProvider registered on the wrapper will never fire."
    )
    assert provider in instance.init_kwargs["hooks"], (
        f"LoggingHooks provider missing from per-thread hooks list; "
        f"got {instance.init_kwargs.get('hooks')}"
    )


@pytest.mark.asyncio
async def test_each_thread_gets_independent_hook_invocation():
    """Each per-thread agent must receive the configured hook providers
    so callbacks fire on every thread, not just the first.

    Also asserts the provider's ``register_hooks`` is invoked once per
    per-thread agent (via its ``registrations`` counter). Proving the
    forwarding kwarg alone is insufficient — what matters for runtime
    correctness is that Strands' HookRegistry actually re-runs
    ``register_hooks`` on each thread's registry.
    """
    provider = _LoggingHooks()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", hooks=[provider])

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance_a = await _trigger_thread_creation(ag, "thread-a")
        instance_b = await _trigger_thread_creation(ag, "thread-b")

    assert provider in instance_a.init_kwargs.get("hooks", []), (
        "thread-a did not receive the hook provider"
    )
    assert provider in instance_b.init_kwargs.get("hooks", []), (
        "thread-b did not receive the hook provider"
    )
    # _CapturingCore is a stub and does not itself wire hooks into a
    # HookRegistry, so ``registrations`` stays at 0 here — the real
    # registration counting is exercised in
    # ``test_registrations_fire_per_thread_with_real_core`` below, which
    # uses the real StrandsAgentCore.


# Parametrize over the two "no hooks supplied" shapes: ``None`` (kwarg
# omitted at call site) and ``[]`` (explicit empty list). Both must
# result in the ``hooks`` kwarg being OMITTED from the per-thread
# StrandsAgentCore construction — not forwarded as ``None`` / ``[]``,
# which future Strands versions might interpret as "disable default
# hooks".
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "hooks_value,label",
    [(None, "hooks kwarg omitted (hooks=None default)"),
     ([], "explicit empty list (hooks=[])")],
    ids=["default-none", "explicit-empty-list"],
)
async def test_no_hooks_kwarg_is_omitted_for_falsy_input(hooks_value, label):
    """When the caller does not supply hook providers (either by omitting
    the kwarg or by passing ``hooks=[]``), the wrapper must omit the
    ``hooks`` kwarg entirely when constructing each per-thread
    StrandsAgentCore."""
    template = Agent(model=_mock_model())
    kwargs = {} if hooks_value is None else {"hooks": hooks_value}
    ag = StrandsAgent(template, name="test", **kwargs)

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "hooks" not in instance.init_kwargs, (
        f"[{label}] expected 'hooks' kwarg to be OMITTED from "
        f"StrandsAgentCore(**kwargs), but it was forwarded with value "
        f"{instance.init_kwargs.get('hooks')!r}"
    )


@pytest.mark.asyncio
async def test_hooks_kwarg_forwarded_when_provider_supplied():
    """Positive-case complement to ``test_no_hooks_kwarg_is_omitted_for_falsy_input``.

    When the caller DOES supply at least one ``HookProvider``, the wrapper
    must forward a ``hooks=[...]`` list to the per-thread StrandsAgentCore
    that contains the provider. Guards against a regression where the
    truthy-branch flips to "also omit" or mutates the list shape.
    """
    provider = _LoggingHooks()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", hooks=[provider])

    with patch("ag_ui_strands.agent.StrandsAgentCore", _CapturingCore):
        instance = await _trigger_thread_creation(ag, "t1")

    assert "hooks" in instance.init_kwargs, (
        "'hooks' kwarg missing from StrandsAgentCore(**kwargs) even though "
        "a HookProvider was supplied to StrandsAgent(hooks=[...])"
    )
    forwarded = instance.init_kwargs["hooks"]
    assert isinstance(forwarded, list), (
        f"expected 'hooks' to be a list, got {type(forwarded).__name__}"
    )
    assert provider in forwarded, (
        f"expected provider {provider!r} to be forwarded; got {forwarded!r}"
    )


@pytest.mark.asyncio
async def test_hooks_integration_real_core_fires_callback():
    """End-to-end-ish check against the real strands.Agent: a callback
    registered via StrandsAgent(hooks=[...]) must actually fire inside
    the per-thread agent's HookRegistry. This is the high-signal repro
    from the upstream bug report."""
    fire_count = {"n": 0}

    class _CountingHooks(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(
                BeforeToolCallEvent, lambda e: fire_count.__setitem__("n", fire_count["n"] + 1)
            )

    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", hooks=[_CountingHooks()])

    # Trigger per-thread agent creation using the real StrandsAgentCore.
    # Reuse the same robust "consume until populated, then surface
    # RunErrorEvents" pattern the other tests use so this one doesn't
    # KeyError if adapter construction order shifts relative to the
    # first yielded event.
    per_thread = await _trigger_thread_creation(ag, "t1")

    # Behavioral proof: invoke BeforeToolCallEvent through the per-thread
    # agent's registry and verify our callback actually fires. This is the
    # only assertion that matters — we deliberately avoid probing private
    # internals like ``hooks._registered_callbacks`` so the test stays green
    # if Strands renames or restructures its HookRegistry storage.
    from strands.hooks.events import BeforeToolCallEvent as _BTCE

    per_thread.hooks.invoke_callbacks(
        _BTCE(
            agent=per_thread,
            # ``selected_tool`` is typed ``AgentTool | None`` in Strands'
            # signature, so None is a valid minimal construction. If that
            # ever tightens, construct a stub AgentTool instead.
            selected_tool=None,
            tool_use={"name": "x", "toolUseId": "1", "input": {}},
            invocation_state={},
        )
    )
    assert fire_count["n"] >= 1, (
        "BeforeToolCallEvent callback did not fire on the per-thread agent — "
        "hooks were dropped when constructing from the template."
    )


@pytest.mark.asyncio
async def test_registrations_fire_per_thread_with_real_core():
    """Verifies per-thread ``register_hooks`` invocation against the real
    StrandsAgentCore.

    Uses ``_LoggingHooks.registrations`` counter to prove that each
    per-thread agent's HookRegistry actually re-invokes our provider's
    ``register_hooks`` — not just that the provider reference was
    forwarded via the kwarg. This closes the gap between "list plumbing
    works" and "callbacks are actually wired into each thread's
    registry".
    """
    provider = _LoggingHooks()
    template = Agent(model=_mock_model())
    ag = StrandsAgent(template, name="test", hooks=[provider])

    # Real StrandsAgentCore is in play (no patch); each per-thread
    # construction builds a fresh HookRegistry which calls
    # ``provider.register_hooks(registry)`` exactly once.
    await _trigger_thread_creation(ag, "thread-a")
    await _trigger_thread_creation(ag, "thread-b")
    await _trigger_thread_creation(ag, "thread-c")

    assert provider.registrations == 3, (
        f"expected provider.register_hooks() to be invoked once per "
        f"per-thread agent (3 threads); got {provider.registrations}. "
        "Either the hooks kwarg wasn't forwarded, or Strands changed its "
        "HookRegistry construction semantics."
    )
