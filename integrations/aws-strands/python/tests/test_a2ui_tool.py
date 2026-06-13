"""Unit tests for the AWS Strands A2UI subagent tool — Python.

Mirrors the TypeScript suite
(integrations/aws-strands/typescript/src/__tests__/a2ui-tool.test.ts), covering
both wiring modes (explicit + auto-injected), message-shape helpers, error
classification, and
the sub-agent streaming translation:

  Explicit wiring: ``get_a2ui_tools(params)`` returns a Strands
  ``AgentTool`` subclass named ``generate_a2ui`` that runs the toolkit recovery
  loop.

  Auto-injection: ``plan_a2ui_injection(...)`` is the pure per-run
  decision — read the runtime ``injectA2UITool`` flag off ``forwarded_props``,
  infer the model from the wrapped agent, resolve the catalog from
  ``input.context``, and decide whether to inject ``generate_a2ui`` (and which
  injected render tool to drop). Returns ``None`` when it must NOT inject.

String literals mirror the shared constants (``GENERATE_A2UI_TOOL_NAME`` from
ag-ui-a2ui-toolkit, ``RENDER_A2UI_TOOL_NAME`` + ``A2UI_SCHEMA_CONTEXT_DESCRIPTION``
from @ag-ui/a2ui-middleware), hardcoded ON PURPOSE: these are cross-package
wire contracts, and a hardcoded copy makes the suite fail if an upstream
constant drifts (importing the constant would hide the drift).
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from ag_ui.core import Context, EventType, RunAgentInput, Tool, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.a2ui_tool import (
    A2UI_STREAM_KEY,
    classify_a2ui_subagent_error,
    get_a2ui_tools,
    is_auto_injected_a2ui_tool,
    plan_a2ui_injection,
    strands_tool_results_to_agui,
    strip_in_flight_tool_call,
)
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig

GENERATE_A2UI_TOOL_NAME = "generate_a2ui"
RENDER_A2UI_TOOL_NAME = "render_a2ui"
A2UI_SCHEMA_CONTEXT_DESCRIPTION = (
    "A2UI Component Schema — available components for generating UI surfaces. "
    "Use these component names and properties when creating A2UI operations."
)
A2UI_OPS_KEY = "a2ui_operations"

STUB_MODEL = MagicMock(name="stub-model")
CATALOG = {
    "components": {
        "Row": {"required": ["children"]},
        "HotelCard": {"required": ["name", "rating"]},
    }
}


def _input(forwarded_props=None, context=None, tools=None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=[],
        tools=tools or [],
        context=context or [],
        forwarded_props=forwarded_props or {},
    )


# ---------------------------------------------------------------------------
# Explicit factory
# ---------------------------------------------------------------------------


def test_get_a2ui_tools_default_name():
    tool = get_a2ui_tools({"model": STUB_MODEL})
    assert tool.tool_name == GENERATE_A2UI_TOOL_NAME


def test_get_a2ui_tools_custom_name():
    tool = get_a2ui_tools({"model": STUB_MODEL, "tool_name": "make_ui"})
    assert tool.tool_name == "make_ui"


# ---------------------------------------------------------------------------
# Auto-inject decision
# ---------------------------------------------------------------------------


def test_injects_when_flag_true_and_model_present():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["tool_name"] == GENERATE_A2UI_TOOL_NAME
    assert RENDER_A2UI_TOOL_NAME in plan["drop_tool_names"]


def test_drops_custom_named_render_tool_when_flag_is_string():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": "render_ui_custom"}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["tool_name"] == GENERATE_A2UI_TOOL_NAME
    assert "render_ui_custom" in plan["drop_tool_names"]


def test_skips_and_warns_when_no_model_inferable_orchestrator():
    log = MagicMock()
    plan = plan_a2ui_injection(
        model=None,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
        log=log,
    )
    assert plan is None
    log.warning.assert_called_once()


def test_no_inject_without_flag_or_override():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(),
        existing_tool_names=[],
    )
    assert plan is None


def test_backend_override_injects_without_runtime_flag():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(),
        existing_tool_names=[],
        config={"inject_a2ui_tool": True},
    )
    assert plan is not None
    assert plan["tool_name"] == GENERATE_A2UI_TOOL_NAME


def test_user_prevails_no_double_inject():
    # THE "USER PREVAILS" REQUIREMENT: explicit dev wiring wins.
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[GENERATE_A2UI_TOOL_NAME],
    )
    assert plan is None


def test_resolves_catalog_from_schema_context_entry():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(
            forwarded_props={"injectA2UITool": True},
            context=[
                Context(
                    description=A2UI_SCHEMA_CONTEXT_DESCRIPTION,
                    value=json.dumps(CATALOG),
                )
            ],
        ),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["catalog"] == CATALOG


def test_marker_distinguishes_auto_injected_from_dev_wired():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": True}),
        existing_tool_names=[],
    )
    assert plan is not None
    assert is_auto_injected_a2ui_tool(plan["tool"]) is True
    # A dev-wired tool carries no marker.
    assert is_auto_injected_a2ui_tool(get_a2ui_tools({"model": STUB_MODEL})) is False


# ---------------------------------------------------------------------------
# Message-shape helpers (Strands python message dicts)
# ---------------------------------------------------------------------------


def test_strip_in_flight_tool_call_drops_trailing_call():
    messages = [
        {"role": "user", "content": [{"text": "compare hotels"}]},
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"name": GENERATE_A2UI_TOOL_NAME, "toolUseId": "t1", "input": {}}}
            ],
        },
    ]
    stripped = strip_in_flight_tool_call(messages, GENERATE_A2UI_TOOL_NAME)
    assert len(stripped) == 1
    assert stripped[0]["role"] == "user"


def test_strip_in_flight_tool_call_keeps_trailing_user_turn():
    messages = [{"role": "user", "content": [{"text": "compare hotels"}]}]
    assert len(strip_in_flight_tool_call(messages, GENERATE_A2UI_TOOL_NAME)) == 1


def test_strands_tool_results_to_agui_reconstructs_a2ui_results():
    envelope = json.dumps({A2UI_OPS_KEY: [{"version": "v0.9"}]})
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "tc1",
                        "status": "success",
                        "content": [{"text": envelope}],
                    }
                }
            ],
        }
    ]
    agui = strands_tool_results_to_agui(messages)
    assert len(agui) == 1
    assert agui[0]["role"] == "tool"
    assert agui[0]["tool_call_id"] == "tc1"
    assert A2UI_OPS_KEY in agui[0]["content"]


def test_strands_tool_results_to_agui_handles_json_blocks_and_ignores_non_a2ui():
    # {json} content block form.
    from_json = strands_tool_results_to_agui(
        [
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "tc2",
                            "status": "success",
                            "content": [{"json": {A2UI_OPS_KEY: [{"version": "v0.9"}]}}],
                        }
                    }
                ],
            }
        ]
    )
    assert len(from_json) == 1
    assert A2UI_OPS_KEY in from_json[0]["content"]
    # Non-A2UI tool results are ignored.
    ignored = strands_tool_results_to_agui(
        [
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "tc3",
                            "status": "success",
                            "content": [{"text": "just a weather result"}],
                        }
                    }
                ],
            }
        ]
    )
    assert ignored == []


# ---------------------------------------------------------------------------
# Sub-agent error classification
# ---------------------------------------------------------------------------


def test_classify_rethrows_cancellation_and_programmer_errors():
    assert classify_a2ui_subagent_error(asyncio.CancelledError(), False) == "rethrow"
    assert classify_a2ui_subagent_error(Exception("x"), True) == "rethrow"
    assert classify_a2ui_subagent_error(TypeError("x"), False) == "rethrow"
    assert classify_a2ui_subagent_error(NameError("x"), False) == "rethrow"


def test_classify_treats_model_errors_as_recoverable():
    assert classify_a2ui_subagent_error(Exception("Bedrock 429"), False) == "recoverable"


# ---------------------------------------------------------------------------
# Adapter integration — scripted runs (conventions from
# tests/test_streaming_predict_state.py)
# ---------------------------------------------------------------------------


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    # A bare MagicMock auto-creates a truthy `_session_manager`, which would
    # fire the "session_manager will be ignored" warning in every test.
    mock._session_manager = None
    return mock


def _build_agent(thread_id: str, stream_events: list, config=None) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.model = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.session_manager = None
    # Without this a bare MagicMock auto-creates a truthy `_session_manager`,
    # flipping `_has_strands_session_manager` True and silently routing every
    # test through the legacy (non-replay) path instead of the default
    # `replay_history_into_strands` one.
    mock_inner._session_manager = None
    mock_inner.messages = []

    async def _stream(_msg):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


RENDER_TOOL_INPUT = Tool(
    name=RENDER_A2UI_TOOL_NAME,
    description="render a2ui",
    parameters={"type": "object", "properties": {}},
)


def _msg_input(**overrides) -> RunAgentInput:
    base = dict(
        thread_id="thread-1",
        run_id="run-1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hi")],
        tools=[],
        context=[],
        forwarded_props={},
    )
    base.update(overrides)
    return RunAgentInput(**base)


@pytest.mark.asyncio
async def test_auto_inject_registers_generate_and_drops_render_across_turns():
    """F1 regression: turn 2 on a cached thread must re-drop the re-synced
    render_a2ui and keep exactly one generate_a2ui (our own marked tool is
    refreshed, never treated as dev-wired)."""
    agent = _build_agent("thread-1", [])
    registry = agent._agents_by_thread["thread-1"].tool_registry

    inp = _msg_input(
        forwarded_props={"injectA2UITool": True}, tools=[RENDER_TOOL_INPUT]
    )
    await _collect(agent, inp)
    names = set(registry.registry.keys())
    assert GENERATE_A2UI_TOOL_NAME in names
    assert RENDER_A2UI_TOOL_NAME not in names
    tool_turn1 = registry.registry[GENERATE_A2UI_TOOL_NAME]
    # The dropped render tool must also leave the proxy bookkeeping.
    assert RENDER_A2UI_TOOL_NAME not in agent._proxy_tool_names_by_thread["thread-1"]

    # Turn 2: syncProxyTools re-adds render_a2ui from input.tools; the hook
    # must drop it again and refresh (not duplicate) generate_a2ui.
    await _collect(agent, inp)
    names = set(registry.registry.keys())
    assert GENERATE_A2UI_TOOL_NAME in names
    assert RENDER_A2UI_TOOL_NAME not in names
    # "Refresh" means a REBUILT tool carrying turn-2 glue — reusing the turn-1
    # object would resolve `intent:"update"` priors against stale history.
    assert registry.registry[GENERATE_A2UI_TOOL_NAME] is not tool_turn1


@pytest.mark.asyncio
async def test_tool_stream_a2ui_payloads_become_inner_tool_call_events():
    """The generate_a2ui tool yields A2UI_STREAM_KEY payloads; the adapter must
    re-emit them as synthetic inner TOOL_CALL_START/ARGS/END so the middleware
    can drive the building skeleton + progressive paint."""
    events = [
        {
            "tool_stream_event": {
                "data": {
                    A2UI_STREAM_KEY: {
                        "kind": "start",
                        "tool_call_id": "r1",
                        "tool_call_name": RENDER_A2UI_TOOL_NAME,
                    }
                }
            }
        },
        {
            "tool_stream_event": {
                "data": {A2UI_STREAM_KEY: {"kind": "args", "tool_call_id": "r1", "delta": '{"surfaceId":'}}
            }
        },
        {
            "tool_stream_event": {
                "data": {A2UI_STREAM_KEY: {"kind": "args", "tool_call_id": "r1", "delta": '"s1"}'}}
            }
        },
        {
            "tool_stream_event": {
                "data": {A2UI_STREAM_KEY: {"kind": "end", "tool_call_id": "r1"}}
            }
        },
    ]
    agent = _build_agent("thread-1", events)
    out = await _collect(agent, _msg_input())

    starts = [
        e
        for e in out
        if e.type == EventType.TOOL_CALL_START
        and getattr(e, "tool_call_name", None) == RENDER_A2UI_TOOL_NAME
    ]
    assert len(starts) == 1
    assert starts[0].tool_call_id == "r1"

    deltas = [
        getattr(e, "delta", "")
        for e in out
        if e.type == EventType.TOOL_CALL_ARGS and getattr(e, "tool_call_id", None) == "r1"
    ]
    assert "".join(deltas) == '{"surfaceId":"s1"}'

    assert any(
        e.type == EventType.TOOL_CALL_END and getattr(e, "tool_call_id", None) == "r1"
        for e in out
    )


# ---------------------------------------------------------------------------
# _GenerateA2UITool.stream() — the REAL executor + queue drain path
# ---------------------------------------------------------------------------


def _tool_use(args=None):
    return {"name": GENERATE_A2UI_TOOL_NAME, "toolUseId": "tu-1", "input": args or {}}


async def _drive_stream(tool, invocation_state=None):
    events = []
    async for ev in tool.stream(_tool_use(), invocation_state or {}):
        events.append(ev)
    return events


@pytest.mark.asyncio
async def test_stream_drains_all_pushed_events_through_executor(monkeypatch):
    """Drives the real worker-thread + queue drain path (not the mocked
    adapter loop): every pushed payload — including the terminal `end` pushed
    just before the recovery future resolves — must reach the wire, and the
    final ToolResultEvent must carry the envelope."""
    import ag_ui_strands.a2ui_tool as mod

    async def fake_subagent(model, prompt, messages, push):
        push({"kind": "start", "tool_call_id": "r1", "tool_call_name": "render_a2ui"})
        for i in range(5):
            push({"kind": "args", "tool_call_id": "r1", "delta": f"chunk{i}"})
        push({"kind": "end", "tool_call_id": "r1"})
        return {"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    events = await _drive_stream(tool)

    payloads = [
        ev["tool_stream_event"]["data"][A2UI_STREAM_KEY]
        for ev in events
        if isinstance(ev, dict) and "tool_stream_event" in ev
    ]
    kinds = [p["kind"] for p in payloads]
    assert kinds[0] == "start"
    assert kinds.count("args") == 5
    assert kinds[-1] == "end", "terminal end push must not be dropped"

    # Final event is the ToolResultEvent wrapper; its text carries the envelope.
    text = str(events[-1])
    assert A2UI_OPS_KEY in text


@pytest.mark.asyncio
async def test_stream_update_intent_without_prior_returns_error_envelope(monkeypatch):
    """intent='update' with an unknown surface short-circuits to an error
    envelope (no recovery loop, no sub-agent call)."""
    import ag_ui_strands.a2ui_tool as mod

    async def fail_subagent(*a, **k):  # pragma: no cover — must not be called
        raise AssertionError("sub-agent must not run on prep error")

    monkeypatch.setattr(mod, "_stream_render_subagent", fail_subagent)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-2",
            "input": {"intent": "update", "target_surface_id": "nope"},
        },
        {},
    ):
        events.append(ev)
    text = str(events[-1])
    assert "error" in text
    assert A2UI_OPS_KEY not in text


@pytest.mark.asyncio
async def test_stream_recoverable_subagent_error_yields_hard_failure(monkeypatch):
    """A recoverable sub-agent error per attempt exhausts the recovery loop and
    yields the structured hard-failure envelope — never a crash."""
    import ag_ui_strands.a2ui_tool as mod

    async def boom(model, prompt, messages, push):
        raise RuntimeError("model 429")

    monkeypatch.setattr(mod, "_stream_render_subagent", boom)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    events = await _drive_stream(tool)
    text = str(events[-1])
    assert "a2ui_recovery_exhausted" in text


@pytest.mark.asyncio
async def test_stream_programmer_error_propagates(monkeypatch):
    """TypeError from the sub-agent path is an adapter bug — it must unwind,
    not masquerade as a failed attempt."""
    import ag_ui_strands.a2ui_tool as mod

    async def bug(model, prompt, messages, push):
        raise TypeError("adapter bug")

    monkeypatch.setattr(mod, "_stream_render_subagent", bug)
    tool = get_a2ui_tools({"model": STUB_MODEL})
    with pytest.raises(TypeError):
        await _drive_stream(tool)


def test_resolve_catalog_malformed_json_returns_none():
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(
            forwarded_props={"injectA2UITool": True},
            context=[
                Context(description=A2UI_SCHEMA_CONTEXT_DESCRIPTION, value="{not json")
            ],
        ),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["catalog"] is None


# ---------------------------------------------------------------------------
# _stream_render_subagent — the REAL streaming translation (faked Agent)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_render_subagent_streams_raw_arg_growth_as_deltas(monkeypatch):
    """Direct coverage of ``_stream_render_subagent`` (OpenAI-chat provider
    shape): the growing ``current_tool_use.input`` string must become start +
    incremental args deltas + end, all under the live toolUseId."""
    import ag_ui_strands.a2ui_tool as mod

    class FakeAgent:
        def __init__(self, **kwargs):
            self._tools = kwargs.get("tools") or []

        async def stream_async(self, _msg):
            yield {
                "current_tool_use": {
                    "name": RENDER_A2UI_TOOL_NAME,
                    "toolUseId": "r1",
                    "input": '{"surf',
                }
            }
            yield {"unrelated_event": True}
            yield {
                "current_tool_use": {
                    "name": RENDER_A2UI_TOOL_NAME,
                    "toolUseId": "r1",
                    "input": '{"surfaceId": "s1"}',
                }
            }

    monkeypatch.setattr(mod, "Agent", FakeAgent)
    pushed = []
    captured = await mod._stream_render_subagent(STUB_MODEL, "prompt", [], pushed.append)

    kinds = [p["kind"] for p in pushed]
    assert kinds == ["start", "args", "args", "end"]
    assert (
        "".join(p["delta"] for p in pushed if p["kind"] == "args")
        == '{"surfaceId": "s1"}'
    )
    assert all(p["tool_call_id"] == "r1" for p in pushed)
    # The fake never invoked the render tool: no captured args -> the recovery
    # loop records a no-call attempt.
    assert captured is None


@pytest.mark.asyncio
async def test_render_subagent_dict_input_falls_back_to_single_delta(monkeypatch):
    """Direct coverage of the parsed-dict provider shape (Anthropic/Gemini
    deliver ``input`` as a dict with no raw string growth): the captured args
    must be emitted as ONE args delta before ``end`` so the middleware still
    sees the components before the result."""
    import ag_ui_strands.a2ui_tool as mod

    args = {"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}

    class FakeAgent:
        def __init__(self, **kwargs):
            self._tools = kwargs.get("tools") or []

        async def stream_async(self, _msg):
            yield {
                "current_tool_use": {
                    "name": RENDER_A2UI_TOOL_NAME,
                    "toolUseId": "r1",
                    "input": dict(args),
                }
            }
            # The model "invokes" the bound render tool, which captures args.
            async for _ in self._tools[0].stream(
                {"name": RENDER_A2UI_TOOL_NAME, "toolUseId": "r1", "input": dict(args)},
                {},
            ):
                pass

    monkeypatch.setattr(mod, "Agent", FakeAgent)
    pushed = []
    captured = await mod._stream_render_subagent(STUB_MODEL, "prompt", [], pushed.append)

    kinds = [p["kind"] for p in pushed]
    assert kinds == ["start", "args", "end"]
    assert json.loads(pushed[1]["delta"]) == args
    assert captured == args


@pytest.mark.asyncio
async def test_auto_inject_failure_never_crashes_run(monkeypatch):
    """The auto-inject hook is best-effort by contract: a planner bug must log and
    leave the turn running without A2UI — never escape after RUN_STARTED."""
    import ag_ui_strands.agent as agent_mod

    def boom(**_kwargs):
        raise RuntimeError("planner exploded")

    monkeypatch.setattr(agent_mod, "plan_a2ui_injection", boom)
    agent = _build_agent("thread-1", [])
    out = await _collect(
        agent,
        _msg_input(forwarded_props={"injectA2UITool": True}, tools=[RENDER_TOOL_INPUT]),
    )
    types = [e.type for e in out]
    assert EventType.RUN_STARTED in types
    assert EventType.RUN_FINISHED in types
    assert EventType.RUN_ERROR not in types


def test_classify_rethrows_non_exception_base_exceptions():
    """SystemExit/KeyboardInterrupt signal shutdown — the recovery loop must
    not retry through them."""
    assert classify_a2ui_subagent_error(SystemExit(), False) == "rethrow"
    assert classify_a2ui_subagent_error(KeyboardInterrupt(), False) == "rethrow"
    # Genuine model/network errors remain recoverable.
    assert classify_a2ui_subagent_error(RuntimeError("429"), False) == "recoverable"


def test_explicit_runtime_false_disables_backend_override():
    """Nullish (not falsy) fallback, mirroring the TS adapter's `??`: a runtime
    that explicitly forwards injectA2UITool=False wins over a backend opt-in."""
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(forwarded_props={"injectA2UITool": False}),
        existing_tool_names=[],
        config={"inject_a2ui_tool": True},
    )
    assert plan is None


def test_resolve_catalog_non_dict_json_returns_none():
    """Parseable-but-wrong-shape JSON (array/scalar) must degrade to no
    catalog, not flow into catalog-aware validation as a non-dict."""
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(
            forwarded_props={"injectA2UITool": True},
            context=[
                Context(description=A2UI_SCHEMA_CONTEXT_DESCRIPTION, value="[]")
            ],
        ),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["catalog"] is None


@pytest.mark.asyncio
async def test_stream_update_intent_reuses_prior_surface(monkeypatch):
    """The auto-inject glue's purpose: `intent:"update"` resolves the prior surface
    from glue agui_messages and the envelope reconciles in place — no
    createSurface op (v0.9 forbids re-creating an existing surface id)."""
    import ag_ui_strands.a2ui_tool as mod

    prior_envelope = json.dumps(
        {
            A2UI_OPS_KEY: [
                {
                    "createSurface": {
                        "surfaceId": "s1",
                        "catalogId": "https://example.com/cat.json",
                    }
                },
                {
                    "updateComponents": {
                        "surfaceId": "s1",
                        "components": [{"id": "root", "component": "Row"}],
                    }
                },
            ]
        }
    )

    async def fake_subagent(model, prompt, messages, push):
        return {"components": [{"id": "root", "component": "Column"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools(
        {"model": STUB_MODEL},
        glue={"agui_messages": [{"role": "tool", "content": prior_envelope}]},
    )
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-up",
            "input": {"intent": "update", "target_surface_id": "s1"},
        },
        {},
    ):
        events.append(ev)

    text = str(events[-1])
    assert A2UI_OPS_KEY in text
    assert "updateComponents" in text
    assert "createSurface" not in text
    assert '\\"surfaceId\\": \\"s1\\"' in text or '"surfaceId": "s1"' in text


@pytest.mark.asyncio
async def test_stream_abandonment_stops_further_recovery_attempts(
    monkeypatch, caplog
):
    """Closing the stream mid-run (client disconnect) sets the disconnect
    flag: the recovery loop must not fire further sub-agent attempts for a
    consumer that's gone — and the intentional abort must not be logged as a
    recovery failure."""
    import threading as _threading

    import ag_ui_strands.a2ui_tool as mod

    attempts: list[int] = []
    gate = _threading.Event()

    async def fake_subagent(model, prompt, messages, push):
        attempts.append(1)
        push(
            {
                "kind": "start",
                "tool_call_id": f"r{len(attempts)}",
                "tool_call_name": RENDER_A2UI_TOOL_NAME,
            }
        )
        gate.wait(timeout=5)  # hold the attempt open until the test closes
        return None  # "no tool call" -> the loop would normally retry

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools({"model": STUB_MODEL})

    agen = tool.stream(_tool_use(), {})
    await agen.__anext__()  # first pushed event reached the wire
    await agen.aclose()  # consumer disconnects mid-drain
    gate.set()  # let attempt 1 finish in the worker

    # Give the executor time to (wrongly) start attempt 2 if the disconnect
    # flag were broken.
    await asyncio.sleep(0.4)
    assert len(attempts) == 1, "no further attempts after consumer disconnect"
    # The deliberate between-attempt CancelledError lands on the future as a
    # stored exception (FINISHED, not CANCELLED) — the abandoned-result
    # consumer must recognize it as intentional, not warn about it.
    # (caplog captures at level 0 by default; the explicit filter below keys
    # off the message, so no at_level scoping is needed.)
    assert not [
        r for r in caplog.records if "A2UI recovery loop failed" in r.getMessage()
    ], "intentional disconnect abort must not be logged as a failure"


def test_resolve_catalog_empty_value_returns_none():
    """An A2UI schema context entry with an empty value degrades to no
    catalog (with a breadcrumb), same as the malformed/wrong-shape branches."""
    plan = plan_a2ui_injection(
        model=STUB_MODEL,
        input=_input(
            forwarded_props={"injectA2UITool": True},
            context=[Context(description=A2UI_SCHEMA_CONTEXT_DESCRIPTION, value="")],
        ),
        existing_tool_names=[],
    )
    assert plan is not None
    assert plan["catalog"] is None


@pytest.mark.asyncio
async def test_no_flag_turn_removes_stale_auto_injected_tool():
    """Turn N+1 WITHOUT the runtime flag must remove turn N's auto-injected
    generate_a2ui (the sweep runs regardless of whether a new plan injects)."""
    agent = _build_agent("thread-1", [])
    registry = agent._agents_by_thread["thread-1"].tool_registry

    await _collect(
        agent,
        _msg_input(forwarded_props={"injectA2UITool": True}, tools=[RENDER_TOOL_INPUT]),
    )
    assert GENERATE_A2UI_TOOL_NAME in registry.registry

    # Flag gone on the next turn: our marked tool must not linger.
    await _collect(agent, _msg_input(forwarded_props={}, tools=[]))
    assert GENERATE_A2UI_TOOL_NAME not in registry.registry


@pytest.mark.asyncio
async def test_stream_update_intent_with_pydantic_glue_messages(monkeypatch):
    """Auto-injection passes pydantic message objects (not dicts) as glue — the prior
    surface must still resolve. Locks the object-shape contract against a
    dict-only toolkit refactor."""
    from ag_ui.core import ToolMessage

    import ag_ui_strands.a2ui_tool as mod

    prior_envelope = json.dumps(
        {
            A2UI_OPS_KEY: [
                {"createSurface": {"surfaceId": "s1", "catalogId": "cat-1"}},
                {
                    "updateComponents": {
                        "surfaceId": "s1",
                        "components": [{"id": "root", "component": "Row"}],
                    }
                },
            ]
        }
    )

    async def fake_subagent(model, prompt, messages, push):
        return {"components": [{"id": "root", "component": "Column"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools(
        {"model": STUB_MODEL},
        glue={
            "agui_messages": [
                ToolMessage(
                    id="t1", role="tool", content=prior_envelope, tool_call_id="tc1"
                )
            ]
        },
    )
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-up2",
            "input": {"intent": "update", "target_surface_id": "s1"},
        },
        {},
    ):
        events.append(ev)

    text = str(events[-1])
    assert "updateComponents" in text
    assert "createSurface" not in text


def test_get_a2ui_tools_requires_model():
    """Explicit wiring without a model would silently bind Strands' default Bedrock
    model — fail loud instead (the TS factory enforces this in the types)."""
    with pytest.raises(ValueError, match="model"):
        get_a2ui_tools({})


@pytest.mark.asyncio
async def test_render_subagent_zero_frames_synthesizes_triplet(monkeypatch):
    """A provider that invokes the bound render tool without emitting any
    current_tool_use frames must still produce start/args/end so the
    middleware paints before the result (no bulk paint)."""
    import ag_ui_strands.a2ui_tool as mod

    args = {"surfaceId": "s1", "components": [{"id": "root", "component": "Row"}]}

    class FakeAgent:
        def __init__(self, **kwargs):
            self._tools = kwargs.get("tools") or []

        async def stream_async(self, _msg):
            # No current_tool_use frames at all — only the tool invocation.
            async for _ in self._tools[0].stream(
                {"name": RENDER_A2UI_TOOL_NAME, "toolUseId": "r1", "input": dict(args)},
                {},
            ):
                pass
            if False:  # pragma: no cover — make this an async generator
                yield None

    monkeypatch.setattr(mod, "Agent", FakeAgent)
    pushed = []
    captured = await mod._stream_render_subagent(STUB_MODEL, "prompt", [], pushed.append)

    kinds = [p["kind"] for p in pushed]
    assert kinds == ["start", "args", "end"]
    assert json.loads(pushed[1]["delta"]) == args
    assert captured == args


@pytest.mark.asyncio
async def test_render_subagent_midstream_error_closes_live_call(monkeypatch):
    """A provider stream dying mid-call (429, network drop) must close the
    live synthetic call — an unclosed inner TOOL_CALL_START is a wire-protocol
    violation and the next recovery attempt would open a fresh call on top."""
    import ag_ui_strands.a2ui_tool as mod

    class FakeAgent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, _msg):
            yield {
                "current_tool_use": {
                    "name": RENDER_A2UI_TOOL_NAME,
                    "toolUseId": "r1",
                    "input": '{"surf',
                }
            }
            raise RuntimeError("model 429")

    monkeypatch.setattr(mod, "Agent", FakeAgent)
    pushed = []
    with pytest.raises(RuntimeError):
        await mod._stream_render_subagent(STUB_MODEL, "prompt", [], pushed.append)

    kinds = [p["kind"] for p in pushed]
    assert kinds == ["start", "args", "end"]
    assert pushed[-1]["tool_call_id"] == "r1"


@pytest.mark.asyncio
async def test_render_subagent_second_call_id_closes_first(monkeypatch):
    """A second render call with a distinct real toolUseId must close the
    first call and reset the delta accumulator (no cross-call mis-attribution)."""
    import ag_ui_strands.a2ui_tool as mod

    class FakeAgent:
        def __init__(self, **kwargs):
            pass

        async def stream_async(self, _msg):
            yield {
                "current_tool_use": {
                    "name": RENDER_A2UI_TOOL_NAME,
                    "toolUseId": "r1",
                    "input": '{"a": 1}',
                }
            }
            yield {
                "current_tool_use": {
                    "name": RENDER_A2UI_TOOL_NAME,
                    "toolUseId": "r2",
                    "input": '{"b',
                }
            }

    monkeypatch.setattr(mod, "Agent", FakeAgent)
    pushed = []
    await mod._stream_render_subagent(STUB_MODEL, "prompt", [], pushed.append)

    assert [(p["kind"], p["tool_call_id"]) for p in pushed] == [
        ("start", "r1"),
        ("args", "r1"),
        ("end", "r1"),
        ("start", "r2"),
        ("args", "r2"),
        ("end", "r2"),
    ]
    # Delta accumulator reset: r2's delta is its full prefix, not a slice
    # against r1's length.
    assert pushed[4]["delta"] == '{"b'


@pytest.mark.asyncio
async def test_stream_non_dict_glue_state_degrades(monkeypatch):
    """A truthy non-dict glue state must degrade to empty state — generation
    proceeds rather than crashing before the recovery loop engages."""
    import ag_ui_strands.a2ui_tool as mod

    async def fake_subagent(model, prompt, messages, push):
        return {"components": [{"id": "root", "component": "Row"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    tool = get_a2ui_tools(
        {"model": STUB_MODEL}, glue={"state": "not-a-dict", "agui_messages": []}
    )
    events = await _drive_stream(tool)
    assert A2UI_OPS_KEY in str(events[-1])


def test_snake_case_recovery_key_warns(caplog):
    """snake_case recovery keys are silently ignored by the camelCase toolkit
    contract — the factory must leave a breadcrumb."""
    import logging

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands"):
        get_a2ui_tools({"model": STUB_MODEL, "recovery": {"max_attempts": 5}})
    assert any("max_attempts" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_stream_update_intent_finds_same_run_surface(monkeypatch):
    """The auto-inject glue snapshots run-start history — a surface created EARLIER
    IN THIS SAME RUN exists only in live Strands history. The glue+derived
    merge must resolve it (a create-then-update turn must not error for a
    surface visibly on screen)."""
    import ag_ui_strands.a2ui_tool as mod

    prior_envelope = json.dumps(
        {
            A2UI_OPS_KEY: [
                {"createSurface": {"surfaceId": "s1", "catalogId": "c"}},
                {
                    "updateComponents": {
                        "surfaceId": "s1",
                        "components": [{"id": "root", "component": "Row"}],
                    }
                },
            ]
        }
    )

    async def fake_subagent(model, prompt, messages, push):
        return {"components": [{"id": "root", "component": "Column"}], "data": {}}

    monkeypatch.setattr(mod, "_stream_render_subagent", fake_subagent)
    # Glue present but EMPTY (run-start snapshot has no envelope); the
    # prior surface lives only in the calling agent's live message history.
    tool = get_a2ui_tools({"model": STUB_MODEL}, glue={"agui_messages": []})
    live_agent = MagicMock()
    live_agent.messages = [
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": "t1",
                        "status": "success",
                        "content": [{"text": prior_envelope}],
                    }
                }
            ],
        }
    ]
    events = []
    async for ev in tool.stream(
        {
            "name": GENERATE_A2UI_TOOL_NAME,
            "toolUseId": "tu-sr",
            "input": {"intent": "update", "target_surface_id": "s1"},
        },
        {"agent": live_agent},
    ):
        events.append(ev)

    text = str(events[-1])
    assert "updateComponents" in text
    assert "createSurface" not in text
