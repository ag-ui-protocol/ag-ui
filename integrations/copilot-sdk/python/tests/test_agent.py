"""Deterministic tests for the Copilot SDK agent — no native runtime, no model."""

from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from typing import Any

import pytest
from ag_ui.core import RunAgentInput
from copilot.tools import ToolInvocation
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui_copilot_sdk import AGUITool, CopilotAgent, add_copilot_fastapi_endpoint
from ag_ui_copilot_sdk.mapper import EventMapper


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
        self.attachments: list[Any] = []
        self.resolved: list[Any] = []
        self.aborted = False
        self._on_event = on_event
        self._script = script
        self._stall = stall
        self.rpc = type("Rpc", (), {"tools": FakeTools(self)})()

    def emit(self, payload: dict[str, Any]) -> None:
        self._on_event(FakeEvent(payload))

    async def send(self, prompt: str, *, attachments=None) -> None:
        self.prompts.append(prompt)
        self.attachments.append(attachments)
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
        self.options: dict[str, Any] = {}

    async def create_session(self, **options: Any) -> FakeSession:
        self.options = options
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
    assert (
        "".join(event.delta for event in events if event.type == "TEXT_MESSAGE_CONTENT")
        == "Hello there"
    )


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
    request = client.session.resolved[0]
    result = request.to_dict()["result"]
    assert request.result.result_type == "failure"
    assert request.result.error == "browser refused"
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


@pytest.mark.parametrize("kind", ["tool.execution_start", "external_tool.requested"])
@pytest.mark.parametrize("name_first", [True, False], ids=["name-first", "name-late"])
def test_streamed_tool_args_close_once_with_no_stream_fallback(kind, name_first):
    mapper = EventMapper()
    chunks = ['{"color":', '"red"}']
    streamed = []
    for index, chunk in enumerate(chunks):
        events = mapper.map_event(
            {
                "id": f"delta-{index}",
                "type": "assistant.tool_call_delta",
                "data": {
                    "toolCallId": "call-1",
                    "inputDelta": chunk,
                    **({"toolName": "paint"} if index == (0 if name_first else 1) else {}),
                },
            }
        )
        if not name_first and index == 0:
            assert events == []
        streamed.extend(e.model_dump(by_alias=True, exclude_none=True) for e in events)
    assert streamed == [
        {"type": "TOOL_CALL_START", "toolCallId": "call-1", "toolCallName": "paint"},
        *(
            {"type": "TOOL_CALL_ARGS", "toolCallId": "call-1", "delta": chunk}
            for chunk in (chunks if name_first else ["".join(chunks)])
        ),
    ]
    data = {
        "toolCallId": "call-1",
        "toolName": "paint",
        "requestId": "req-1",
        "arguments": {"color": "red"},
    }
    ended = mapper.map_event({"id": "end", "type": kind, "data": data})
    assert [e.model_dump(by_alias=True, exclude_none=True) for e in ended] == [
        {"type": "TOOL_CALL_END", "toolCallId": "call-1"},
    ]
    assert (
        mapper.map_event(
            {
                "id": "final-message",
                "type": "assistant.message",
                "data": {
                    "messageId": "m1",
                    "content": "",
                    "toolRequests": [
                        {"toolCallId": "call-1", "name": "paint", "arguments": data["arguments"]},
                    ],
                },
            }
        )
        == []
    )
    fallback = mapper.map_event(
        {
            "id": "fallback",
            "type": kind,
            "data": {**data, "toolCallId": "call-2", "requestId": "req-2"},
        }
    )
    assert [e.model_dump(by_alias=True, exclude_none=True) for e in fallback] == [
        {"type": "TOOL_CALL_START", "toolCallId": "call-2", "toolCallName": "paint"},
        {"type": "TOOL_CALL_ARGS", "toolCallId": "call-2", "delta": '{"color":"red"}'},
        {"type": "TOOL_CALL_END", "toolCallId": "call-2"},
    ]
    assert mapper.finish() == []


