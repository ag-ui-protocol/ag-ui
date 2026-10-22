"""Exercise real AgentScope runs and the HTTP protocol boundary without an API key."""

import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import pytest
from ag_ui.core import Event, RunAgentInput
from agentscope.agent import Agent
from agentscope.event import (
    ReplyEndEvent,
    RequireExternalExecutionEvent,
    RequireUserConfirmEvent,
)
from agentscope.message import TextBlock, ToolCallBlock, ToolResultBlock
from agentscope.state import AgentState
from agentscope.tool import FunctionTool, ToolChunk, Toolkit
from agentscope.types import ReplyFinishedReason
from pydantic import TypeAdapter
from server import agents as example_agents
from server import app
from server.agents import ScriptedModel
from server.bridge import create_agent_app, history_messages, run_stream


def request(*, messages=None, thread="thread", run="run"):
    return {
        "threadId": thread,
        "runId": run,
        "messages": messages
        if messages is not None
        else [{"id": "user", "role": "user", "content": "Hi"}],
        "state": {},
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def events(response):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    result = [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    for event in result:
        TypeAdapter(Event).validate_python(event)
    assert result[0]["type"] == "RUN_STARTED"
    assert sum(e["type"] in ("RUN_FINISHED", "RUN_ERROR") for e in result) == 1
    return result


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setenv("AG_UI_AGENTSCOPE_OFFLINE", "1")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


@pytest.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


async def test_chat_stream_and_caller_ids(client):
    result = events(
        await client.post(
            "/agentic_chat/", json=request(thread="caller-thread", run="caller-run")
        )
    )
    assert result[0]["protocolVersion"] == "1.0"
    assert result[0]["threadId"] == result[-1]["threadId"] == "caller-thread"
    assert result[0]["runId"] == result[-1]["runId"] == "caller-run"
    content = [e for e in result if e["type"] == "TEXT_MESSAGE_CONTENT"]
    assert len(content) > 1
    assert (
        "".join(e["delta"] for e in content).strip()
        == "Hello! How can I help you today?"
    )
    assert len({e["messageId"] for e in content}) == 1
    assert result[-1]["type"] == "RUN_FINISHED"


async def test_real_backend_tool_loop(client):
    result = events(
        await client.post(
            "/backend_tool_rendering/",
            json=request(
                messages=[
                    {
                        "id": "user",
                        "role": "user",
                        "content": "Weather in San Francisco",
                    },
                ]
            ),
        )
    )
    call = next(e for e in result if e["type"] == "TOOL_CALL_START")
    assert call["toolCallName"] == "get_weather"
    args = "".join(e["delta"] for e in result if e["type"] == "TOOL_CALL_ARGS")
    assert json.loads(args) == {"location": "San Francisco"}
    output = next(e for e in result if e["type"] == "TOOL_CALL_RESULT")
    assert output["toolCallId"] == call["toolCallId"]
    assert json.loads(output["content"])["humidity"] == 65
    assert result[-1]["type"] == "RUN_FINISHED"


async def test_provider_mode_formats_history_once_and_closes_client(
    client, monkeypatch
):
    """Run the real OpenAI model/formatter with a local HTTP transport."""
    received = []

    def provider(req):
        assert req.url == "https://provider.example/v1/chat/completions"
        received.append(json.loads(req.content))
        chunks = [
            {
                "id": "response",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "test-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": "Hello from the provider",
                        },
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "response",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "test-model",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
        ]
        body = (
            "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks)
            + "data: [DONE]\n\n"
        )
        return httpx.Response(
            200, headers={"Content-Type": "text/event-stream"}, content=body
        )

    provider_client = httpx.AsyncClient(transport=httpx.MockTransport(provider))
    real_model = example_agents.OpenAIChatModel

    def model(**kwargs):
        return real_model(
            **kwargs, client_kwargs={"http_client": provider_client}, max_retries=0
        )

    monkeypatch.setattr(example_agents, "OpenAIChatModel", model)
    monkeypatch.setenv("AG_UI_AGENTSCOPE_OFFLINE", "0")
    monkeypatch.setenv("OPENAI_API_KEY", "test-placeholder")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://provider.example/v1")
    supplied = [
        {"id": "s", "role": "system", "content": "Speak briefly"},
        *tool_history(),
    ]
    payload_with_context = request(messages=supplied)
    payload_with_context["context"] = [{"description": "User's name", "value": "Bob"}]
    result = events(
        await client.post("/backend_tool_rendering/", json=payload_with_context)
    )
    assert result[-1]["type"] == "RUN_FINISHED"
    assert "Hello from the provider" in "".join(
        e["delta"] for e in result if e["type"] == "TEXT_MESSAGE_CONTENT"
    )
    assert len(received) == 1
    payload = received[0]
    assert (
        sum(
            m["role"] == "user" and "Hello again" in json.dumps(m["content"])
            for m in payload["messages"]
        )
        == 1
    )
    assert (
        sum(
            m["role"] == "tool" and m["tool_call_id"] == "call1"
            for m in payload["messages"]
        )
        == 1
    )
    assert payload["tools"][0]["function"]["name"] == "get_weather"
    assert any(
        m["role"] == "system" and "Bob" in json.dumps(m["content"])
        for m in payload["messages"]
    )
    assert provider_client.is_closed


def tool_history():
    return [
        {"id": "u1", "role": "user", "content": "Weather in Paris"},
        {
            "id": "a1",
            "role": "assistant",
            "toolCalls": [
                {
                    "id": "call1",
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "arguments": '{"location":"Paris"}',
                    },
                }
            ],
        },
        {
            "id": "t1",
            "role": "tool",
            "toolCallId": "call1",
            "content": '{"humidity":65}',
        },
        {"id": "a2", "role": "assistant", "content": "Here is the weather."},
        {
            "id": "u2",
            "role": "user",
            "content": [{"type": "text", "text": "Hello again"}],
        },
    ]


def test_history_preserves_roles_text_and_tool_identity():
    supplied = [
        {"id": "s", "role": "system", "content": "Be brief"},
        {"id": "d", "role": "developer", "content": "Use text"},
        *tool_history(),
    ]
    history = history_messages(RunAgentInput.model_validate(request(messages=supplied)))
    assert [m.id for m in history] == [m["id"] for m in supplied]
    assert [m.role for m in history] == [
        "system",
        "system",
        "user",
        "assistant",
        "assistant",
        "assistant",
        "user",
    ]
    call = history[3].content[0]
    result = history[4].content[0]
    assert isinstance(call, ToolCallBlock) and isinstance(result, ToolResultBlock)
    assert call.id == result.id == "call1"
    assert call.name == result.name == "get_weather"
    assert history[-1].content[0].text == "Hello again"


async def test_previous_backend_tools_are_not_reexecuted(client):
    result = events(
        await client.post(
            "/backend_tool_rendering/", json=request(messages=tool_history())
        )
    )
    assert not any(e["type"].startswith("TOOL_CALL") for e in result)
    assert result[-1]["type"] == "RUN_FINISHED"


@pytest.mark.parametrize(
    "messages",
    [
        [],
        [{"id": "t", "role": "tool", "toolCallId": "missing", "content": "orphan"}],
        tool_history()[:2],
        tool_history()[:3] + [tool_history()[2]],
        tool_history()[:3] + tool_history()[1:3],
        [
            {
                "id": "u",
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "url", "url": "https://example.com/a.png"},
                    }
                ],
            }
        ],
    ],
)
async def test_invalid_history_is_rejected_before_streaming(client, messages):
    response = await client.post("/agentic_chat/", json=request(messages=messages))
    assert response.status_code == 422
    assert response.headers["content-type"] == "application/json"


