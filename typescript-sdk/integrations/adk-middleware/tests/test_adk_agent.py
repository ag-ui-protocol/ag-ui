# tests/test_adk_agent.py

"""Tests for ADKAgent middleware."""

import pytest
import asyncio
from unittest.mock import Mock, MagicMock, AsyncMock, patch


from adk_middleware import ADKAgent, AgentRegistry,SessionManager
from ag_ui.core import (
    RunAgentInput, EventType, UserMessage, Context,
    RunStartedEvent, RunFinishedEvent, TextMessageChunkEvent, SystemMessage
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
    
    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            # Event loop may be closed - ignore
            pass
        yield
        # Cleanup after test
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            # Event loop may be closed - ignore
            pass

    @pytest.fixture
    def adk_agent(self):
        """Create an ADKAgent instance."""
        return ADKAgent(
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True
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
        assert adk_agent._static_app_name == "test_app"
        assert adk_agent._session_manager is not None
    
    @pytest.mark.asyncio
    async def test_user_extraction(self, adk_agent, sample_input):
        """Test user ID extraction."""
        # Test static user ID
        assert adk_agent._get_user_id(sample_input) == "test_user"
        
        # Test custom extractor
        def custom_extractor(input):
            return "custom_user"
        
        adk_agent_custom = ADKAgent(app_name="test_app", user_id_extractor=custom_extractor)
        assert adk_agent_custom._get_user_id(sample_input) == "custom_user"
    
    @pytest.mark.asyncio
    async def test_agent_id_default(self, adk_agent, sample_input):
        """Test agent ID is always default."""
        # Should always return default
        assert adk_agent._get_agent_id() == "default"
    
    @pytest.mark.asyncio
    async def test_run_basic_flow(self, adk_agent, sample_input, registry, mock_agent):
        """Test basic run flow with mocked runner."""
        with patch.object(adk_agent, '_create_runner') as mock_create_runner:
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
            mock_create_runner.return_value = mock_runner
            
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
        
        # Create a session through get_or_create_session
        await session_mgr.get_or_create_session(
            session_id="session1",
            app_name="agent1",
            user_id="user1"
        )
        
        assert session_mgr.get_session_count() == 1
        
        # Add another session
        await session_mgr.get_or_create_session(
            session_id="session2",
            app_name="agent1",
            user_id="user1"
        )
        assert session_mgr.get_session_count() == 2
    
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
        # Add a mock execution
        mock_execution = Mock()
        mock_execution.cancel = AsyncMock()
        
        async with adk_agent._execution_lock:
            adk_agent._active_executions["test_thread"] = mock_execution
        
        await adk_agent.close()
        
        # Verify execution was cancelled and cleaned up
        mock_execution.cancel.assert_called_once()
        assert len(adk_agent._active_executions) == 0

    @pytest.mark.asyncio
    async def test_system_message_appended_to_instructions(self, registry):
        """Test that SystemMessage as first message gets appended to agent instructions."""
        # Create an agent with initial instructions
        mock_agent = Agent(
            name="test_agent",
            instruction="You are a helpful assistant."
        )
        registry.set_default_agent(mock_agent)
        
        adk_agent = ADKAgent(app_name="test_app", user_id="test_user")
        
        # Create input with SystemMessage as first message
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                SystemMessage(id="sys_1", role="system", content="Be very concise in responses."),
                UserMessage(id="msg_1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )
        
        # Mock the background execution to capture the modified agent
        captured_agent = None
        original_run_background = adk_agent._run_adk_in_background
        
        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue):
            nonlocal captured_agent
            captured_agent = adk_agent
            # Just put a completion event in the queue and return
            await event_queue.put(None)
        
        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            # Start execution to trigger agent modification
            execution = await adk_agent._start_background_execution(system_input, "default")
            
            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)
        
        # Verify the agent's instruction was modified
        assert captured_agent is not None
        expected_instruction = "You are a helpful assistant.\n\nBe very concise in responses."
        assert captured_agent.instruction == expected_instruction

    @pytest.mark.asyncio
    async def test_system_message_not_first_ignored(self, registry):
        """Test that SystemMessage not as first message is ignored."""
        mock_agent = Agent(
            name="test_agent", 
            instruction="You are a helpful assistant."
        )
        registry.set_default_agent(mock_agent)
        
        adk_agent = ADKAgent(app_name="test_app", user_id="test_user")
        
        # Create input with SystemMessage as second message
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run", 
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello"),
                SystemMessage(id="sys_1", role="system", content="Be very concise in responses.")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )
        
        # Mock the background execution to capture the agent
        captured_agent = None
        
        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue):
            nonlocal captured_agent
            captured_agent = adk_agent
            await event_queue.put(None)
        
        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            execution = await adk_agent._start_background_execution(system_input, "default")
            await asyncio.sleep(0.01)
        
        # Verify the agent's instruction was NOT modified
        assert captured_agent.instruction == "You are a helpful assistant."

    @pytest.mark.asyncio
    async def test_system_message_with_no_existing_instruction(self, registry):
        """Test SystemMessage handling when agent has no existing instruction."""
        mock_agent = Agent(name="test_agent")  # No instruction
        registry.set_default_agent(mock_agent)
        
        adk_agent = ADKAgent(app_name="test_app", user_id="test_user")
        
        system_input = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                SystemMessage(id="sys_1", role="system", content="You are a math tutor.")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={}
        )
        
        captured_agent = None
        
        async def mock_run_background(input, adk_agent, user_id, app_name, event_queue):
            nonlocal captured_agent
            captured_agent = adk_agent
            await event_queue.put(None)
        
        with patch.object(adk_agent, '_run_adk_in_background', side_effect=mock_run_background):
            execution = await adk_agent._start_background_execution(system_input, "default")
            await asyncio.sleep(0.01)
        
        # Verify the SystemMessage became the instruction
        assert captured_agent.instruction == "You are a math tutor."


@pytest.fixture(autouse=True)
def reset_registry():
    """Reset the AgentRegistry before each test."""
    AgentRegistry.reset_instance()
    yield
    AgentRegistry.reset_instance()