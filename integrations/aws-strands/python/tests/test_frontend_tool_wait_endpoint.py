"""Deterministic HTTP coverage for frontend-tool wait lifecycle variants."""

from __future__ import annotations

import asyncio
import copy
import json
from typing import Any

import httpx
import pytest
from ag_ui.core import RunAgentInput, Tool, ToolMessage, UserMessage
from strands import Agent
from strands.models.model import Model

from ag_ui_strands import create_strands_app
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior


class _EndpointModel(Model):
    """One scripted tool-use turn followed by deterministic text."""

    def __init__(self, tool_name: str) -> None:
        self.tool_name = tool_name
        self.calls = 0
        self.seen_messages: list[list[dict[str, Any]]] = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt, **kwargs
    ):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls == 1:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": f"native-{self.tool_name}",
                            "name": self.tool_name,
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": '{"value":"requested"}'}}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def _tool(name: str) -> Tool:
    return Tool(
        name=name,
        description=f"Client tool {name}",
        parameters={
            "type": "object",
            "properties": {"value": {"type": "string"}},
        },
    )


def _input(
    thread_id: str,
    tool: Tool,
    *,
    run_id: str = "run-1",
    messages: list[Any] | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=messages
        if messages is not None
        else [UserMessage(id=f"user-{thread_id}", content="use the client tool")],
        tools=[tool],
        context=[],
        forwarded_props={},
    )


def _decode_sse(body: str) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


async def _post(app: Any, input_data: RunAgentInput) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/agent",
            json=input_data.model_dump(mode="json", by_alias=True, exclude_none=True),
            headers={"accept": "text/event-stream"},
        )
    assert response.status_code == 200
    return _decode_sse(response.text)


def _assert_hidden_wait(events: list[dict[str, Any]]) -> str:
    event_types = [event["type"] for event in events]
    assert event_types.count("TOOL_CALL_START") == 1
    assert event_types.count("TOOL_CALL_ARGS") == 1
    assert event_types.count("TOOL_CALL_END") == 1
    finished = next(event for event in events if event["type"] == "RUN_FINISHED")
    assert finished["outcome"] == {"type": "success"}
    assert "interrupts" not in finished["outcome"]
    return next(
        event["toolCallId"] for event in events if event["type"] == "TOOL_CALL_START"
    )


@pytest.mark.asyncio
async def test_automatic_wait_resumes_exact_immediate_tool_message_over_http():
    model = _EndpointModel("lookup_value")
    tool = _tool("lookup_value")
    adapter = StrandsAgent(Agent(model=model, tools=[]), name="endpoint-auto")
    app = create_strands_app(adapter, path="/agent", ping_path=None)

    first = await _post(app, _input("auto-thread", tool))
    wire_id = _assert_hidden_wait(first)
    assert model.calls == 1

    exact_result = '{"answer":42,"source":"client"}'
    second = await _post(
        app,
        _input(
            "auto-thread",
            tool,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="automatic-result",
                    tool_call_id=wire_id,
                    content=exact_result,
                )
            ],
        ),
    )

    assert model.calls == 2
    assert any(event.get("delta") == "continued" for event in second)
    assert exact_result in repr(model.seen_messages[-1])
    assert not any(event["type"] == "TOOL_CALL_START" for event in second)


@pytest.mark.asyncio
@pytest.mark.parametrize("result", ["", "false"])
async def test_interactive_wait_accepts_delayed_falsy_response_once_over_http(
    result: str,
):
    model = _EndpointModel("render_prompt")
    tool = _tool("render_prompt")
    adapter = StrandsAgent(Agent(model=model, tools=[]), name="endpoint-interactive")
    app = create_strands_app(adapter, path="/agent", ping_path=None)

    first = await _post(app, _input("interactive-thread", tool))
    wire_id = _assert_hidden_wait(first)
    await asyncio.sleep(0)

    second = await _post(
        app,
        _input(
            "interactive-thread",
            tool,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="interactive-result",
                    tool_call_id=wire_id,
                    content=result,
                )
            ],
        ),
    )

    assert model.calls == 2
    assert not any(event["type"] == "RUN_ERROR" for event in second)
    assert not any(event["type"] == "TOOL_CALL_START" for event in second)
    model_visible_result = model.seen_messages[-1][-1]["content"][0]["toolResult"]
    assert model_visible_result == {
        "toolUseId": "native-render_prompt",
        "status": "success",
        "content": [{"text": result}],
    }


