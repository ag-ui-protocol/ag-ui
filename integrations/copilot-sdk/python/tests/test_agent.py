"""Deterministic tests for the Copilot SDK agent — no native runtime, no model."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from ag_ui.core import RunAgentInput
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui_copilot_sdk import CopilotAgent, add_copilot_fastapi_endpoint


class FakeEvent:
    def __init__(self, payload: dict[str, Any]):
        self._payload = payload

    def to_dict(self) -> dict[str, Any]:
        return self._payload


class FakeTools:
    def __init__(self, session: FakeSession):
        self._session = session

    async def handle_pending_tool_call(self, request: Any):
        self._session.resolved.append(request)
        self._session.emit(
            {
                "id": f"complete-{request.request_id}",
                "type": "tool.execution_complete",
                "data": {
                    "toolCallId": "call-1",
                    "success": True,
                    "result": {"content": "tool done"},
                },
            }
        )
        self._session.emit({"id": f"idle-{request.request_id}", "type": "session.idle", "data": {}})
        return type("Response", (), {"success": True})()


class FakeSession:
    """Scripts a native turn: whatever ``script`` yields is emitted on ``send``."""

    def __init__(self, on_event, script, *, stall: bool = False):
        self.session_id = "fake-session"
        self.prompts: list[str] = []
        self.resolved: list[Any] = []
        self.aborted = False
        self._on_event = on_event
        self._script = script
        self._stall = stall
        self.rpc = type("Rpc", (), {"tools": FakeTools(self)})()

    def emit(self, payload: dict[str, Any]) -> None:
        self._on_event(FakeEvent(payload))

    async def send(self, prompt: str) -> None:
        self.prompts.append(prompt)
        if self._stall:
            await asyncio.Event().wait()  # Never resolves: models a wedged native RPC.
        for payload in self._script:
            self.emit(payload)

    async def abort(self) -> None:
        self.aborted = True

    async def disconnect(self) -> None:
        return None


class FakeClient:
    def __init__(self, script, *, stall: bool = False):
        self._script = script
        self._stall = stall
        self.session: FakeSession | None = None

    async def create_session(self, **options: Any) -> FakeSession:
        self.session = FakeSession(options["on_event"], self._script, stall=self._stall)
        return self.session


TEXT_TURN = [
    {"id": "1", "type": "assistant.message_start", "data": {"messageId": "m1"}},
    {
        "id": "2",
        "type": "assistant.message_delta",
        "data": {"messageId": "m1", "deltaContent": "Hello"},
    },
    {
        "id": "3",
        "type": "assistant.message",
        "data": {"messageId": "m1", "content": "Hello there", "toolRequests": []},
    },
    {"id": "4", "type": "session.idle", "data": {}},
]

FRONTEND_TOOL_TURN = [
    {
        "id": "1",
        "type": "external_tool.requested",
        "data": {
            "toolCallId": "call-1",
            "requestId": "req-1",
            "toolName": "change_background",
            "arguments": {"color": "red"},
        },
    },
]


def make_input(**overrides: Any) -> RunAgentInput:
    payload: dict[str, Any] = {
        "threadId": "t1",
        "runId": "r1",
        "messages": [{"id": "u1", "role": "user", "content": "Say hello."}],
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {},
    }
    payload.update(overrides)
    return RunAgentInput.model_validate(payload)


async def collect(agent: CopilotAgent, input_data: RunAgentInput) -> list[Any]:
    return [event async for event in agent.run(input_data)]


async def test_streams_assistant_text():
    agent = CopilotAgent(FakeClient(TEXT_TURN))
    events = await collect(agent, make_input())
    types = [event.type for event in events]
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert "".join(
        event.delta for event in events if event.type == "TEXT_MESSAGE_CONTENT"
    ) == "Hello there"


async def test_context_and_state_reach_the_prompt():
    """RunAgentInput.context must not be dropped — the Dojo passes the user name there."""
    client = FakeClient(TEXT_TURN)
    agent = CopilotAgent(client)
    await collect(
        agent,
        make_input(
            context=[{"description": "user name", "value": "Ada"}],
            state={"theme": "dark"},
        ),
    )
    prompt = client.session.prompts[0]
    assert "user name: Ada" in prompt
    assert '"theme": "dark"' in prompt
    assert prompt.endswith("Say hello.")


async def test_frontend_tool_handoff_then_continuation_resolves_original_request():
    client = FakeClient(FRONTEND_TOOL_TURN)
    agent = CopilotAgent(client, run_timeout=5)
    tools = [
        {
            "name": "change_background",
            "description": "change it",
            "parameters": {"type": "object", "properties": {}},
        }
    ]

    first = await collect(agent, make_input(tools=tools))
    assert [event.type for event in first][-1] == "RUN_FINISHED"
    assert any(event.type == "TOOL_CALL_START" for event in first)

    second = await collect(
        agent,
        make_input(
            runId="r2",
            tools=tools,
            messages=[
                {"id": "u1", "role": "user", "content": "Say hello."},
                {
                    "id": "a1",
                    "role": "assistant",
                    "toolCalls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {"name": "change_background", "arguments": "{}"},
                        }
                    ],
                },
                {"id": "t-1", "role": "tool", "toolCallId": "call-1", "content": "ok"},
            ],
        ),
    )
    assert [event.type for event in second][-1] == "RUN_FINISHED"
    # The original pending RPC was resolved by requestId, not re-prompted as text.
    assert [r.request_id for r in client.session.resolved] == ["req-1"]
    assert len(client.session.prompts) == 1


async def test_frontend_tool_error_is_forwarded_as_a_failure():
    client = FakeClient(FRONTEND_TOOL_TURN)
    agent = CopilotAgent(client, run_timeout=5)
    tools = [
        {
            "name": "change_background",
            "description": "change it",
            "parameters": {"type": "object", "properties": {}},
        }
    ]
    await collect(agent, make_input(tools=tools))
    await collect(
        agent,
        make_input(
            runId="r2",
            tools=tools,
            messages=[
                {"id": "u1", "role": "user", "content": "Say hello."},
                {
                    "id": "t-1",
                    "role": "tool",
                    "toolCallId": "call-1",
                    "content": "unavailable",
                    "error": "browser refused",
                },
            ],
        ),
    )
    result = client.session.resolved[0].result
    assert result["resultType"] == "failure"
    assert result["error"] == "browser refused"


async def test_run_timeout_does_not_await_a_wedged_native_call():
    """A stuck native RPC must end the run rather than hang the HTTP response."""
    client = FakeClient(TEXT_TURN, stall=True)
    agent = CopilotAgent(client, run_timeout=0.2)
    events = await asyncio.wait_for(collect(agent, make_input()), 5)
    assert events[-1].type == "RUN_ERROR"
    assert client.session.aborted


def test_fastapi_endpoint_streams_sse():
    agent = CopilotAgent(FakeClient(TEXT_TURN))
    app = FastAPI()
    add_copilot_fastapi_endpoint(app=app, agent=agent, path="/agentic_chat")
    with TestClient(app) as http:
        assert http.get("/agentic_chat/health").json()["status"] == "ok"
        response = http.post("/agentic_chat", json=make_input().model_dump(by_alias=True))
        assert response.status_code == 200
        assert "RUN_FINISHED" in response.text


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
