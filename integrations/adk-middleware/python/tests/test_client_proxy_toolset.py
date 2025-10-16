#!/usr/bin/env python
"""Test ClientProxyToolset class functionality."""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import Tool as AGUITool
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset
from ag_ui_adk.client_proxy_tool import ClientProxyTool
from google.adk.tools import FunctionTool, LongRunningFunctionTool


class TestClientProxyToolset:
    """Test cases for ClientProxyToolset class."""

    @pytest.fixture
    def sample_tools(self):
        """Create sample AG-UI tool definitions."""
        return [
            AGUITool(
                name="calculator",
                description="Basic arithmetic operations",
                parameters={
                    "type": "object",
                    "properties": {
                        "operation": {"type": "string"},
                        "a": {"type": "number"},
                        "b": {"type": "number"}
                    }
                }
            ),
            AGUITool(
                name="weather",
                description="Get weather information",
                parameters={
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"},
                        "units": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                    }
                }
            ),
            AGUITool(
                name="simple_tool",
                description="A simple tool with no parameters",
                parameters={}
            )
        ]

    @pytest.fixture
    def mock_event_queue(self):
        """Create a mock event queue."""
        return AsyncMock()

    @pytest.fixture
    def toolset(self, sample_tools, mock_event_queue):
        """Create a ClientProxyToolset instance."""
        return ClientProxyToolset(
            ag_ui_tools=sample_tools,
            event_queue=mock_event_queue
        )

    def test_initialization(self, toolset, sample_tools, mock_event_queue):
        """Test ClientProxyToolset initialization."""
        assert toolset.ag_ui_tools == sample_tools
        assert toolset.event_queue == mock_event_queue

    @pytest.mark.asyncio
    async def test_get_tools_first_call(self, toolset, sample_tools):
        """Test get_tools creates proxy tools."""
        tools = await toolset.get_tools()

        # Should have created 3 proxy tools
        assert len(tools) == 3

        # All should be ClientProxyTool instances
        for tool in tools:
            assert isinstance(tool, ClientProxyTool)

        # Should have correct names
        tool_names = [tool.name for tool in tools]
        assert "calculator" in tool_names
        assert "weather" in tool_names
        assert "simple_tool" in tool_names

    @pytest.mark.asyncio
    async def test_get_tools_fresh_instances(self, toolset):
        """Test get_tools creates fresh tool instances on each call."""
        # First call
        tools1 = await toolset.get_tools()

        # Second call
        tools2 = await toolset.get_tools()

        # Should create fresh instances (no caching)
        assert tools1 is not tools2
        assert len(tools1) == 3
        assert len(tools2) == 3

        # But should have same tool names
        names1 = {tool.name for tool in tools1}
        names2 = {tool.name for tool in tools2}
        assert names1 == names2

    @pytest.mark.asyncio
    async def test_get_tools_with_readonly_context(self, toolset):
        """Test get_tools with readonly_context parameter."""
        mock_context = MagicMock()

        tools = await toolset.get_tools(readonly_context=mock_context)

        # Should work (parameter is currently unused but part of interface)
        assert len(tools) == 3

    @pytest.mark.asyncio
    async def test_get_tools_empty_list(self, mock_event_queue):
        """Test get_tools with empty tool list."""
        empty_toolset = ClientProxyToolset(
            ag_ui_tools=[],
            event_queue=mock_event_queue
        )

        tools = await empty_toolset.get_tools()

        assert len(tools) == 0
        assert tools == []

    @pytest.mark.asyncio
    async def test_get_tools_with_invalid_tool(self, mock_event_queue):
        """Test get_tools handles invalid tool definitions gracefully."""
        # Create a tool that might cause issues
        problematic_tool = AGUITool(
            name="problematic",
            description="Tool that might fail",
            parameters={"invalid": "schema"}
        )

        # Mock ClientProxyTool creation to raise exception
        with patch('ag_ui_adk.client_proxy_toolset.ClientProxyTool') as mock_tool_class:
            mock_tool_class.side_effect = [
                Exception("Failed to create tool"),  # First tool fails
                MagicMock(),  # Second tool succeeds
            ]

            toolset = ClientProxyToolset(
                ag_ui_tools=[problematic_tool, AGUITool(name="good", description="Good tool", parameters={})],
                event_queue=mock_event_queue
            )

            tools = await toolset.get_tools()

            # Should continue with other tools despite one failing
            assert len(tools) == 1  # Only the successful tool

    @pytest.mark.asyncio
    async def test_close_no_pending_futures(self, toolset):
        """Test close method completes successfully."""
        await toolset.close()

        # Close should complete without error
        # No cached tools to clean up in new architecture

    @pytest.mark.asyncio
    async def test_close_with_pending_futures(self, toolset):
        """Test close method completes successfully."""
        await toolset.close()

        # Close should complete without error
        # No tool futures to clean up in new architecture

    @pytest.mark.asyncio
    async def test_close_idempotent(self, toolset):
        """Test that close can be called multiple times safely."""
        await toolset.close()
        await toolset.close()  # Should not raise
        await toolset.close()  # Should not raise

        # All calls should complete without error

    def test_string_representation(self, toolset):
        """Test __repr__ method."""
        repr_str = repr(toolset)

        assert "ClientProxyToolset" in repr_str
        assert "calculator" in repr_str
        assert "weather" in repr_str
        assert "simple_tool" in repr_str

    def test_string_representation_empty(self, mock_event_queue):
        """Test __repr__ method with empty toolset."""
        empty_toolset = ClientProxyToolset(
            ag_ui_tools=[],
            event_queue=mock_event_queue
        )

        repr_str = repr(empty_toolset)

        assert "ClientProxyToolset" in repr_str
        assert "tools=[]" in repr_str

    @pytest.mark.asyncio
    async def test_tool_properties_preserved(self, toolset, sample_tools):
        """Test that tool properties are correctly preserved in proxy tools."""
        tools = await toolset.get_tools()

        # Find calculator tool
        calc_tool = next(tool for tool in tools if tool.name == "calculator")

        assert calc_tool.name == "calculator"
        assert calc_tool.description == "Basic arithmetic operations"
        assert calc_tool.ag_ui_tool == sample_tools[0]  # Should reference original

    @pytest.mark.asyncio
    async def test_shared_state_between_tools(self, toolset, mock_event_queue):
        """Test that all proxy tools share the same event queue."""
        tools = await toolset.get_tools()

        # All tools should share the same references
        for tool in tools:
            assert tool.event_queue is mock_event_queue

    @pytest.mark.asyncio
    async def test_tool_timeout_configuration(self, sample_tools, mock_event_queue):
        """Test that tool timeout is properly configured."""
        # Tool timeout configuration was removed in all-long-running architecture
        toolset = ClientProxyToolset(
            ag_ui_tools=sample_tools,
            event_queue=mock_event_queue
        )

        tools = await toolset.get_tools()

        # All tools should be created successfully
        assert len(tools) == len(sample_tools)

    @pytest.mark.asyncio
    async def test_lifecycle_get_tools_then_close(self, toolset):
        """Test complete lifecycle: get tools, then close."""
        # Get tools (creates proxy tools)
        tools = await toolset.get_tools()
        assert len(tools) == 3

        # Close should complete without error
        await toolset.close()

        # Can still get tools after close (creates fresh instances)
        tools_after_close = await toolset.get_tools()
        assert len(tools_after_close) == 3

    @pytest.mark.asyncio
    async def test_multiple_toolsets_isolation(self, sample_tools):
        """Test that multiple toolsets don't interfere with each other."""
        queue1 = AsyncMock()
        queue2 = AsyncMock()

        toolset1 = ClientProxyToolset(sample_tools, queue1)
        toolset2 = ClientProxyToolset(sample_tools, queue2)

        tools1 = await toolset1.get_tools()
        tools2 = await toolset2.get_tools()

        # Should have different tool instances
        assert tools1 is not tools2
        assert len(tools1) == len(tools2) == 3

        # Tools should reference their respective queues
        for tool in tools1:
            assert tool.event_queue is queue1

        for tool in tools2:
            assert tool.event_queue is queue2