"""Tests for message pause/resume bug fixes.

Each fix has a RED test (demonstrates the bug) and a GREEN test (verifies the fix).
Since the fixes are already applied, the RED tests verify the bug *would* have occurred
by testing the underlying conditions, while GREEN tests verify correct behavior.
"""

import unittest
from unittest.mock import MagicMock, patch
from typing import Optional

from ag_ui.core import EventType

from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph.types import MessageInProgress


def _make_agent() -> LangGraphAgent:
    """Create a minimal LangGraphAgent for unit testing."""
    graph = MagicMock()
    graph.config_specs = []
    agent = LangGraphAgent(name="test", graph=graph)
    agent.active_run = {
        "id": "run-1",
        "thread_id": "thread-1",
        "reasoning_process": None,
        "node_name": None,
        "has_function_streaming": False,
        "model_made_tool_call": False,
        "state_reliable": True,
        "stable_message_id": None,
        "paused_text_message_id": None,
    }
    return agent


def _make_chunk(content=None, tool_call_chunks=None, chunk_id="chunk-1", finish_reason=None):
    """Create a mock AIMessageChunk."""
    chunk = MagicMock()
    chunk.id = chunk_id
    chunk.content = content if content is not None else ""
    chunk.tool_call_chunks = tool_call_chunks or []
    chunk.response_metadata = {}
    # Prevent resolve_reasoning_content / resolve_encrypted_reasoning_content
    # from finding spurious reasoning data in mock attributes.
    chunk.additional_kwargs = {}
    if finish_reason:
        chunk.response_metadata["finish_reason"] = finish_reason
    return chunk


def _make_stream_event(chunk, metadata=None):
    """Create a synthetic on_chat_model_stream event."""
    return {
        "event": "on_chat_model_stream",
        "data": {"chunk": chunk},
        "metadata": metadata or {},
        "run_id": "run-1",
    }


def _make_model_end_event(output_msg=None):
    """Create a synthetic on_chat_model_end event."""
    return {
        "event": "on_chat_model_end",
        "data": {"output": output_msg},
        "metadata": {},
        "run_id": "run-1",
    }


async def _collect_events(async_gen):
    """Collect all events from an async generator."""
    events = []
    async for ev in async_gen:
        events.append(ev)
    return events


class TestFix1_SetMessageInProgressNone(unittest.TestCase):
    """Fix 1: set_message_in_progress(None) crashes on **None."""

    def test_red_set_message_in_progress_with_none_crashes(self):
        """Demonstrate that set_message_in_progress(run_id, None) would crash."""
        agent = _make_agent()
        # set_message_in_progress does **data which crashes on None
        with self.assertRaises(TypeError):
            agent.set_message_in_progress("run-1", None)

    def test_green_direct_assignment_clears_safely(self):
        """The fix uses direct assignment instead of set_message_in_progress."""
        agent = _make_agent()
        # Set up a message in progress first
        agent.set_message_in_progress("run-1", MessageInProgress(
            id="msg-1", tool_call_id=None, tool_call_name=None
        ))
        self.assertIsNotNone(agent.get_message_in_progress("run-1"))

        # The fix: direct assignment works with None
        agent.messages_in_process["run-1"] = None
        self.assertIsNone(agent.get_message_in_progress("run-1"))


class TestFix2_ToolCallStartAfterPause(unittest.IsolatedAsyncioTestCase):
    """Fix 2: Tool call start dropped after pause because is_tool_call_start_event
    was pre-computed with has_current_stream=True (so it was False)."""

    async def test_red_tool_call_start_flag_stale_after_pause(self):
        """Show that pre-computed is_tool_call_start_event is False when
        has_current_stream was True at computation time."""
        # This simulates the pre-fix logic
        has_current_stream = True  # Text message was in progress
        tool_call_data = {"name": "search", "id": "tc-1", "args": ""}

        # Pre-fix: flag computed once with has_current_stream=True
        is_tool_call_start_event = not has_current_stream and tool_call_data and tool_call_data.get("name")
        self.assertFalse(is_tool_call_start_event, "Pre-fix: tool call start is incorrectly False")

    async def test_green_tool_call_start_re_derived_after_pause(self):
        """After the pause handler clears message_in_progress, re-derive the flag."""
        agent = _make_agent()

        # Set up: text message in progress
        agent.set_message_in_progress("run-1", MessageInProgress(
            id="msg-1", tool_call_id=None, tool_call_name=None
        ))

        # Create a stream event with a tool call chunk (triggers pause then tool call start)
        tool_call_chunk = MagicMock()
        tool_call_chunk.get = lambda k, d=None: {"name": "search", "id": "tc-1", "args": ""}.get(k, d)
        tool_call_chunk.__getitem__ = lambda self_tc, k: {"name": "search", "id": "tc-1", "args": ""}[k]

        chunk = _make_chunk(
            content="",
            tool_call_chunks=[tool_call_chunk],
        )
        event = _make_stream_event(chunk, metadata={"emit-messages": True, "emit-tool-calls": True})

        events = await _collect_events(agent._handle_single_event(event, {}))

        # After fix: tool call start event should be emitted
        tool_call_starts = [e for e in events if hasattr(e, 'type') and e.type == EventType.TOOL_CALL_START]
        self.assertEqual(len(tool_call_starts), 1, "Tool call start should be emitted after pause")
        self.assertEqual(tool_call_starts[0].tool_call_name, "search")


