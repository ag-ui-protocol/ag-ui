"""Integration tests for custom/generic OpenResponses-compatible endpoints."""

import os
import pytest

from ag_ui.core import (
    EventType,
    RunAgentInput,
    UserMessage,
)

from ag_ui_openresponses import (
    OpenResponsesAgent,
    OpenResponsesAgentConfig,
)


# Run if CUSTOM_ENDPOINT is set, or fall back to OpenAI as a "custom" endpoint
_has_custom = bool(os.environ.get("CUSTOM_ENDPOINT"))
_has_openai = bool(os.environ.get("OPENAI_API_KEY"))

pytestmark = pytest.mark.skipif(
    not _has_custom and not _has_openai,
    reason="Neither CUSTOM_ENDPOINT nor OPENAI_API_KEY environment variable is set",
)


@pytest.fixture
def custom_agent() -> OpenResponsesAgent:
    """Create an agent for a custom endpoint, falling back to OpenAI."""
    if _has_custom:
        # Prefer explicit custom endpoint if provided
        base_url = os.environ["CUSTOM_ENDPOINT"]
        api_key = os.environ.get("CUSTOM_API_KEY", "")
        model = os.environ.get("CUSTOM_MODEL", "default")
    elif _has_openai:
        # Fall back to OpenAI as a generic custom endpoint
        base_url = "https://api.openai.com/v1"
        api_key = os.environ["OPENAI_API_KEY"]
        model = "gpt-4o-mini"

    return OpenResponsesAgent(
        OpenResponsesAgentConfig(
            base_url=base_url,
            api_key=api_key,
            default_model=model,
        )
    )


@pytest.fixture
def simple_input() -> RunAgentInput:
    """Create a simple input for testing."""
    return RunAgentInput(
        thread_id="custom-test-thread-1",
        run_id="custom-test-run-1",
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


class TestCustomBasicStreaming:
    """Tests for basic text streaming with a custom endpoint."""

    @pytest.mark.asyncio
    async def test_simple_text_response(
        self, custom_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should stream a simple text response."""
        events = []
        async for event in custom_agent.run(simple_input):
            events.append(event)

        event_types = [e.type for e in events]

        assert event_types[0] == EventType.RUN_STARTED
        assert EventType.TEXT_MESSAGE_START in event_types
        assert EventType.TEXT_MESSAGE_CONTENT in event_types
        assert EventType.TEXT_MESSAGE_END in event_types
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_text_message_content(
        self, custom_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should stream text content with consistent message_id."""
        events = []
        async for event in custom_agent.run(simple_input):
            events.append(event)

        text_start = next(e for e in events if e.type == EventType.TEXT_MESSAGE_START)
        text_contents = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)

        message_id = text_start.message_id
        assert message_id is not None
        assert all(e.message_id == message_id for e in text_contents)
        assert text_end.message_id == message_id

        full_content = "".join(e.delta for e in text_contents)
        assert len(full_content) > 0


class TestCustomErrorHandling:
    """Tests for error handling with a custom endpoint."""

    @pytest.mark.asyncio
    async def test_unreachable_endpoint(self):
        """Should emit RUN_ERROR for unreachable endpoint."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="http://localhost:19999",
                api_key="",
                default_model="default",
                max_retries=0,
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
        with pytest.raises(Exception):
            async for event in agent.run(input_data):
                events.append(event)

        event_types = [e.type for e in events]

        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_ERROR in event_types
        assert EventType.RUN_FINISHED not in event_types