@pytest.mark.asyncio
async def test_continue_true_keeps_placeholder_same_run_continuation_over_http():
    model = _EndpointModel("render_and_continue")
    tool = _tool("render_and_continue")
    adapter = StrandsAgent(
        Agent(model=model, tools=[]),
        name="endpoint-continue",
        config=StrandsAgentConfig(
            tool_behaviors={
                "render_and_continue": ToolBehavior(continue_after_frontend_call=True)
            }
        ),
    )
    app = create_strands_app(adapter, path="/agent", ping_path=None)

    events = await _post(app, _input("continue-thread", tool))

    assert model.calls == 2
    assert any(event.get("delta") == "continued" for event in events)
    assert "Forwarded to client" in repr(model.seen_messages[-1])
    finished = next(event for event in events if event["type"] == "RUN_FINISHED")
    assert finished["outcome"] == {"type": "success"}


@pytest.mark.asyncio
async def test_full_history_over_512_messages_resumes_from_bounded_checkpoint():
    model = _EndpointModel("long_history_lookup")
    tool = _tool("long_history_lookup")
    adapter = StrandsAgent(Agent(model=model, tools=[]), name="endpoint-long-history")
    app = create_strands_app(adapter, path="/agent", ping_path=None)
    history = [
        UserMessage(id=f"history-{index}", content=f"old turn {index}")
        for index in range(600)
    ]

    first = await _post(
        app,
        _input("long-history-thread", tool, messages=history),
    )
    wire_id = _assert_hidden_wait(first)
    snapshot = next(
        event["messages"]
        for event in reversed(first)
        if event["type"] == "MESSAGES_SNAPSHOT"
    )
    full_history = [
        *snapshot,
        {
            "id": "long-history-result",
            "role": "tool",
            "toolCallId": wire_id,
            "content": "exact-long-history-result",
        },
    ]
    second = await _post(
        app,
        RunAgentInput.model_validate(
            {
                "threadId": "long-history-thread",
                "runId": "run-2",
                "state": {},
                "messages": full_history,
                "tools": [tool.model_dump(mode="json", by_alias=True)],
                "context": [],
                "forwardedProps": {},
            }
        ),
    )

    assert model.calls == 2
    assert not any(event["type"] == "RUN_ERROR" for event in second)
    assert "exact-long-history-result" in repr(model.seen_messages[-1])


class _BlockingEndpointModel(Model):
    """Holds the first run open so a contender can arrive mid-stream."""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt, **kwargs
    ):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.entered.set()
        await self.release.wait()
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockDelta": {"delta": {"text": "done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


@pytest.mark.asyncio
async def test_a_busy_thread_answers_thread_busy_over_http():
    """A contender gets a readable protocol error, not a stream that dies."""
    model = _BlockingEndpointModel()
    tool = _tool("unused_tool")
    adapter = StrandsAgent(Agent(model=model, tools=[]), name="endpoint-busy")
    app = create_strands_app(adapter, path="/agent", ping_path=None)

    first = asyncio.create_task(_post(app, _input("busy-thread", tool)))
    try:
        await asyncio.wait_for(model.entered.wait(), timeout=5.0)

        contender = await _post(
            app, _input("busy-thread", tool, run_id="run-contender")
        )
    finally:
        model.release.set()
        first_events = await asyncio.wait_for(first, timeout=5.0)

    assert [event["type"] for event in contender] == ["RUN_STARTED", "RUN_ERROR"]
    assert contender[1]["code"] == "THREAD_BUSY"
    assert 'thread "busy-thread"' in contender[1]["message"]
    assert contender[0]["runId"] == "run-contender"

    # The rejected contender must not have disturbed the run it collided with.
    assert [event["type"] for event in first_events][-1] == "RUN_FINISHED"

    # And the thread is usable again once the first run finishes.
    after = await _post(app, _input("busy-thread", tool, run_id="run-after"))
    assert not any(event["type"] == "RUN_ERROR" for event in after)
