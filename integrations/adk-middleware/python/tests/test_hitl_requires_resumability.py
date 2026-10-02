"""Unsupported HITL fails clearly; ordinary direct-constructor runs still work."""

from unittest.mock import AsyncMock, Mock, patch

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.events import Event
from google.genai import types
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager


@pytest.mark.asyncio
@pytest.mark.parametrize("setup", ["direct", "missing", "disabled", "enabled"])
@pytest.mark.parametrize("partial", [True, False])
async def test_hitl_requires_resumable_app(setup, partial):
    SessionManager.reset_instance()
    root = LlmAgent(name="agent", model="unused")
    if setup == "direct":
        agent = ADKAgent(adk_agent=root, app_name="test", user_id="user")
    else:
        config = (
            None
            if setup == "missing"
            else ResumabilityConfig(is_resumable=setup == "enabled")
        )
        agent = ADKAgent.from_app(
            App(name="test", root_agent=root, resumability_config=config),
            user_id="user",
        )
    consumed = []

    async def run_async(**kwargs):
        for is_partial in ([True, False] if partial else [False]):
            consumed.append(is_partial)
            yield Event(
                author="agent",
                invocation_id="inv",
                partial=is_partial,
                long_running_tool_ids={"call"},
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                id="call", name="approve", args={}
                            )
                        )
                    ],
                ),
            )

    runner = Mock(run_async=run_async, close=AsyncMock())
    request = RunAgentInput(
        thread_id="thread",
        run_id="run",
        messages=[UserMessage(id="u", content="hello")],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )
    try:
        with patch.object(agent, "_create_runner", return_value=runner):
            events = [event async for event in agent.run(request)]
        terminals = [
            e for e in events if e.type in (EventType.RUN_ERROR, EventType.RUN_FINISHED)
        ]
        assert len(terminals) == 1
        if setup == "enabled":
            assert terminals[0].type == EventType.RUN_FINISHED
            assert consumed == ([True, False] if partial else [False])
            assert sum(e.type == EventType.TOOL_CALL_START for e in events) == 1
        else:
            assert terminals[0].type == EventType.RUN_ERROR
            assert "ADKAgent.from_app" in terminals[0].message
            assert "ResumabilityConfig(is_resumable=True)" in terminals[0].message
            assert not any(e.type == EventType.TOOL_CALL_START for e in events)
        runner.close.assert_awaited_once()
    finally:
        SessionManager.reset_instance()
