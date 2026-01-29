"""Integration tests for OpenAI provider."""

import os
import pytest

from ag_ui.core import (
    EventType,
    RunAgentInput,
    UserMessage,
    Tool,
)

from ag_ui_openresponses import (
    OpenResponsesAgent,
    OpenResponsesAgentConfig,
    ProviderType,
)


# Skip all tests if OPENAI_API_KEY is not set
pytestmark = pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY"),
    reason="OPENAI_API_KEY environment variable not set",
)


@pytest.fixture
def openai_agent() -> OpenResponsesAgent:
    """Create an OpenAI agent for testing."""
    return OpenResponsesAgent(
        OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            api_key=os.environ.get("OPENAI_API_KEY", ""),
            default_model="gpt-4o-mini",  # Use mini for faster/cheaper tests
        )
    )


@pytest.fixture
def simple_input() -> RunAgentInput:
    """Create a simple input for testing."""
    return RunAgentInput(
        thread_id="test-thread-1",
        run_id="test-run-1",
        messages=[
            UserMessage(
                id="msg-1",
                role="user",
                content="Say 'Hello, AG-UI!' and nothing else.",
            )
        ],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )


class TestOpenAIBasicStreaming:
    """Tests for basic text streaming with OpenAI."""

    @pytest.mark.asyncio
    async def test_simple_text_response(
        self, openai_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should stream a simple text response."""
        events = []
        async for event in openai_agent.run(simple_input):
            events.append(event)

        # Verify event sequence
        event_types = [e.type for e in events]

        # Must start with RUN_STARTED
        assert event_types[0] == EventType.RUN_STARTED

        # Must have TEXT_MESSAGE_START
        assert EventType.TEXT_MESSAGE_START in event_types

        # Must have at least one TEXT_MESSAGE_CONTENT
        assert EventType.TEXT_MESSAGE_CONTENT in event_types

        # Must have TEXT_MESSAGE_END
        assert EventType.TEXT_MESSAGE_END in event_types

        # Must end with STATE_SNAPSHOT and RUN_FINISHED
        assert event_types[-2] == EventType.STATE_SNAPSHOT
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_run_started_event(
        self, openai_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should emit RUN_STARTED with correct thread_id and run_id."""
        events = []
        async for event in openai_agent.run(simple_input):
            events.append(event)
            if event.type == EventType.RUN_STARTED:
                break

        run_started = events[0]
        assert run_started.type == EventType.RUN_STARTED
        assert run_started.thread_id == "test-thread-1"
        assert run_started.run_id == "test-run-1"

    @pytest.mark.asyncio
    async def test_text_message_content(
        self, openai_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should stream text content with consistent message_id."""
        events = []
        async for event in openai_agent.run(simple_input):
            events.append(event)

        # Get message events
        text_start = next(e for e in events if e.type == EventType.TEXT_MESSAGE_START)
        text_contents = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)

        # All should have same message_id
        message_id = text_start.message_id
        assert message_id is not None
        assert all(e.message_id == message_id for e in text_contents)
        assert text_end.message_id == message_id

        # Content should be non-empty
        full_content = "".join(e.delta for e in text_contents)
        assert len(full_content) > 0
        assert "hello" in full_content.lower()

    @pytest.mark.asyncio
    async def test_state_snapshot_with_response_id(
        self, openai_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should emit STATE_SNAPSHOT with response_id for stateful mode."""
        events = []
        async for event in openai_agent.run(simple_input):
            events.append(event)

        # Find STATE_SNAPSHOT
        state_snapshot = next(
            (e for e in events if e.type == EventType.STATE_SNAPSHOT), None
        )
        assert state_snapshot is not None

        # Should have openresponses_state with response_id
        snapshot = state_snapshot.snapshot
        assert "openresponses_state" in snapshot
        assert "response_id" in snapshot["openresponses_state"]
        assert snapshot["openresponses_state"]["response_id"].startswith("resp_")


class TestOpenAIToolCalls:
    """Tests for tool call handling with OpenAI."""

    @pytest.fixture
    def tool_input(self) -> RunAgentInput:
        """Create input with a tool definition."""
        return RunAgentInput(
            thread_id="test-thread-2",
            run_id="test-run-2",
            messages=[
                UserMessage(
                    id="msg-1",
                    role="user",
                    content="What is the weather in San Francisco? Use the get_weather tool.",
                )
            ],
            tools=[
                Tool(
                    name="get_weather",
                    description="Get the current weather for a location",
                    parameters={
                        "type": "object",
                        "properties": {
                            "location": {
                                "type": "string",
                                "description": "The city name",
                            }
                        },
                        "required": ["location"],
                    },
                )
            ],
            context=[],
            state={},
            forwarded_props={},
        )

    @pytest.mark.asyncio
    async def test_tool_call_events(
        self, openai_agent: OpenResponsesAgent, tool_input: RunAgentInput
    ):
        """Should emit proper tool call events."""
        events = []
        async for event in openai_agent.run(tool_input):
            events.append(event)

        event_types = [e.type for e in events]

        # Should have tool call events
        assert EventType.TOOL_CALL_START in event_types
        assert EventType.TOOL_CALL_ARGS in event_types
        assert EventType.TOOL_CALL_END in event_types

    @pytest.mark.asyncio
    async def test_tool_call_structure(
        self, openai_agent: OpenResponsesAgent, tool_input: RunAgentInput
    ):
        """Should emit tool call with correct structure."""
        events = []
        async for event in openai_agent.run(tool_input):
            events.append(event)

        # Get tool call events
        tool_start = next(
            (e for e in events if e.type == EventType.TOOL_CALL_START), None
        )
        tool_args = [e for e in events if e.type == EventType.TOOL_CALL_ARGS]
        tool_end = next(
            (e for e in events if e.type == EventType.TOOL_CALL_END), None
        )

        assert tool_start is not None
        assert tool_end is not None

        # Tool call should have name and id
        assert tool_start.tool_call_name == "get_weather"
        assert tool_start.tool_call_id is not None

        # All events should have consistent tool_call_id
        tool_call_id = tool_start.tool_call_id
        assert all(e.tool_call_id == tool_call_id for e in tool_args)
        assert tool_end.tool_call_id == tool_call_id

        # Arguments should be valid JSON containing location
        full_args = "".join(e.delta for e in tool_args)
        assert "location" in full_args.lower() or "san" in full_args.lower()


class TestOpenAIStatefulMode:
    """Tests for stateful conversation mode."""

    @pytest.mark.asyncio
    async def test_stateful_continuation(self, openai_agent: OpenResponsesAgent):
        """Should support stateful conversation via response_id."""
        # First request
        input1 = RunAgentInput(
            thread_id="stateful-thread",
            run_id="run-1",
            messages=[
                UserMessage(
                    id="msg-1",
                    role="user",
                    content="My favorite color is blue. Remember this.",
                )
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        events1 = []
        async for event in openai_agent.run(input1):
            events1.append(event)

        # Get response_id from state snapshot
        state_snapshot = next(
            (e for e in events1 if e.type == EventType.STATE_SNAPSHOT), None
        )
        assert state_snapshot is not None
        response_id = state_snapshot.snapshot["openresponses_state"]["response_id"]

        # Second request with state containing response_id
        input2 = RunAgentInput(
            thread_id="stateful-thread",
            run_id="run-2",
            messages=[
                UserMessage(
                    id="msg-2",
                    role="user",
                    content="What is my favorite color?",
                )
            ],
            tools=[],
            context=[],
            state={"openresponses_state": {"response_id": response_id}},
            forwarded_props={},
        )

        events2 = []
        async for event in openai_agent.run(input2):
            events2.append(event)

        # Get the response text
        text_contents = [e for e in events2 if e.type == EventType.TEXT_MESSAGE_CONTENT]
        full_response = "".join(e.delta for e in text_contents)

        # Should remember the color
        assert "blue" in full_response.lower()


class TestOpenAIErrorHandling:
    """Tests for error handling."""

    @pytest.mark.asyncio
    async def test_invalid_api_key(self):
        """Should emit RUN_ERROR for invalid API key."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key="invalid-key",
                default_model="gpt-4o-mini",
            )
        )

        input_data = RunAgentInput(
            thread_id="error-thread",
            run_id="error-run",
            messages=[
                UserMessage(id="msg-1", role="user", content="Hello")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]

        # Should have RUN_STARTED then RUN_ERROR
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_ERROR in event_types

        # Should NOT have RUN_FINISHED
        assert EventType.RUN_FINISHED not in event_types
