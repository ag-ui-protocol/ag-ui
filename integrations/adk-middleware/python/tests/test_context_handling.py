#!/usr/bin/env python
"""Tests for AG-UI context handling in ADK middleware.

This module tests the implementation of Issue #959: passing RunAgentInput.context
to ADK agents via session state.

Context is stored under the '_ag_ui_context' key (CONTEXT_STATE_KEY) and is
accessible in both tools (via tool_context.state) and instruction providers
(via ctx.state).
"""

import pytest
from unittest.mock import Mock, MagicMock, AsyncMock, patch

from ag_ui.core import (
    RunAgentInput,
    UserMessage,
    Context,
    EventType,
)
from ag_ui_adk import ADKAgent, CONTEXT_STATE_KEY
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import Agent


class TestContextStateKey:
    """Test the CONTEXT_STATE_KEY constant."""

    def test_context_state_key_value(self):
        """Test that CONTEXT_STATE_KEY has expected value."""
        assert CONTEXT_STATE_KEY == "_ag_ui_context"

    def test_context_state_key_exported(self):
        """Test that CONTEXT_STATE_KEY is exported from package."""
        from ag_ui_adk import CONTEXT_STATE_KEY as imported_key
        assert imported_key == "_ag_ui_context"


class TestContextInSessionState:
    """Test context handling in session state."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        agent.instruction = "Test instruction"
        agent.tools = []
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        """Create an ADKAgent instance."""
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True
        )

    @pytest.mark.asyncio
    async def test_context_included_in_session_state(self, adk_agent):
        """Test that context is included in state passed to session."""
        input_with_context = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="msg1", role="user", content="Hello")],
            context=[
                Context(description="feature_flag", value="enabled"),
                Context(description="environment", value="production"),
            ],
            state={"existing_key": "existing_value"},
            tools=[],
            forwarded_props={}
        )

        # Mock the _ensure_session_exists to capture the state passed
        captured_state = {}

        async def mock_ensure_session(app_name, user_id, thread_id, initial_state):
            captured_state.update(initial_state)
            # Create a mock session
            mock_session = MagicMock()
            mock_session.id = "mock_session_id"
            return mock_session, "mock_session_id"

        with patch.object(adk_agent, '_ensure_session_exists', side_effect=mock_ensure_session):
            with patch.object(adk_agent, '_session_manager') as mock_sm:
                mock_sm.update_session_state = AsyncMock(return_value=True)
                with patch.object(adk_agent, '_create_runner') as mock_create_runner:
                    mock_runner = AsyncMock()
                    mock_runner.close = AsyncMock()

                    async def empty_run_async(*args, **kwargs):
                        if False:
                            yield None

                    mock_runner.run_async = empty_run_async
                    mock_create_runner.return_value = mock_runner

                    # Run the agent to trigger state preparation
                    events = []
                    async for event in adk_agent.run(input_with_context):
                        events.append(event)

        # Verify context was included in state
        assert CONTEXT_STATE_KEY in captured_state
        context_in_state = captured_state[CONTEXT_STATE_KEY]
        assert len(context_in_state) == 2
        assert {"description": "feature_flag", "value": "enabled"} in context_in_state
        assert {"description": "environment", "value": "production"} in context_in_state

        # Verify existing state was preserved
        assert captured_state.get("existing_key") == "existing_value"

    @pytest.mark.asyncio
    async def test_empty_context_not_in_state(self, adk_agent):
        """Test that empty context is not added to state."""
        input_without_context = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="msg1", role="user", content="Hello")],
            context=[],
            state={"key": "value"},
            tools=[],
            forwarded_props={}
        )

        captured_state = {}

        async def mock_ensure_session(app_name, user_id, thread_id, initial_state):
            captured_state.update(initial_state)
            mock_session = MagicMock()
            mock_session.id = "mock_session_id"
            return mock_session, "mock_session_id"

        with patch.object(adk_agent, '_ensure_session_exists', side_effect=mock_ensure_session):
            with patch.object(adk_agent, '_session_manager') as mock_sm:
                mock_sm.update_session_state = AsyncMock(return_value=True)
                with patch.object(adk_agent, '_create_runner') as mock_create_runner:
                    mock_runner = AsyncMock()
                    mock_runner.close = AsyncMock()

                    async def empty_run_async(*args, **kwargs):
                        if False:
                            yield None

                    mock_runner.run_async = empty_run_async
                    mock_create_runner.return_value = mock_runner

                    events = []
                    async for event in adk_agent.run(input_without_context):
                        events.append(event)

        # Context key should not be present with empty context
        assert CONTEXT_STATE_KEY not in captured_state
        assert captured_state.get("key") == "value"


class TestContextSerializationFormat:
    """Test that context is serialized in the correct format."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        agent.instruction = "Test instruction"
        agent.tools = []
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        """Create an ADKAgent instance."""
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True
        )

    @pytest.mark.asyncio
    async def test_context_serialization_format(self, adk_agent):
        """Test that context items are serialized as dicts with description/value."""
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="msg1", role="user", content="Hello")],
            context=[
                Context(description="key1", value="value1"),
                Context(description="key2", value="value2"),
                Context(description="numeric", value="123"),
            ],
            state={},
            tools=[],
            forwarded_props={}
        )

        captured_state = {}

        async def mock_ensure_session(app_name, user_id, thread_id, initial_state):
            captured_state.update(initial_state)
            mock_session = MagicMock()
            mock_session.id = "mock_session_id"
            return mock_session, "mock_session_id"

        with patch.object(adk_agent, '_ensure_session_exists', side_effect=mock_ensure_session):
            with patch.object(adk_agent, '_session_manager') as mock_sm:
                mock_sm.update_session_state = AsyncMock(return_value=True)
                with patch.object(adk_agent, '_create_runner') as mock_create_runner:
                    mock_runner = AsyncMock()
                    mock_runner.close = AsyncMock()

                    async def empty_run_async(*args, **kwargs):
                        if False:
                            yield None

                    mock_runner.run_async = empty_run_async
                    mock_create_runner.return_value = mock_runner

                    events = []
                    async for event in adk_agent.run(input_data):
                        events.append(event)

        # Verify context format
        assert CONTEXT_STATE_KEY in captured_state
        context_data = captured_state[CONTEXT_STATE_KEY]

        # Each item should be a dict with exactly 'description' and 'value' keys
        for item in context_data:
            assert isinstance(item, dict)
            assert set(item.keys()) == {"description", "value"}
            assert isinstance(item["description"], str)
            assert isinstance(item["value"], str)


