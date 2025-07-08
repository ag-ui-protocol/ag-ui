#!/usr/bin/env python
"""Test ClientProxyTool class functionality."""

import pytest
import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import Tool as AGUITool, EventType
from ag_ui.core import ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent

from adk_middleware.client_proxy_tool import ClientProxyTool


class TestClientProxyTool:
    """Test cases for ClientProxyTool class."""
    
    @pytest.fixture
    def sample_tool_definition(self):
        """Create a sample AG-UI tool definition."""
        return AGUITool(
            name="test_calculator",
            description="Performs basic arithmetic operations",
            parameters={
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["add", "subtract", "multiply", "divide"],
                        "description": "The arithmetic operation to perform"
                    },
                    "a": {
                        "type": "number",
                        "description": "First number"
                    },
                    "b": {
                        "type": "number", 
                        "description": "Second number"
                    }
                },
                "required": ["operation", "a", "b"]
            }
        )
    
    @pytest.fixture
    def mock_event_queue(self):
        """Create a mock event queue."""
        return AsyncMock()
    
    @pytest.fixture
    def tool_futures(self):
        """Create tool futures dictionary."""
        return {}
    
    @pytest.fixture
    def proxy_tool(self, sample_tool_definition, mock_event_queue, tool_futures):
        """Create a ClientProxyTool instance."""
        return ClientProxyTool(
            ag_ui_tool=sample_tool_definition,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            timeout_seconds=60,
            is_long_running = False
        )
    
    def test_initialization(self, proxy_tool, sample_tool_definition, mock_event_queue, tool_futures):
        """Test ClientProxyTool initialization."""
        assert proxy_tool.name == "test_calculator"
        assert proxy_tool.description == "Performs basic arithmetic operations"
        assert proxy_tool.ag_ui_tool == sample_tool_definition
        assert proxy_tool.event_queue == mock_event_queue
        assert proxy_tool.tool_futures == tool_futures
        assert proxy_tool.timeout_seconds == 60
    
    def test_get_declaration(self, proxy_tool):
        """Test _get_declaration method."""
        declaration = proxy_tool._get_declaration()
        
        assert declaration is not None
        assert declaration.name == "test_calculator"
        assert declaration.description == "Performs basic arithmetic operations"
        assert declaration.parameters is not None
        
        # Check that parameters schema was converted properly
        params = declaration.parameters
        assert hasattr(params, 'type')
    
    def test_get_declaration_with_invalid_parameters(self, mock_event_queue, tool_futures):
        """Test _get_declaration with invalid parameters."""
        invalid_tool = AGUITool(
            name="invalid_tool",
            description="Tool with invalid params",
            parameters="invalid_schema"  # Should be dict
        )
        
        proxy_tool = ClientProxyTool(
            ag_ui_tool=invalid_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            is_long_running = False
        )
        
        declaration = proxy_tool._get_declaration()
        
        # Should default to empty object schema
        assert declaration is not None
        assert declaration.parameters is not None
    
    @pytest.mark.asyncio
    async def test_run_async_success(self, proxy_tool, mock_event_queue, tool_futures):
        """Test successful tool execution."""
        args = {"operation": "add", "a": 5, "b": 3}
        mock_context = MagicMock()
        expected_result = {"result": 8}
        
        # Mock UUID generation for predictable tool_call_id
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="test-uuid-123")
            
            # Start the tool execution
            execution_task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_context)
            )
            
            # Wait a moment for events to be queued
            await asyncio.sleep(0.01)
            
            # Verify events were emitted in correct order
            assert mock_event_queue.put.call_count == 3
            
            # Check TOOL_CALL_START event
            start_event = mock_event_queue.put.call_args_list[0][0][0]
            assert isinstance(start_event, ToolCallStartEvent)
            assert start_event.tool_call_id == "test-uuid-123"
            assert start_event.tool_call_name == "test_calculator"
            
            # Check TOOL_CALL_ARGS event
            args_event = mock_event_queue.put.call_args_list[1][0][0]
            assert isinstance(args_event, ToolCallArgsEvent)
            assert args_event.tool_call_id == "test-uuid-123"
            assert json.loads(args_event.delta) == args
            
            # Check TOOL_CALL_END event
            end_event = mock_event_queue.put.call_args_list[2][0][0]
            assert isinstance(end_event, ToolCallEndEvent)
            assert end_event.tool_call_id == "test-uuid-123"
            
            # Verify future was created
            assert "test-uuid-123" in tool_futures
            future = tool_futures["test-uuid-123"]
            assert isinstance(future, asyncio.Future)
            assert not future.done()
            
            # Simulate client providing result
            future.set_result(expected_result)
            
            # Tool execution should complete
            result = await execution_task
            assert result == expected_result
    
    @pytest.mark.asyncio
    async def test_run_async_timeout(self, proxy_tool, mock_event_queue, tool_futures):
        """Test tool execution timeout."""
        args = {"operation": "add", "a": 5, "b": 3}
        mock_context = MagicMock()
        
        # Create proxy tool with very short timeout
        short_timeout_tool = ClientProxyTool(
            ag_ui_tool=proxy_tool.ag_ui_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            is_long_running = False,
            timeout_seconds=0.01  # 10ms timeout
        )
        
        with pytest.raises(TimeoutError) as exc_info:
            await short_timeout_tool.run_async(args=args, tool_context=mock_context)
        
        assert "timed out after 0.01 seconds" in str(exc_info.value)
        
        # Future should be cleaned up
        # Note: The tool_call_id is random, so we check if dict is empty
        assert len(tool_futures) == 0
    
    @pytest.mark.asyncio
    async def test_run_async_event_queue_error(self, proxy_tool, tool_futures):
        """Test handling of event queue errors."""
        args = {"operation": "add", "a": 5, "b": 3}
        mock_context = MagicMock()
        
        # Mock event queue to raise error
        error_queue = AsyncMock()
        error_queue.put.side_effect = RuntimeError("Queue error")
        
        proxy_tool.event_queue = error_queue
        
        with pytest.raises(RuntimeError) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)
        
        assert "Queue error" in str(exc_info.value)
        
        # Future should be cleaned up on error
        assert len(tool_futures) == 0
    
    @pytest.mark.asyncio
    async def test_run_async_future_exception(self, proxy_tool, mock_event_queue, tool_futures):
        """Test tool execution when future gets an exception."""
        args = {"operation": "divide", "a": 5, "b": 0}
        mock_context = MagicMock()
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="test-uuid-456")
            
            # Start the tool execution
            execution_task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_context)
            )
            
            # Wait for future to be created
            await asyncio.sleep(0.01)
            
            # Simulate client providing exception
            future = tool_futures["test-uuid-456"]
            future.set_exception(ValueError("Division by zero"))
            
            # Tool execution should raise the exception
            with pytest.raises(ValueError) as exc_info:
                await execution_task
            
            assert "Division by zero" in str(exc_info.value)
    
    @pytest.mark.asyncio
    async def test_run_async_cancellation(self, proxy_tool, mock_event_queue, tool_futures):
        """Test tool execution cancellation."""
        args = {"operation": "multiply", "a": 7, "b": 6}
        mock_context = MagicMock()
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="test-uuid-789")
            
            # Start the tool execution
            execution_task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_context)
            )
            
            # Wait for future to be created
            await asyncio.sleep(0.01)
            
            # Cancel the execution
            execution_task.cancel()
            
            # Should raise CancelledError
            with pytest.raises(asyncio.CancelledError):
                await execution_task
            
            # Future should still exist but be cancelled
            assert len(tool_futures) == 1
            future = tool_futures["test-uuid-789"]
            assert future.cancelled()
    
    def test_string_representation(self, proxy_tool):
        """Test __repr__ method."""
        repr_str = repr(proxy_tool)
        
        assert "ClientProxyTool" in repr_str
        assert "test_calculator" in repr_str
        assert "Performs basic arithmetic operations" in repr_str
    
    @pytest.mark.asyncio
    async def test_multiple_concurrent_executions(self, proxy_tool, mock_event_queue, tool_futures):
        """Test multiple concurrent tool executions."""
        args1 = {"operation": "add", "a": 1, "b": 2}
        args2 = {"operation": "subtract", "a": 10, "b": 5}
        mock_context = MagicMock()
        
        # Start two concurrent executions
        task1 = asyncio.create_task(
            proxy_tool.run_async(args=args1, tool_context=mock_context)
        )
        task2 = asyncio.create_task(
            proxy_tool.run_async(args=args2, tool_context=mock_context)
        )
        
        # Wait for futures to be created
        await asyncio.sleep(0.01)
        
        # Should have two futures
        assert len(tool_futures) == 2
        
        # Resolve both futures
        futures = list(tool_futures.values())
        futures[0].set_result({"result": 3})
        futures[1].set_result({"result": 5})
        
        # Both should complete successfully
        result1 = await task1
        result2 = await task2
        
        assert result1 == {"result": 3} or result1 == {"result": 5}
        assert result2 == {"result": 3} or result2 == {"result": 5}
        assert result1 != result2  # Should be different results
    
    @pytest.mark.asyncio
    async def test_json_serialization_in_args(self, proxy_tool, mock_event_queue, tool_futures):
        """Test that complex arguments are properly JSON serialized."""
        complex_args = {
            "operation": "custom",
            "config": {
                "precision": 2,
                "rounding": "up",
                "metadata": ["tag1", "tag2"]
            },
            "values": [1.5, 2.7, 3.9]
        }
        mock_context = MagicMock()
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="complex-test")
            
            # Start execution
            task = asyncio.create_task(
                proxy_tool.run_async(args=complex_args, tool_context=mock_context)
            )
            
            await asyncio.sleep(0.01)
            
            # Check that args were properly serialized in the event
            args_event = mock_event_queue.put.call_args_list[1][0][0]
            serialized_args = json.loads(args_event.delta)
            assert serialized_args == complex_args
            
            # Complete the execution
            future = tool_futures["complex-test"]
            future.set_result({"processed": True})
            
            await task