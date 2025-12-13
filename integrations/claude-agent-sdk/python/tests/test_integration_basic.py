"""Integration tests for basic Claude Agent SDK functionality."""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from types import SimpleNamespace

from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage, EventType, RunStartedEvent, RunFinishedEvent


class TestBasicIntegration:
    """Basic integration tests."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager."""
        from ag_ui_claude.session_manager import SessionManager
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def claude_agent(self):
        """Create ClaudeAgent instance."""
        return ClaudeAgent(
            use_persistent_sessions=False,  # Use stateless for simpler testing
            app_name="test_app",
            user_id="test_user"
        )

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.claude_query')
    async def test_basic_conversation_flow(self, mock_query, claude_agent):
        """Test basic conversation flow."""
        # Mock Claude SDK response
        text_block = SimpleNamespace()
        text_block.text = "Hello! How can I help you?"
        
        assistant_message = SimpleNamespace()
        assistant_message.content = [text_block]
        
        result_message = SimpleNamespace()
        result_message.subtype = "success"
        
        async def mock_query_gen():
            yield assistant_message
            yield result_message
        
        mock_query.return_value = mock_query_gen()
        
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello!")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        # Run agent
        events = []
        async for event in claude_agent.run(input_data):
            events.append(event)
        
        # Verify events
        assert len(events) > 0
        
        # Should have RUN_STARTED
        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        
        # Should have RUN_FINISHED
        assert EventType.RUN_FINISHED in event_types

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.ClaudeSDKClient')
    async def test_persistent_session_flow(self, mock_client_class, claude_agent):
        """Test persistent session flow."""
        # Switch to persistent mode
        claude_agent._use_persistent_sessions = True
        
        # Mock client
        mock_client = AsyncMock()
        mock_client.query = AsyncMock()
        
        async def mock_receive():
            text_block = SimpleNamespace()
            text_block.text = "Response"
            
            message = SimpleNamespace()
            message.__class__ = type('AssistantMessage', (), {})
            message.content = [text_block]
            
            result_message = SimpleNamespace()
            result_message.__class__ = type('ResultMessage', (), {})
            result_message.subtype = "success"
            
            yield message
            yield result_message
        
        mock_client.receive_response = AsyncMock(side_effect=mock_receive)
        mock_client_class.return_value = mock_client
        
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello!")
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={}
        )
        
        # Run agent
        events = []
        async for event in claude_agent.run(input_data):
            events.append(event)
        
        # Verify client was used
        assert mock_client.query.called

    @pytest.mark.asyncio
    async def test_event_sequence(self, claude_agent):
        """Test that events are emitted in correct sequence."""
        with patch('ag_ui_claude.claude_agent.claude_query') as mock_query:
            # Mock response
            text_block = SimpleNamespace()
            text_block.text = "Test"
            
            message = SimpleNamespace()
            message.content = [text_block]
            
            result_message = SimpleNamespace()
            result_message.subtype = "success"
            
            async def mock_gen():
                yield message
                yield result_message
            
            mock_query.return_value = mock_gen()
            
            input_data = RunAgentInput(
                thread_id="test_thread",
                run_id="test_run",
                messages=[
                    UserMessage(id="msg_1", role="user", content="Test")
                ],
                state={},
                context=[],
                tools=[],
                forwarded_props={}
            )
            
            events = []
            async for event in claude_agent.run(input_data):
                events.append(event)
            
            # Check sequence: RUN_STARTED should come first
            assert events[0].type == EventType.RUN_STARTED
            
            # RUN_FINISHED should come last
            assert events[-1].type == EventType.RUN_FINISHED

