"""Approvals raised by Strands' own ``HumanInTheLoop`` gate.

The gate pauses a tool call through a native interrupt named after the handler
and reads the answer with ``default_evaluate``: ``True`` approves, anything
else denies. Forwarded as a generic interrupt, the answer arrives wrapped as
``{"response": ...}``, which is neither, so every approval was a denial. These
drive a real agent through the pause and the resume.
"""

from __future__ import annotations

import pytest
from ag_ui.core import EventType, ResumeEntry
from strands import Agent, tool
from strands.vended_interventions.hitl import HumanInTheLoop

from ag_ui_strands.agent import StrandsAgent, _strands_interrupt_to_agui
from ag_ui_strands.config import StrandsAgentConfig
from tests.error_code_table import assert_contract_error
from tests.scripted_model import (
    ScriptedModel,
    collect,
    has_tool_result,
    last_tool_result_text,
    run_input,
)

RAN: list[str] = []


@tool
def delete_file(path: str) -> str:
    """Delete a file."""
    RAN.append(path)
    return f"deleted {path}"


def _adapter(gate=HumanInTheLoop) -> StrandsAgent:
    RAN.clear()

    def script(_model, messages):
        if has_tool_result(messages):
            return "done: " + last_tool_result_text(messages)
        return ("delete_file", {"path": "/tmp/a"})

    return StrandsAgent(
        agent=Agent(model=ScriptedModel(script), tools=[delete_file], callback_handler=None),
        name="gated",
        # A handler is the agent's own, like a plugin: one per thread.
        config=StrandsAgentConfig(
            thread_agent_kwargs=lambda _input: {"interventions": [gate()]}
        ),
    )


async def _pause(adapter: StrandsAgent):
    events = await collect(adapter, run_input())
    finished = events[-1]
    assert finished.type == EventType.RUN_FINISHED
    assert finished.outcome.type == "interrupt"
    (interrupt,) = finished.outcome.interrupts
    return events, interrupt


async def _resume(adapter: StrandsAgent, interrupt_id: str, status: str, payload):
    return await collect(
        adapter,
        run_input(
            run_id="r2",
            resume=[ResumeEntry(interrupt_id=interrupt_id, status=status, payload=payload)],
        ),
    )


def _result_of(events, tool_call_id: str) -> str:
    (result,) = [
        event
        for event in events
        if event.type == EventType.TOOL_CALL_RESULT and event.tool_call_id == tool_call_id
    ]
    return result.content


@pytest.mark.asyncio
async def test_the_gate_is_published_as_a_tool_call_approval():
    events, interrupt = await _pause(_adapter())

    assert RAN == []
    assert interrupt.reason == "tool_call"
    # The call the client was just shown, so the approval lands on its card.
    (started,) = [e for e in events if e.type == EventType.TOOL_CALL_START]
    assert interrupt.tool_call_id == started.tool_call_id == "call-1"
    assert interrupt.response_schema == {
        "type": "object",
        "properties": {"approved": {"type": "boolean"}},
        "required": ["approved"],
    }
    assert interrupt.metadata == {
        "tool_name": "delete_file",
        "tool_input": {"path": "/tmp/a"},
        "strandsName": "strands:human-in-the-loop",
    }
    # The gate's own prompt, which under a classifier also says why.
    assert interrupt.message.startswith('Approve "delete_file"?')


@pytest.mark.asyncio
async def test_approving_runs_the_call():
    adapter = _adapter()
    _, interrupt = await _pause(adapter)

    events = await _resume(adapter, interrupt.id, "resolved", {"approved": True})

    assert RAN == ["/tmp/a"]
    assert "deleted /tmp/a" in _result_of(events, "call-1")
    assert events[-1].outcome.type == "success"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,payload",
    [
        ("resolved", {"approved": False}),
        ("cancelled", None),
    ],
)
async def test_anything_but_an_approval_denies_the_call(status, payload):
    adapter = _adapter()
    _, interrupt = await _pause(adapter)

    events = await _resume(adapter, interrupt.id, status, payload)

    assert RAN == []
    assert "CONFIRMATION_FAILED" in _result_of(events, "call-1")
    assert events[-1].outcome.type == "success"


@pytest.mark.asyncio
# Strict, like the adapter's own gate: truthiness is not approval.
@pytest.mark.parametrize("payload", [{"ok": True}, {"approved": "true"}])
async def test_an_answer_that_is_not_a_decision_is_refused(payload):
    adapter = _adapter()
    _, interrupt = await _pause(adapter)

    events = await _resume(adapter, interrupt.id, "resolved", payload)

    assert RAN == []
    assert_contract_error(events[-1], "INVALID_PAYLOAD")


