"""``StrandsHarnessAgent``: a Strands harness built per thread.

``StrandsAgent`` clones the agent it is given, and a harness does not survive
being cloned: the context manager, memory and background tasks stay on the
template while the tools that need them are carried over. This entry point
calls ``create_harness`` once per thread instead and runs everything else
through ``StrandsAgent`` unchanged.

Two halves. The first swaps ``create_harness`` for a stand-in, so it runs on
the SDK floor and pins what the adapter passes and decides. The second drives
the real ``strands-harness`` and is skipped where that is not installed:

    uv run --with strands-harness pytest tests/test_harness_agent.py
"""

from __future__ import annotations

import sys
from typing import Any
from unittest.mock import patch

import pytest
from ag_ui.core import EventType, ResumeEntry, Tool, UserMessage
from strands import Agent, tool
from strands.session import SessionManager

from ag_ui_strands import StrandsAgent, StrandsHarnessAgent
from ag_ui_strands.config import StrandsAgentConfig
from tests.error_code_table import assert_contract_error
from tests.scripted_model import (
    ScriptedModel,
    collect,
    has_tool_result,
    last_tool_result_text,
    run_input,
)


@tool
def read_docs(topic: str) -> str:
    """Read the docs."""
    return f"docs on {topic}"


@tool
def delete_all() -> str:
    """Delete everything."""
    return "gone"


class _StandIn:
    """``create_harness``'s shape: options in, a plain ``Agent`` out."""

    def __init__(self, script=None, tools=()) -> None:
        self.calls: list[dict[str, Any]] = []
        self.built: list[Agent] = []
        self._script = script or (lambda _model, _messages: "hello")
        self._tools = list(tools)

    def __call__(self, **options: Any) -> Agent:
        self.calls.append(options)
        agent = Agent(
            model=ScriptedModel(self._script),
            tools=list(self._tools),
            hooks=options.get("hooks"),
            session_manager=options.get("session_manager"),
            callback_handler=None,
        )
        self.built.append(agent)
        return agent


class _Hook:
    def register_hooks(self, registry, **_kwargs) -> None:
        pass


def _session_manager() -> SessionManager:
    from strands.session import FileSessionManager

    return FileSessionManager.__new__(FileSessionManager)


# --- what the adapter passes and decides ------------------------------------


@pytest.mark.asyncio
async def test_each_thread_gets_a_harness_of_its_own_built_once():
    create = _StandIn()
    adapter = StrandsHarnessAgent("h", create_harness=create)

    await collect(adapter, run_input("a"))
    await collect(adapter, run_input("a", run_id="r2"))
    await collect(adapter, run_input("b"))

    assert len(create.calls) == 2
    assert adapter._agents_by_thread["a"] is create.built[0]
    assert adapter._agents_by_thread["b"] is create.built[1]


@pytest.mark.asyncio
async def test_a_run_goes_through_the_same_translation_as_strands_agent():
    adapter = StrandsHarnessAgent("h", create_harness=_StandIn())
    assert isinstance(adapter, StrandsAgent)

    events = await collect(adapter, run_input())

    kinds = [event.type for event in events]
    assert kinds[0] == EventType.RUN_STARTED
    assert EventType.TEXT_MESSAGE_CONTENT in kinds
    assert events[-1].outcome.type == "success"


