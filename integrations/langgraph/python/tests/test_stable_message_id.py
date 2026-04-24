"""Tests that a single agent run reuses one TEXT_MESSAGE_ID even when tool
calls interrupt the text stream.

Issue #1317: multiple TEXT_MESSAGE_IDs were generated per agent run when
using LangChain/LangGraph, causing CopilotKit to split one assistant
response into multiple message bubbles.
"""
import pytest
from unittest.mock import MagicMock

from ag_ui.core import EventType
from ag_ui_langgraph.types import LangGraphEventTypes


def _make_agent():
    from ag_ui_langgraph.agent import LangGraphAgent

    mock_graph = MagicMock()
    agent = LangGraphAgent(name="test", graph=mock_graph)
    agent.active_run = {
        "id": "run-1",
        "thread_id": "t1",
        "reasoning_process": None,
        "node_name": "agent",
        "has_function_streaming": False,
        "model_made_tool_call": False,
        "state_reliable": True,
        "streamed_messages": [],
        "manually_emitted_state": None,
        "schema_keys": {
            "input": ["messages", "tools"],
            "output": ["messages", "tools"],
            "config": [],
            "context": [],
        },
    }

    dispatched = []

    def _dispatch(event):
        dispatched.append(event)
        return event

    agent._dispatch_event = _dispatch
    agent.dispatched = dispatched
    return agent


def _make_text_chunk(chunk_id: str, content: str):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": {"emit-messages": True, "emit-tool-calls": True},
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": content,
                "tool_call_chunks": [],
                "response_metadata": {},
            }
        },
    }


def _make_tool_call_start_chunk(chunk_id: str, tool_id: str, tool_name: str):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": {"emit-messages": True, "emit-tool-calls": True},
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": "",
                "tool_call_chunks": [{"id": tool_id, "name": tool_name, "args": ""}],
                "response_metadata": {},
            }
        },
    }


def _make_tool_call_end_chunk(chunk_id: str, tool_id: str):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": {"emit-messages": True, "emit-tool-calls": True},
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": "",
                "tool_call_chunks": [{"id": tool_id, "args": '{"q":"test"}'}],
                "response_metadata": {},
            }
        },
    }


def _make_model_end_event():
    return {
        "event": LangGraphEventTypes.OnChatModelEnd,
        "metadata": {},
        "data": {},
    }


class TestStableMessageId:
    """The same TEXT_MESSAGE_ID must be reused across a text → tool → text
    sequence within a single agent run."""

    @pytest.mark.asyncio
    async def test_text_tool_text_reuses_same_message_id(self):
        agent = _make_agent()

        # 1. First text segment
        async for _ in agent._handle_single_event(_make_text_chunk("msg-abc", "Let me search"), {}):
            pass

        # 2. Tool call begins — text message is ended internally
        async for _ in agent._handle_single_event(
            _make_tool_call_start_chunk("msg-abc", "tc-1", "search"), {}
        ):
            pass

        # 3. On chat model end — tool call event finalized
        async for _ in agent._handle_single_event(_make_model_end_event(), {}):
            pass

        # 4. Second text segment — DIFFERENT chunk.id simulates a new model invocation
        async for _ in agent._handle_single_event(_make_text_chunk("msg-xyz", "The result is 42"), {}):
            pass

        text_starts = [e for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START]
        assert len(text_starts) >= 1, "Expected at least one TEXT_MESSAGE_START"

        first_id = text_starts[0].message_id
        for ev in text_starts:
            assert ev.message_id == first_id, (
                f"Expected all TEXT_MESSAGE_START events to share message_id={first_id!r}, "
                f"but got {ev.message_id!r}"
            )

        content_after_tool = [
            e
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT and e.delta == "The result is 42"
        ]
        assert len(content_after_tool) == 1
        assert content_after_tool[0].message_id == first_id, (
            f"TEXT_MESSAGE_CONTENT after tool call used wrong message_id: "
            f"{content_after_tool[0].message_id!r} != {first_id!r}"
        )
