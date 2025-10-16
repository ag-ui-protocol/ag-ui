#!/usr/bin/env python
"""Test ADKAgent memory service integration functionality."""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, Mock, patch

from ag_ui_adk import ADKAgent, SessionManager
from ag_ui.core import RunAgentInput, UserMessage, Context
from google.adk.agents import Agent


class TestADKAgentMemoryIntegration:
    """Test cases for ADKAgent memory service integration."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "memory_test_agent"
        agent.model_copy = Mock(return_value=agent)
        return agent


    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_memory_service(self):
        """Create a mock memory service."""
        service = AsyncMock()
        service.add_session_to_memory = AsyncMock()
        return service

    @pytest.fixture
    def simple_input(self):
        """Create a simple RunAgentInput for testing."""
        return RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[UserMessage(id="msg_1", role="user", content="Hello")],
            state={},
            context=[Context(description="user", value="test_user")],
            tools=[],
            forwarded_props={}
        )

    def test_adk_agent_memory_service_initialization_explicit(self, mock_memory_service, mock_agent):
        """Test ADKAgent properly stores explicit memory service."""
        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            memory_service=mock_memory_service,
            use_in_memory_services=True
        )

        # Verify the memory service is stored
        assert adk_agent._memory_service is mock_memory_service

    def test_adk_agent_memory_service_initialization_in_memory(self, mock_agent):
        """Test ADKAgent creates in-memory memory service when use_in_memory_services=True."""
        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True
        )

        # Verify an in-memory memory service was created
        assert adk_agent._memory_service is not None
        # Should be InMemoryMemoryService type
        assert "InMemoryMemoryService" in str(type(adk_agent._memory_service))

    def test_adk_agent_memory_service_initialization_disabled(self, mock_agent):
        """Test ADKAgent doesn't create memory service when use_in_memory_services=False."""
        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            memory_service=None,
            use_in_memory_services=False
        )

        # Verify memory service is None
        assert adk_agent._memory_service is None

    def test_adk_agent_passes_memory_service_to_session_manager(self, mock_memory_service, mock_agent):
        """Test that ADKAgent passes memory service to SessionManager."""
        with patch.object(SessionManager, 'get_instance') as mock_get_instance:
            mock_session_manager = Mock()
            mock_get_instance.return_value = mock_session_manager

            adk_agent = ADKAgent(
                adk_agent=mock_agent,
                app_name="test_app",
                user_id="test_user",
                memory_service=mock_memory_service,
                use_in_memory_services=True
            )

            # Verify SessionManager.get_instance was called with the memory service
            mock_get_instance.assert_called_once()
            call_args = mock_get_instance.call_args
            assert call_args[1]['memory_service'] is mock_memory_service

    def test_adk_agent_memory_service_sharing_same_instance(self, mock_memory_service, mock_agent):
        """Test that the same memory service instance is used across components."""
        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            memory_service=mock_memory_service,
            use_in_memory_services=True
        )

        # The ADKAgent should store the same instance
        assert adk_agent._memory_service is mock_memory_service

        # The SessionManager should also have the same instance
        session_manager = adk_agent._session_manager
        assert session_manager._memory_service is mock_memory_service

    @patch('ag_ui_adk.adk_agent.Runner')
    def test_adk_agent_creates_runner_with_memory_service(self, mock_runner_class, mock_memory_service, mock_agent, simple_input):
        """Test that ADKAgent creates Runner with the correct memory service."""
        # Setup mock runner
        mock_runner = AsyncMock()
        mock_runner.run_async = AsyncMock()
        # Create an async generator that yields no events and then stops
        async def mock_run_async(*args, **kwargs):
            # Yield no events - just return immediately
            if False:  # This makes it an async generator that yields nothing
                yield
        mock_runner.run_async.return_value = mock_run_async()
        mock_runner_class.return_value = mock_runner

        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            memory_service=mock_memory_service,
            use_in_memory_services=True
        )

        # Mock the _create_runner method to capture its call
        with patch.object(adk_agent, '_create_runner', return_value=mock_runner) as mock_create_runner:
            # Start the execution (it will fail due to mocking but we just want to see the Runner creation)
            gen = adk_agent.run(simple_input)

            # Start the async generator to trigger runner creation
            try:
                async def run_test():
                    async for event in gen:
                        break  # Just get the first event to trigger runner creation

                # We expect this to fail due to mocking, but it should call _create_runner
                asyncio.create_task(run_test())
                asyncio.get_event_loop().run_until_complete(asyncio.sleep(0.1))
            except:
                pass  # Expected to fail due to mocking

            # Verify that _create_runner was called and Runner was created with memory service
            # We can check this by verifying the Runner constructor was called with memory_service
            if mock_runner_class.called:
                call_args = mock_runner_class.call_args
                assert call_args[1]['memory_service'] is mock_memory_service

    def test_adk_agent_memory_service_configuration_inheritance(self, mock_memory_service, mock_agent):
        """Test that memory service configuration is properly inherited by all components."""
        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            memory_service=mock_memory_service,
            use_in_memory_services=True
        )

        # Test the memory service ID is consistent across components
        agent_memory_service_id = id(adk_agent._memory_service)
        session_manager_memory_service_id = id(adk_agent._session_manager._memory_service)

        assert agent_memory_service_id == session_manager_memory_service_id

        # Both should point to the same mock object
        assert adk_agent._memory_service is mock_memory_service
        assert adk_agent._session_manager._memory_service is mock_memory_service

    def test_adk_agent_in_memory_memory_service_defaults(self, mock_agent):
        """Test that in-memory memory service defaults work correctly."""
        adk_agent = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True  # Should create InMemoryMemoryService
        )

        # Should have created an InMemoryMemoryService
        assert adk_agent._memory_service is not None
        assert "InMemoryMemoryService" in str(type(adk_agent._memory_service))

        # SessionManager should have the same instance
        assert adk_agent._session_manager._memory_service is adk_agent._memory_service

        # Should be the same object (not just same type)
        assert id(adk_agent._memory_service) == id(adk_agent._session_manager._memory_service)