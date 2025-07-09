#!/usr/bin/env python
"""Test ClientProxyToolset class functionality."""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import Tool as AGUITool
from adk_middleware.client_proxy_toolset import ClientProxyToolset
from adk_middleware.client_proxy_tool import ClientProxyTool
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
    def tool_futures(self):
        """Create tool futures dictionary."""
        return {}
    
    @pytest.fixture
    def toolset(self, sample_tools, mock_event_queue, tool_futures):
        """Create a ClientProxyToolset instance."""
        return ClientProxyToolset(
            ag_ui_tools=sample_tools,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=120
        )
    
    def test_initialization(self, toolset, sample_tools, mock_event_queue, tool_futures):
        """Test ClientProxyToolset initialization."""
        assert toolset.ag_ui_tools == sample_tools
        assert toolset.event_queue == mock_event_queue
        assert toolset.tool_futures == tool_futures
        assert toolset.tool_timeout_seconds == 120
        assert toolset._proxy_tools is None  # Not created yet
    
    @pytest.mark.asyncio
    async def test_get_tools_first_call(self, toolset, sample_tools):
        """Test get_tools creates proxy tools on first call."""
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
        
        # Tools should be cached
        assert toolset._proxy_tools is not None
        assert len(toolset._proxy_tools) == 3
    
    @pytest.mark.asyncio
    async def test_get_tools_cached(self, toolset):
        """Test get_tools returns cached tools on subsequent calls."""
        # First call
        tools1 = await toolset.get_tools()
        
        # Second call
        tools2 = await toolset.get_tools()
        
        # Should return the same instances
        assert tools1 is tools2
        assert len(tools1) == 3
        assert len(tools2) == 3
    
    @pytest.mark.asyncio
    async def test_get_tools_with_readonly_context(self, toolset):
        """Test get_tools with readonly_context parameter."""
        mock_context = MagicMock()
        
        tools = await toolset.get_tools(readonly_context=mock_context)
        
        # Should work (parameter is currently unused but part of interface)
        assert len(tools) == 3
    
    @pytest.mark.asyncio
    async def test_get_tools_empty_list(self, mock_event_queue, tool_futures):
        """Test get_tools with empty tool list."""
        empty_toolset = ClientProxyToolset(
            ag_ui_tools=[],
            event_queue=mock_event_queue,
            tool_futures=tool_futures
        )
        
        tools = await empty_toolset.get_tools()
        
        assert len(tools) == 0
        assert tools == []
    
    @pytest.mark.asyncio
    async def test_get_tools_with_invalid_tool(self, mock_event_queue, tool_futures):
        """Test get_tools handles invalid tool definitions gracefully."""
        # Create a tool that might cause issues
        problematic_tool = AGUITool(
            name="problematic",
            description="Tool that might fail",
            parameters={"invalid": "schema"}
        )
        
        # Mock ClientProxyTool creation to raise exception
        with patch('adk_middleware.client_proxy_toolset.ClientProxyTool') as mock_tool_class:
            mock_tool_class.side_effect = [
                Exception("Failed to create tool"),  # First tool fails
                MagicMock(),  # Second tool succeeds
            ]
            
            toolset = ClientProxyToolset(
                ag_ui_tools=[problematic_tool, AGUITool(name="good", description="Good tool", parameters={})],
                event_queue=mock_event_queue,
                tool_futures=tool_futures
            )
            
            tools = await toolset.get_tools()
            
            # Should continue with other tools despite one failing
            assert len(tools) == 1  # Only the successful tool
    
    @pytest.mark.asyncio
    async def test_close_no_pending_futures(self, toolset, tool_futures):
        """Test close with no pending futures."""
        await toolset.close()
        
        # Should clear cached tools
        assert toolset._proxy_tools is None
        
        # Futures dict should be cleared
        assert len(tool_futures) == 0
    
    @pytest.mark.asyncio
    async def test_close_with_pending_futures(self, toolset, tool_futures):
        """Test close with pending tool futures."""
        # Add some pending futures
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        future3 = asyncio.Future()
        future3.set_result("completed")  # This one is done
        
        tool_futures["tool1"] = future1
        tool_futures["tool2"] = future2
        tool_futures["tool3"] = future3
        
        await toolset.close()
        
        # Pending futures should be cancelled
        assert future1.cancelled()
        assert future2.cancelled()
        assert future3.done()  # Was already done, shouldn't be cancelled
        
        # Dict should be cleared
        assert len(tool_futures) == 0
        
        # Cached tools should be cleared
        assert toolset._proxy_tools is None
    
    @pytest.mark.asyncio
    async def test_close_idempotent(self, toolset):
        """Test that close can be called multiple times safely."""
        await toolset.close()
        await toolset.close()  # Should not raise
        await toolset.close()  # Should not raise
        
        assert toolset._proxy_tools is None
    
    def test_string_representation(self, toolset):
        """Test __repr__ method."""
        repr_str = repr(toolset)
        
        assert "ClientProxyToolset" in repr_str
        assert "calculator" in repr_str
        assert "weather" in repr_str
        assert "simple_tool" in repr_str
    
    def test_string_representation_empty(self, mock_event_queue, tool_futures):
        """Test __repr__ method with empty toolset."""
        empty_toolset = ClientProxyToolset(
            ag_ui_tools=[],
            event_queue=mock_event_queue,
            tool_futures=tool_futures
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
        assert calc_tool.timeout_seconds == 120
    
    @pytest.mark.asyncio
    async def test_shared_state_between_tools(self, toolset, mock_event_queue, tool_futures):
        """Test that all proxy tools share the same event queue and futures dict."""
        tools = await toolset.get_tools()
        
        # All tools should share the same references
        for tool in tools:
            assert tool.event_queue is mock_event_queue
            assert tool.tool_futures is tool_futures
    
    @pytest.mark.asyncio
    async def test_tool_timeout_configuration(self, sample_tools, mock_event_queue, tool_futures):
        """Test that tool timeout is properly configured."""
        custom_timeout = 300  # 5 minutes
        
        toolset = ClientProxyToolset(
            ag_ui_tools=sample_tools,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=custom_timeout
        )
        
        tools = await toolset.get_tools()
        
        # All tools should have the custom timeout
        for tool in tools:
            assert tool.timeout_seconds == custom_timeout
    
    @pytest.mark.asyncio
    async def test_lifecycle_get_tools_then_close(self, toolset, tool_futures):
        """Test complete lifecycle: get tools, add futures, then close."""
        # Get tools (creates proxy tools)
        tools = await toolset.get_tools()
        assert len(tools) == 3
        
        # Simulate some tool executions by adding futures
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        tool_futures["execution1"] = future1
        tool_futures["execution2"] = future2
        
        # Close should clean everything up
        await toolset.close()
        
        # Futures cancelled and cleared
        assert future1.cancelled()
        assert future2.cancelled()
        assert len(tool_futures) == 0
        
        # Tools cleared
        assert toolset._proxy_tools is None
    
    @pytest.mark.asyncio
    async def test_multiple_toolsets_isolation(self, sample_tools, tool_futures):
        """Test that multiple toolsets don't interfere with each other."""
        queue1 = AsyncMock()
        queue2 = AsyncMock()
        futures1 = {}
        futures2 = {}
        
        toolset1 = ClientProxyToolset(sample_tools, queue1, futures1)
        toolset2 = ClientProxyToolset(sample_tools, queue2, futures2)
        
        tools1 = await toolset1.get_tools()
        tools2 = await toolset2.get_tools()
        
        # Should have different tool instances
        assert tools1 is not tools2
        assert len(tools1) == len(tools2) == 3
        
        # Tools should reference their respective queues/futures
        for tool in tools1:
            assert tool.event_queue is queue1
            assert tool.tool_futures is futures1
        
        for tool in tools2:
            assert tool.event_queue is queue2
            assert tool.tool_futures is futures2