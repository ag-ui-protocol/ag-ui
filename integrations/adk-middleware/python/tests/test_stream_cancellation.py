"""Disconnects must stop the producer, including an active Express model stream."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from ag_ui.core import ActivitySnapshotEvent, EventType, RunAgentInput, UserMessage
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.genai import types

from ag_ui_adk import ADKAgent, get_a2ui_tool
from ag_ui_adk.execution_state import ExecutionState


def _input():
    return RunAgentInput(
        thread_id=f"cancel-thread-{uuid4().hex}",
        run_id="cancel-run",
        state={},
        context=[],
        tools=[],
        messages=[
            UserMessage(id="user-message", role="user", content="Build a surface")
        ],
        forwarded_props={},
    )


@pytest.mark.parametrize("while_waiting", [False, True])
@pytest.mark.asyncio
async def test_closing_queue_consumer_cancels_and_awaits_producer(while_waiting):
    started = asyncio.Event()
    cleaned = asyncio.Event()
    queue = asyncio.Queue()

    async def produce():
        try:
            started.set()
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            cleaned.set()

    producer = asyncio.create_task(produce())
    execution = ExecutionState(producer, "thread", queue)
    stream = ADKAgent._stream_events(SimpleNamespace(_execution_timeout=600), execution)
    consumer = None
    await started.wait()
    try:
        if while_waiting:
            consumer = asyncio.create_task(anext(stream))
            await asyncio.sleep(0)
            consumer.cancel()
            with pytest.raises(asyncio.CancelledError):
                await consumer
        else:
            queue.put_nowait(
                ActivitySnapshotEvent(
                    type=EventType.ACTIVITY_SNAPSHOT,
                    message_id="surface",
                    activity_type="a2ui-surface",
                    content={"a2ui_operations": []},
                    replace=True,
                )
            )
            await anext(stream)
            await stream.aclose()
        assert producer.done(), "The disconnected consumer left its producer alive"
        assert producer.cancelled()
        assert (
            cleaned.is_set()
        ), "Producer cleanup must finish before stream closure returns"
    finally:
        if consumer is not None and not consumer.done():
            consumer.cancel()
        await stream.aclose()
        await execution.cancel()


class _Planner(BaseLlm):
    calls: int = 0

    async def generate_content_async(self, llm_request, stream=False):
        self.calls += 1
        if self.calls == 1:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name="generate_a2ui", args={}
                            )
                        )
                    ],
                ),
                partial=False,
                turn_complete=True,
            )
        else:
            yield LlmResponse(
                content=types.Content(
                    role="model", parts=[types.Part(text="Narration after the surface")]
                ),
                partial=False,
                turn_complete=True,
            )


class _BlockingExpress(BaseLlm):
    started: object
    cleaned: object
    release: object
    before_surface: bool = False
    calls: int = 0

    async def generate_content_async(self, llm_request, stream=False):
        self.calls += 1
        try:
            self.started.set()
            if self.before_surface:
                await self.release.wait()
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            text='<a2ui>\nroot = Text("A valid partial surface")\n'
                        )
                    ],
                ),
                partial=True,
            )
            await self.release.wait()
            yield LlmResponse(
                content=types.Content(role="model", parts=[types.Part(text="</a2ui>")]),
                partial=True,
            )
        finally:
            await asyncio.sleep(0)
            self.cleaned.set()


def _agent(*, before_surface=False):
    planner = _Planner(model="planner")
    model = _BlockingExpress(
        model="express",
        started=asyncio.Event(),
        cleaned=asyncio.Event(),
        release=asyncio.Event(),
        before_surface=before_surface,
    )
    tool = get_a2ui_tool(
        {
            "model": model,
            "inference_format": "express",
            "catalog": {
                "catalogId": "cat://cancel",
                "components": {
                    "Text": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                        "required": ["text"],
                    }
                },
            },
        }
    )
    agent = ADKAgent(
        adk_agent=LlmAgent(name="root", model=planner, tools=[tool]),
        app_name="cancel_app",
        user_id="user",
        use_in_memory_services=True,
    )
    return agent, planner, model


@pytest.mark.asyncio
async def test_closing_run_after_first_surface_stops_inner_model_and_narration():
    agent, planner, model = _agent()
    stream = agent.run(_input())
    try:
        async with asyncio.timeout(5):
            async for event in stream:
                if (
                    event.type == EventType.ACTIVITY_SNAPSHOT
                    and "a2ui_operations" in event.content
                ):
                    break
        await stream.aclose()
        assert model.cleaned.is_set(), "The inner model still runs after Stop"
        assert model.calls == 1
        assert planner.calls == 1, "The outer planner must not continue with narration"
        assert not agent._active_executions
    finally:
        model.release.set()
        await stream.aclose()
        await agent.close()


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize(
    "before_surface,block_send", [(False, False), (True, False), (False, True)]
)
@pytest.mark.asyncio
async def test_http_disconnect_stops_model_stream(legacy, before_surface, block_send):
    from fastapi import FastAPI
    from ag_ui.encoder import EventEncoder
    from ag_ui_adk.endpoint import add_adk_fastapi_endpoint

    agent, planner, model = _agent(before_surface=before_surface)
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent, path="/agent")
    disconnect = asyncio.Event()
    surface_sent = asyncio.Event()
    sent_request = False
    response_bodies = []

    async def receive():
        nonlocal sent_request
        if not sent_request:
            sent_request = True
            return {
                "type": "http.request",
                "body": _input().model_dump_json(by_alias=True).encode(),
                "more_body": False,
            }
        await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            body = message.get("body", b"")
            response_bodies.append(body)
            if b'"a2ui_operations"' in body:
                surface_sent.set()
                if block_send:
                    await asyncio.Event().wait()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/agent",
        "raw_path": b"/agent",
        "query_string": b"",
        "root_path": "",
        "server": ("test", 80),
        "client": ("client", 123),
        "headers": [
            (b"content-type", b"application/json"),
            (b"accept", b"text/event-stream"),
        ],
    }
    response = None
    try:
        with patch.object(
            EventEncoder,
            "get_content_type",
            return_value=(
                "application/vnd.ag-ui.event+proto" if legacy else "text/event-stream"
            ),
        ):
            response = asyncio.create_task(app(scope, receive, send))
            try:
                await asyncio.wait_for(model.started.wait(), 5)
            except TimeoutError:
                raise AssertionError(
                    f"Model did not start; HTTP body: {response_bodies!r}"
                )
            if not before_surface:
                await asyncio.wait_for(surface_sent.wait(), 5)
            disconnect.set()
            await asyncio.wait_for(response, 5)
        assert (
            model.cleaned.is_set()
        ), "HTTP disconnect returned while the inner model still runs"
        assert model.calls == planner.calls == 1
        assert not agent._active_executions
        assert b"Narration after the surface" not in b"".join(response_bodies)
    finally:
        disconnect.set()
        model.release.set()
        if response is not None and not response.done():
            response.cancel()
            await asyncio.gather(response, return_exceptions=True)
        await agent.close()


@pytest.mark.asyncio
async def test_normal_hitl_completion_sentinel_does_not_cancel_producer_cleanup():
    queue = asyncio.Queue()
    release_cleanup = asyncio.Event()
    producer_cleaned = asyncio.Event()

    async def producer():
        await queue.put(None)
        await release_cleanup.wait()
        producer_cleaned.set()

    task = asyncio.create_task(producer())
    execution = ExecutionState(task, "hitl-thread", queue)
    execution.add_pending_tool_call("pending-hitl-call")
    try:
        assert [
            event
            async for event in ADKAgent._stream_events(
                SimpleNamespace(_execution_timeout=600), execution
            )
        ] == []
        assert execution.is_complete
        assert not task.cancelled()
        assert execution.has_pending_tool_calls()
        release_cleanup.set()
        await task
        assert producer_cleaned.is_set()
    finally:
        release_cleanup.set()
        await execution.cancel()
