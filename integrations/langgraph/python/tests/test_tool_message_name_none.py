"""
Tests for handling ToolMessage with name=None in Command outputs.

Regression test for GitHub issue #1120:
ToolCallStartEvent crashes with ValidationError when tool returns Command
with ToolMessage missing `name` field.
"""

import asyncio
import unittest

from ag_ui.core import (
    EventType,
    ToolCallStartEvent,
)

from langchain_core.messages import ToolMessage
from langgraph.types import Command

from ag_ui_langgraph.agent import LangGraphAgent


def _collect_events(async_gen):
    """Run an async generator synchronously and collect all results."""
    loop = asyncio.new_event_loop()
    try:
        results = []
        async def _drain():
            async for item in async_gen:
                results.append(item)
        loop.run_until_complete(_drain())
        return results
    finally:
        loop.close()


def _make_on_tool_end_event(output, tool_name="my_tool"):
    """Construct a minimal OnToolEnd event dict."""
    return {
        "event": "on_tool_end",
        "name": tool_name,
        "data": {
            "output": output,
            "input": {"arg1": "value1"},
        },
        "metadata": {},
        "tags": [],
        "run_id": "test-run-id",
    }


def _make_agent():
    """Create a minimal LangGraphAgent for testing _handle_single_event."""
    agent = object.__new__(LangGraphAgent)
    agent.active_run = {
        "has_function_streaming": False,
        "manually_emitted_state": None,
        "node_name": None,
        "reasoning_process": None,
    }
    agent.messages_in_process = {}
    agent.emit_intermediate_state = False
    return agent


class TestToolMessageNameNone(unittest.TestCase):
    """Test that ToolMessage with name=None does not crash event handling."""

    def test_tool_message_name_none_in_command(self):
        """ToolMessage with name=None should not raise ValidationError.

        When a LangGraph tool returns a Command containing ToolMessage objects
        where name is not set (defaults to None), the agent should fall back
        to the tool name from the event metadata instead of crashing.
        """
        tool_msg = ToolMessage(
            content="Done.",
            tool_call_id="call-123",
            # name is intentionally NOT set - defaults to None
        )
        self.assertIsNone(tool_msg.name)

        command = Command(update={"messages": [tool_msg]})
        event = _make_on_tool_end_event(command, tool_name="my_tool")

        agent = _make_agent()
        state = {}

        # This should NOT raise a ValidationError
        events = _collect_events(agent._handle_single_event(event, state))

        # Find the ToolCallStartEvent
        start_events = [
            e for e in events
            if isinstance(e, ToolCallStartEvent)
        ]
        self.assertEqual(len(start_events), 1)
        # The tool_call_name should fall back to event["name"]
        self.assertEqual(start_events[0].tool_call_name, "my_tool")

    def test_tool_message_with_name_set(self):
        """ToolMessage with name explicitly set should use that name."""
        tool_msg = ToolMessage(
            content="Done.",
            tool_call_id="call-456",
            name="explicit_tool_name",
        )

        command = Command(update={"messages": [tool_msg]})
        event = _make_on_tool_end_event(command, tool_name="my_tool")

        agent = _make_agent()
        state = {}

        events = _collect_events(agent._handle_single_event(event, state))

        start_events = [
            e for e in events
            if isinstance(e, ToolCallStartEvent)
        ]
        self.assertEqual(len(start_events), 1)
        # Should use the explicit name, not the fallback
        self.assertEqual(start_events[0].tool_call_name, "explicit_tool_name")


    def test_tool_message_name_none_and_event_name_missing(self):
        """When both tool_msg.name and event['name'] are missing, should fall back to empty string.

        This covers the edge case where the event metadata also lacks a 'name' key,
        hitting the final '' fallback in: tool_msg.name or event.get('name', '')
        """
        tool_msg = ToolMessage(
            content="Done.",
            tool_call_id="call-789",
            # name is intentionally NOT set - defaults to None
        )
        self.assertIsNone(tool_msg.name)

        command = Command(update={"messages": [tool_msg]})
        # Create event WITHOUT a 'name' key
        event = {
            "event": "on_tool_end",
            "data": {
                "output": command,
                "input": {"arg1": "value1"},
            },
            "metadata": {},
            "tags": [],
            "run_id": "test-run-id",
        }

        agent = _make_agent()
        state = {}

        # This should NOT crash - should fall back to empty string
        events = _collect_events(agent._handle_single_event(event, state))

        start_events = [
            e for e in events
            if isinstance(e, ToolCallStartEvent)
        ]
        self.assertEqual(len(start_events), 1)
        # Should fall back to empty string
        self.assertEqual(start_events[0].tool_call_name, "")


if __name__ == "__main__":
    unittest.main()
