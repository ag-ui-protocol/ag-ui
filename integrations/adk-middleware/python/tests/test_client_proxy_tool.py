#!/usr/bin/env python
"""Test ClientProxyTool class functionality."""

import pytest
import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import Tool as AGUITool, EventType
from ag_ui.core import ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent

from ag_ui_adk.client_proxy_tool import ClientProxyTool


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
    def proxy_tool(self, sample_tool_definition, mock_event_queue):
        """Create a ClientProxyTool instance."""
        return ClientProxyTool(
            ag_ui_tool=sample_tool_definition,
            event_queue=mock_event_queue
        )

    def test_initialization(self, proxy_tool, sample_tool_definition, mock_event_queue):
        """Test ClientProxyTool initialization."""
        assert proxy_tool.name == "test_calculator"
        assert proxy_tool.description == "Performs basic arithmetic operations"
        assert proxy_tool.ag_ui_tool == sample_tool_definition
        assert proxy_tool.event_queue == mock_event_queue

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

    def test_get_declaration_with_invalid_parameters(self, mock_event_queue):
        """Test _get_declaration with invalid parameters."""
        invalid_tool = AGUITool(
            name="invalid_tool",
            description="Tool with invalid params",
            parameters="invalid_schema"  # Should be dict
        )

        proxy_tool = ClientProxyTool(
            ag_ui_tool=invalid_tool,
            event_queue=mock_event_queue
        )

        declaration = proxy_tool._get_declaration()

        # Should default to empty object schema
        assert declaration is not None
        assert declaration.parameters is not None

    @pytest.mark.asyncio
    async def test_run_async_success(self, proxy_tool, mock_event_queue):
        """Test successful tool execution with long-running behavior."""
        args = {"operation": "add", "a": 5, "b": 3}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Mock UUID generation for predictable tool_call_id
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.hex = "abc123456789abcdef012345"  # Valid hex string

            # Execute the tool - should return None immediately (long-running)
            result = await proxy_tool.run_async(args=args, tool_context=mock_context)

            # All client tools are long-running and return None
            assert result is None

            # Verify events were emitted in correct order
            assert mock_event_queue.put.call_count == 3

            # Check TOOL_CALL_START event
            start_event = mock_event_queue.put.call_args_list[0][0][0]
            assert isinstance(start_event, ToolCallStartEvent)
            assert start_event.tool_call_id == "test_function_call_id"  # Uses ADK function call ID
            assert start_event.tool_call_name == "test_calculator"

            # Check TOOL_CALL_ARGS event
            args_event = mock_event_queue.put.call_args_list[1][0][0]
            assert isinstance(args_event, ToolCallArgsEvent)
            assert args_event.tool_call_id == "test_function_call_id"  # Uses ADK function call ID
            assert json.loads(args_event.delta) == args

            # Check TOOL_CALL_END event
            end_event = mock_event_queue.put.call_args_list[2][0][0]
            assert isinstance(end_event, ToolCallEndEvent)
            assert end_event.tool_call_id == "test_function_call_id"  # Uses ADK function call ID


    @pytest.mark.asyncio
    async def test_run_async_event_queue_error(self, proxy_tool):
        """Test handling of event queue errors."""
        args = {"operation": "add", "a": 5, "b": 3}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Mock event queue to raise error
        error_queue = AsyncMock()
        error_queue.put.side_effect = RuntimeError("Queue error")

        proxy_tool.event_queue = error_queue

        with pytest.raises(RuntimeError) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)

        assert "Queue error" in str(exc_info.value)


    def test_string_representation(self, proxy_tool):
        """Test __repr__ method."""
        repr_str = repr(proxy_tool)

        assert "ClientProxyTool" in repr_str
        assert "test_calculator" in repr_str
        # The repr shows the tool name, not the description
        assert "name='test_calculator'" in repr_str
        assert "ag_ui_tool='test_calculator'" in repr_str

    @pytest.mark.asyncio
    async def test_multiple_concurrent_executions(self, proxy_tool, mock_event_queue):
        """Test multiple concurrent tool executions with long-running behavior."""
        args1 = {"operation": "add", "a": 1, "b": 2}
        args2 = {"operation": "subtract", "a": 10, "b": 5}
        mock_context = MagicMock()
        mock_context.function_call_id = "test_function_call_id"

        # Start two concurrent executions - both should return None immediately
        task1 = asyncio.create_task(
            proxy_tool.run_async(args=args1, tool_context=mock_context)
        )
        task2 = asyncio.create_task(
            proxy_tool.run_async(args=args2, tool_context=mock_context)
        )

        # Both should complete successfully with None (long-running)
        result1 = await task1
        result2 = await task2

        assert result1 is None
        assert result2 is None

        # Should have emitted events for both executions
        # Each execution emits 3 events, so 6 total
        assert mock_event_queue.put.call_count == 6

    @pytest.mark.asyncio
    async def test_json_serialization_in_args(self, proxy_tool, mock_event_queue):
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
        mock_context.function_call_id = "test_function_call_id"

        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="complex-test")

            # Execute the tool - should return None immediately
            result = await proxy_tool.run_async(args=complex_args, tool_context=mock_context)

            # Should return None (long-running behavior)
            assert result is None

            # Check that args were properly serialized in the event
            args_event = mock_event_queue.put.call_args_list[1][0][0]
            serialized_args = json.loads(args_event.delta)
            assert serialized_args == complex_args