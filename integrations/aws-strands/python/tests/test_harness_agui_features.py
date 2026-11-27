"""What an AG-UI client can do with ``StrandsAgent``, done with a real harness.

``StrandsHarnessAgent`` reuses the run loop, so each of these is the same code
as for a plain agent. What differs is the agent underneath: a harness has a
context manager that rewrites the conversation, injectors that write into the
latest user turn, its own approval gate and its own tools. These drive the
request context, client tools, both kinds of interrupt, shared state and
history through an agent ``create_harness`` built, with everything the harness
turns on by default left on unless it writes outside the test.

Skipped where ``strands-harness`` is not installed.
"""

from __future__ import annotations

from typing import Any

import pytest
from ag_ui.core import (
    AssistantMessage,
    Context,
    EventType,
    FunctionCall,
    ResumeEntry,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands import tool
from strands.types.tools import ToolContext

from ag_ui_strands.harness import StrandsHarnessAgent
from tests.scripted_model import (
    ScriptedModel,
    collect,
    has_tool_result,
    last_tool_result_text,
    run_input,
)

pytest.importorskip("strands_harness")

CARD = Tool(
    name="show_card",
    description="Show a card",
    parameters={"type": "object", "properties": {"title": {"type": "string"}}},
)


@pytest.fixture
def harness(tmp_path, monkeypatch):
    """A harness as it comes, minus what would write outside the test.

    The context manager stays on ``auto``: it is the part that edits the
    conversation behind the adapter's back.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")

    def build(script, **overrides: Any) -> tuple[StrandsHarnessAgent, ScriptedModel]:
        model = ScriptedModel(script)
        options = {
            "model": model,
            "memory": False,
            "skills": False,
            "caching": False,
            "callback_handler": None,
            **overrides,
        }
        return StrandsHarnessAgent("h", options), model

    return build


def _calls(events) -> list[str]:
    return [e.tool_call_name for e in events if e.type == EventType.TOOL_CALL_START]


def _snapshot(events) -> list:
    return [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages


def _text(events) -> str:
    return "".join(e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT)


def _user_text(messages: list) -> str:
    return " ".join(
        block.get("text", "")
        for message in messages
        if message["role"] == "user"
        for block in message["content"]
    )


# --- Context -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_request_context_reaches_the_model_and_is_not_kept(harness):
    adapter, model = harness(lambda *_: "ok")

    events = await collect(
        adapter,
        run_input(context=[Context(description="The open document", value="Q3 forecast")]),
    )

    assert events[-1].outcome.type == "success"
    seen = _user_text(model.seen_messages[0])
    assert "The open document" in seen and "Q3 forecast" in seen
    # Context is the request's, not the conversation's: neither the agent's
    # history nor the client's keeps it.
    kept = adapter._agents_by_thread["t1"].messages
    assert "Q3 forecast" not in str(kept)
    assert "Q3 forecast" not in str([m.model_dump() for m in _snapshot(events)])
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_each_run_sees_its_own_context(harness):
    adapter, model = harness(lambda *_: "ok")

    first = await collect(adapter, run_input(context=[Context(description="page", value="alpha")]))
    await collect(
        adapter,
        run_input(
            run_id="r2",
            messages=[*_snapshot(first), UserMessage(id="u2", content="again")],
            context=[Context(description="page", value="beta")],
        ),
    )

    second = _user_text(model.seen_messages[-1])
    assert "beta" in second and "alpha" not in second
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_context_is_there_on_every_model_call_of_a_run(harness):
    """A tool round trip is a second model call; it still has the context."""

    def script(_model, messages):
        if not has_tool_result(messages):
            return ("shell", {"command": "echo hi"})
        return "done"

    adapter, model = harness(script, builtin_tools=["shell"])

    await collect(adapter, run_input(context=[Context(description="page", value="gamma")]))

    assert len(model.seen_messages) == 2
    assert all("gamma" in _user_text(seen) for seen in model.seen_messages)
    await adapter.shutdown()


# --- Client tools ------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_client_tool_is_offered_called_and_answered_by_the_client(harness):
    def script(_model, messages):
        if not has_tool_result(messages):
            return ("show_card", {"title": "hello"})
        return "the client said: " + last_tool_result_text(messages)

    adapter, model = harness(script, builtin_tools=["shell"])

    first = await collect(adapter, run_input(tools=[CARD]))

    # Offered beside the harness's own.
    assert {"show_card", "shell"} <= set(model.seen_tool_names[0])
    assert _calls(first) == ["show_card"]
    (args,) = [e.delta for e in first if e.type == EventType.TOOL_CALL_ARGS]
    assert '"hello"' in args
    # The run ends without a result: the client runs it.
    assert not [e for e in first if e.type == EventType.TOOL_CALL_RESULT]
    assert first[-1].type == EventType.RUN_FINISHED
    assert model.calls == 1

    snapshot = _snapshot(first)
    (call,) = snapshot[-1].tool_calls
    second = await collect(
        adapter,
        run_input(
            run_id="r2",
            tools=[CARD],
            messages=[
                *snapshot,
                ToolMessage(id="tm1", tool_call_id=call.id, content="card-shown-7"),
            ],
        ),
    )

    assert second[-1].outcome.type == "success"
    assert "card-shown-7" in _text(second)
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_a_client_tool_behind_the_approval_gate_is_asked_for_then_handed_over(harness):
    """``interventions="ask"`` asks before every call, the client's included.
    Approved, the call goes to the client like any other of its tools."""

    def script(_model, messages):
        if not has_tool_result(messages):
            return ("show_card", {"title": "hello"})
        return "the client said: " + last_tool_result_text(messages)

    adapter, model = harness(script, builtin_tools=["shell"], interventions="ask")

    paused = await collect(adapter, run_input(tools=[CARD]))
    (interrupt,) = paused[-1].outcome.interrupts
    assert interrupt.reason == "tool_call"
    assert interrupt.metadata["tool_name"] == "show_card"

    approved = await collect(
        adapter,
        run_input(
            run_id="r2",
            tools=[CARD],
            resume=[
                ResumeEntry(interrupt_id=interrupt.id, status="resolved", payload={"approved": True})
            ],
        ),
    )

    # Handed over, not run here and not asked for twice.
    assert approved[-1].type == EventType.RUN_FINISHED
    assert approved[-1].outcome.type != "interrupt"
    assert not [e for e in approved if e.type == EventType.TOOL_CALL_RESULT]
    assert model.calls == 1

    # Nothing new was said, so the client still holds the paused run's history.
    snapshot = _snapshot(paused)
    (call,) = [c for m in snapshot for c in (getattr(m, "tool_calls", None) or [])]
    answered = await collect(
        adapter,
        run_input(
            run_id="r3",
            tools=[CARD],
            messages=[*snapshot, ToolMessage(id="tm1", tool_call_id=call.id, content="card-shown-7")],
        ),
    )

    assert answered[-1].outcome.type == "success"
    assert "card-shown-7" in _text(answered)
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_a_client_that_asks_about_its_own_tools_is_not_asked_twice(harness):
    """``gate_client_tools=False``: the gate still asks about the harness's
    tools, and a client's tool goes to the client without a question."""

    def script(model, messages):
        if model.calls == 0:
            return ("show_card", {"title": "hello"})
        if model.calls == 1:
            return ("shell", {"command": "echo own-tool"})
        return "done: " + last_tool_result_text(messages)

    model = ScriptedModel(script)
    adapter = StrandsHarnessAgent(
        "h",
        {
            "model": model,
            "memory": False,
            "skills": False,
            "caching": False,
            "callback_handler": None,
            "builtin_tools": ["shell"],
            "interventions": "ask",
        },
        gate_client_tools=False,
    )

    handed_over = await collect(adapter, run_input(tools=[CARD]))
    assert handed_over[-1].outcome.type != "interrupt"
    assert _calls(handed_over) == ["show_card"]

    (call,) = [c for m in _snapshot(handed_over) for c in (getattr(m, "tool_calls", None) or [])]
    paused = await collect(
        adapter,
        run_input(
            run_id="r2",
            tools=[CARD],
            messages=[*_snapshot(handed_over), ToolMessage(id="tm1", tool_call_id=call.id, content="shown")],
        ),
    )
    (interrupt,) = paused[-1].outcome.interrupts
    assert interrupt.reason == "tool_call"
    assert interrupt.metadata["tool_name"] == "shell"

    approved = await collect(
        adapter,
        run_input(
            run_id="r3",
            tools=[CARD],
            resume=[
                ResumeEntry(interrupt_id=interrupt.id, status="resolved", payload={"approved": True})
            ],
        ),
    )
    assert approved[-1].outcome.type == "success"
    assert "own-tool" in _text(approved)
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_the_tools_a_client_sends_can_change_between_runs(harness):
    adapter, model = harness(lambda *_: "ok")

    await collect(adapter, run_input(tools=[CARD]))
    await collect(adapter, run_input(run_id="r2", tools=[]))

    assert "show_card" in model.seen_tool_names[0]
    assert "show_card" not in model.seen_tool_names[1]
    await adapter.shutdown()


# --- Interrupts --------------------------------------------------------------


@tool(context=True)
def book_flight(destination: str, tool_context: ToolContext) -> str:
    """Book a flight."""
    seat = tool_context.interrupt("seat", reason={"question": f"Which seat to {destination}?"})
    return f"booked {destination}, seat {seat}"


@pytest.mark.asyncio
async def test_a_tool_that_asks_a_question_pauses_and_resumes(harness):
    """An interrupt a tool raises itself, beside the harness's own gate."""

    def script(_model, messages):
        if has_tool_result(messages):
            return "done: " + last_tool_result_text(messages)
        return ("book_flight", {"destination": "Vienna"})

    adapter, _ = harness(script, tools=[book_flight], builtin_tools=[])

    paused = await collect(adapter, run_input())

    assert paused[-1].outcome.type == "interrupt"
    (interrupt,) = paused[-1].outcome.interrupts
    assert "Which seat to Vienna?" in str(interrupt.model_dump())

    resumed = await collect(
        adapter,
        run_input(
            run_id="r2",
            resume=[ResumeEntry(interrupt_id=interrupt.id, status="resolved", payload="12A")],
        ),
    )

    assert resumed[-1].outcome.type == "success"
    assert "12A" in _text(resumed)
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_an_approval_survives_the_agent_being_rebuilt(harness, tmp_path):
    """A restart between the question and the answer: the thread's harness is
    built again and the client's history and answer are all it has."""
    marker = tmp_path / "marker"

    def script(_model, messages):
        if has_tool_result(messages):
            return "done: " + last_tool_result_text(messages)
        return ("shell", {"command": f"touch {marker}"})

    adapter, _ = harness(script, builtin_tools=["shell"], interventions="ask")
    paused = await collect(adapter, run_input())
    (interrupt,) = paused[-1].outcome.interrupts
    assert interrupt.reason == "tool_call"

    await adapter.shutdown()  # forgets every thread's agent
    resumed = await collect(
        adapter,
        run_input(
            run_id="r2",
            messages=_snapshot(paused),
            resume=[
                ResumeEntry(interrupt_id=interrupt.id, status="resolved", payload={"approved": True})
            ],
        ),
    )

    # Either the call runs, or the run says plainly that it could not resume.
    # What it must not do is report success having done nothing.
    finished = resumed[-1]
    if finished.type == EventType.RUN_FINISHED and finished.outcome.type == "success":
        assert marker.exists()
    else:
        assert finished.type in (EventType.RUN_ERROR, EventType.RUN_FINISHED)
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_a_thread_waiting_on_an_approval_outlives_the_idle_timeout(harness):
    """The question lives on the thread's harness, so the harness is kept until
    it is answered, and let go like any other thread after."""
    from ag_ui_strands.config import StrandsAgentConfig

    def script(_model, messages):
        if has_tool_result(messages):
            return "done: " + last_tool_result_text(messages)
        return ("shell", {"command": "echo ran-it"})

    adapter = StrandsHarnessAgent(
        "h",
        {
            "model": ScriptedModel(script),
            "memory": False,
            "skills": False,
            "caching": False,
            "callback_handler": None,
            "builtin_tools": ["shell"],
            "interventions": "ask",
        },
        config=StrandsAgentConfig(thread_idle_timeout=0),
    )
    paused = await collect(adapter, run_input())
    (interrupt,) = paused[-1].outcome.interrupts

    await collect(adapter, run_input(thread_id="other"))
    assert "t1" in adapter._agents_by_thread

    approved = await collect(
        adapter,
        run_input(
            run_id="r2",
            messages=_snapshot(paused),
            resume=[
                ResumeEntry(interrupt_id=interrupt.id, status="resolved", payload={"approved": True})
            ],
        ),
    )
    assert approved[-1].outcome.type == "success"
    assert "ran-it" in _text(approved)

    await collect(adapter, run_input(thread_id="other", run_id="o2"))
    assert "t1" not in adapter._agents_by_thread
    await adapter.shutdown()


# --- State -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shared_state_is_echoed_and_shown_to_the_model(harness):
    from ag_ui_strands.config import StrandsAgentConfig

    model = ScriptedModel(lambda *_: "ok")
    adapter = StrandsHarnessAgent(
        "h",
        {"model": model, "memory": False, "skills": False, "caching": False, "callback_handler": None},
        config=StrandsAgentConfig(
            state_context_builder=lambda input_data, prompt: f"theme={input_data.state['theme']}\n{prompt}"
        ),
    )

    events = await collect(adapter, run_input(state={"theme": "dark"}))

    snapshots = [e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT]
    assert snapshots and all(snapshot == {"theme": "dark"} for snapshot in snapshots)
    assert "theme=dark" in _user_text(model.seen_messages[0])
    await adapter.shutdown()


@tool(context=True)
def set_theme(theme: str, tool_context: ToolContext) -> str:
    """Set the theme."""
    return f"theme set to {theme}"


@pytest.mark.asyncio
async def test_a_tool_of_the_harness_can_write_shared_state(harness):
    from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior

    def script(_model, messages):
        return "ok" if has_tool_result(messages) else ("set_theme", {"theme": "light"})

    async def from_args(context):
        return {"theme": context.tool_input["theme"]}

    adapter = StrandsHarnessAgent(
        "h",
        {
            "model": ScriptedModel(script),
            "tools": [set_theme],
            "builtin_tools": [],
            "memory": False,
            "skills": False,
            "caching": False,
            "callback_handler": None,
        },
        config=StrandsAgentConfig(tool_behaviors={"set_theme": ToolBehavior(state_from_args=from_args)}),
    )

    events = await collect(adapter, run_input(state={"theme": "dark"}))

    snapshots = [e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT]
    assert snapshots[0] == {"theme": "dark"} and snapshots[-1] == {"theme": "light"}
    await adapter.shutdown()


# --- History -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_new_process_continues_from_the_clients_history(harness):
    """No session store: the client's history is the conversation."""
    adapter, model = harness(lambda *_: "ok")
    history = [
        UserMessage(id="u1", content="my name is Ada"),
        AssistantMessage(
            id="a1",
            content=None,
            tool_calls=[
                ToolCall(id="c1", function=FunctionCall(name="shell", arguments='{"command":"id"}'))
            ],
        ),
        ToolMessage(id="t1", tool_call_id="c1", content="uid=1000"),
        AssistantMessage(id="a2", content="hello Ada"),
        UserMessage(id="u2", content="who am I?"),
    ]

    events = await collect(adapter, run_input(messages=history))

    assert events[-1].outcome.type == "success"
    seen = str(model.seen_messages[-1])
    assert "my name is Ada" in seen and "uid=1000" in seen and "who am I?" in seen
    # What the client had comes back with the same ids, plus the new answer.
    ids = [m.id for m in _snapshot(events)]
    assert ids[:5] == ["u1", "a1", "t1", "a2", "u2"] and len(ids) == 6
    await adapter.shutdown()


@pytest.mark.asyncio
async def test_the_harness_contract_is_the_system_prompt(harness):
    from strands_harness import HARNESS_CONTRACT

    adapter, model = harness(lambda *_: "ok")

    await collect(adapter, run_input())

    assert HARNESS_CONTRACT[:200] in str(model.seen_system_prompts[0])
    await adapter.shutdown()
