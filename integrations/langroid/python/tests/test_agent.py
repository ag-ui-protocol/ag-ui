"""Tests for the LangroidAgent adapter."""

import asyncio
import json
import unittest
from unittest.mock import MagicMock

from ag_ui.core import (
    EventType,
    RunAgentInput,
    UserMessage,
    ToolMessage as AgUiToolMessage,
    Tool,
)

from ag_ui_langroid.agent import LangroidAgent
from ag_ui_langroid.types import LangroidAgentConfig, ToolBehavior


def _collect_events(agent, input_data):
    """Helper to collect all events from an async iterator."""
    async def _run():
        events = []
        async for event in agent.run(input_data):
            events.append(event)
        return events
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()


def _make_input(messages=None, thread_id="test-thread", run_id="test-run", state=None, tools=None):
    """Create a RunAgentInput with sensible defaults."""
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=messages or [],
        state=state,
        tools=tools or [],
        context=[],
        forwarded_props={},
    )


def _make_user_message(content="Hello", msg_id="msg-1"):
    """Create a real UserMessage."""
    return UserMessage(id=msg_id, role="user", content=content)


class FakeLLMResponse:
    """A fake LLM response that only has 'content' (no tool attributes)."""
    def __init__(self, content):
        self.content = content


class FakeToolResponse:
    """A fake LLM response that looks like a Langroid ToolMessage."""
    def __init__(self, request, purpose="", **kwargs):
        self.request = request
        self.purpose = purpose
        for k, v in kwargs.items():
            setattr(self, k, v)


class FakeLangroidAgent:
    """A minimal fake Langroid ChatAgent for testing."""
    def __init__(self, response):
        self._response = response
        self.message_history = []

    def llm_response(self, msg):
        return self._response


class TestLangroidAgentInit(unittest.TestCase):
    """Test LangroidAgent initialization."""

    def test_basic_init(self):
        agent = LangroidAgent(agent=FakeLangroidAgent(None), name="test-agent")
        self.assertEqual(agent.name, "test-agent")
        self.assertEqual(agent.description, "")
        self.assertIsNotNone(agent.config)

    def test_init_with_description(self):
        agent = LangroidAgent(
            agent=FakeLangroidAgent(None),
            name="test-agent",
            description="A test agent",
        )
        self.assertEqual(agent.description, "A test agent")

    def test_init_with_config(self):
        config = LangroidAgentConfig(
            tool_behaviors={"tool1": ToolBehavior()},
        )
        agent = LangroidAgent(
            agent=FakeLangroidAgent(None),
            name="test-agent",
            config=config,
        )
        self.assertEqual(agent.config, config)


class TestLangroidAgentExtractUserMessage(unittest.TestCase):
    """Test _extract_user_message method."""

    def setUp(self):
        self.agent = LangroidAgent(agent=FakeLangroidAgent(None), name="test")

    def test_no_messages_returns_default(self):
        result = self.agent._extract_user_message(None)
        self.assertEqual(result, "Hello")

    def test_empty_list_returns_default(self):
        result = self.agent._extract_user_message([])
        self.assertEqual(result, "Hello")

    def test_extracts_latest_user_message(self):
        msg1 = _make_user_message("First message", "m1")
        msg2 = _make_user_message("Second message", "m2")
        result = self.agent._extract_user_message([msg1, msg2])
        self.assertEqual(result, "Second message")

    def test_skips_non_user_messages(self):
        assistant_msg = MagicMock()
        assistant_msg.role = "assistant"
        assistant_msg.content = "I am assistant"

        user_msg = _make_user_message("User says hi")
        result = self.agent._extract_user_message([user_msg, assistant_msg])
        self.assertEqual(result, "User says hi")

    def test_multimodal_content_list(self):
        msg = MagicMock()
        msg.role = "user"
        msg.content = [
            {"text": "Part 1"},
            {"text": "Part 2"},
        ]
        result = self.agent._extract_user_message([msg])
        self.assertEqual(result, "Part 1 Part 2")

    def test_multimodal_content_string_list(self):
        msg = MagicMock()
        msg.role = "user"
        msg.content = ["Hello", "World"]
        result = self.agent._extract_user_message([msg])
        self.assertEqual(result, "Hello World")


