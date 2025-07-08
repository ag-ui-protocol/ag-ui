#!/usr/bin/env python
"""Test execution resumption with ToolMessage - the core of hybrid tool execution model."""

import pytest
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, ToolMessage, RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent
)

from adk_middleware import ADKAgent, AgentRegistry
from adk_middleware.execution_state import ExecutionState
from adk_middleware.client_proxy_tool import ClientProxyTool


class TestExecutionResumption:
    """Test cases for execution resumption - the hybrid model's core functionality."""
    
    @pytest.fixture(autouse=True)
    def reset_registry(self):
        """Reset agent registry before each test."""
        AgentRegistry.reset_instance()
        yield
        AgentRegistry.reset_instance()
    
    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool definition."""
        return AGUITool(
            name="calculator",
            description="Performs calculations",
            parameters={
                "type": "object",
                "properties": {
                    "operation": {"type": "string"},
                    "a": {"type": "number"},
                    "b": {"type": "number"}
                },
                "required": ["operation", "a", "b"]
            }
        )
    
    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent for execution resumption testing"
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
    
    @pytest.mark.asyncio
    async def test_execution_state_tool_future_resolution(self):
        """Test ExecutionState's resolve_tool_result method - foundation of resumption."""
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Create a pending tool future
        future = asyncio.Future()
        tool_futures["call_123"] = future
        
        # Test successful resolution
        result = {"answer": 42}
        success = execution.resolve_tool_result("call_123", result)
        
        assert success is True
        assert future.done()
        assert future.result() == result
        assert not execution.has_pending_tools()
    
    @pytest.mark.asyncio
    async def test_execution_state_multiple_tool_resolution(self):
        """Test resolving multiple tool results in sequence."""
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Create multiple pending tool futures
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        future3 = asyncio.Future()
        tool_futures["calc_1"] = future1
        tool_futures["calc_2"] = future2
        tool_futures["calc_3"] = future3
        
        assert execution.has_pending_tools() is True
        
        # Resolve them one by one
        execution.resolve_tool_result("calc_1", {"result": 10})
        assert execution.has_pending_tools() is True  # Still has pending
        
        execution.resolve_tool_result("calc_2", {"result": 20})
        assert execution.has_pending_tools() is True  # Still has pending
        
        execution.resolve_tool_result("calc_3", {"result": 30})
        assert execution.has_pending_tools() is False  # All resolved
        
        # Verify all results
        assert future1.result() == {"result": 10}
        assert future2.result() == {"result": 20}
        assert future3.result() == {"result": 30}
    
    @pytest.mark.asyncio
    async def test_execution_state_nonexistent_tool_resolution(self):
        """Test attempting to resolve a non-existent tool."""
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Try to resolve a tool that doesn't exist
        success = execution.resolve_tool_result("nonexistent", {"result": "ignored"})
        
        assert success is False
        assert not execution.has_pending_tools()
    
    @pytest.mark.asyncio
    async def test_execution_state_already_resolved_tool(self):
        """Test attempting to resolve an already resolved tool."""
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Create and resolve a tool future
        future = asyncio.Future()
        future.set_result({"original": "result"})
        tool_futures["already_done"] = future
        
        # Try to resolve it again
        success = execution.resolve_tool_result("already_done", {"new": "result"})
        
        assert success is False  # Should return False for already done
        assert future.result() == {"original": "result"}  # Original result preserved
    
    @pytest.mark.asyncio
    async def test_tool_result_extraction_single(self, adk_middleware):
        """Test extracting a single tool result from input."""
        tool_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Calculate 5 + 3"),
                ToolMessage(
                    id="2", 
                    role="tool", 
                    content='{"result": 8}', 
                    tool_call_id="calc_001"
                )
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        tool_results = adk_middleware._extract_tool_results(tool_input)
        
        assert len(tool_results) == 1
        assert tool_results[0].role == "tool"
        assert tool_results[0].tool_call_id == "calc_001"
        assert json.loads(tool_results[0].content) == {"result": 8}
    
    @pytest.mark.asyncio
    async def test_tool_result_extraction_multiple(self, adk_middleware):
        """Test extracting multiple tool results from input."""
        tool_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Do some calculations"),
                ToolMessage(id="2", role="tool", content='{"result": 8}', tool_call_id="calc_001"),
                ToolMessage(id="3", role="tool", content='{"result": 15}', tool_call_id="calc_002"),
                ToolMessage(id="4", role="tool", content='{"error": "division by zero"}', tool_call_id="calc_003")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        tool_results = adk_middleware._extract_tool_results(tool_input)
        
        assert len(tool_results) == 3
        
        # Verify each tool result
        assert tool_results[0].tool_call_id == "calc_001"
        assert json.loads(tool_results[0].content) == {"result": 8}
        
        assert tool_results[1].tool_call_id == "calc_002"
        assert json.loads(tool_results[1].content) == {"result": 15}
        
        assert tool_results[2].tool_call_id == "calc_003"
        assert json.loads(tool_results[2].content) == {"error": "division by zero"}
    
    @pytest.mark.asyncio
    async def test_tool_result_extraction_mixed_messages(self, adk_middleware):
        """Test extracting tool results when mixed with other message types."""
        tool_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Start calculation"),
                ToolMessage(id="2", role="tool", content='{"result": 42}', tool_call_id="calc_001"),
                UserMessage(id="3", role="user", content="That looks good"),
                ToolMessage(id="4", role="tool", content='{"result": 100}', tool_call_id="calc_002")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        tool_results = adk_middleware._extract_tool_results(tool_input)
        
        assert len(tool_results) == 2
        assert tool_results[0].tool_call_id == "calc_001"
        assert tool_results[1].tool_call_id == "calc_002"
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_no_active_execution(self, adk_middleware):
        """Test handling tool result when no execution is active - should error gracefully."""
        tool_input = RunAgentInput(
            thread_id="orphaned_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": 8}', tool_call_id="calc_001")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(tool_input):
            events.append(event)
        
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "NO_ACTIVE_EXECUTION"
        assert "No active execution found" in events[0].message
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_with_active_execution(self, adk_middleware):
        """Test the full execution resumption flow - the heart of the hybrid model."""
        # Create a mock execution with pending tools
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Create pending tool futures
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        tool_futures["calc_001"] = future1
        tool_futures["calc_002"] = future2
        
        # Register the execution
        adk_middleware._active_executions["test_thread"] = execution
        
        # Prepare some events for streaming
        await event_queue.put(TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id="msg_1",
            delta="The calculation results are: "
        ))
        await event_queue.put(TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id="msg_1",
            delta="8 and 15"
        ))
        await event_queue.put(None)  # Signal completion
        
        # Create tool result input
        tool_input = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": 8}', tool_call_id="calc_001"),
                ToolMessage(id="2", role="tool", content='{"result": 15}', tool_call_id="calc_002")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Handle the tool result submission
        events = []
        async for event in adk_middleware._handle_tool_result_submission(tool_input):
            events.append(event)
        
        # Verify tool futures were resolved
        assert future1.done()
        assert future1.result() == {"result": 8}
        assert future2.done()
        assert future2.result() == {"result": 15}
        
        # Verify events were streamed
        assert len(events) == 2  # 2 content events (None completion signal doesn't get yielded)
        assert all(isinstance(e, TextMessageContentEvent) for e in events)
        assert events[0].delta == "The calculation results are: "
        assert events[1].delta == "8 and 15"
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_invalid_json(self, adk_middleware):
        """Test handling tool result with invalid JSON content."""
        # Create a mock execution
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
        
        # Create tool result with invalid JSON
        tool_input = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='invalid json content', tool_call_id="calc_001")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(tool_input):
            events.append(event)
        
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "TOOL_RESULT_ERROR"
    
    @pytest.mark.asyncio
    async def test_execution_resumption_with_partial_results(self, adk_middleware):
        """Test resumption when only some tools have results."""
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
        
        # Create three pending tool futures
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        future3 = asyncio.Future()
        tool_futures["calc_001"] = future1
        tool_futures["calc_002"] = future2
        tool_futures["calc_003"] = future3
        
        adk_middleware._active_executions["test_thread"] = execution
        
        # Provide results for only two of the three tools
        tool_input = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": 8}', tool_call_id="calc_001"),
                ToolMessage(id="2", role="tool", content='{"result": 15}', tool_call_id="calc_002")
                # calc_003 deliberately missing
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock _stream_events to return immediately since we have pending tools
        with patch.object(adk_middleware, '_stream_events') as mock_stream:
            mock_stream.return_value = AsyncMock()
            mock_stream.return_value.__aiter__ = AsyncMock(return_value=iter([]))
            
            events = []
            async for event in adk_middleware._handle_tool_result_submission(tool_input):
                events.append(event)
        
        # Verify partial resolution
        assert future1.done()
        assert future1.result() == {"result": 8}
        assert future2.done()
        assert future2.result() == {"result": 15}
        assert not future3.done()  # Still pending
        
        # Execution should still have pending tools
        assert execution.has_pending_tools() is True
    
    @pytest.mark.asyncio
    async def test_execution_resumption_with_tool_call_id_mismatch(self, adk_middleware):
        """Test resumption when tool_call_id doesn't match any pending tools."""
        # Create execution with pending tools
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Create pending tool future
        future1 = asyncio.Future()
        tool_futures["calc_001"] = future1
        
        adk_middleware._active_executions["test_thread"] = execution
        
        # Provide result for non-existent tool
        tool_input = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": 8}', tool_call_id="nonexistent_call")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock logging to capture warnings
        with patch('adk_middleware.adk_agent.logger') as mock_logger:
            with patch.object(adk_middleware, '_stream_events') as mock_stream:
                mock_stream.return_value = AsyncMock()
                mock_stream.return_value.__aiter__ = AsyncMock(return_value=iter([]))
                
                events = []
                async for event in adk_middleware._handle_tool_result_submission(tool_input):
                    events.append(event)
        
        # Should log warning about missing tool
        mock_logger.warning.assert_called_with("No pending tool found for ID nonexistent_call")
        
        # Original future should remain unresolved
        assert not future1.done()
    
    @pytest.mark.asyncio
    async def test_full_execution_lifecycle_simulation(self, adk_middleware, sample_tool):
        """Test complete execution lifecycle: start -> pause at tools -> resume -> complete."""
        # This test simulates the complete hybrid execution flow
        
        # Step 1: Start execution with tools
        initial_input = RunAgentInput(
            thread_id="lifecycle_test",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Calculate 5 + 3 and 10 * 2")
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock ADK execution to emit tool calls and then pause
        mock_events = [
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id="lifecycle_test", run_id="run_1"),
            ToolCallStartEvent(type=EventType.TOOL_CALL_START, tool_call_id="calc_001", tool_call_name="calculator"),
            ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id="calc_001", delta='{"operation": "add", "a": 5, "b": 3}'),
            ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id="calc_001"),
            ToolCallStartEvent(type=EventType.TOOL_CALL_START, tool_call_id="calc_002", tool_call_name="calculator"),
            ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id="calc_002", delta='{"operation": "multiply", "a": 10, "b": 2}'),
            ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id="calc_002"),
            # Execution would pause here waiting for tool results
        ]
        
        with patch.object(adk_middleware, '_start_new_execution') as mock_start:
            async def mock_start_execution(input_data, agent_id):
                for event in mock_events:
                    yield event
            
            mock_start.side_effect = mock_start_execution
            
            # Start execution and collect initial events
            initial_events = []
            async for event in adk_middleware.run(initial_input):
                initial_events.append(event)
        
        # Verify initial execution events
        assert len(initial_events) == len(mock_events)
        assert isinstance(initial_events[0], RunStartedEvent)
        
        # Step 2: Simulate providing tool results (resumption)
        tool_results_input = RunAgentInput(
            thread_id="lifecycle_test",
            run_id="run_2",  # New run ID for tool results
            messages=[
                ToolMessage(id="2", role="tool", content='{"result": 8}', tool_call_id="calc_001"),
                ToolMessage(id="3", role="tool", content='{"result": 20}', tool_call_id="calc_002")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock continued execution after resumption
        resumed_events = [
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="msg_1", role="assistant"),
            TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id="msg_1", delta="The results are 8 and 20."),
            TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="msg_1"),
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="lifecycle_test", run_id="run_2")
        ]
        
        with patch.object(adk_middleware, '_handle_tool_result_submission') as mock_handle:
            async def mock_handle_results(input_data):
                for event in resumed_events:
                    yield event
            
            mock_handle.side_effect = mock_handle_results
            
            # Resume execution with tool results
            resumption_events = []
            async for event in adk_middleware.run(tool_results_input):
                resumption_events.append(event)
        
        # Verify resumption events
        assert len(resumption_events) == len(resumed_events)
        assert isinstance(resumption_events[0], TextMessageStartEvent)
        assert isinstance(resumption_events[-1], RunFinishedEvent)
        
        # Verify the complete lifecycle worked
        assert mock_start.called
        assert mock_handle.called