"""The endpoint drives one agent run from one ``contextvars.Context``.

Strands holds OpenTelemetry context tokens across its yields: ``stream_async``
and each event-loop cycle run inside ``trace_api.use_span``, which attaches a
span to the current Context and detaches it when the block exits. A token can
only be reset from the Context that created it. If successive ``__anext__``
calls, or the final ``aclose``, run in different Contexts, every span that
outlives one pull fails to detach and OpenTelemetry logs ``Failed to detach
context`` with ``ValueError: <Token ...> was created in a different Context``.
The run itself still works, so only the logs show it.

These tests hold a ContextVar token across a yield, the way ``use_span`` does,
and check that it resets cleanly on every way a run ends: completing, being
abandoned by the endpoint, and the client disconnecting. The last test runs a
real Strands agent and checks OpenTelemetry's own log.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import traceback
from contextvars import ContextVar
from typing import Any, AsyncIterator

import httpx
import pytest
from ag_ui.core import BaseEvent, RunAgentInput, Tool, UserMessage
from fastapi import FastAPI
from strands import Agent
from strands.models.model import Model

from ag_ui_strands import create_strands_app
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.endpoint import add_strands_fastapi_endpoint

from tests.endpoint_helpers import run_finished, run_started, valid_run_input

CLEANUP_TIMEOUT_SECONDS = 10

_HELD: ContextVar[str] = ContextVar("held_across_yields", default="unset")


class _Unencodable:
    """Not a pydantic model, so the encoder fails and the endpoint abandons the run."""

    type = "NOT_A_REAL_EVENT"


class HoldsTokenAcrossYields:
    """Sets a ContextVar before its first yield and resets it in ``finally``.

    The same shape as ``with trace_api.use_span(...)`` around a Strands yield.
    """

    name = "holds-token"

    def __init__(self, events: list[Any], *, forever: bool = False) -> None:
        self._events = events
        self._forever = forever
        self.reset_error: BaseException | None = None
        self.finished = asyncio.Event()

    async def run(self, input_data: Any) -> AsyncIterator[BaseEvent]:
        token = _HELD.set("run")
        try:
            for event in self._events:
                yield event
            while self._forever:
                yield run_started()
                await asyncio.sleep(0.02)
        finally:
            try:
                _HELD.reset(token)
            except ValueError as error:
                self.reset_error = error
            self.finished.set()


async def _post(app: FastAPI) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post("/", json=valid_run_input())


async def test_a_token_held_across_yields_resets_after_a_completed_run() -> None:
    agent = HoldsTokenAcrossYields([run_started(), run_finished()])
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")

    response = await _post(app)

    assert response.status_code == 200
    assert agent.finished.is_set()
    assert agent.reset_error is None, agent.reset_error


async def test_a_token_held_across_yields_resets_when_the_endpoint_closes_the_run() -> None:
    """An encoding failure makes the endpoint stop pulling and close the agent."""
    agent = HoldsTokenAcrossYields([run_started(), _Unencodable(), run_finished()])
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")

    response = await _post(app)

    assert b"RUN_ERROR" in response.content
    assert agent.finished.is_set()
    assert agent.reset_error is None, agent.reset_error


async def test_a_token_held_across_yields_resets_after_a_client_disconnect() -> None:
    agent = HoldsTokenAcrossYields([], forever=True)
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")

    body = json.dumps(valid_run_input()).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }
    delivered_request = False

    async def receive() -> dict:
        nonlocal delivered_request
        if not delivered_request:
            delivered_request = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(0.1)
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        pass

    await asyncio.wait_for(app(scope, receive, send), timeout=CLEANUP_TIMEOUT_SECONDS)

    # The close runs detached from the cancelled request, so it settles just
    # after the response ends.
    deadline = time.monotonic() + CLEANUP_TIMEOUT_SECONDS
    while not agent.finished.is_set() and time.monotonic() < deadline:
        await asyncio.sleep(0.01)
    assert agent.finished.is_set()
    assert agent.reset_error is None, agent.reset_error


class _ScriptedModel(Model):
    """Answers with text, or with one frontend tool call when asked to."""

    def __init__(self, *, call_frontend_tool: bool) -> None:
        self._call_frontend_tool = call_frontend_tool

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt, **kwargs):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        if self._call_frontend_tool:
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "call-1", "name": "set_theme"}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "hello"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def _detach_failure_origin(record: logging.LogRecord) -> str:
    """Where the span block was exiting when its detach failed.

    A ``GeneratorExit`` context means a generator was being closed at a
    yield, and the innermost frame says which one. With no context the block
    exited normally.
    """
    error = record.exc_info[1] if record.exc_info else None
    closing = error.__context__ if error is not None else None
    if not isinstance(closing, GeneratorExit):
        return "normal exit"
    frames = traceback.extract_tb(closing.__traceback__)
    return f"close of {frames[-1].name}" if frames else "close"


@pytest.mark.parametrize("call_frontend_tool", [False, True], ids=["text", "frontend-tool"])
async def test_strands_spans_detach_without_opentelemetry_errors(
    call_frontend_tool: bool, caplog: pytest.LogCaptureFixture
) -> None:
    adapter = StrandsAgent(
        Agent(
            model=_ScriptedModel(call_frontend_tool=call_frontend_tool),
            tools=[],
            callback_handler=None,
        ),
        name="otel-context",
    )
    app = create_strands_app(adapter, path="/agent", ping_path=None, origins=["*"])
    input_data = RunAgentInput(
        thread_id="otel-thread",
        run_id="otel-run",
        state={},
        messages=[UserMessage(id="user-1", content="hi")],
        tools=[
            Tool(
                name="set_theme",
                description="Runs in the browser",
                parameters={"type": "object", "properties": {}},
            )
        ],
        context=[],
        forwarded_props={},
    )

    with caplog.at_level(logging.ERROR, logger="opentelemetry.context"):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/agent",
                json=input_data.model_dump(mode="json", by_alias=True, exclude_none=True),
                headers={"accept": "text/event-stream"},
            )
        # Let the event loop run any async-generator finalizers it scheduled.
        await asyncio.sleep(0.05)

    assert response.status_code == 200
    assert b"RUN_FINISHED" in response.content
    origins = [
        _detach_failure_origin(record)
        for record in caplog.records
        if record.name == "opentelemetry.context"
    ]
    # Known Strands-side leak, not this adapter's: when ``stream_async`` is
    # closed early (here, the halt at a frontend tool), Strands does not close
    # the ``event_loop_cycle`` generator it iterates internally. The event
    # loop's async-generator finalizer closes it later from a new task, so its
    # span cannot detach whatever Context the adapter drives the run from.
    # Everything else must detach cleanly.
    strands_internal = "close of event_loop_cycle"
    assert [origin for origin in origins if origin != strands_internal] == []
    if not call_frontend_tool:
        assert origins == []