@pytest.mark.asyncio
async def test_fixed_options_reach_create_harness():
    create = _StandIn()
    adapter = StrandsHarnessAgent(
        "h", {"model": "bedrock/some-model", "memory": False}, create_harness=create
    )

    await collect(adapter, run_input())

    assert create.calls[0]["model"] == "bedrock/some-model"
    assert create.calls[0]["memory"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("is_async", [False, True])
async def test_a_callable_is_asked_for_the_thread_it_starts(is_async):
    create = _StandIn()

    def options(input_data):
        return {"instructions": f"thread {input_data.thread_id}"}

    async def options_async(input_data):
        return options(input_data)

    adapter = StrandsHarnessAgent(
        "h", options_async if is_async else options, create_harness=create
    )

    await collect(adapter, run_input("a"))
    await collect(adapter, run_input("b"))

    assert [call["instructions"] for call in create.calls] == ["thread a", "thread b"]


@pytest.mark.asyncio
async def test_file_sessions_are_off_unless_asked_for():
    """The harness default is a session under a random id nothing can resume."""
    create = _StandIn()

    await collect(StrandsHarnessAgent("h", create_harness=create), run_input())

    assert create.calls[0]["session"] is False


@pytest.mark.asyncio
async def test_a_session_the_thread_asked_for_is_kept():
    create = _StandIn()
    adapter = StrandsHarnessAgent(
        "h",
        lambda input_data: {"session": {"id": input_data.thread_id}},
        create_harness=create,
    )

    await collect(adapter, run_input("a"))

    assert create.calls[0]["session"] == {"id": "a"}


@pytest.mark.asyncio
async def test_the_session_manager_provider_supplies_the_threads_manager():
    create = _StandIn()
    manager = _session_manager()
    adapter = StrandsHarnessAgent(
        "h",
        {"session": True},
        config=StrandsAgentConfig(session_manager_provider=lambda _input: manager),
        create_harness=lambda **options: create.calls.append(options) or Agent(
            model=ScriptedModel(lambda *_: "hello"), callback_handler=None
        ),
    )

    await collect(adapter, run_input())

    assert create.calls[0]["session_manager"] is manager
    assert "session" not in create.calls[0]


@pytest.mark.asyncio
async def test_hooks_and_plugins_given_to_the_adapter_go_first():
    create = _StandIn()
    mine, theirs, plugin, their_plugin = _Hook(), _Hook(), object(), object()
    adapter = StrandsHarnessAgent(
        "h",
        lambda _input: {"hooks": [theirs], "plugins": [their_plugin]},
        hooks=[mine],
        plugins=[plugin],
        create_harness=lambda **options: create.calls.append(options) or Agent(
            model=ScriptedModel(lambda *_: "hello"), callback_handler=None
        ),
    )

    await collect(adapter, run_input())

    assert create.calls[0]["hooks"] == [mine, theirs]
    assert create.calls[0]["plugins"] == [plugin, their_plugin]


@pytest.mark.asyncio
async def test_no_hooks_means_no_hooks_argument():
    create = _StandIn()

    await collect(StrandsHarnessAgent("h", create_harness=create), run_input())

    assert "hooks" not in create.calls[0]
    assert "plugins" not in create.calls[0]


@pytest.mark.parametrize(
    "options,named",
    [
        ({"session": {"id": "one"}}, "session"),
        ({"session": _session_manager()}, "session"),
        ({"session_manager": _session_manager()}, "session_manager_provider"),
        ({"context_manager": object()}, "context manager"),
        ({"conversation_manager": object()}, "conversation manager"),
    ],
)
def test_fixed_options_that_every_thread_would_share_are_refused(options, named):
    with pytest.raises(ValueError, match=named):
        StrandsHarnessAgent("h", options, create_harness=_StandIn())


@pytest.mark.parametrize(
    "options",
    [
        {"session": True},
        {"session": False},
        {"session": {"dir": "/var/sessions"}},
        {"context_manager": "agentic"},
        {"context_manager": False},
    ],
)
def test_fixed_options_that_name_no_conversation_are_accepted(options):
    StrandsHarnessAgent("h", options, create_harness=_StandIn())


def test_options_that_are_neither_a_mapping_nor_a_callable_are_refused():
    with pytest.raises(TypeError, match="mapping"):
        StrandsHarnessAgent("h", ["model"], create_harness=_StandIn())  # type: ignore[arg-type]


def test_thread_agent_kwargs_is_refused_with_where_to_go_instead():
    config = StrandsAgentConfig(thread_agent_kwargs=lambda _input: {})

    with pytest.raises(ValueError, match="`harness` callable"):
        StrandsHarnessAgent("h", config=config, create_harness=_StandIn())


def test_a_missing_strands_harness_says_what_to_install():
    with patch.dict(sys.modules, {"strands_harness": None}):
        with pytest.raises(ImportError, match="pip install strands-harness"):
            StrandsHarnessAgent("h")


@pytest.mark.asyncio
async def test_failing_options_end_the_run_and_the_thread_is_retried():
    create = _StandIn()
    attempts = []

    def options(_input):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("no tenant")
        return {}

    adapter = StrandsHarnessAgent("h", options, create_harness=create)

    failed = await collect(adapter, run_input())

    assert failed[0].type == EventType.RUN_STARTED
    assert_contract_error(failed[-1], "THREAD_AGENT_KWARGS_ERROR")
    assert "no tenant" in failed[-1].message
    assert "t1" not in adapter._agents_by_thread

    retried = await collect(adapter, run_input(run_id="r2"))
    assert retried[-1].outcome.type == "success"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "create,said",
    [
        (lambda **_: (_ for _ in ()).throw(ValueError("Unknown built-in plugin")), "Unknown built-in"),
        (lambda **_: object(), "not a strands Agent"),
    ],
)
async def test_a_harness_that_cannot_be_built_ends_the_run(create, said):
    adapter = StrandsHarnessAgent("h", create_harness=create)

    events = await collect(adapter, run_input())

    assert events[0].type == EventType.RUN_STARTED
    assert_contract_error(events[-1], "THREAD_AGENT_BUILD_ERROR")
    assert said in events[-1].message
    assert "t1" not in adapter._agents_by_thread


