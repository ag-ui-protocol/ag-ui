"""A failed tool closes streams opened by models running inside that tool."""

import unittest
from unittest.mock import MagicMock

from ag_ui.core import EventType

from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui_langgraph.types import LangGraphEventTypes

FAILED_TOOL_RUN_ID = "failed-tool-run"


def _make_agent() -> LangGraphAgent:
    agent = LangGraphAgent(name="test", graph=MagicMock())
    agent.active_run = {
        "id": "run-1",
        "reasoning_processes": {},
        "pending_reasoning_ids": {},
        "current_text_message_ids": {},
        "current_text_message_nodes": {},
        "streamed_tool_call_ids": set(),
        "failed_tool_calls": {},
        "node_name": "agent",
        "has_function_streaming": False,
        "model_made_tool_call": False,
        "state_reliable": True,
    }
    agent.dispatched = []

    def _dispatch(event):
        agent.dispatched.append(event)
        return event

    agent._dispatch_event = _dispatch
    return agent


def _model_chunk(
    *,
    chunk_id: str,
    content="",
    tool_call_chunks=None,
    parent_ids=None,
    node="tools",
):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "run_id": f"model-{chunk_id}",
        "parent_ids": list(parent_ids or []),
        "metadata": {
            "emit-messages": True,
            "emit-tool-calls": True,
            "langgraph_node": node,
        },
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": content,
                "tool_call_chunks": list(tool_call_chunks or []),
                "response_metadata": {},
            }
        },
    }


def _tool_error(run_id=FAILED_TOOL_RUN_ID):
    return {
        "event": LangGraphEventTypes.OnToolError,
        "run_id": run_id,
        "parent_ids": ["tools-node-run"],
        "name": "ask_helper",
        "data": {"error": RuntimeError("stream cut")},
    }


async def _feed(agent: LangGraphAgent, *events) -> None:
    for event in events:
        async for _ in agent._handle_single_event(event, {}):
            pass


def _types(agent: LangGraphAgent):
    return [event.type for event in agent.dispatched]


class TestFailedToolStreamCleanup(unittest.IsolatedAsyncioTestCase):
    async def test_closes_text_stream_opened_inside_failed_tool(self):
        agent = _make_agent()

        await _feed(
            agent,
            _model_chunk(
                chunk_id="helper-message",
                content="partial helper answer",
                parent_ids=["tools-node-run", FAILED_TOOL_RUN_ID],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="agent-message",
                content="parent answer",
                parent_ids=["agent-node-run"],
                node="agent",
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
            ],
        )
        text_events = [
            event
            for event in agent.dispatched
            if event.type
            in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]
        self.assertEqual(
            [event.message_id for event in text_events],
            [
                "helper-message",
                "helper-message",
                "helper-message",
                "agent-message",
                "agent-message",
            ],
        )

    async def test_closes_tool_call_stream_opened_inside_failed_tool(self):
        agent = _make_agent()

        await _feed(
            agent,
            _model_chunk(
                chunk_id="helper-message",
                tool_call_chunks=[
                    {
                        "id": "helper-call",
                        "name": "read_file",
                        "args": '{"path": "/sh',
                    }
                ],
                parent_ids=["tools-node-run", FAILED_TOOL_RUN_ID],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="agent-message",
                content="first parent chunk",
                parent_ids=["agent-node-run"],
                node="agent",
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_END,
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
            ],
        )
        self.assertEqual(agent.dispatched[1].tool_call_id, "helper-call")
        self.assertEqual(agent.dispatched[-1].delta, "first parent chunk")

    async def test_closes_reasoning_stream_opened_inside_failed_tool(self):
        agent = _make_agent()
        reasoning = [
            {
                "type": "reasoning_content",
                "reasoning_content": {"text": "helper thinks"},
                "index": 0,
            }
        ]

        await _feed(
            agent,
            _model_chunk(
                chunk_id="helper-reasoning",
                content=reasoning,
                parent_ids=["tools-node-run", FAILED_TOOL_RUN_ID],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="agent-reasoning",
                content=[
                    {
                        "type": "reasoning_content",
                        "reasoning_content": {"text": "agent thinks"},
                        "index": 0,
                    }
                ],
                parent_ids=["agent-node-run"],
                node="agent",
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.REASONING_START,
                EventType.REASONING_MESSAGE_START,
                EventType.REASONING_MESSAGE_CONTENT,
                EventType.REASONING_MESSAGE_END,
                EventType.REASONING_END,
                EventType.REASONING_START,
                EventType.REASONING_MESSAGE_START,
                EventType.REASONING_MESSAGE_CONTENT,
            ],
        )
        starts = [
            event.message_id
            for event in agent.dispatched
            if event.type == EventType.REASONING_START
        ]
        self.assertEqual(len(starts), 2)
        self.assertNotEqual(starts[0], starts[1])

    async def test_does_not_close_stream_from_unrelated_model(self):
        agent = _make_agent()

        await _feed(
            agent,
            _model_chunk(
                chunk_id="unrelated-message",
                content="before error",
                parent_ids=["other-tool-run"],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="unrelated-message",
                content=" after error",
                parent_ids=["other-tool-run"],
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_CONTENT,
            ],
        )
        self.assertEqual(
            "".join(
                event.delta
                for event in agent.dispatched
                if event.type == EventType.TEXT_MESSAGE_CONTENT
            ),
            "before error after error",
        )
