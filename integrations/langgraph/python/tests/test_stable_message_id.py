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


def _fresh_active_run(run_id: str = "run-1") -> dict:
    """Mirror the INITIAL_ACTIVE_RUN shape created by _handle_stream_events."""
    return {
        "id": run_id,
        "thread_id": "t1",
        "reasoning_process": None,
        "node_name": "agent",
        "has_function_streaming": False,
        "model_made_tool_call": False,
        "state_reliable": True,
        "manually_emitted_state": None,
        "schema_keys": {
            "input": ["messages", "tools"],
            "output": ["messages", "tools"],
            "config": [],
            "context": [],
        },
    }


def _make_agent():
    from ag_ui_langgraph.agent import LangGraphAgent

    mock_graph = MagicMock()
    agent = LangGraphAgent(name="test", graph=mock_graph)
    agent.active_run = _fresh_active_run()

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

    @pytest.mark.asyncio
    async def test_multiple_text_tool_cycles_reuse_same_id(self):
        """Three text segments separated by two tool calls within one run all
        share the same message_id. Pins the invariant against any future
        'reset on tool end' change."""
        agent = _make_agent()

        async for _ in agent._handle_single_event(_make_text_chunk("msg-a", "First"), {}):
            pass
        async for _ in agent._handle_single_event(
            _make_tool_call_start_chunk("msg-a", "tc-1", "search"), {}
        ):
            pass
        async for _ in agent._handle_single_event(_make_model_end_event(), {}):
            pass
        async for _ in agent._handle_single_event(_make_text_chunk("msg-b", "Second"), {}):
            pass
        async for _ in agent._handle_single_event(
            _make_tool_call_start_chunk("msg-b", "tc-2", "search"), {}
        ):
            pass
        async for _ in agent._handle_single_event(_make_model_end_event(), {}):
            pass
        async for _ in agent._handle_single_event(_make_text_chunk("msg-c", "Third"), {}):
            pass

        text_starts = [e for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START]
        assert len(text_starts) >= 3, f"Expected 3 TEXT_MESSAGE_START events, got {len(text_starts)}"
        first_id = text_starts[0].message_id
        for ev in text_starts:
            assert ev.message_id == first_id

        deltas_to_id = {
            e.delta: e.message_id
            for e in agent.dispatched
            if e.type == EventType.TEXT_MESSAGE_CONTENT
        }
        assert deltas_to_id == {"First": first_id, "Second": first_id, "Third": first_id}

    @pytest.mark.asyncio
    async def test_new_run_does_not_reuse_prior_runs_message_id(self):
        """current_text_message_id must not bleed across runs. Mimics the
        run-boundary reset that _handle_stream_events performs at the start
        of each run by replacing active_run wholesale."""
        agent = _make_agent()

        # Run 1
        async for _ in agent._handle_single_event(_make_text_chunk("run1-chunk", "Hello"), {}):
            pass
        run1_starts = [e for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START]
        assert len(run1_starts) == 1
        run1_id = run1_starts[0].message_id

        # Run boundary — _handle_stream_events replaces active_run with a fresh dict
        agent.active_run = _fresh_active_run(run_id="run-2")
        agent.dispatched.clear()

        # Run 2 — same chunk_id pattern but a different model invocation
        async for _ in agent._handle_single_event(_make_text_chunk("run2-chunk", "World"), {}):
            pass
        run2_starts = [e for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START]
        assert len(run2_starts) == 1
        run2_id = run2_starts[0].message_id

        assert run2_id != run1_id, (
            f"Run 2 reused run 1's message_id {run1_id!r} — current_text_message_id "
            "must reset between runs"
        )
        assert run2_id == "run2-chunk"

    @pytest.mark.asyncio
    async def test_manually_emitted_message_uses_supplied_id(self):
        """ManuallyEmitMessage carries its own message_id and must not consult
        or mutate current_text_message_id."""
        from ag_ui_langgraph.types import CustomEventNames

        agent = _make_agent()
        agent.active_run["current_text_message_id"] = "stable-stream-id"

        manual_event = {
            "event": LangGraphEventTypes.OnCustomEvent,
            "name": CustomEventNames.ManuallyEmitMessage,
            "metadata": {},
            "data": {"message_id": "user-supplied-id", "message": "Hello"},
        }
        async for _ in agent._handle_single_event(manual_event, {}):
            pass

        text_starts = [e for e in agent.dispatched if e.type == EventType.TEXT_MESSAGE_START]
        assert len(text_starts) == 1
        assert text_starts[0].message_id == "user-supplied-id"
        assert agent.active_run["current_text_message_id"] == "stable-stream-id", (
            "ManuallyEmitMessage must not mutate current_text_message_id"
        )