class _Gated:
    """An agent holding the gate as the SDK ships it."""

    class _intervention_registry:
        _handlers = [HumanInTheLoop()]


def test_a_call_the_agent_does_not_hold_is_published_without_a_card():
    """A delegate's call was never streamed, so there is no card to point at."""

    class _Native:
        id = "v1:before_tool_call:inner-7:0b3f3c0e-0000-5000-8000-000000000000"
        name = "strands:human-in-the-loop"
        reason = 'Approve "shell"?\n  Input: {"command": "ls"}'

    class _Parent(_Gated):
        messages = [{"role": "assistant", "content": [{"text": "delegating"}]}]

    interrupt = _strands_interrupt_to_agui(_Native(), _Parent())

    assert interrupt.reason == "tool_call"
    assert interrupt.tool_call_id is None
    assert interrupt.message == _Native.reason
    assert interrupt.metadata == {
        "tool_name": "unknown",
        "tool_input": {},
        "strandsName": "strands:human-in-the-loop",
        "reason": _Native.reason,
    }
    assert interrupt.response_schema["required"] == ["approved"]


def test_a_tool_use_id_containing_a_colon_is_read_whole():
    class _Native:
        id = "v1:before_tool_call:tooluse:with:colons:0b3f3c0e-0000-5000-8000-000000000000"
        name = "strands:human-in-the-loop"
        reason = "Approve?"

    class _Agent(_Gated):
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"toolUseId": "tooluse:with:colons", "name": "shell", "input": {}}}
                ],
            }
        ]

    assert _strands_interrupt_to_agui(_Native(), _Agent()).tool_call_id == "tooluse:with:colons"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "gate",
    [
        # Written against the envelope this adapter has always sent.
        lambda: HumanInTheLoop(evaluate=lambda r: r.get("response", {}).get("decision") == "allow"),
        # Reads a "trust" answer a bool cannot express.
        lambda: HumanInTheLoop(enable_trust=True, evaluate=lambda r: r.get("response", {}).get("decision") == "allow"),
    ],
)
async def test_a_gate_that_reads_its_own_answers_stays_a_generic_interrupt(gate):
    """Its ``evaluate`` receives the envelope it was written for, unchanged."""
    adapter = _adapter(gate)
    _, interrupt = await _pause(adapter)

    assert interrupt.reason == "strands:human-in-the-loop"
    assert interrupt.response_schema is None

    events = await _resume(adapter, interrupt.id, "resolved", {"decision": "allow"})

    assert RAN == ["/tmp/a"]
    assert events[-1].outcome.type == "success"


def test_an_interrupt_whose_agent_is_not_known_stays_generic():
    """A multi-agent orchestrator publishes for its nodes and answers them
    with the envelope, so their gates are not advertised as approvals."""

    class _Native:
        id = "v1:before_tool_call:call-1:0b3f3c0e-0000-5000-8000-000000000000"
        name = "strands:human-in-the-loop"
        reason = "Approve?"

    interrupt = _strands_interrupt_to_agui(_Native())

    assert interrupt.reason == "strands:human-in-the-loop"
    assert interrupt.response_schema is None
    assert interrupt.metadata == {"reason": "Approve?"}


@pytest.mark.asyncio
async def test_an_approved_client_tool_is_handed_to_the_client():
    """The gate holds a client's tool like any other. Approved, the call runs
    with nothing streamed to stop the run on, and its placeholder result would
    send the model on as though the client had answered."""
    from ag_ui.core import Tool

    def script(_model, messages):
        if has_tool_result(messages):
            return "the model went on: " + last_tool_result_text(messages)
        return ("show_card", {"title": "hello"})

    model = ScriptedModel(script)
    adapter = StrandsAgent(
        agent=Agent(model=model, callback_handler=None),
        name="gated",
        config=StrandsAgentConfig(
            thread_agent_kwargs=lambda _input: {"interventions": [HumanInTheLoop()]}
        ),
    )
    card = Tool(name="show_card", description="Show a card", parameters={"type": "object"})

    paused = await collect(adapter, run_input(tools=[card]))
    (interrupt,) = paused[-1].outcome.interrupts
    assert interrupt.metadata["tool_name"] == "show_card"

    events = await collect(
        adapter,
        run_input(
            run_id="r2",
            tools=[card],
            resume=[
                ResumeEntry(interrupt_id=interrupt.id, status="resolved", payload={"approved": True})
            ],
        ),
    )

    assert events[-1].type == EventType.RUN_FINISHED
    assert events[-1].outcome.type == "success"
    assert model.calls == 1
    assert not [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
    assert not [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