@pytest.mark.asyncio
async def test_template_tools_provider_filters_the_threads_own_tools():
    def script(model, _messages):
        return "ok"

    create = _StandIn(script, tools=[read_docs, delete_all])
    adapter = StrandsHarnessAgent(
        "h",
        config=StrandsAgentConfig(
            template_tools_provider=lambda input_data: (
                ["read_docs"] if input_data.thread_id == "guest" else None
            )
        ),
        create_harness=create,
    )

    await collect(adapter, run_input("guest"))
    await collect(adapter, run_input("admin"))

    guest, admin = (agent.model.seen_tool_names[-1] for agent in create.built)
    assert guest == ["read_docs"]
    assert sorted(admin) == ["delete_all", "read_docs"]


@pytest.mark.asyncio
async def test_shutdown_shuts_every_threads_agent_down_and_forgets_it():
    create = _StandIn()
    adapter = StrandsHarnessAgent("h", create_harness=create)
    await collect(adapter, run_input("a"))
    await collect(adapter, run_input("b"))
    shut: list[Agent] = []

    for agent in create.built:

        async def shutdown_async(agent=agent):
            shut.append(agent)
            if agent is create.built[0]:
                raise RuntimeError("store unreachable")

        agent.shutdown_async = shutdown_async  # type: ignore[attr-defined]

    await adapter.shutdown()

    # One agent failing does not strand the other.
    assert shut == create.built
    assert adapter._agents_by_thread == {}


# --- the real harness -------------------------------------------------------


@pytest.fixture
def harness(tmp_path, monkeypatch):
    """``create_harness`` options for a harness that touches nothing outside
    the test: the scripted model, a scratch working directory, and none of the
    stores it would otherwise keep under ``./.agent``."""
    pytest.importorskip("strands_harness")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")

    def options(script, **overrides: Any) -> dict[str, Any]:
        return {
            "model": ScriptedModel(script),
            "memory": False,
            "skills": False,
            "caching": False,
            "context_manager": False,
            "builtin_tools": ["shell"],
            "callback_handler": None,
            **overrides,
        }

    return options


def _calls(events) -> list[str]:
    return [e.tool_call_name for e in events if e.type == EventType.TOOL_CALL_START]


def _result(events, tool_call_id: str) -> str:
    (result,) = [
        e for e in events if e.type == EventType.TOOL_CALL_RESULT and e.tool_call_id == tool_call_id
    ]
    return result.content


@pytest.mark.asyncio
async def test_a_thread_keeps_what_cloning_a_harness_loses(harness):
    """The reason this entry point exists, stated as the difference."""
    from strands_harness import create_harness

    options = harness(lambda *_: "hello", context_manager="auto", builtin_tools=["shell", "subagent"])

    cloned = StrandsAgent(agent=create_harness(**options), name="cloned")
    await collect(cloned, run_input())
    lost = cloned._agents_by_thread["t1"]
    assert getattr(lost, "context_manager", None) is None
    assert "strands_manage_background_task" not in lost.tool_registry.registry

    built = StrandsHarnessAgent("h", options)
    await collect(built, run_input())
    kept = built._agents_by_thread["t1"]
    assert kept.context_manager is not None
    assert "strands_manage_background_task" in kept.tool_registry.registry
    await built.shutdown()


