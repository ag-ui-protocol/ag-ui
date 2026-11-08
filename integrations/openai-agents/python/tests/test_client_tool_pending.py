"""A client tool call must reach the client however late the stream is read."""

from __future__ import annotations

import asyncio

from agents import Agent, Runner
from test_interrupts import ScriptedModel, call, finished, request

from ag_ui.core import EventType, Tool, UserMessage
from ag_ui_openai_agents import AGUITranslator
from ag_ui_openai_agents.engine import ClientToolPending


def test_a_client_tool_call_survives_a_slow_start_of_the_stream():
    # Runner.run_streamed starts the SDK run before to_agui reads its stream.
    # Here the model call and the client tool's proxy finish before the first
    # read, so ClientToolPending ends the run with the call's events still
    # queued. They must reach the client, or it never sees the call.
    translator = AGUITranslator()
    run_input = request(
        [UserMessage(id="u1", role="user", content="confirm it")],
        tools=[Tool(name="confirm", description="Confirm.", parameters={"type": "object", "properties": {}})],
    )
    translated = translator.to_openai(run_input)
    agent = Agent(
        name="assistant",
        instructions="Help.",
        model=ScriptedModel([call("confirm", {}, "c1")]),
        tools=translated.tools,
    )

    async def collect():
        result = Runner.run_streamed(agent, input=translated.messages)
        await asyncio.sleep(0.1)  # e.g. an async initial_state still loading
        return [event async for event in translator.to_agui(result, run_input)]

    events = asyncio.run(collect())
    assert [e.tool_call_id for e in events if e.type == EventType.TOOL_CALL_START] == ["c1"]
    assert finished(events).outcome.pending_tool_call_ids == ["c1"]


def test_client_tool_pending_asks_the_sdk_to_deliver_queued_events_first():
    # The SDK's own hook: an exception marked this way is raised from
    # stream_events() only after the events already queued are delivered.
    from agents.exceptions import _should_drain_stream_events_before_raising

    assert _should_drain_stream_events_before_raising(ClientToolPending("confirm", "c1", "{}"))
