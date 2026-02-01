"""Integration tests for runtime configuration via forwarded_props."""

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


# Skip all tests if OPENAI_API_KEY is not set
pytestmark = pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY"),
    reason="OPENAI_API_KEY environment variable not set",
)


def _simple_input(*, forwarded_props: dict | None = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="rt-config-thread",
        run_id="rt-config-run",
        messages=[
            UserMessage(
                id="msg-1",
                role="user",
                content="Say 'pong' and nothing else.",
            )
        ],
        tools=[],
        context=[],
        state={},
        forwarded_props=forwarded_props or {},
    )


class TestRuntimeConfigFromForwardedProps:
    """Test that all config fields can be supplied at runtime via forwarded_props."""

    @pytest.mark.asyncio
    async def test_all_config_from_forwarded_props(self):
        """Agent with no static config should work when forwarded_props supplies everything."""
        agent = OpenResponsesAgent()  # No static config at all

        input_data = _simple_input(forwarded_props={
            "openresponses_config": {
                "base_url": "https://api.openai.com/v1",
                "api_key": os.environ["OPENAI_API_KEY"],
                "default_model": "gpt-4o-mini",
            },
        })

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert event_types[0] == EventType.RUN_STARTED
        assert EventType.TEXT_MESSAGE_CONTENT in event_types
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_runtime_model_override(self):
        """Runtime forwarded_props should override static default_model."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key=os.environ.get("OPENAI_API_KEY", ""),
                default_model="gpt-4o",  # static model
            )
        )

        input_data = _simple_input(forwarded_props={
            "openresponses_config": {
                "default_model": "gpt-4o-mini",  # cheaper override
            },
        })

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert event_types[0] == EventType.RUN_STARTED
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_runtime_api_key_override(self):
        """Runtime forwarded_props should override static api_key."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key="invalid-static-key",
                default_model="gpt-4o-mini",
            )
        )

        # Supply working key at runtime
        input_data = _simple_input(forwarded_props={
            "openresponses_config": {
                "api_key": os.environ["OPENAI_API_KEY"],
            },
        })

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert event_types[0] == EventType.RUN_STARTED
        assert EventType.TEXT_MESSAGE_CONTENT in event_types
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_runtime_timeout_and_retries(self):
        """Runtime timeout_seconds and max_retries should be accepted."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key=os.environ.get("OPENAI_API_KEY", ""),
                default_model="gpt-4o-mini",
            )
        )

        input_data = _simple_input(forwarded_props={
            "openresponses_config": {
                "timeout_seconds": 30.0,
                "max_retries": 1,
            },
        })

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert event_types[0] == EventType.RUN_STARTED
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_runtime_extra_headers(self):
        """Runtime headers should be accepted without breaking the request."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key=os.environ.get("OPENAI_API_KEY", ""),
                default_model="gpt-4o-mini",
            )
        )

        input_data = _simple_input(forwarded_props={
            "openresponses_config": {
                "headers": {"X-Custom-Trace-Id": "test-trace-123"},
            },
        })

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert event_types[0] == EventType.RUN_STARTED
        assert event_types[-1] == EventType.RUN_FINISHED


class TestRuntimeConfigErrors:
    """Test error handling for invalid runtime configurations."""

    @pytest.mark.asyncio
    async def test_no_base_url_anywhere(self):
        """Should emit RUN_ERROR when no base_url in static or runtime config."""
        agent = OpenResponsesAgent()  # No static config

        input_data = _simple_input(forwarded_props={
            "openresponses_config": {
                "api_key": "sk-test",
                # no base_url
            },
        })

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert EventType.RUN_ERROR in event_types
        error_event = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert "base_url" in error_event.message

    @pytest.mark.asyncio
    async def test_no_config_at_all(self):
        """Should emit RUN_ERROR when agent has no config and no forwarded_props."""
        agent = OpenResponsesAgent()

        input_data = _simple_input()  # no forwarded_props

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert EventType.RUN_ERROR in event_types

    @pytest.mark.asyncio
    async def test_runtime_invalid_api_key(self):
        """Should emit RUN_ERROR when runtime api_key is invalid."""
        agent = OpenResponsesAgent()

        input_data = _simple_input(forwarded_props={
            "openresponses_config": {
                "base_url": "https://api.openai.com/v1",
                "api_key": "invalid-key",
                "default_model": "gpt-4o-mini",
            },
        })

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_ERROR in event_types
        assert EventType.RUN_FINISHED not in event_types


class TestStaticConfigStillWorks:
    """Ensure the original static-only config path is not broken."""

    @pytest.mark.asyncio
    async def test_no_forwarded_props(self):
        """Static config with no forwarded_props should work as before."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key=os.environ.get("OPENAI_API_KEY", ""),
                default_model="gpt-4o-mini",
            )
        )

        input_data = _simple_input()

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert event_types[0] == EventType.RUN_STARTED
        assert event_types[-1] == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_empty_forwarded_props(self):
        """Static config with empty forwarded_props should work as before."""
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key=os.environ.get("OPENAI_API_KEY", ""),
                default_model="gpt-4o-mini",
            )
        )

        input_data = _simple_input(forwarded_props={})

        events = []
        async for event in agent.run(input_data):
            events.append(event)

        event_types = [e.type for e in events]
        assert event_types[0] == EventType.RUN_STARTED
        assert event_types[-1] == EventType.RUN_FINISHED
