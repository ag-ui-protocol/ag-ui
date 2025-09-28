# tests/test_adk_agent.py

"""Tests for ADKAgent middleware."""

import pytest
import asyncio
from unittest.mock import Mock, MagicMock, AsyncMock, patch


from ag_ui_adk import ADKAgent, SessionManager
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
    def adk_agent(self, mock_agent):
        """Create an ADKAgent instance."""
        return ADKAgent(
            adk_agent=mock_agent,
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

        # Create a test agent for the custom instance
        test_agent_custom = Mock(spec=Agent)
        test_agent_custom.name = "custom_test_agent"

        adk_agent_custom = ADKAgent(adk_agent=test_agent_custom, app_name="test_app", user_id_extractor=custom_extractor)
        assert adk_agent_custom._get_user_id(sample_input) == "custom_user"

    @pytest.mark.asyncio
    async def test_adk_agent_has_direct_reference(self, adk_agent, sample_input):
        """Test that ADK agent has direct reference to underlying agent."""
        # Test that the agent is directly accessible
        assert adk_agent._adk_agent is not None
        assert adk_agent._adk_agent.name == "test_agent"

    @pytest.mark.asyncio
    async def test_run_basic_flow(self, adk_agent, sample_input, mock_agent):
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
        # Force an error by making the underlying agent fail
        adk_agent._adk_agent = None  # This will cause an error

        events = []
        async for event in adk_agent.run(sample_input):
            events.append(event)

        # Should get RUN_STARTED, RUN_ERROR, and RUN_FINISHED
        assert len(events) == 3
        assert events[0].type == EventType.RUN_STARTED
        assert events[1].type == EventType.RUN_ERROR
        assert events[2].type == EventType.RUN_FINISHED
        # Check that it's an error with meaningful content
        assert len(events[1].message) > 0
        assert events[1].code == 'BACKGROUND_EXECUTION_ERROR'

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
    async def test_system_message_appended_to_instructions(self):
        """Test that SystemMessage as first message gets appended to agent instructions."""
        # Create an agent with initial instructions
        mock_agent = Agent(
            name="test_agent",
            instruction="You are a helpful assistant."
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

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
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was modified
        assert captured_agent is not None
        expected_instruction = "You are a helpful assistant.\n\nBe very concise in responses."
        assert captured_agent.instruction == expected_instruction

    @pytest.mark.asyncio
    async def test_system_message_appended_to_instruction_provider(self):
        """Test that SystemMessage as first message gets appended to agent instructions
        when they are set via instruction provider."""
        # Create an agent with initial instructions
        received_context = None

        async def instruction_provider(context) -> str:
            nonlocal received_context
            received_context = context
            return "You are a helpful assistant."

        mock_agent = Agent(
            name="test_agent",
            instruction=instruction_provider
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

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
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was wrapped correctly
        assert captured_agent is not None
        assert callable(captured_agent.instruction) is True

        # Test that the context object received in instruction provider is the same
        test_context = {"test": "value"}
        expected_instruction = "You are a helpful assistant.\n\nBe very concise in responses."
        agent_instruction = await captured_agent.instruction(test_context)
        assert agent_instruction == expected_instruction
        assert received_context is test_context

    @pytest.mark.asyncio
    async def test_system_message_appended_to_instruction_provider_with_none(self):
        """Test that SystemMessage as first message gets appended to agent instructions
        when they are set via instruction provider."""
        # Create an agent with initial instructions, but return None
        async def instruction_provider(context) -> str:
            return None

        mock_agent = Agent(
            name="test_agent",
            instruction=instruction_provider
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

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
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was wrapped correctly
        assert captured_agent is not None
        assert callable(captured_agent.instruction) is True

        # No empty new lines should be added before the instructions
        expected_instruction = "Be very concise in responses."
        agent_instruction = await captured_agent.instruction({})
        assert agent_instruction == expected_instruction

    @pytest.mark.asyncio
    async def test_system_message_appended_to_sync_instruction_provider(self):
        """Test that SystemMessage as first message gets appended to agent instructions
        when they are set via sync instruction provider."""
        # Create an agent with initial instructions
        received_context = None

        def instruction_provider(context) -> str:
            nonlocal received_context
            received_context = context
            return "You are a helpful assistant."

        mock_agent = Agent(
            name="test_agent",
            instruction=instruction_provider
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

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
            execution = await adk_agent._start_background_execution(system_input)

            # Wait briefly for the background task to start
            await asyncio.sleep(0.01)

        # Verify agent was captured
        assert captured_agent is not None
        assert callable(captured_agent.instruction)

        # Test that the context object received in instruction provider is the same
        test_context = {"test": "value"}
        expected_instruction = "You are a helpful assistant.\n\nBe very concise in responses."
        agent_instruction = captured_agent.instruction(test_context)  # Note: no await for sync function
        assert agent_instruction == expected_instruction
        assert received_context is test_context

    @pytest.mark.asyncio
    async def test_system_message_not_first_ignored(self):
        """Test that SystemMessage not as first message is ignored."""
        mock_agent = Agent(
            name="test_agent",
            instruction="You are a helpful assistant."
        )

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

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
            execution = await adk_agent._start_background_execution(system_input)
            await asyncio.sleep(0.01)

        # Verify the agent's instruction was NOT modified
        assert captured_agent.instruction == "You are a helpful assistant."

    @pytest.mark.asyncio
    async def test_system_message_with_no_existing_instruction(self):
        """Test SystemMessage handling when agent has no existing instruction."""
        mock_agent = Agent(name="test_agent")  # No instruction

        adk_agent = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")

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
            execution = await adk_agent._start_background_execution(system_input)
            await asyncio.sleep(0.01)

        # Verify the SystemMessage became the instruction
        assert captured_agent.instruction == "You are a math tutor."