async def test_invalid_request_and_health(client):
    assert (await client.get("/health")).json() == {"status": "ok"}
    assert (await client.post("/agentic_chat/", json={})).status_code == 422


async def test_concurrent_real_agents_and_history_are_isolated():
    barrier = asyncio.Barrier(2)
    observed = {}
    closed = []

    class ConcurrentModel(ScriptedModel):
        async def _call_api(self, model_name, messages, **kwargs):
            observed[model_name] = [m.id for m in messages]
            await asyncio.wait_for(barrier.wait(), timeout=5)
            return await super()._call_api(model_name, messages, **kwargs)

    @asynccontextmanager
    async def factory(input_data):
        model = ConcurrentModel()
        model.model = input_data.run_id
        try:
            yield Agent(
                name="Assistant",
                system_prompt="Be helpful",
                model=model,
                state=AgentState(session_id=input_data.thread_id),
            )
        finally:
            await model.client.close()
            closed.append(input_data.run_id)

    test_app = create_agent_app(factory)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=test_app), base_url="http://test"
    ) as client:
        responses = await asyncio.gather(
            *[
                client.post(
                    "/",
                    json=request(
                        run=name,
                        messages=[{"id": name, "role": "user", "content": "Hi"}],
                    ),
                )
                for name in ("first", "second")
            ]
        )
    for name, response in zip(("first", "second"), responses):
        result = events(response)
        assert [
            e["stepName"]
            for e in result
            if e["type"] in ("STEP_STARTED", "STEP_FINISHED")
        ] == [name, name]
        assert observed[name].count(name) == 1
        assert ("second" if name == "first" else "first") not in observed[name]
        assert result[-1]["runId"] == name
    assert sorted(closed) == ["first", "second"]


