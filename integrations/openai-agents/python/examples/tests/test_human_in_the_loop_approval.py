"""The approval demo over HTTP: pause, then approve or reject, with no server state.

The SDK runs for real; only the model is scripted. Each resume is built from
the previous response's MESSAGES_SNAPSHOT, as a client does, so the two
requests share nothing on the server.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, AsyncIterator

import pytest
from agents.models.interface import Model
from fastapi.testclient import TestClient
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
)

EXAMPLES = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLES))

from agents_examples import human_in_the_loop_approval as demo  # noqa: E402


class ScriptedModel(Model):
    """Answers each model call with the next scripted output item."""

    def __init__(self, *turns: Any) -> None:
        self.turns = list(turns)

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:  # pragma: no cover
        raise NotImplementedError

    async def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        item = self.turns.pop(0)
        for event_cls, kind in (
            (ResponseOutputItemAddedEvent, "response.output_item.added"),
            (ResponseOutputItemDoneEvent, "response.output_item.done"),
        ):
            yield event_cls(type=kind, item=item, output_index=0, sequence_number=0)
        yield ResponseCompletedEvent(
            type="response.completed",
            sequence_number=0,
            response=Response(
                id="resp",
                created_at=0,
                model="scripted",
                object="response",
                output=[item],
                parallel_tool_calls=False,
                tool_choice="auto",
                tools=[],
            ),
        )


REFUND_CALL = ResponseFunctionToolCall(
    id="fc_1",
    call_id="call_1",
    name="issue_refund",
    arguments=json.dumps({"order_id": "ORD-1001"}),
    type="function_call",
    status="completed",
)


def reply(text: str) -> ResponseOutputMessage:
    return ResponseOutputMessage(
        id="msg_1",
        role="assistant",
        status="completed",
        type="message",
        content=[ResponseOutputText(type="output_text", text=text, annotations=[])],
    )


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(demo._ORDERS, "ORD-1001", {"amount": 49.99, "status": "paid"})
    return TestClient(demo.app)


def post(client: TestClient, monkeypatch, model: ScriptedModel, body: dict) -> list[dict]:
    monkeypatch.setattr(demo.agent, "agent", demo.agent.agent.clone(model=model))
    response = client.post("/", json=body)
    assert response.status_code == 200
    return [
        json.loads(line[len("data: ") :])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def body(messages: list[dict], resume: list[dict] | None = None) -> dict:
    return {
        "threadId": "t1",
        "runId": "r1",
        "messages": messages,
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {},
        **({"resume": resume} if resume else {}),
    }


def pause(client, monkeypatch) -> list[dict]:
    events = post(
        client,
        monkeypatch,
        ScriptedModel(REFUND_CALL),
        body([{"id": "u1", "role": "user", "content": "Refund ORD-1001."}]),
    )
    [finished] = [e for e in events if e["type"] == "RUN_FINISHED"]
    [interrupt] = finished["outcome"]["interrupts"]
    assert interrupt["id"] == interrupt["toolCallId"] == "call_1"
    assert interrupt["metadata"] == {
        "tool_name": "issue_refund",
        "tool_input": {"order_id": "ORD-1001"},
    }
    assert demo._ORDERS["ORD-1001"]["status"] == "paid"
    return [e for e in events if e["type"] == "MESSAGES_SNAPSHOT"][-1]["messages"]


def test_approving_the_interrupt_runs_the_refund(client, monkeypatch):
    history = pause(client, monkeypatch)
    events = post(
        client,
        monkeypatch,
        ScriptedModel(reply("Refunded.")),
        body(history, [{"interruptId": "call_1", "status": "resolved", "payload": {"approved": True}}]),
    )
    result = next(e for e in events if e["type"] == "TOOL_CALL_RESULT")
    assert result["content"] == "Refunded $49.99 for ORD-1001."
    assert demo._ORDERS["ORD-1001"]["status"] == "refunded"


def test_rejecting_the_interrupt_leaves_the_order_alone(client, monkeypatch):
    history = pause(client, monkeypatch)
    events = post(
        client,
        monkeypatch,
        ScriptedModel(reply("No refund then.")),
        body(history, [{"interruptId": "call_1", "status": "resolved", "payload": {"approved": False}}]),
    )
    result = next(e for e in events if e["type"] == "TOOL_CALL_RESULT")
    assert result["content"] == "Tool execution was not approved."
    assert demo._ORDERS["ORD-1001"]["status"] == "paid"