class TestLangroidAgentRunLifecycle(unittest.TestCase):
    """Test the run method event lifecycle."""

    def test_emits_run_started_and_finished(self):
        fake = FakeLangroidAgent(FakeLLMResponse("Hello there!"))
        agent = LangroidAgent(agent=fake, name="test")
        input_data = _make_input(messages=[_make_user_message("Hi")])
        events = _collect_events(agent, input_data)

        event_types = [e.type for e in events]
        self.assertEqual(event_types[0], EventType.RUN_STARTED)
        self.assertEqual(event_types[-1], EventType.RUN_FINISHED)

    def test_emits_text_message_events(self):
        fake = FakeLangroidAgent(FakeLLMResponse("Hello there!"))
        agent = LangroidAgent(agent=fake, name="test")
        input_data = _make_input(messages=[_make_user_message("Hi")])
        events = _collect_events(agent, input_data)

        event_types = [e.type for e in events]
        self.assertIn(EventType.TEXT_MESSAGE_START, event_types)
        self.assertIn(EventType.TEXT_MESSAGE_CONTENT, event_types)
        self.assertIn(EventType.TEXT_MESSAGE_END, event_types)

        content_events = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        full_content = "".join(e.delta for e in content_events)
        self.assertEqual(full_content, "Hello there!")

    def test_emits_state_snapshot_from_input_state(self):
        fake = FakeLangroidAgent(FakeLLMResponse("Ok"))
        agent = LangroidAgent(agent=fake, name="test")
        input_data = _make_input(
            messages=[_make_user_message("Hi")],
            state={"count": 5, "items": ["a", "b"]},
        )
        events = _collect_events(agent, input_data)

        snapshot_events = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        self.assertEqual(len(snapshot_events), 1)
        self.assertEqual(snapshot_events[0].snapshot, {"count": 5, "items": ["a", "b"]})

    def test_state_snapshot_excludes_messages_key(self):
        fake = FakeLangroidAgent(FakeLLMResponse("Ok"))
        agent = LangroidAgent(agent=fake, name="test")
        input_data = _make_input(
            messages=[_make_user_message("Hi")],
            state={"count": 5, "messages": ["should be excluded"]},
        )
        events = _collect_events(agent, input_data)

        snapshot_events = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        self.assertEqual(len(snapshot_events), 1)
        self.assertNotIn("messages", snapshot_events[0].snapshot)

    def test_no_state_snapshot_when_state_is_none(self):
        fake = FakeLangroidAgent(FakeLLMResponse("Ok"))
        agent = LangroidAgent(agent=fake, name="test")
        input_data = _make_input(messages=[_make_user_message("Hi")])
        events = _collect_events(agent, input_data)

        snapshot_events = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        self.assertEqual(len(snapshot_events), 0)

    def test_emits_error_when_llm_returns_none(self):
        fake = FakeLangroidAgent(None)
        agent = LangroidAgent(agent=fake, name="test")
        input_data = _make_input(messages=[_make_user_message("Hi")])
        events = _collect_events(agent, input_data)

        event_types = [e.type for e in events]
        self.assertIn(EventType.RUN_STARTED, event_types)
        self.assertIn(EventType.RUN_ERROR, event_types)

    def test_emits_error_when_agent_has_no_llm_response(self):
        class BareAgent:
            pass
        agent = LangroidAgent(agent=BareAgent(), name="test")
        input_data = _make_input(messages=[_make_user_message("Hi")])
        events = _collect_events(agent, input_data)

        event_types = [e.type for e in events]
        self.assertIn(EventType.RUN_STARTED, event_types)
        self.assertIn(EventType.RUN_ERROR, event_types)


