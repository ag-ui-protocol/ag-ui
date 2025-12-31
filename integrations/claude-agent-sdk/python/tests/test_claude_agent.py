"""Tests for ClaudeAgent middleware."""

import pytest
import asyncio
from unittest.mock import Mock, MagicMock, AsyncMock, patch, call
from types import SimpleNamespace

from ag_ui_claude import ClaudeAgent, SessionManager
from ag_ui.core import (
    RunAgentInput, EventType, UserMessage, SystemMessage,
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallEndEvent
)


class TestClaudeAgent:
    """Test cases for ClaudeAgent."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def claude_agent_persistent(self):
        """Create ClaudeAgent with persistent sessions."""
        return ClaudeAgent(
            use_persistent_sessions=True,
            app_name="test_app",
            user_id="test_user",
            execution_timeout_seconds=60,
            max_concurrent_executions=5
        )

    @pytest.fixture
    def claude_agent_stateless(self):
        """Create ClaudeAgent with stateless mode."""
        return ClaudeAgent(
            use_persistent_sessions=False,
            app_name="test_app",
            user_id="test_user",
            execution_timeout_seconds=60,
            max_concurrent_executions=5
        )

    @pytest.fixture
    def sample_input(self):
        """Create a sample RunAgentInput."""
        return RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Hello!"
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )

    def test_initialization_persistent(self):
        """Test ClaudeAgent initialization with persistent sessions."""
        agent = ClaudeAgent(
            use_persistent_sessions=True,
            app_name="test_app",
            user_id="test_user"
        )
        
        assert agent._use_persistent_sessions is True
        assert agent._static_app_name == "test_app"
        assert agent._static_user_id == "test_user"

    def test_initialization_stateless(self):
        """Test ClaudeAgent initialization with stateless mode."""
        agent = ClaudeAgent(
            use_persistent_sessions=False,
            app_name="test_app"
        )
        
        assert agent._use_persistent_sessions is False

    def test_initialization_with_claude_options(self):
        """Test initialization with ClaudeAgentOptions."""
        from claude_agent_sdk import ClaudeAgentOptions
        
        options = ClaudeAgentOptions(system_prompt="Test prompt")
        agent = ClaudeAgent(
            claude_options=options,
            app_name="test_app"
        )
        
        assert agent._claude_options == options

    def test_app_name_extraction(self, claude_agent_persistent, sample_input):
        """Test app name extraction."""
        app_name = claude_agent_persistent._get_app_name(sample_input)
        assert app_name == "test_app"

    def test_user_id_extraction(self, claude_agent_persistent, sample_input):
        """Test user ID extraction."""
        user_id = claude_agent_persistent._get_user_id(sample_input)
        assert user_id == "test_user"

    @pytest.mark.asyncio
    async def test_get_unseen_messages(self, claude_agent_persistent, sample_input):
        """Test unseen messages extraction."""
        unseen = await claude_agent_persistent._get_unseen_messages(sample_input)
        assert len(unseen) == 1
        assert unseen[0].content == "Hello!"

    @pytest.mark.asyncio
    async def test_get_unseen_messages_with_processed(self, claude_agent_persistent, sample_input):
        """Test unseen messages with processed message IDs."""
        # Mark message as processed
        claude_agent_persistent._session_manager.mark_messages_processed(
            "test_app",
            "test_thread",
            ["msg_1"]
        )
        
        unseen = await claude_agent_persistent._get_unseen_messages(sample_input)
        assert len(unseen) == 0

    @pytest.mark.asyncio
    async def test_extract_user_prompt(self, claude_agent_persistent):
        """Test user prompt extraction."""
        messages = [
            UserMessage(id="1", role="user", content="First message"),
            UserMessage(id="2", role="user", content="Second message")
        ]
        
        prompt = await claude_agent_persistent._extract_user_prompt(messages)
        assert prompt == "Second message"

    @pytest.mark.asyncio
    async def test_extract_user_prompt_empty(self, claude_agent_persistent):
        """Test user prompt extraction with empty messages."""
        prompt = await claude_agent_persistent._extract_user_prompt([])
        assert prompt == ""

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.ClaudeSDKClient')
    async def test_get_claude_client_persistent(self, mock_client_class, claude_agent_persistent):
        """Test getting Claude client in persistent mode."""
        mock_client = AsyncMock()
        mock_client_class.return_value = mock_client
        
        session_key = "test_app:test_thread"
        client = claude_agent_persistent._get_claude_client(session_key)
        
        assert client is not None
        mock_client_class.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_claude_client_stateless(self, claude_agent_stateless):
        """Test getting Claude client in stateless mode."""
        session_key = "test_app:test_thread"
        client = claude_agent_stateless._get_claude_client(session_key)
        
        assert client is None

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.claude_query')
    async def test_call_claude_sdk_stateless(self, mock_query, claude_agent_stateless):
        """Test calling Claude SDK in stateless mode."""
        # Mock messages - use MagicMock instead of SimpleNamespace with __class__ assignment
        mock_message = MagicMock()
        
        async def mock_query_gen():
            yield mock_message
        
        mock_query.return_value = mock_query_gen()
        
        messages = []
        async for msg in claude_agent_stateless._call_claude_sdk(None, "test prompt", None):
            messages.append(msg)
        
        assert len(messages) == 1
        mock_query.assert_called_once()

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_true(self, claude_agent_persistent):
        """Test detecting tool result submission."""
        from ag_ui.core import ToolMessage
        
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", tool_call_id="tool_1", content="result")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        is_tool_result = await claude_agent_persistent._is_tool_result_submission(input_data)
        assert is_tool_result is True

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_false(self, claude_agent_persistent, sample_input):
        """Test detecting non-tool result submission."""
        is_tool_result = await claude_agent_persistent._is_tool_result_submission(sample_input)
        assert is_tool_result is False

    @pytest.mark.asyncio
    async def test_prepare_request_options_no_tools(self, claude_agent_persistent):
        """Test preparing request options without tools."""
        options = await claude_agent_persistent._prepare_request_options(None)
        assert options is None  # Should return None when no tools provided

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.ClaudeAgentOptions')
    @patch('ag_ui_claude.tool_adapter.ToolAdapter')
    async def test_prepare_request_options_with_tools(
        self, mock_tool_adapter, mock_options_class, claude_agent_persistent, sample_ag_ui_tool
    ):
        """Test preparing request options with tools."""
        # Mock MCP server
        mock_mcp_server = Mock()
        mock_tool_adapter.create_mcp_server_for_tools.return_value = mock_mcp_server
        
        # Mock options
        mock_options = Mock()
        mock_options_class.return_value = mock_options
        
        tools = [sample_ag_ui_tool]
        options = await claude_agent_persistent._prepare_request_options(tools)
        
        assert options is not None
        mock_tool_adapter.create_mcp_server_for_tools.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_error_on_no_user_message(self, claude_agent_persistent):
        """Test run() handles missing user message."""
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[],  # No user messages
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        events = []
        async for event in claude_agent_persistent.run(input_data):
            events.append(event)
        
        # Should emit RUN_STARTED and then handle the error
        assert len(events) > 0
        # Check if we got an error or finished event
        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types

