"""Shared state that tools change mid-run, and AG-UI context in the instructions."""

from __future__ import annotations

from typing import Any

import pytest
from agents import Agent, RunContextWrapper, function_tool
from test_interrupts import ScriptedModel, call, finished, request, run, text

from ag_ui.core import Context, EventType, ResumeEntry, UserMessage
from ag_ui_openai_agents import OpenAIAgentsAgent, SharedState, shared_state, use_shared_state


@function_tool
def add_item(name: str) -> str:
    """Add an item to the list."""
    state = shared_state()
    state.update(items=[*state.value.get("items", []), name])
    return f"Added {name}."


@function_tool(needs_approval=True)
def clear_items() -> str:
    """Clear the list."""
    shared_state().update(items=[])
    return "Cleared."


def list_agent(*turns: list[Any], **options: Any) -> tuple[OpenAIAgentsAgent, ScriptedModel]:
    model = ScriptedModel(*turns)
    agent = Agent(name="lists", instructions="Keep the list.", tools=[add_item, clear_items], model=model)
    return OpenAIAgentsAgent(agent, **options), model


def with_state(run_input, state):
    return run_input.model_copy(update={"state": state})


def test_a_tool_state_change_streams_before_the_tool_result():
    agent, _ = list_agent([call("add_item", {"name": "milk"}, "c1")], [text("Added milk.")])
    run_input = with_state(
        request([UserMessage(id="u1", role="user", content="add milk")]), {"items": ["eggs"]}
    )
    events = run(agent, run_input)
    kinds = [e.type for e in events]

    snapshots = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
    assert [s.snapshot for s in snapshots] == [{"items": ["eggs", "milk"]}]
    assert kinds.index(EventType.STATE_SNAPSHOT) < kinds.index(EventType.TOOL_CALL_RESULT)
    assert run_input.state == {"items": ["eggs"]}  # the request is not mutated
    assert finished(events).outcome.type == "success"


def test_an_approved_call_changes_state_before_its_result():
    agent, _ = list_agent([call("clear_items", {}, "c1")])
    paused = run(agent, with_state(request([UserMessage(id="u1", role="user", content="clear")]), {"items": ["a"]}))
    history = [e for e in paused if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages

    agent, _ = list_agent([text("Cleared.")])
    resume = [ResumeEntry(interrupt_id="c1", status="resolved", payload={"approved": True})]
    events = run(agent, with_state(request(history, resume=resume), {"items": ["a"]}))
    kinds = [e.type for e in events]

    assert [e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT] == [{"items": []}]
    assert kinds.index(EventType.STATE_SNAPSHOT) < kinds.index(EventType.TOOL_CALL_RESULT)


def test_context_is_added_to_the_instructions():
    agent, model = list_agent([text("Hi Ada.")])
    run_input = request([UserMessage(id="u1", role="user", content="hi")]).model_copy(
        update={"context": [Context(description="User name", value="Ada")]}
    )
    run(agent, run_input)
    assert model.instructions[0] == "Keep the list.\n\nContext from the application:\nUser name: Ada"


def test_context_can_stay_out_of_the_instructions():
    agent, model = list_agent([text("Hi.")], context_in_instructions=False)
    run_input = request([UserMessage(id="u1", role="user", content="hi")]).model_copy(
        update={"context": [Context(description="User name", value="Ada")]}
    )
    run(agent, run_input)
    assert model.instructions[0] == "Keep the list."


def test_dynamic_instructions_see_the_state_and_keep_the_context():
    def instructions(run_context: RunContextWrapper[Any], agent: Agent) -> str:
        return f"Items: {shared_state().value.get('items')}"

    model = ScriptedModel([text("Two items.")])
    agent = OpenAIAgentsAgent(Agent(name="lists", instructions=instructions, model=model))
    run_input = with_state(request([UserMessage(id="u1", role="user", content="count")]), {"items": [1, 2]})
    run(agent, run_input.model_copy(update={"context": [Context(description="Plan", value="pro")]}))
    assert model.instructions[0] == "Items: [1, 2]\n\nContext from the application:\nPlan: pro"


def test_shared_state_outside_a_run_is_an_error():
    with pytest.raises(LookupError):
        shared_state()
    state = SharedState({"a": 1})
    with use_shared_state(state):
        assert shared_state() is state
    with pytest.raises(LookupError):
        shared_state()


def test_update_needs_a_mapping_state():
    state = SharedState(["not", "a", "dict"])
    with pytest.raises(TypeError):
        state.update(a=1)
    state.set({"a": 1})
    assert [e.snapshot for e in state.drain()] == [{"a": 1}]
    assert state.drain() == []