class TestCustomRunConfigFactory:
    """Test that custom run_config_factory still works and can access context."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        return agent

    def test_custom_run_config_factory_receives_input(self, mock_agent):
        """Test that custom run_config_factory receives the full RunAgentInput."""
        from google.adk.agents.run_config import RunConfig, StreamingMode

        received_input = None

        def custom_factory(input_data: RunAgentInput) -> RunConfig:
            nonlocal received_input
            received_input = input_data
            return RunConfig(streaming_mode=StreamingMode.SSE)

        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            run_config_factory=custom_factory,
            use_in_memory_services=True
        )

        input_with_context = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="msg1", role="user", content="Hello")],
            context=[Context(description="test", value="data")],
            state={},
            tools=[],
            forwarded_props={}
        )

        # Call the factory through the agent
        run_config = adk_agent._run_config_factory(input_with_context)

        assert received_input is not None
        assert received_input.context == input_with_context.context
        assert len(received_input.context) == 1
        assert received_input.context[0].description == "test"
        assert received_input.context[0].value == "data"


class TestDefaultRunConfigUnchanged:
    """Test that _default_run_config works correctly without custom_metadata."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        """Create an ADKAgent instance."""
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True
        )

    def test_default_run_config_returns_valid_config(self, adk_agent):
        """Test that _default_run_config returns a valid RunConfig."""
        from google.adk.agents.run_config import StreamingMode

        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="msg1", role="user", content="Hello")],
            context=[Context(description="key", value="value")],
            state={},
            tools=[],
            forwarded_props={}
        )

        run_config = adk_agent._default_run_config(input_data)

        assert run_config is not None
        assert run_config.streaming_mode == StreamingMode.SSE
        assert run_config.save_input_blobs_as_artifacts is True


# Run tests with pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