@pytest.mark.asyncio
async def test_threads_do_not_share_a_context_manager(harness):
    adapter = StrandsHarnessAgent("h", harness(lambda *_: "hello", context_manager="auto"))

    await collect(adapter, run_input("a"))
    await collect(adapter, run_input("b"))

    a, b = adapter._agents_by_thread["a"], adapter._agents_by_thread["b"]
    assert a.context_manager is not b.context_manager
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_a_built_in_tool_and_a_client_tool_in_one_run(harness):
    def script(_model, messages):
        if not has_tool_result(messages):
            return ("shell", {"command": "echo harness-ok"})
        if "show_card" not in str(messages):
            return ("show_card", {"title": "harness-ok"})
        return "shown"

    adapter = StrandsHarnessAgent("h", harness(script))
    card = Tool(
        name="show_card",
        description="Show a card",
        parameters={"type": "object", "properties": {"title": {"type": "string"}}},
    )

    events = await collect(adapter, run_input(tools=[card]))

    assert _calls(events) == ["shell", "show_card"]
    assert "harness-ok" in _result(events, "call-1")
    # The client runs its own tool: the run ends for it to answer.
    assert events[-1].type == EventType.RUN_FINISHED
    await adapter.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("approved,ran", [(True, True), (False, False)])
async def test_interventions_ask_is_an_approval_the_client_can_answer(harness, tmp_path, approved, ran):
    marker = tmp_path / "marker"

    def script(_model, messages):
        if has_tool_result(messages):
            return "done: " + last_tool_result_text(messages)
        return ("shell", {"command": f"touch {marker}"})

    adapter = StrandsHarnessAgent("h", harness(script, interventions="ask"))

    paused = await collect(adapter, run_input())
    (interrupt,) = paused[-1].outcome.interrupts
    assert interrupt.reason == "tool_call"
    assert interrupt.tool_call_id == "call-1"
    assert interrupt.metadata["tool_name"] == "shell"
    assert not marker.exists()

    resumed = await collect(
        adapter,
        run_input(
            run_id="r2",
            resume=[
                ResumeEntry(
                    interrupt_id=interrupt.id, status="resolved", payload={"approved": approved}
                )
            ],
        ),
    )

    assert marker.exists() is ran
    assert resumed[-1].outcome.type == "success"
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_a_background_subagents_result_reaches_the_client(harness):
    """The harness delegates in the background; the result comes back as a
    delivery the SDK writes into the conversation without streaming it."""

    def script(_model, messages):
        first = messages[0]["content"][0].get("text", "")
        if first.startswith("say hi"):
            return "child says hi"
        if not has_tool_result(messages):
            return ("subagent", {"task": "say hi", "description": "greet"})
        return "parent has " + ("the answer" if "child says hi" in str(messages) else "nothing yet")

    adapter = StrandsHarnessAgent("h", harness(script, builtin_tools=["subagent"]))

    events = await collect(adapter, run_input())

    assert _calls(events) == ["subagent", "strands_manage_background_task"]
    (delivery,) = [
        e
        for e in events
        if e.type == EventType.TOOL_CALL_START
        and e.tool_call_name == "strands_manage_background_task"
    ]
    assert "child says hi" in _result(events, delivery.tool_call_id)
    # The answer before the result and the one after are separate messages.
    texts = [e.message_id for e in events if e.type == EventType.TEXT_MESSAGE_START]
    assert len(texts) == len(set(texts)) == 2
    snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages
    assert [m.content for m in snapshot if m.role == "assistant" and m.content] == [
        "parent has nothing yet",
        "parent has the answer",
    ]
    assert events[-1].outcome.type == "success"

    # And the client can carry on from that history.
    again = await collect(
        adapter,
        run_input(run_id="r2", messages=[*snapshot, UserMessage(id="u2", content="thanks")]),
    )
    assert again[-1].outcome.type == "success"
    await adapter.shutdown()