async def test_subagent_lifecycle_and_message_tool_tags():
    child = {
        "toolCallId": "spawn-1",
        "agentName": "research",
        "agentDisplayName": "Research",
        "agentDescription": "Find facts",
        "parentId": "parent-agent",
    }
    script = [
        {
            "type": "subagent.started",
            "agentId": "parent-agent",
            "data": {
                "toolCallId": "spawn-parent",
                "agentName": "coordinator",
                "agentDisplayName": "Coordinator",
                "agentDescription": "Coordinate",
                "parentId": "unknown-task-registry-id",
            },
        },
        {"type": "subagent.started", "data": child},
        {
            "type": "assistant.message_delta",
            "data": {"messageId": "child-message", "deltaContent": "Found it"},
        },
        {
            "type": "assistant.message",
            "data": {"messageId": "child-message", "content": "Found it", "toolRequests": []},
        },
        {
            "type": "assistant.tool_call_delta",
            "data": {"toolCallId": "child-tool", "toolName": "lookup", "inputDelta": "{}"},
        },
        {
            "type": "tool.execution_start",
            "data": {"toolCallId": "child-tool", "toolName": "lookup", "arguments": {}},
        },
        {
            "type": "tool.execution_complete",
            "data": {"toolCallId": "child-tool", "success": True, "result": {"content": "found"}},
        },
        {"type": "subagent.completed", "data": child},
        {
            "type": "subagent.started",
            "agentId": "child-2",
            "data": {**child, "toolCallId": "spawn-2"},
        },
        {
            "type": "subagent.failed",
            "agentId": "child-2",
            "data": {**child, "toolCallId": "spawn-2", "error": "Lookup failed"},
        },
        {
            "type": "subagent.completed",
            "agentId": "parent-agent",
            "data": {
                "toolCallId": "spawn-parent",
                "agentName": "coordinator",
                "agentDisplayName": "Coordinator",
            },
        },
    ]
    events = await collect(
        CopilotAgent(
            FakeClient(
                [
                    {"id": str(index), "agentId": "child-1", **event}
                    for index, event in enumerate(script)
                ]
                + [{"id": "root-idle", "type": "session.idle", "data": {}}]
            ),
            run_timeout=1,
        ),
        make_input(),
    )
    lifecycle = [
        e.model_dump(by_alias=True, exclude_none=True)
        for e in events
        if e.type.startswith("SUBAGENT_")
    ]
    assert [(e["type"], e["subagentRunId"]) for e in lifecycle] == [
        ("SUBAGENT_STARTED", "parent-agent"),
        ("SUBAGENT_STARTED", "child-1"),
        ("SUBAGENT_FINISHED", "child-1"),
        ("SUBAGENT_STARTED", "child-2"),
        ("SUBAGENT_ERROR", "child-2"),
        ("SUBAGENT_FINISHED", "parent-agent"),
    ]
    assert lifecycle[1]["parentToolCallId"] == "spawn-1"
    assert "parentSubagentRunId" not in lifecycle[0]
    assert lifecycle[1]["parentSubagentRunId"] == "parent-agent"
    assert lifecycle[1]["name"] == "Research"
    assert "toolCallId" not in lifecycle[1]
    assert lifecycle[2]["outcome"] == {"type": "success"}
    assert lifecycle[3]["parentToolCallId"] == "spawn-2"
    assert lifecycle[4]["message"] == "Lookup failed"
    tagged = [e for e in events if e.type.startswith(("TEXT_MESSAGE_", "TOOL_CALL_"))]
    assert len(tagged) == 7
    assert all(e.subagent_run_id == "child-1" for e in tagged)
    assert events[-1].type == "RUN_FINISHED"


@pytest.mark.parametrize("with_text", [True, False], ids=["text-and-image", "image-only"])
async def test_inline_image_and_legacy_binary_are_sent_as_blobs(with_text):
    client = FakeClient(TEXT_TURN)
    content = [
        {
            "type": "image",
            "source": {
                "type": "data",
                "value": "data:image/png;base64,aGVsbG8=",
                "mimeType": "image/png",
            },
        },
        {"type": "binary", "data": "d29ybGQ=", "mimeType": "image/jpeg"},
    ]
    if with_text:
        content.insert(0, {"type": "text", "text": "Describe these."})
    events = await collect(
        CopilotAgent(client),
        make_input(
            messages=[{"id": "image-user", "role": "user", "content": content}],
        ),
    )
    assert len(client.session.prompts) == 1
    assert client.session.attachments == [
        [
            {"type": "blob", "data": "aGVsbG8=", "mimeType": "image/png"},
            {"type": "blob", "data": "d29ybGQ=", "mimeType": "image/jpeg"},
        ]
    ]
    if with_text:
        assert client.session.prompts[0] == "Describe these."
    assert events[-1].type == "RUN_FINISHED"


