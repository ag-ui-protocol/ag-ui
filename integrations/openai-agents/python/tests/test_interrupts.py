"""Tool approvals as AG-UI interrupts, end to end through the real SDK run loop.

Every resume builds a fresh request from the previous run's
MESSAGES_SNAPSHOT, the way a client does, so these also show that nothing on
the server carries over from the paused run to the resumed one.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import pytest
from agents import Agent, function_tool
from agents.models.interface import Model
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseTextDeltaEvent,
)

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    ResumeEntry,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_openai_agents import OpenAIAgentsAgent, resume_tool_calls
from ag_ui_openai_agents.interrupts import ABANDONED, APPROVAL_SCHEMA, CANCELLED, REJECTED


# ── a model that answers from a script ──────────────────────────────────


def call(name: str, arguments: dict[str, Any], call_id: str) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(
        id=f"fc_{call_id}",
        call_id=call_id,
        name=name,
        arguments=json.dumps(arguments),
        type="function_call",
        status="completed",
    )


def text(content: str) -> ResponseOutputMessage:
    return ResponseOutputMessage(
        id="msg_1",
        role="assistant",
        status="completed",
        type="message",
        content=[ResponseOutputText(type="output_text", text=content, annotations=[])],
    )


class ScriptedModel(Model):
    """Answers each model call with the next scripted list of output items."""

    def __init__(self, *turns: list[Any]) -> None:
        self.turns = list(turns)
        self.inputs: list[Any] = []
        self.instructions: list[Any] = []

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover
        raise NotImplementedError

    async def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        self.inputs.append(kwargs["input"] if "input" in kwargs else args[1])
        self.instructions.append(
            kwargs["system_instructions"] if "system_instructions" in kwargs else args[0]
        )
        output = self.turns.pop(0)
        for index, item in enumerate(output):
            yield ResponseOutputItemAddedEvent(
                type="response.output_item.added", item=item, output_index=index, sequence_number=0
            )
            if isinstance(item, ResponseOutputMessage):
                yield ResponseTextDeltaEvent(
                    type="response.output_text.delta",
                    delta=item.content[0].text,
                    item_id=item.id,
                    output_index=index,
                    content_index=0,
                    logprobs=[],
                    sequence_number=0,
                )
            yield ResponseOutputItemDoneEvent(
                type="response.output_item.done", item=item, output_index=index, sequence_number=0
            )
        yield ResponseCompletedEvent(
            type="response.completed",
            sequence_number=0,
            response=Response(
                id=f"resp_{len(self.inputs)}",
                created_at=0,
                model="scripted",
                object="response",
                output=output,
                parallel_tool_calls=True,
                tool_choice="auto",
                tools=[],
            ),
        )


# ── an agent with an approval-gated tool ─────────────────────────────────

refunds: list[str] = []


@function_tool(needs_approval=True)
def issue_refund(order_id: str) -> str:
    """Issue a refund."""
    refunds.append(order_id)
    return f"Refunded {order_id}."


def refund_agent(*turns: list[Any]) -> tuple[OpenAIAgentsAgent, ScriptedModel]:
    model = ScriptedModel(*turns)
    agent = Agent(name="support", instructions="Help.", tools=[issue_refund], model=model)
    return OpenAIAgentsAgent(agent), model


def request(messages: list[Any], resume: list[ResumeEntry] | None = None, tools=()) -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=list(messages),
        tools=list(tools),
        state={},
        context=[],
        forwarded_props=None,
        resume=resume,
    )


def run(agent: OpenAIAgentsAgent, run_input: RunAgentInput) -> list[Any]:
    async def collect():
        return [event async for event in agent.run_streamed(run_input)]

    return asyncio.run(collect())


def finished(events: list[Any]) -> Any:
    [event] = [e for e in events if e.type == EventType.RUN_FINISHED]
    return event


def snapshot(events: list[Any]) -> list[Any]:
    return [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages


def paused_history() -> list[Any]:
    agent, _ = refund_agent([call("issue_refund", {"order_id": "ORD-1"}, "c1")])
    return snapshot(run(agent, request([UserMessage(id="u1", role="user", content="refund ORD-1")])))


@pytest.fixture(autouse=True)
def _clear_refunds():
    refunds.clear()


# ── pause ────────────────────────────────────────────────────────────────


def test_a_paused_tool_call_ends_the_run_with_an_interrupt():
    agent, model = refund_agent([call("issue_refund", {"order_id": "ORD-1"}, "c1")])
    events = run(agent, request([UserMessage(id="u1", role="user", content="refund ORD-1")]))

    outcome = finished(events).outcome
    assert outcome.type == "interrupt"
    [interrupt] = outcome.interrupts
    assert interrupt.id == interrupt.tool_call_id == "c1"
    # Not "tool_call": CopilotKit would answer that one itself (see below).
    assert interrupt.reason == "tool_approval"
    assert interrupt.message == "Approve call to issue_refund?"
    assert interrupt.response_schema == APPROVAL_SCHEMA
    assert interrupt.metadata == {"tool_name": "issue_refund", "tool_input": {"order_id": "ORD-1"}}

    assert EventType.TOOL_CALL_RESULT not in [e.type for e in events]
    assert refunds == [] and len(model.inputs) == 1  # nothing ran, the model waits
    # The paused call stays in the history the client keeps.
    assert any(
        isinstance(m, AssistantMessage) and m.tool_calls and m.tool_calls[0].id == "c1"
        for m in snapshot(events)
    )


# ── resume ───────────────────────────────────────────────────────────────


def test_an_approved_call_runs_once_and_the_run_continues():
    history = paused_history()
    agent, model = refund_agent([text("Done, ORD-1 is refunded.")])
    events = run(
        agent,
        request(history, resume=[ResumeEntry(interrupt_id="c1", status="resolved", payload={"approved": True})]),
    )
    kinds = [e.type for e in events]

    assert refunds == ["ORD-1"]
    result = next(e for e in events if e.type == EventType.TOOL_CALL_RESULT)
    assert (result.tool_call_id, result.content) == ("c1", "Refunded ORD-1.")
    assert kinds.index(EventType.RUN_STARTED) < kinds.index(EventType.TOOL_CALL_RESULT)
    assert kinds.index(EventType.TOOL_CALL_RESULT) < kinds.index(EventType.TEXT_MESSAGE_START)
    assert finished(events).outcome.type == "success"
    # The model saw the tool's output right after its call.
    sent = model.inputs[0]
    outputs = [item for item in sent if item.get("type") == "function_call_output"]
    assert [(o["call_id"], o["output"]) for o in outputs] == [("c1", "Refunded ORD-1.")]
    # The snapshot carries the answer, so the next request is complete.
    tool_messages = [m for m in snapshot(events) if isinstance(m, ToolMessage)]
    assert [(m.tool_call_id, m.id) for m in tool_messages] == [("c1", result.message_id)]


@pytest.mark.parametrize("payload", [{"approved": False}, {"approved": "true"}, "yes", None])
def test_anything_but_an_explicit_approval_rejects_the_call(payload):
    history = paused_history()
    agent, _ = refund_agent([text("Okay, no refund.")])
    events = run(
        agent,
        request(history, resume=[ResumeEntry(interrupt_id="c1", status="resolved", payload=payload)]),
    )
    assert next(e for e in events if e.type == EventType.TOOL_CALL_RESULT).content == REJECTED
    assert refunds == []


def test_a_cancelled_interrupt_does_not_run_the_tool():
    history = paused_history()
    agent, _ = refund_agent([text("Okay.")])
    events = run(agent, request(history, resume=[ResumeEntry(interrupt_id="c1", status="cancelled")]))
    assert next(e for e in events if e.type == EventType.TOOL_CALL_RESULT).content == CANCELLED
    assert refunds == []


def test_a_call_left_open_is_closed_when_the_user_moves_on():
    history = paused_history()
    history.append(UserMessage(id="u2", role="user", content="never mind"))
    agent, model = refund_agent([text("Sure.")])
    events = run(agent, request(history))

    assert next(e for e in events if e.type == EventType.TOOL_CALL_RESULT).content == ABANDONED
    assert refunds == []
    sent = model.inputs[0]
    kinds = [item.get("type") or item.get("role") for item in sent]
    # The output sits right after its call, before the new user message.
    assert kinds.index("function_call_output") == kinds.index("function_call") + 1
    assert sent[-1]["role"] == "user"


def test_client_tool_calls_are_left_for_the_client():
    history = [
        UserMessage(id="u1", role="user", content="confirm it"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[ToolCall(id="c9", type="function", function=FunctionCall(name="confirm", arguments="{}"))],
        ),
    ]
    agent = Agent(name="support", instructions="Help.", tools=[issue_refund])
    resumed = asyncio.run(
        resume_tool_calls(
            agent,
            request(history, tools=[Tool(name="confirm", description="", parameters={"type": "object"})]),
        )
    )
    assert resumed.tool_results == []
    assert resumed.run_input.messages == history


def test_a_handoff_agents_tool_is_answered_too():
    specialist = Agent(name="refunds", instructions="Refund.", tools=[issue_refund])
    triage = Agent(name="triage", instructions="Route.", handoffs=[specialist])
    history = [
        UserMessage(id="u1", role="user", content="refund ORD-2"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="c2",
                    type="function",
                    function=FunctionCall(name="issue_refund", arguments='{"order_id": "ORD-2"}'),
                )
            ],
        ),
    ]
    resumed = asyncio.run(
        resume_tool_calls(
            triage,
            request(history, resume=[ResumeEntry(interrupt_id="c2", status="resolved", payload={"approved": True})]),
        )
    )
    assert [e.content for e in resumed.tool_results] == ["Refunded ORD-2."]
    assert refunds == ["ORD-2"]


def test_a_decision_the_client_also_wrote_as_the_tool_result_still_runs_the_tool():
    # CopilotKit answers a "tool_call" interrupt by adding a tool message whose
    # content is the response, next to the resume entry. For the agent's own
    # tool the entry decides: the tool runs and its output replaces that message.
    history = paused_history()
    history.append(
        ToolMessage(id="client-1", role="tool", tool_call_id="c1", content='{"approved":true}')
    )
    agent, model = refund_agent([text("Done.")])
    events = run(
        agent,
        request(history, resume=[ResumeEntry(interrupt_id="c1", status="resolved", payload={"approved": True})]),
    )
    assert refunds == ["ORD-1"]
    outputs = [item for item in model.inputs[0] if item.get("type") == "function_call_output"]
    assert [o["output"] for o in outputs] == ["Refunded ORD-1."]
    tool_messages = [m for m in snapshot(events) if isinstance(m, ToolMessage)]
    assert [(m.tool_call_id, m.content) for m in tool_messages] == [("c1", "Refunded ORD-1.")]
