"""Repro for CopilotKit/CopilotKit#3030.

Reported symptom (react-core/react-ui 1.51.0): the agent emitted text, called
a frontend tool, then emitted more text -- but the UI rendered

    pre text -> post text -> tool call component

instead of

    pre text -> tool call component -> post text

The reporter's own event trace showed a single assistant text message
spanning the tool call: TEXT_MESSAGE_END never fired before TOOL_CALL_START,
and no new TEXT_MESSAGE_START opened afterwards, so the client received one
text message plus a trailing tool call.

These tests assert the wire ordering the reporter asked for.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from ag_ui.core import EventType, RunAgentInput, Tool, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(thread_id: str, stream_events: list) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.session_manager = None

    async def _stream(_msg):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _input(thread_id: str, tools: list[Tool]) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=f"{thread_id}-run",
        messages=[UserMessage(id="u1", role="user", content="weather in SA?")],
        tools=tools,
        context=[],
        state={},
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def _order(events: list) -> list[str]:
    """Wire order of just the events this bug is about."""
    interesting = {
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_END,
    }
    return [e.type.value for e in events if e.type in interesting]


class TestBackendToolTextOrdering:
    """text -> backend tool -> text, all within one run."""

    THREAD = "issue-3030-backend"
    STREAM = [
        {"data": "The weather in SA is "},
        {
            "current_tool_use": {
                "name": "backend_tool",
                "toolUseId": "st-backend",
                "input": {},
            }
        },
        {"event": {"contentBlockStop": {}}},
        {
            "message": {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "st-backend",
                            "content": [{"text": '{"tempC": 21}'}],
                        }
                    }
                ],
            }
        },
        {"data": "currently 21 degrees."},
    ]

    async def test_text_message_end_precedes_tool_call_start(self):
        agent = _build_agent(self.THREAD, self.STREAM)
        events = await _collect(agent, _input(self.THREAD, []))
        order = _order(events)

        assert EventType.TEXT_MESSAGE_END.value in order, (
            f"no TEXT_MESSAGE_END emitted at all; order={order}"
        )
        first_end = order.index(EventType.TEXT_MESSAGE_END.value)
        tool_start = order.index(EventType.TOOL_CALL_START.value)
        assert first_end < tool_start, (
            "assistant text message was not closed before the tool call -- "
            f"this is issue #3030; order={order}"
        )

    async def test_post_tool_text_opens_a_new_message(self):
        agent = _build_agent(self.THREAD, self.STREAM)
        events = await _collect(agent, _input(self.THREAD, []))
        order = _order(events)

        tool_start = order.index(EventType.TOOL_CALL_START.value)
        starts_after = [
            i
            for i, t in enumerate(order)
            if t == EventType.TEXT_MESSAGE_START.value and i > tool_start
        ]
        assert starts_after, (
            "post-tool text did not open a new TEXT_MESSAGE_START, so it "
            f"renders as part of the pre-tool message; order={order}"
        )

        text_starts = [
            e for e in events if e.type == EventType.TEXT_MESSAGE_START
        ]
        ids = [e.message_id for e in text_starts]
        assert len(set(ids)) == len(ids), (
            f"pre- and post-tool text reused the same message_id: {ids}"
        )


class TestFrontendToolTextOrdering:
    """text -> frontend tool. The loop halts for the client to execute the
    tool, so only the pre-text and the tool call appear in this run -- but the
    text must still be closed before TOOL_CALL_START."""

    THREAD = "issue-3030-frontend"
    TOOLS = [Tool(name="get_weather", description="w", parameters={})]
    STREAM = [
        {"data": "Let me check that for you. "},
        {
            "current_tool_use": {
                "name": "get_weather",
                "toolUseId": "st-fe",
                "input": {},
            }
        },
        {"event": {"contentBlockStop": {}}},
    ]

    async def test_text_message_end_precedes_tool_call_start(self):
        agent = _build_agent(self.THREAD, self.STREAM)
        events = await _collect(agent, _input(self.THREAD, self.TOOLS))
        order = _order(events)

        assert EventType.TOOL_CALL_START.value in order, (
            f"frontend tool call never reached the wire; order={order}"
        )
        assert EventType.TEXT_MESSAGE_END.value in order, (
            f"no TEXT_MESSAGE_END emitted at all; order={order}"
        )
        first_end = order.index(EventType.TEXT_MESSAGE_END.value)
        tool_start = order.index(EventType.TOOL_CALL_START.value)
        assert first_end < tool_start, (
            "assistant text message was not closed before the frontend tool "
            f"call -- this is issue #3030; order={order}"
        )