@pytest.mark.parametrize(
    "reason",
    [
        ReplyFinishedReason.INTERRUPTED,
        ReplyFinishedReason.ERROR,
        ReplyFinishedReason.EXCEED_MAX_ITERS,
    ],
)
async def test_native_failure_is_not_reported_as_success(reason):
    class FailedAgent:
        state = AgentState()

        async def reply_stream(self, inputs):
            yield ReplyEndEvent(
                session_id="native", reply_id="native", finished_reason=reason
            )

    @asynccontextmanager
    async def factory(_):
        yield FailedAgent()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_agent_app(factory)),
        base_url="http://test",
    ) as client:
        result = events(await client.post("/", json=request()))
    assert result[-1]["type"] == "RUN_ERROR"


@pytest.mark.parametrize(
    "failure",
    ["exception", "eof", "approval", "external", "cleanup", "approval_cleanup"],
)
async def test_error_paths_finalize_resources_and_emit_one_terminal(failure):
    finalized = []

    class BrokenAgent:
        state = AgentState()

        async def reply_stream(self, inputs):
            if failure == "exception":
                raise RuntimeError("sensitive provider details")
            if failure in ("approval", "approval_cleanup"):
                yield RequireUserConfirmEvent(reply_id="native", tool_calls=[])
            if failure == "external":
                yield RequireExternalExecutionEvent(reply_id="native", tool_calls=[])
            if failure == "cleanup":
                yield ReplyEndEvent(session_id="native", reply_id="native")

    @asynccontextmanager
    async def factory(_):
        try:
            yield BrokenAgent()
        finally:
            finalized.append(True)
            if failure in ("cleanup", "approval_cleanup"):
                raise RuntimeError("sensitive cleanup details")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=create_agent_app(factory)),
        base_url="http://test",
    ) as client:
        response = await client.post("/", json=request())
        result = events(response)
    assert finalized == [True]
    assert result[-1]["type"] == "RUN_ERROR"
    assert "sensitive" not in response.text


@pytest.mark.parametrize("during_tool", [False, True])
@pytest.mark.parametrize("transport", ["task", "asgi"])
async def test_cancellation_closes_real_agent_resources(during_tool, transport):
    entered = asyncio.Event()
    finalized = asyncio.Event()
    chunks = []

    class BlockingModel(ScriptedModel):
        async def _call_api(self, *args, **kwargs):
            if not during_tool:
                entered.set()
                await asyncio.Event().wait()
            return await super()._call_api(*args, **kwargs)

    async def get_weather(location: str) -> ToolChunk:
        """Wait for cancellation while executing a backend tool."""
        entered.set()
        await asyncio.Event().wait()
        return ToolChunk(content=[TextBlock(text=location)])

    @asynccontextmanager
    async def factory(input_data):
        model = BlockingModel()
        try:
            yield Agent(
                name="Assistant",
                system_prompt="Use tools",
                model=model,
                toolkit=Toolkit(tools=[FunctionTool(get_weather, is_read_only=True)]),
                state=AgentState(session_id=input_data.thread_id),
            )
        finally:
            await model.client.close()
            finalized.set()

    input_data = RunAgentInput.model_validate(
        request(messages=[{"id": "u", "role": "user", "content": "Weather in Paris"}])
    )

    async def consume():
        async for chunk in run_stream(
            input_data, factory, history_messages(input_data)
        ):
            chunks.append(json.loads(chunk[6:]))

    disconnected = asyncio.Event()
    if transport == "asgi":
        body = json.dumps(
            request(
                messages=[{"id": "u", "role": "user", "content": "Weather in Paris"}]
            )
        ).encode()
        received_body = False

        async def receive():
            nonlocal received_body
            if not received_body:
                received_body = True
                return {"type": "http.request", "body": body, "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body":
                chunks.extend(
                    json.loads(line[6:])
                    for line in message.get("body", b"").decode().splitlines()
                    if line.startswith("data: ")
                )

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/",
            "raw_path": b"/",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"content-type", b"application/json")],
            "client": ("127.0.0.1", 1234),
            "server": ("localhost", 80),
        }
        task = asyncio.create_task(create_agent_app(factory)(scope, receive, send))
    else:
        task = asyncio.create_task(consume())
    await asyncio.wait_for(entered.wait(), timeout=5)
    if transport == "asgi":
        disconnected.set()
    else:
        task.cancel()
    try:
        await asyncio.wait_for(task, timeout=5)
    except asyncio.CancelledError:
        pass
    assert finalized.is_set()
    assert not any(e["type"] in ("RUN_FINISHED", "REPLY_END") for e in chunks)
