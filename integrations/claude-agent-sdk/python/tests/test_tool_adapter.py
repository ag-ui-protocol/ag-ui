"""Tests for ToolAdapter."""

import pytest
from unittest.mock import Mock, patch, MagicMock

from ag_ui_claude.tool_adapter import ToolAdapter
from ag_ui.core import Tool as AGUITool


class TestToolAdapter:
    """Test cases for ToolAdapter."""

    @pytest.fixture
    def sample_ag_ui_tool(self):
        """Create a sample AG-UI Tool."""
        return AGUITool(
            name="get_weather",
            description="Get the current weather",
            parameters={
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city and state"
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["celsius", "fahrenheit"]
                    }
                },
                "required": ["location"]
            }
        )

    @pytest.mark.asyncio
    @patch('ag_ui_claude.tool_adapter.SdkMcpTool')
    @patch('ag_ui_claude.tool_adapter.create_sdk_mcp_server')
    async def test_convert_ag_ui_tool_to_claude(self, mock_sdk_tool, mock_mcp_server, sample_ag_ui_tool):
        """Test converting AG-UI tool to Claude SDK format."""
        # Mock SdkMcpTool
        mock_tool_instance = Mock()
        mock_sdk_tool.return_value = mock_tool_instance
        
        try:
            result = ToolAdapter.convert_ag_ui_tool_to_claude(sample_ag_ui_tool)
            assert result is not None
        except ImportError:
            # If claude-agent-sdk is not installed, skip this test
            pytest.skip("claude-agent-sdk not installed")

    @pytest.mark.asyncio
    async def test_convert_ag_ui_tools_to_claude(self, sample_ag_ui_tool):
        """Test converting multiple AG-UI tools."""
        tools = [sample_ag_ui_tool]
        
        try:
            result = ToolAdapter.convert_ag_ui_tools_to_claude(tools)
            assert len(result) == 1
        except ImportError:
            pytest.skip("claude-agent-sdk not installed")

    @pytest.mark.asyncio
    @patch('ag_ui_claude.tool_adapter.create_sdk_mcp_server')
    async def test_create_mcp_server_for_tools(self, mock_create_server, sample_ag_ui_tool):
        """Test creating MCP server for tools."""
        mock_server = Mock()
        mock_create_server.return_value = mock_server
        
        tools = [sample_ag_ui_tool]
        
        try:
            server = ToolAdapter.create_mcp_server_for_tools(
                ag_ui_tools=tools,
                server_name="test_server",
                server_version="1.0.0"
            )
            
            assert server is not None
            mock_create_server.assert_called_once()
        except ImportError:
            pytest.skip("claude-agent-sdk not installed")

    def test_extract_tool_call_id(self):
        """Test extracting tool call ID from ToolUseBlock."""
        tool_block = Mock()
        tool_block.id = "tool_call_123"
        
        tool_id = ToolAdapter.extract_tool_call_id(tool_block)
        assert tool_id == "tool_call_123"

    def test_extract_tool_name(self):
        """Test extracting tool name from ToolUseBlock."""
        tool_block = Mock()
        tool_block.name = "get_weather"
        
        tool_name = ToolAdapter.extract_tool_name(tool_block)
        assert tool_name == "get_weather"

    def test_extract_tool_args(self):
        """Test extracting tool arguments from ToolUseBlock."""
        tool_block = Mock()
        tool_block.input = {"location": "San Francisco"}
        
        args = ToolAdapter.extract_tool_args(tool_block)
        assert args == {"location": "San Francisco"}

    def test_extract_tool_args_empty(self):
        """Test extracting tool arguments when input is empty."""
        tool_block = Mock()
        tool_block.input = {}
        
        args = ToolAdapter.extract_tool_args(tool_block)
        assert args == {}

    def test_is_long_running_tool(self, sample_ag_ui_tool):
        """Test checking if tool is long-running."""
        is_lro = ToolAdapter.is_long_running_tool(sample_ag_ui_tool)
        # Currently all client tools are treated as long-running
        assert is_lro is True

    @pytest.mark.asyncio
    async def test_convert_ag_ui_tool_with_invalid_parameters(self):
        """Test converting tool with invalid parameters."""
        tool = AGUITool(
            name="test_tool",
            description="Test",
            parameters="invalid"  # Not a dict
        )
        
        try:
            result = ToolAdapter.convert_ag_ui_tool_to_claude(tool)
            # Should handle gracefully with empty schema
            assert result is not None
        except ImportError:
            pytest.skip("claude-agent-sdk not installed")

