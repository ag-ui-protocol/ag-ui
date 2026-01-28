"""Integration tests for tool calling functionality."""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from types import SimpleNamespace

from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage, Tool as AGUITool, ToolMessage, EventType


class TestToolIntegration:
    """Tool integration tests."""

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
            use_persistent_sessions=False,
            app_name="test_app",
            user_id="test_user"
        )

    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool."""
        return AGUITool(
            name="get_weather",
            description="Get weather",
            parameters={
                "type": "object",
                "properties": {
                    "location": {"type": "string"}
                },
                "required": ["location"]
            }
        )

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.claude_query')
    async def test_tool_call_flow(self, mock_query, claude_agent, sample_tool):
        """Test tool call flow."""
        # Mock tool use block
        tool_block = SimpleNamespace()
        tool_block.id = "tool_call_123"
        tool_block.name = "get_weather"
        tool_block.input = {"location": "San Francisco"}
        
        message = SimpleNamespace()
        message.content = [tool_block]
        
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
                UserMessage(id="msg_1", role="user", content="What's the weather?")
            ],
            state={},
            context=[],
            tools=[sample_tool],
            forwarded_props={}
        )
        
        events = []
        async for event in claude_agent.run(input_data):
            events.append(event)
        
        # Should have tool call events
        event_types = [e.type for e in events]
        assert EventType.TOOL_CALL_START in event_types
        assert EventType.TOOL_CALL_END in event_types

    @pytest.mark.asyncio
    @patch('ag_ui_claude.claude_agent.claude_query')
    async def test_tool_result_submission(self, mock_query, claude_agent, sample_tool):
        """Test tool result submission flow."""
        # Mock response after tool result
        text_block = SimpleNamespace()
        text_block.text = "The weather is sunny."
        
        message = SimpleNamespace()
        message.content = [text_block]
        
        result_message = SimpleNamespace()
        result_message.subtype = "success"
        
        async def mock_gen():
            yield message
            yield result_message
        
        mock_query.return_value = mock_gen()
        
        # Input with tool result
        from ag_ui.core import AssistantMessage as AGUIAssistantMessage, ToolCall, FunctionCall
        
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="test_run",
            messages=[
                UserMessage(id="msg_1", role="user", content="What's the weather?"),
                AGUIAssistantMessage(
                    id="msg_2",
                    role="assistant",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id="tool_call_123",
                            function=FunctionCall(
                                name="get_weather",
                                arguments='{"location": "San Francisco"}'
                            )
                        )
                    ]
                ),
                ToolMessage(
                    id="msg_3",
                    role="tool",
                    tool_call_id="tool_call_123",
                    content="Sunny, 72°F"
                )
            ],
            state={},
            context=[],
            tools=[sample_tool],
            forwarded_props={}
        )
        
        events = []
        async for event in claude_agent.run(input_data):
            events.append(event)
        
        # Should process tool result and continue
        assert len(events) > 0