class TestLangroidAgentFrontendTools(unittest.TestCase):
    """Test frontend tool call event emission."""

    def test_frontend_tool_emits_tool_events(self):
        tool_response = FakeToolResponse(
            request="change_background",
            purpose="Change the chat background color",
            color="blue",
        )
        fake = FakeLangroidAgent(tool_response)

        tools = [
            Tool(name="change_background", description="Change bg", parameters={}),
        ]

        agent = LangroidAgent(agent=fake, name="test")
        input_data = _make_input(
            messages=[_make_user_message("Change background to blue")],
            tools=tools,
        )
        events = _collect_events(agent, input_data)

        event_types = [e.type for e in events]
        self.assertIn(EventType.TOOL_CALL_START, event_types)
        self.assertIn(EventType.TOOL_CALL_ARGS, event_types)
        self.assertIn(EventType.TOOL_CALL_END, event_types)
        self.assertIn(EventType.RUN_FINISHED, event_types)

        start_event = next(e for e in events if e.type == EventType.TOOL_CALL_START)
        self.assertEqual(start_event.tool_call_name, "change_background")

        args_event = next(e for e in events if e.type == EventType.TOOL_CALL_ARGS)
        args = json.loads(args_event.delta)
        self.assertEqual(args["color"], "blue")


class TestLangroidAgentStateContextBuilder(unittest.TestCase):
    """Test state context builder integration."""

    def test_state_context_builder_is_applied(self):
        class TrackingAgent:
            """Agent that records what message was passed to llm_response."""
            def __init__(self):
                self.message_history = []
                self.last_input = None

            def llm_response(self, msg):
                self.last_input = msg
                return FakeLLMResponse("Got it")

        tracking_agent = TrackingAgent()

        def builder(input_data, msg):
            return f"[STATE: count=5] {msg}"

        config = LangroidAgentConfig(state_context_builder=builder)
        agent = LangroidAgent(agent=tracking_agent, name="test", config=config)
        input_data = _make_input(messages=[_make_user_message("Hi")])
        _collect_events(agent, input_data)

        self.assertIn("[STATE: count=5]", tracking_agent.last_input)


class TestLangroidAgentThreading(unittest.TestCase):
    """Test thread-based agent instance management."""

    def test_same_thread_reuses_agent(self):
        fake = FakeLangroidAgent(FakeLLMResponse("Ok"))
        agent = LangroidAgent(agent=fake, name="test")

        input1 = _make_input(thread_id="thread-1", messages=[_make_user_message("Hi")])
        _collect_events(agent, input1)

        input2 = _make_input(thread_id="thread-1", messages=[_make_user_message("Hello again", "m2")])
        _collect_events(agent, input2)

        self.assertEqual(len(agent._agents_by_thread), 1)
        self.assertIn("thread-1", agent._agents_by_thread)

    def test_different_threads_get_separate_agents(self):
        fake = FakeLangroidAgent(FakeLLMResponse("Ok"))
        agent = LangroidAgent(agent=fake, name="test")

        input1 = _make_input(thread_id="thread-1", messages=[_make_user_message("Hi")])
        _collect_events(agent, input1)

        input2 = _make_input(thread_id="thread-2", messages=[_make_user_message("Hello", "m2")])
        _collect_events(agent, input2)

        self.assertEqual(len(agent._agents_by_thread), 2)


class TestLangroidAgentPendingToolResult(unittest.TestCase):
    """Test handling of pending tool results."""

    def test_tool_result_message_sends_empty_to_llm(self):
        class TrackingAgent:
            def __init__(self):
                self.message_history = []
                self.last_input = None

            def llm_response(self, msg):
                self.last_input = msg
                return FakeLLMResponse("Based on the weather data...")

        tracking_agent = TrackingAgent()
        agent = LangroidAgent(agent=tracking_agent, name="test")

        user_msg = _make_user_message("What's the weather?")
        tool_msg = AgUiToolMessage(
            id="tool-msg-1",
            role="tool",
            content='{"temperature": 72}',
            tool_call_id="tc-123",
        )

        input_data = _make_input(messages=[user_msg, tool_msg])
        _collect_events(agent, input_data)

        self.assertEqual(tracking_agent.last_input, "")


if __name__ == "__main__":
    unittest.main()