class TestFix3_PausedMessageOrphanedOnModelEnd(unittest.IsolatedAsyncioTestCase):
    """Fix 3: Paused text message gets no TextMessageEnd when model ends without
    resuming text."""

    async def test_red_no_text_end_for_paused_message_without_fix(self):
        """Demonstrate that without the fix, on_chat_model_end would not emit
        TextMessageEnd for a paused text message."""
        agent = _make_agent()
        agent.active_run["paused_text_message_id"] = "msg-paused"
        # No message_in_progress (was cleared during pause)
        agent.messages_in_process["run-1"] = None

        event = _make_model_end_event(output_msg=None)

        # Simulate the OLD handler logic (no paused_id check):
        # - not isinstance(output_msg, BaseMessage) -> skip streamed_messages append
        # - get_message_in_progress is None -> skip both branches
        # Result: no events emitted, paused_text_message_id left dangling
        old_events = []
        # The old code had no paused_id cleanup, so events list would be empty
        # (the two elif branches both require get_message_in_progress to be truthy)
        mip = agent.get_message_in_progress("run-1")
        self.assertIsNone(mip, "No message in progress after pause")
        # Without fix: paused_text_message_id is still set
        self.assertEqual(agent.active_run["paused_text_message_id"], "msg-paused")

    async def test_green_text_end_emitted_for_paused_on_model_end(self):
        """With the fix, on_chat_model_end emits TextMessageEnd for paused messages."""
        agent = _make_agent()
        agent.active_run["paused_text_message_id"] = "msg-paused"
        agent.messages_in_process["run-1"] = None

        event = _make_model_end_event(output_msg=None)

        events = await _collect_events(agent._handle_single_event(event, {}))

        text_ends = [e for e in events if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_END]
        self.assertEqual(len(text_ends), 1, "Should emit TextMessageEnd for paused message")
        self.assertEqual(text_ends[0].message_id, "msg-paused")
        # paused_text_message_id should be cleared
        self.assertIsNone(agent.active_run["paused_text_message_id"])


