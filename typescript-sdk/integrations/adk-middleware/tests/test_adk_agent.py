# tests/test_adk_agent.py

"""Tests for ADKAgent middleware."""

import pytest
import asyncio
from unittest.mock import Mock, MagicMock, AsyncMock, patch

from adk_agent import ADKAgent
from agent_registry import AgentRegistry
from ag_ui.core import (
    RunAgentInput, EventType, UserMessage, Context,
    RunStartedEvent, RunFinishedEvent, TextMessageChunkEvent
)
from google.adk.agents import Agent


class TestADKAgent:
    """Test cases for ADKAgent."""
    
    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADK agent."""
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        return agent
    
    @pytest.fixture
    def registry(self, mock_agent):
        """Set up the agent registry."""
        registry = AgentRegistry.get_instance()
        registry.clear()  # Clear any existing registrations
        registry.set_default_agent(mock_agent)
        return registry
    
    @pytest.fixture
    def adk_agent(self):
        """Create an ADKAgent instance."""
        return ADKAgent(
            user_id="test_user",
            session_timeout_seconds=60,
            auto_cleanup=False  # Disable for tests
        )
    
    @pytest.fixture
    def sample_input(self):
        """Create a sample RunAgentInput."""
        return RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(
                    id="msg1",
                    role="user",
                    content="Hello, test!"
                )
            ],
            context=[
                Context(description="test", value="true")
            ],
            state={},
            tools=[],
            forwarded_props={}
        )
    
    @pytest.mark.asyncio
    async def test_agent_initialization(self, adk_agent):
        """Test ADKAgent initialization."""
        assert adk_agent._static_user_id == "test_user"
        assert adk_agent._session_manager._session_timeout == 60
        assert adk_agent._cleanup_task is None  # auto_cleanup=False
    
    @pytest.mark.asyncio
    async def test_user_extraction(self, adk_agent, sample_input):
        """Test user ID extraction."""
        # Test static user ID
        assert adk_agent._get_user_id(sample_input) == "test_user"
        
        # Test custom extractor
        def custom_extractor(input):
            return "custom_user"
        
        adk_agent_custom = ADKAgent(user_id_extractor=custom_extractor)
        assert adk_agent_custom._get_user_id(sample_input) == "custom_user"
    
    @pytest.mark.asyncio
    async def test_agent_id_extraction(self, adk_agent, sample_input):
        """Test agent ID extraction from input."""
        # Default case
        assert adk_agent._extract_agent_id(sample_input) == "default"
        
        # From context
        sample_input.context.append(
            Context(description="agent_id", value="specific_agent")
        )
        assert adk_agent._extract_agent_id(sample_input) == "specific_agent"
    
    @pytest.mark.asyncio
    async def test_run_basic_flow(self, adk_agent, sample_input, registry, mock_agent):
        """Test basic run flow with mocked runner."""
        with patch.object(adk_agent, '_get_or_create_runner') as mock_get_runner:
            # Create a mock runner
            mock_runner = AsyncMock()
            mock_event = Mock()
            mock_event.id = "event1"
            mock_event.author = "test_agent"
            mock_event.content = Mock()
            mock_event.content.parts = [Mock(text="Hello from agent!")]
            mock_event.partial = False
            mock_event.actions = None
            mock_event.get_function_calls = Mock(return_value=[])
            mock_event.get_function_responses = Mock(return_value=[])
            
            # Configure mock runner to yield our mock event
            async def mock_run_async(*args, **kwargs):
                yield mock_event
            
            mock_runner.run_async = mock_run_async
            mock_get_runner.return_value = mock_runner
            
            # Collect events
            events = []
            async for event in adk_agent.run(sample_input):
                events.append(event)
            
            # Verify events
            assert len(events) >= 2  # At least RUN_STARTED and RUN_FINISHED
            assert events[0].type == EventType.RUN_STARTED
            assert events[-1].type == EventType.RUN_FINISHED
    
    @pytest.mark.asyncio
    async def test_session_management(self, adk_agent):
        """Test session lifecycle management."""
        session_mgr = adk_agent._session_manager
        
        # Track a session
        session_mgr.track_activity(
            "agent1:user1:session1",
            "agent1",
            "user1",
            "session1"
        )
        
        assert session_mgr.get_session_count() == 1
        assert session_mgr.get_session_count("user1") == 1
        
        # Test session limits
        session_mgr._max_sessions_per_user = 2
        assert not session_mgr.should_create_new_session("user1")
        
        # Add another session
        session_mgr.track_activity(
            "agent1:user1:session2",
            "agent1",
            "user1",
            "session2"
        )
        assert session_mgr.should_create_new_session("user1")
    
    @pytest.mark.asyncio
    async def test_error_handling(self, adk_agent, sample_input):
        """Test error handling in run method."""
        # Force an error by not setting up the registry
        AgentRegistry.reset_instance()
        
        events = []
        async for event in adk_agent.run(sample_input):
            events.append(event)
        
        # Should get RUN_STARTED and RUN_ERROR
        assert len(events) == 2
        assert events[0].type == EventType.RUN_STARTED
        assert events[1].type == EventType.RUN_ERROR
        assert "No agent found" in events[1].message
    
    @pytest.mark.asyncio
    async def test_cleanup(self, adk_agent):
        """Test cleanup method."""
        # Add a mock runner
        mock_runner = AsyncMock()
        adk_agent._runners["test:user"] = mock_runner
        
        await adk_agent.close()
        
        # Verify runner was closed
        mock_runner.close.assert_called_once()
        assert len(adk_agent._runners) == 0


@pytest.fixture(autouse=True)
def reset_registry():
    """Reset the AgentRegistry before each test."""
    AgentRegistry.reset_instance()
    yield
    AgentRegistry.reset_instance()