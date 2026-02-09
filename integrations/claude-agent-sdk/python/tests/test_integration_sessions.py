"""Integration tests for session management."""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from types import SimpleNamespace

from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage, EventType


class TestSessionIntegration:
    """Session integration tests."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager."""
        from ag_ui_claude.session_manager import SessionManager
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def claude_agent_persistent(self):
        """Create ClaudeAgent with persistent sessions."""
        return ClaudeAgent(
            use_persistent_sessions=True,
            app_name="test_app",
            user_id="test_user"
        )

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.ClaudeSDKClient')
    async def test_persistent_session_reuse(self, mock_client_class, claude_agent_persistent):
        """Test that persistent sessions reuse clients."""
        mock_client = AsyncMock()
        mock_client.query = AsyncMock()
        
        async def mock_receive():
            result_message = SimpleNamespace()
            result_message.subtype = "success"
            yield result_message
        
        mock_client.receive_response = mock_receive
        mock_client_class.return_value = mock_client
        
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="First message")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        # First run
        events1 = []
        async for event in claude_agent_persistent.run(input_data):
            events1.append(event)
        
        # Second run with same thread_id
        input_data2 = RunAgentInput(
            thread_id="test_thread",  # Same thread
            run_id="test_run_2",
            messages=[
                UserMessage(id="msg_2", role="user", content="Second message")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        events2 = []
        async for event in claude_agent_persistent.run(input_data2):
            events2.append(event)
        
        # Client should be reused (created once)
        assert mock_client_class.call_count == 1

    @pytest.mark.asyncio
    async def test_stateless_session_no_reuse(self, claude_agent_persistent):
        """Test that stateless mode doesn't reuse sessions."""
        claude_agent_persistent._use_persistent_sessions = False
        
        with patch('ag_ui_claude.claude_agent.claude_query') as mock_query:
            async def mock_gen():
                result_message = SimpleNamespace()
                result_message = SimpleNamespace()
                result_message.subtype = "success"
                yield result_message
            
            mock_query.return_value = mock_gen()
            
            input_data = RunAgentInput(
                thread_id="test_thread",
                run_id="test_run",
                messages=[
                    UserMessage(id="msg_1", role="user", content="Hello")
                ],
                state={},
                context=[],
                tools=[],
                forwarded_props={}
            )
            
            events = []
            async for event in claude_agent_persistent.run(input_data):
                events.append(event)
            
            # Should use query() function directly
            assert mock_query.called

    @pytest.mark.asyncio
    async def test_message_deduplication(self, claude_agent_persistent):
        """Test message deduplication across runs."""
        with patch('ag_ui_claude.claude_agent.claude_query') as mock_query:
            async def mock_gen():
                result_message = SimpleNamespace()
                result_message = SimpleNamespace()
                result_message.subtype = "success"
                yield result_message
            
            mock_query.return_value = mock_gen()
            
            input_data = RunAgentInput(
                thread_id="test_thread",
                run_id="test_run_1",
                messages=[
                    UserMessage(id="msg_1", role="user", content="First")
                ],
                state={},
                context=[],
                tools=[],
                forwarded_props={}
            )
            
            # First run
            async for _ in claude_agent_persistent.run(input_data):
                pass
            
            # Second run with same message
            input_data2 = RunAgentInput(
                thread_id="test_thread",
                run_id="test_run_2",
                messages=[
                    UserMessage(id="msg_1", role="user", content="First"),  # Same message
                    UserMessage(id="msg_2", role="user", content="Second")  # New message
                ],
                state={},
                context=[],
                tools=[],
                forwarded_props={}
            )
            
            # Should only process unseen messages
            unseen = await claude_agent_persistent._get_unseen_messages(input_data2)
            assert len(unseen) == 1  # Only msg_2 should be unseen
            assert unseen[0].id == "msg_2"