class TestFix4_PausedMessageOrphanedOnError(unittest.IsolatedAsyncioTestCase):
    """Fix 4: Stream error while message is paused leaves it orphaned."""

    async def test_red_no_cleanup_on_error_without_fix(self):
        """Without the fix, an exception in the stream leaves paused messages orphaned."""
        agent = _make_agent()
        agent.active_run["paused_text_message_id"] = "msg-paused"

        # The old except handler was just `raise` - no cleanup
        # Verify the paused state exists and would be orphaned
        self.assertEqual(agent.active_run["paused_text_message_id"], "msg-paused")

    async def test_green_cleanup_on_error(self):
        """With the fix, the exception handler emits TextMessageEnd before re-raising."""
        agent = _make_agent()
        agent.active_run["paused_text_message_id"] = "msg-paused"

        # We need to test _handle_stream_events exception handler.
        # Instead of mocking the full stream pipeline, test the cleanup logic directly
        # by simulating what the fixed except block does.

        # The fix checks for paused_text_message_id and emits TextMessageEnd
        paused_id = agent.active_run.get("paused_text_message_id")
        self.assertIsNotNone(paused_id)

        # Simulate the cleanup the fixed except block performs
        event = agent._dispatch_event(
            __import__('ag_ui.core', fromlist=['TextMessageEndEvent']).TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=paused_id,
                raw_event={},
            )
        )
        agent.active_run["paused_text_message_id"] = None

        self.assertEqual(event.type, EventType.TEXT_MESSAGE_END)
        self.assertEqual(event.message_id, "msg-paused")
        self.assertIsNone(agent.active_run["paused_text_message_id"])

    async def test_green_error_handler_in_stream_context(self):
        """Integration test: verify the except block in _handle_stream_events
        yields TextMessageEnd before re-raising when paused_text_message_id is set."""
        from unittest.mock import AsyncMock, patch

        agent = _make_agent()

        # Create a mock input
        mock_input = MagicMock()
        mock_input.thread_id = "thread-1"
        mock_input.run_id = "run-1"
        mock_input.messages = []
        mock_input.state = {}
        mock_input.forwarded_props = {}
        mock_input.copy = MagicMock(return_value=mock_input)

        # Mock prepare_stream to set up paused state and return a failing stream
        async def failing_stream():
            # Set up paused state as if text was paused
            agent.active_run["paused_text_message_id"] = "msg-paused"
            raise RuntimeError("Stream connection lost")
            yield  # make it a generator  # noqa: unreachable

        mock_state = MagicMock()
        mock_state.tasks = []
        mock_state.values = {"messages": []}

        async def mock_prepare_stream(input, agent_state, config):
            return {
                "state": {},
                "stream": failing_stream(),
                "config": {},
            }

        with patch.object(agent, 'prepare_stream', side_effect=mock_prepare_stream):
            with patch.object(agent.graph, 'aget_state', new_callable=AsyncMock, return_value=mock_state):
                events = []
                error_raised = False
                try:
                    async for ev in agent._handle_stream_events(mock_input):
                        events.append(ev)
                except RuntimeError as e:
                    error_raised = True
                    self.assertEqual(str(e), "Stream connection lost")

                self.assertTrue(error_raised, "RuntimeError should propagate")

                # Check that TextMessageEnd was yielded for the paused message
                text_ends = [e for e in events
                             if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_END]
                self.assertEqual(len(text_ends), 1,
                                 "TextMessageEnd should be emitted for paused message on error")
                self.assertEqual(text_ends[0].message_id, "msg-paused")