async def test_predict_state_and_immutable_snapshots_across_mutable_backend_handler_steps():
    prediction = [{"state_key": "theme", "tool": "set_theme", "tool_argument": "theme"}]
    seen_states = []
    client = FakeClient([{"id": "idle", "type": "session.idle", "data": {}}])
    create = client.create_session

    async def create_with_backend(**options):
        session = await create(**options)
        send = session.send

        async def send_with_backend(prompt, **kwargs):
            for theme in ("light", "contrast"):
                await options["tools"][0].handler(
                    ToolInvocation(
                        session_id=session.session_id,
                        tool_call_id=f"backend-{theme}",
                        tool_name="set_theme",
                        arguments={"theme": theme},
                    )
                )
            await send(prompt, **kwargs)

        session.send = send_with_backend
        return session

    client.create_session = create_with_backend

    def update_theme(args, context):
        state = context.state
        seen_states.append(deepcopy(state))
        state["theme"]["history"].append(args["theme"])
        context.set_state(state)
        state["theme"]["history"].append("unpublished")
        return "updated"

    agent = CopilotAgent(
        client,
        predict_state=prediction,
        tools=[
            AGUITool("set_theme", "Update theme", {"type": "object"}, update_theme),
        ],
    )
    events = await collect(agent, make_input(state={"theme": {"history": ["dark"]}}))
    assert seen_states == [
        {"theme": {"history": ["dark"]}},
        {"theme": {"history": ["dark", "light"]}},
    ]
    assert [e.model_dump(by_alias=True, exclude_none=True) for e in events] == [
        {"type": "RUN_STARTED", "threadId": "t1", "runId": "r1"},
        {"type": "CUSTOM", "name": "PredictState", "value": prediction},
        {"type": "STATE_SNAPSHOT", "snapshot": {"theme": {"history": ["dark", "light"]}}},
        {
            "type": "STATE_SNAPSHOT",
            "snapshot": {"theme": {"history": ["dark", "light", "contrast"]}},
        },
        {"type": "RUN_FINISHED", "threadId": "t1", "runId": "r1"},
    ]


@pytest.mark.parametrize("mode", ["tool", "resume", "error"])
async def test_interrupt_resolves_original_native_request_and_preserves_errors(mode):
    client = FakeClient([{**e, "agentId": "approval-agent"} for e in FRONTEND_TOOL_TURN])
    answers = []

    def resume(answer, args):
        answers.append((answer, args))
        return {"answer": answer, "args": args}

    agent = CopilotAgent(
        client,
        tools=[AGUITool("change_background", "change it")],
        interrupts={"change_background": resume},
        run_timeout=5,
    )
    first = await collect(agent, make_input())
    assert client.options["tools"][0].handler is None
    assert client.options["tools"][0].skip_permission
    assert first[-1].type == "RUN_FINISHED"
    assert first[-1].outcome.type == "interrupt"
    interrupt = first[-1].outcome.interrupts[0]
    assert interrupt.id == interrupt.tool_call_id == "call-1"
    assert interrupt.reason == "tool_call"
    assert interrupt.subagent_run_id == "approval-agent"
    assert interrupt.metadata == {"reason": {"color": "red"}}
    answer = {"approved": True}
    continuation = (
        {"resume": [{"interruptId": "call-1", "status": "resolved", "payload": answer}]}
        if mode == "resume"
        else {
            "messages": [
                {"id": "u1", "role": "user", "content": "Say hello."},
                {
                    "id": "answer",
                    "role": "tool",
                    "toolCallId": "call-1",
                    "content": "unavailable" if mode == "error" else json.dumps(answer),
                    **({"error": "browser refused"} if mode == "error" else {}),
                },
            ]
        }
    )
    second = await collect(agent, make_input(runId="r2", **continuation))
    assert second[-1].type == "RUN_FINISHED"
    assert [r.request_id for r in client.session.resolved] == ["req-1"]
    assert len(client.session.prompts) == 1
    result = client.session.resolved[0].result
    if mode == "error":
        assert result.to_dict() == {
            "textResultForLlm": "unavailable",
            "resultType": "failure",
            "error": "browser refused",
        }
    else:
        assert answers == [(answer, {"color": "red"})]
        assert json.loads(result) == {"answer": answer, "args": {"color": "red"}}


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))
