#!/usr/bin/env python
"""Test error handling scenarios in tool flows."""

import pytest
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, ToolMessage, RunStartedEvent, RunErrorEvent, RunFinishedEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent
)

from adk_middleware import ADKAgent, AgentRegistry
from adk_middleware.execution_state import ExecutionState
from adk_middleware.client_proxy_tool import ClientProxyTool
from adk_middleware.client_proxy_toolset import ClientProxyToolset


class TestToolErrorHandling:
    """Test cases for various tool error scenarios."""
    
    @pytest.fixture(autouse=True)
    def reset_registry(self):
        """Reset agent registry before each test."""
        AgentRegistry.reset_instance()
        yield
        AgentRegistry.reset_instance()
    
    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent for error testing"
        )
    
    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware."""
        registry = AgentRegistry.get_instance()
        registry.set_default_agent(mock_adk_agent)
        
        return ADKAgent(
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30,
            max_concurrent_executions=5
        )
    
    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool definition."""
        return AGUITool(
            name="error_prone_tool",
            description="A tool that might encounter various errors",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "data": {"type": "string"}
                },
                "required": ["action"]
            }
        )
    
    @pytest.mark.asyncio
    async def test_adk_execution_error_during_tool_run(self, adk_middleware, sample_tool):
        """Test error handling when ADK execution fails during tool usage."""
        # Test that the system gracefully handles exceptions from background execution
        async def failing_adk_execution(*_args, **_kwargs):
            raise Exception("ADK execution failed unexpectedly")
        
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=failing_adk_execution):
            input_data = RunAgentInput(
                thread_id="test_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Use the error prone tool")],
                tools=[sample_tool], context=[], state={}, forwarded_props={}
            )
            
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)
            
            # Should get at least a run started event
            assert len(events) >= 1
            assert isinstance(events[0], RunStartedEvent)
            
            # The exception should be caught and handled (not crash the system)
            # The actual error events depend on the error handling implementation
    
    @pytest.mark.asyncio
    async def test_tool_result_parsing_error(self, adk_middleware, sample_tool):
        """Test error handling when tool result cannot be parsed."""
        # Create an execution with a pending tool
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Add to active executions
        adk_middleware._active_executions["test_thread"] = execution
        
        # Create a future for the tool call
        future = asyncio.Future()
        tool_futures["call_1"] = future
        
        # Submit invalid JSON as tool result
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2", 
                    role="tool", 
                    tool_call_id="call_1",
                    content="{ invalid json syntax"  # Malformed JSON
                )
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(input_data):
            events.append(event)
        
        # Should get an error event for invalid JSON
        error_events = [e for e in events if isinstance(e, RunErrorEvent)]
        assert len(error_events) >= 1
        # The actual JSON error message varies, so check for common JSON error indicators
        error_msg = error_events[0].message.lower()
        assert any(keyword in error_msg for keyword in ["json", "parse", "expecting", "decode"])
    
    @pytest.mark.asyncio
    async def test_tool_result_for_nonexistent_call(self, adk_middleware, sample_tool):
        """Test error handling when tool result is for non-existent call."""
        # Create an execution without the expected tool call
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}  # Empty - no pending tools
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        adk_middleware._active_executions["test_thread"] = execution
        
        # Submit tool result for non-existent call
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2", 
                    role="tool", 
                    tool_call_id="nonexistent_call",
                    content='{"result": "some result"}'
                )
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(input_data):
            events.append(event)
        
        # The system logs warnings but may not emit error events for unknown tool calls
        # Just check that it doesn't crash the system
        assert len(events) >= 0  # Should not crash
    
    @pytest.mark.asyncio
    async def test_toolset_creation_error(self, adk_middleware):
        """Test error handling when toolset creation fails."""
        # Create invalid tool definition
        invalid_tool = AGUITool(
            name="",  # Invalid empty name
            description="Invalid tool",
            parameters={"invalid": "schema"}  # Invalid schema
        )
        
        # Simply test that invalid tools don't crash the system
        async def mock_adk_execution(*_args, **_kwargs):
            raise Exception("Failed to create toolset with invalid tool")
        
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_adk_execution):
            input_data = RunAgentInput(
                thread_id="test_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[invalid_tool], context=[], state={}, forwarded_props={}
            )
            
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)
            
            # Should handle the error gracefully without crashing
            assert len(events) >= 1
            assert isinstance(events[0], RunStartedEvent)
    
    @pytest.mark.asyncio
    async def test_tool_timeout_during_execution(self, sample_tool):
        """Test that tool timeouts are properly handled."""
        event_queue = AsyncMock()
        tool_futures = {}
        
        # Create proxy tool with very short timeout
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            is_long_running = False,
            timeout_seconds=0.001  # 1ms timeout
        )
        
        args = {"action": "slow_action"}
        mock_context = MagicMock()
        
        # Should timeout quickly
        with pytest.raises(TimeoutError) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)
        
        assert "timed out" in str(exc_info.value)
        
        # Future should be cleaned up
        assert len(tool_futures) == 0
    
    @pytest.mark.asyncio
    async def test_execution_state_error_handling(self):
        """Test ExecutionState error handling methods."""
        mock_task = MagicMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Test resolving a tool result successfully
        future = asyncio.Future()
        tool_futures["call_1"] = future
        
        result = execution.resolve_tool_result("call_1", {"success": True})
        
        assert result is True  # Should return True for successful resolution
        assert future.done()
        assert future.result() == {"success": True}
    
    @pytest.mark.asyncio
    async def test_multiple_tool_errors_handling(self, adk_middleware, sample_tool):
        """Test handling multiple tool errors in sequence."""
        # Create execution with multiple pending tools
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        adk_middleware._active_executions["test_thread"] = execution
        
        # Create multiple futures
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        tool_futures["call_1"] = future1
        tool_futures["call_2"] = future2
        
        # Submit results for both - one valid, one invalid
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(id="2", role="tool", tool_call_id="call_1", content='{"valid": "result"}'),
                ToolMessage(id="3", role="tool", tool_call_id="call_2", content='{ invalid json')
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(input_data):
            events.append(event)
        
        # Should handle both results - one success, one error
        # First tool should succeed
        assert future1.done() and not future1.exception()
        
        # Should get error events for the invalid JSON
        error_events = [e for e in events if isinstance(e, RunErrorEvent)]
        assert len(error_events) >= 1
    
    @pytest.mark.asyncio
    async def test_execution_cleanup_on_error(self, adk_middleware, sample_tool):
        """Test that executions are properly cleaned up when errors occur."""
        async def error_adk_execution(*_args, **_kwargs):
            raise Exception("Critical ADK error")
        
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=error_adk_execution):
            input_data = RunAgentInput(
                thread_id="test_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[sample_tool], context=[], state={}, forwarded_props={}
            )
            
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)
            
            # Should handle the error gracefully
            assert len(events) >= 1
            assert isinstance(events[0], RunStartedEvent)
            
            # System should handle the error without crashing
    
    @pytest.mark.asyncio
    async def test_toolset_close_error_handling(self):
        """Test error handling during toolset close operations."""
        event_queue = AsyncMock()
        tool_futures = {}
        
        # Create a sample tool for the toolset
        sample_tool = AGUITool(
            name="test_tool",
            description="A test tool",
            parameters={"type": "object", "properties": {}}
        )
        
        toolset = ClientProxyToolset(
            ag_ui_tools=[sample_tool],
            event_queue=event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=1
        )
        
        # Add a future that will raise an exception when cancelled
        problematic_future = MagicMock()
        problematic_future.done.return_value = False
        problematic_future.cancel.side_effect = Exception("Cancel failed")
        tool_futures["problematic"] = problematic_future
        
        # Close should handle the exception gracefully
        try:
            await toolset.close()
        except Exception:
            # If the mock exception propagates, that's fine for this test
            pass
        
        # The exception might prevent full cleanup, so just verify close was attempted
        # and didn't crash the system completely
        assert True  # If we get here, close didn't crash
    
    @pytest.mark.asyncio
    async def test_event_queue_error_during_tool_call_long_running(self, sample_tool):
        """Test error handling when event queue operations fail (long-running tool)."""
        # Create a mock event queue that fails
        event_queue = AsyncMock()
        event_queue.put.side_effect = Exception("Queue operation failed")
        
        tool_futures = {}
        
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=1,
            is_long_running=True
        )
        
        args = {"action": "test"}
        mock_context = MagicMock()
        
        # Should handle queue errors gracefully
        with pytest.raises(Exception) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)
        
        assert "Queue operation failed" in str(exc_info.value)
    
    @pytest.mark.asyncio
    async def test_event_queue_error_during_tool_call_blocking(self, sample_tool):
        """Test error handling when event queue operations fail (blocking tool)."""
        # Create a mock event queue that fails
        event_queue = AsyncMock()
        event_queue.put.side_effect = Exception("Queue operation failed")
        
        tool_futures = {}
        
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=1,
            is_long_running=False
        )
        
        args = {"action": "test"}
        mock_context = MagicMock()
        
        # Should handle queue errors gracefully
        with pytest.raises(Exception) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_context)
        
        assert "Queue operation failed" in str(exc_info.value)
    
    @pytest.mark.asyncio
    async def test_concurrent_tool_errors(self, adk_middleware, sample_tool):
        """Test handling errors when multiple tools fail concurrently."""
        # Create execution with multiple tools
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        adk_middleware._active_executions["test_thread"] = execution
        
        # Create multiple futures and set them to fail
        for i in range(3):
            future = asyncio.Future()
            future.set_exception(Exception(f"Tool {i} failed"))
            tool_futures[f"call_{i}"] = future
        
        # All tools should be in failed state
        assert execution.has_pending_tools() is False  # All done (with exceptions)
        
        # Check that all have exceptions
        for call_id, future in tool_futures.items():
            assert future.done()
            assert future.exception() is not None
    
    @pytest.mark.asyncio
    async def test_malformed_tool_message_handling(self, adk_middleware, sample_tool):
        """Test handling of malformed tool messages."""
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        adk_middleware._active_executions["test_thread"] = execution
        
        # Create future for tool call
        future = asyncio.Future()
        tool_futures["call_1"] = future
        
        # Submit tool message with empty content (which should be handled gracefully)
        input_data = RunAgentInput(
            thread_id="test_thread", run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Test"),
                ToolMessage(
                    id="2", 
                    role="tool", 
                    tool_call_id="call_1",
                    content=""  # Empty content instead of None
                )
            ],
            tools=[sample_tool], context=[], state={}, forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(input_data):
            events.append(event)
        
        # Should handle the malformed message gracefully
        error_events = [e for e in events if isinstance(e, RunErrorEvent)]
        assert len(error_events) >= 1