class TestFix5_DeferredTextMessageEnd(unittest.IsolatedAsyncioTestCase):
    """Fix 5: Empty chunk between text and tool call causes premature TextMessageEnd.

    Some models (DeepSeek, Qwen) send an empty chunk (no content, no tool_call_chunks)
    between text output and tool call initiation. Previously this triggered
    isMessageEndEvent and emitted TextMessageEnd prematurely. Now we defer
    TextMessageEnd to on_chat_model_end.
    """

    async def test_red_empty_chunk_causes_premature_end(self):
        """Demonstrate that an empty chunk between text and tool call
        would have caused premature TextMessageEnd under the old logic."""
        # Under the old logic, isMessageEndEvent fires when:
        # - has_current_stream = True (text in progress)
        # - tool_call_data is None (no tool call chunks)
        # - is_message_content_event = False (empty content)
        has_current_stream = True
        tool_call_data = None
        is_message_content_event = False

        # Old isMessageEndEvent computation (before adding toolCallData check):
        old_is_message_end_event = (
            has_current_stream
            and not is_message_content_event
            and tool_call_data is None
        )
        self.assertTrue(old_is_message_end_event,
                        "Old logic would trigger TextMessageEnd on empty chunk")

    async def test_green_empty_chunk_does_not_emit_text_end(self):
        """With the fix, an empty chunk while text is in progress does not
        emit a premature TextMessageEnd. Under the current empty-delta
        handling on main (resolve_message_content preserves ""), the empty
        delta is swallowed as a legitimate content chunk and the message
        remains in progress — TextMessageEnd is deferred to on_chat_model_end
        or to a subsequent tool-call chunk (which triggers the pause path)."""
        agent = _make_agent()

        # Set up: text message in progress
        agent.set_message_in_progress("run-1", MessageInProgress(
            id="msg-1", tool_call_id=None, tool_call_name=None
        ))

        # Empty chunk — no content, no tool calls
        chunk = _make_chunk(content="", tool_call_chunks=[], chunk_id="msg-1")
        event = _make_stream_event(chunk, metadata={"emit-messages": True})

        events = await _collect_events(agent._handle_single_event(event, {}))

        # No TextMessageEnd should be emitted
        text_ends = [e for e in events if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_END]
        self.assertEqual(len(text_ends), 0,
                         "Empty chunk should not emit premature TextMessageEnd")

        # messagesInProcess should still be tracking the open text message —
        # the empty delta is valid content, not an end-of-message signal.
        self.assertIsNotNone(agent.get_message_in_progress("run-1"))
        self.assertEqual(agent.get_message_in_progress("run-1")["id"], "msg-1")

    async def test_green_empty_chunk_then_tool_then_text_then_model_end(self):
        """Full sequence: text -> empty chunk -> tool call -> text resume -> model end.
        TextMessageEnd fires exactly once at the end."""
        agent = _make_agent()

        # 1. Text content arrives
        chunk1 = _make_chunk(content="Let me search", chunk_id="msg-1")
        event1 = _make_stream_event(chunk1, metadata={"emit-messages": True, "emit-tool-calls": True})
        events = await _collect_events(agent._handle_single_event(event1, {}))

        text_starts = [e for e in events if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_START]
        self.assertEqual(len(text_starts), 1)

        # 2. Empty chunk (gap between text and tool call)
        chunk2 = _make_chunk(content="", tool_call_chunks=[], chunk_id="msg-1")
        event2 = _make_stream_event(chunk2, metadata={"emit-messages": True, "emit-tool-calls": True})
        events2 = await _collect_events(agent._handle_single_event(event2, {}))

        # No TextMessageEnd yet
        text_ends = [e for e in events2 if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_END]
        self.assertEqual(len(text_ends), 0, "No premature TextMessageEnd after empty chunk")

        # 3. Tool call arrives
        tc_chunk = MagicMock()
        tc_chunk.get = lambda k, d=None: {"name": "search", "id": "tc-1", "args": ""}.get(k, d)
        tc_chunk.__getitem__ = lambda self_tc, k: {"name": "search", "id": "tc-1", "args": ""}[k]
        chunk3 = _make_chunk(content="", tool_call_chunks=[tc_chunk], chunk_id="msg-1")
        event3 = _make_stream_event(chunk3, metadata={"emit-messages": True, "emit-tool-calls": True})
        events3 = await _collect_events(agent._handle_single_event(event3, {}))

        tool_starts = [e for e in events3 if hasattr(e, 'type') and e.type == EventType.TOOL_CALL_START]
        self.assertEqual(len(tool_starts), 1)

        # 4. Tool call ends
        chunk4 = _make_chunk(content="", tool_call_chunks=[], chunk_id="msg-1")
        # Simulate tool call in progress
        agent.set_message_in_progress("run-1", MessageInProgress(
            id="msg-1", tool_call_id="tc-1", tool_call_name="search"
        ))
        event4 = _make_stream_event(chunk4, metadata={"emit-messages": True, "emit-tool-calls": True})
        events4 = await _collect_events(agent._handle_single_event(event4, {}))

        tool_ends = [e for e in events4 if hasattr(e, 'type') and e.type == EventType.TOOL_CALL_END]
        self.assertEqual(len(tool_ends), 1)

        # 5. Text resumes
        chunk5 = _make_chunk(content="Here are results", chunk_id="msg-1")
        event5 = _make_stream_event(chunk5, metadata={"emit-messages": True, "emit-tool-calls": True})
        events5 = await _collect_events(agent._handle_single_event(event5, {}))

        # Should NOT have a new TextMessageStart (resumed, not new)
        new_starts = [e for e in events5 if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_START]
        self.assertEqual(len(new_starts), 0, "Resumed text should not emit new TextMessageStart")

        # 6. Model ends
        event6 = _make_model_end_event(output_msg=None)
        events6 = await _collect_events(agent._handle_single_event(event6, {}))

        # Now TextMessageEnd should fire
        all_text_ends = [e for e in events6 if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_END]
        self.assertEqual(len(all_text_ends), 1, "TextMessageEnd should fire on model end")
        self.assertEqual(all_text_ends[0].message_id, "msg-1")

    async def test_green_text_then_model_end_no_empty_chunk(self):
        """Text content followed directly by model end (no empty chunk) still works."""
        agent = _make_agent()

        # 1. Text content
        chunk = _make_chunk(content="Hello world", chunk_id="msg-1")
        event = _make_stream_event(chunk, metadata={"emit-messages": True})
        await _collect_events(agent._handle_single_event(event, {}))

        # 2. Model ends (text still in messagesInProcess)
        event2 = _make_model_end_event(output_msg=None)
        events2 = await _collect_events(agent._handle_single_event(event2, {}))

        text_ends = [e for e in events2 if hasattr(e, 'type') and e.type == EventType.TEXT_MESSAGE_END]
        self.assertEqual(len(text_ends), 1)
        self.assertEqual(text_ends[0].message_id, "msg-1")


if __name__ == "__main__":
    unittest.main()
