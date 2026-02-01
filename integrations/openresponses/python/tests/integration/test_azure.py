"""Integration tests for Azure OpenAI provider."""

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
    AzureProviderConfig,
)


# Skip all tests if Azure env vars are not set
pytestmark = pytest.mark.skipif(
    not os.environ.get("AZURE_OPENAI_API_KEY") or not os.environ.get("AZURE_OPENAI_ENDPOINT"),
    reason="AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT environment variables not set",
)


@pytest.fixture
def azure_agent() -> OpenResponsesAgent:
    """Create an Azure OpenAI agent for testing."""
    return OpenResponsesAgent(
        OpenResponsesAgentConfig(
            base_url=os.environ.get("AZURE_OPENAI_ENDPOINT", ""),
            api_key=os.environ.get("AZURE_OPENAI_API_KEY", ""),
            default_model=os.environ.get("AZURE_OPENAI_DEPLOYMENT", "gpt-4o"),
            azure=AzureProviderConfig(
                api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview"),
            ),
        )
    )


@pytest.fixture
def simple_input() -> RunAgentInput:
    """Create a simple input for testing."""
    return RunAgentInput(
        thread_id="azure-test-thread-1",
        run_id="azure-test-run-1",
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


class TestAzureBasicStreaming:
    """Tests for basic text streaming with Azure OpenAI."""

    @pytest.mark.asyncio
    async def test_simple_text_response(
        self, azure_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should stream a simple text response."""
        events = []
        async for event in azure_agent.run(simple_input):
            events.append(event)

        event_types = [e.type for e in events]

        assert event_types[0] == EventType.RUN_STARTED
        assert EventType.TEXT_MESSAGE_START in event_types
        assert EventType.TEXT_MESSAGE_CONTENT in event_types
        assert EventType.TEXT_MESSAGE_END in event_types
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_text_message_content(
        self, azure_agent: OpenResponsesAgent, simple_input: RunAgentInput
    ):
        """Should stream text content with consistent message_id."""
        events = []
        async for event in azure_agent.run(simple_input):
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
        assert "hello" in full_content.lower()


class TestAzureErrorHandling:
    """Tests for error handling with Azure OpenAI."""

    @pytest.mark.asyncio
    async def test_invalid_deployment(self):
        """Should emit RUN_ERROR for invalid deployment."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url=os.environ.get("AZURE_OPENAI_ENDPOINT", ""),
                api_key=os.environ.get("AZURE_OPENAI_API_KEY", ""),
                default_model="nonexistent-deployment-xyz",
                azure=AzureProviderConfig(
                    api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview"),
                ),
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

        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_ERROR in event_types
        assert EventType.RUN_FINISHED not in event_types
