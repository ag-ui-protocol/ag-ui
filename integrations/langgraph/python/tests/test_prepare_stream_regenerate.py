"""
Tests for prepare_stream regenerate detection fix.

Verifies that prepare_stream correctly distinguishes between:
1. Regenerate request: user wants to redo a response (message ID exists in checkpoint)
2. Thread continuation: user sends a new message on existing thread (new message ID)

See: https://github.com/ag-ui-protocol/ag-ui/issues/706
"""

import unittest
from unittest.mock import AsyncMock, MagicMock, patch
import asyncio

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from ag_ui.core import UserMessage, AssistantMessage

from ag_ui_langgraph.agent import LangGraphAgent


def run_async(coro):
    """Helper to run async functions in sync tests."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class TestPrepareStreamRegenerateDetection(unittest.TestCase):
    """Test that prepare_stream correctly identifies regenerate vs continuation."""

    def _make_agent(self):
        """Create a LangGraphAgent with a mocked graph."""
        graph = MagicMock()
        graph.get_input_jsonschema.return_value = {"properties": {"messages": {}}}
        graph.get_output_jsonschema.return_value = {"properties": {"messages": {}}}
        graph.astream_events = MagicMock(return_value=AsyncMock())
        graph.aupdate_state = AsyncMock()
        agent = LangGraphAgent(name="test", graph=graph)
        agent.active_run = {
            "id": "run-1",
            "thread_id": "thread-1",
            "thinking_process": None,
            "node_name": None,
            "has_function_streaming": False,
            "mode": "start",
            "manually_emitted_state": None,
        }
        return agent

    def _make_agent_state(self, messages):
        """Create a mock agent_state with given messages."""
        state = MagicMock()
        state.values = {"messages": messages}
        state.tasks = []
        return state

    def _make_config(self):
        return {"configurable": {"thread_id": "thread-1"}}

    def _make_input(self, messages):
        """Create a mock RunAgentInput."""
        input_mock = MagicMock()
        input_mock.state = {}
        input_mock.messages = messages
        input_mock.forwarded_props = {}
        input_mock.tools = []
        input_mock.thread_id = "thread-1"
        input_mock.context = []
        input_mock.run_id = "run-1"
        return input_mock

    def test_new_message_on_existing_thread_does_not_regenerate(self):
        """A new message on an existing thread should NOT trigger regenerate.

        Scenario: Checkpoint has 4 messages, frontend sends 1 new message
        with a client-generated ID that doesn't exist in checkpoint.
        This is the core bug from Issue #706.
        """
        agent = self._make_agent()

        # Checkpoint has existing conversation
        checkpoint_messages = [
            HumanMessage(content="Hello", id="msg-1"),
            AIMessage(content="Hi there!", id="msg-2"),
            HumanMessage(content="How are you?", id="msg-3"),
            AIMessage(content="I'm good!", id="msg-4"),
        ]

        # Frontend sends a NEW message (new client-generated ID)
        frontend_messages = [
            UserMessage(id="msg-5-new", role="user", content="What's the weather?"),
        ]

        agent_state = self._make_agent_state(checkpoint_messages)
        config = self._make_config()
        input_data = self._make_input(frontend_messages)

        # Mock prepare_regenerate_stream to track if it's called
        agent.prepare_regenerate_stream = AsyncMock()

        result = run_async(agent.prepare_stream(input_data, agent_state, config))

        # prepare_regenerate_stream should NOT be called
        agent.prepare_regenerate_stream.assert_not_called()

    def test_internal_messages_do_not_trigger_regenerate(self):
        """Internal ToolMessages/named HumanMessages should not inflate count.

        Scenario: Graph injects internal messages (ToolMessages, reflection
        checkpoints) that make checkpoint count > frontend count, but the
        user is sending a new message, not requesting regeneration.
        """
        agent = self._make_agent()

        # Checkpoint has conversation + internal messages
        checkpoint_messages = [
            HumanMessage(content="Search for silver prices", id="msg-1"),
            AIMessage(content="", id="msg-2"),  # tool call
            ToolMessage(content="Silver is $80", tool_call_id="call-1", id="tool-1"),
            HumanMessage(content="reflect checkpoint", id="reflect-1", name="system_reflect"),
            AIMessage(content="Silver is $80/oz today.", id="msg-3"),
        ]

        # Frontend sends all visible messages + a new one
        frontend_messages = [
            UserMessage(id="msg-1", role="user", content="Search for silver prices"),
            AssistantMessage(id="msg-3", role="assistant", content="Silver is $80/oz today."),
            UserMessage(id="msg-6-new", role="user", content="What about gold?"),
        ]

        agent_state = self._make_agent_state(checkpoint_messages)
        config = self._make_config()
        input_data = self._make_input(frontend_messages)

        agent.prepare_regenerate_stream = AsyncMock()

        result = run_async(agent.prepare_stream(input_data, agent_state, config))

        # Should NOT regenerate - the new message ID doesn't exist in checkpoint
        agent.prepare_regenerate_stream.assert_not_called()

    def test_actual_regenerate_still_works(self):
        """A real regenerate request should still trigger regeneration.

        Scenario: Checkpoint has messages A and B. Frontend sends only A
        (requesting to regenerate B). A's ID exists in checkpoint.
        """
        agent = self._make_agent()

        # Checkpoint has 2 messages
        checkpoint_messages = [
            HumanMessage(content="Hello", id="msg-1"),
            AIMessage(content="Hi!", id="msg-2"),
        ]

        # Frontend sends only the first message (regenerate the response)
        frontend_messages = [
            UserMessage(id="msg-1", role="user", content="Hello"),
        ]

        agent_state = self._make_agent_state(checkpoint_messages)
        config = self._make_config()
        input_data = self._make_input(frontend_messages)

        agent.prepare_regenerate_stream = AsyncMock(return_value={
            "stream": MagicMock(),
            "state": {},
            "config": config,
        })

        result = run_async(agent.prepare_stream(input_data, agent_state, config))

        # prepare_regenerate_stream SHOULD be called for a real regenerate
        agent.prepare_regenerate_stream.assert_called_once()


if __name__ == "__main__":
    unittest.main()
