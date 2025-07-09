#!/usr/bin/env python
"""Test tool result submission flow in ADKAgent."""

import pytest
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, ToolMessage, RunStartedEvent, RunFinishedEvent, RunErrorEvent
)

from adk_middleware import ADKAgent, AgentRegistry


class TestToolResultFlow:
    """Test cases for tool result submission flow."""
    
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
            name="test_tool",
            description="A test tool",
            parameters={
                "type": "object",
                "properties": {
                    "input": {"type": "string"}
                }
            }
        )
    
    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent for tool flow testing"
        )
    
    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware with mocked dependencies."""
        # Register the mock agent
        registry = AgentRegistry.get_instance()
        registry.set_default_agent(mock_adk_agent)
        
        return ADKAgent(
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30
        )
    
    def test_is_tool_result_submission_with_tool_message(self, adk_middleware):
        """Test detection of tool result submission."""
        # Input with tool message as last message
        input_with_tool = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Do something"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        assert adk_middleware._is_tool_result_submission(input_with_tool) is True
    
    def test_is_tool_result_submission_with_user_message(self, adk_middleware):
        """Test detection when last message is not a tool result."""
        # Input with user message as last message
        input_without_tool = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                UserMessage(id="2", role="user", content="How are you?")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        assert adk_middleware._is_tool_result_submission(input_without_tool) is False
    
    def test_is_tool_result_submission_empty_messages(self, adk_middleware):
        """Test detection with empty messages."""
        empty_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        assert adk_middleware._is_tool_result_submission(empty_input) is False
    
    def test_extract_tool_results_single_tool(self, adk_middleware):
        """Test extraction of single tool result."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        tool_results = adk_middleware._extract_tool_results(input_data)
        
        assert len(tool_results) == 1
        assert tool_results[0].role == "tool"
        assert tool_results[0].tool_call_id == "call_1"
        assert tool_results[0].content == '{"result": "success"}'
    
    def test_extract_tool_results_multiple_tools(self, adk_middleware):
        """Test extraction of multiple tool results."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "first"}', tool_call_id="call_1"),
                ToolMessage(id="3", role="tool", content='{"result": "second"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        tool_results = adk_middleware._extract_tool_results(input_data)
        
        assert len(tool_results) == 2
        tool_call_ids = [msg.tool_call_id for msg in tool_results]
        assert "call_1" in tool_call_ids
        assert "call_2" in tool_call_ids
    
    def test_extract_tool_results_mixed_messages(self, adk_middleware):
        """Test extraction when mixed with other message types."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1"),
                UserMessage(id="3", role="user", content="Thanks"),
                ToolMessage(id="4", role="tool", content='{"result": "done"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        tool_results = adk_middleware._extract_tool_results(input_data)
        
        assert len(tool_results) == 2
        # Should only extract tool messages, not user messages
        for result in tool_results:
            assert result.role == "tool"
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_no_active_execution(self, adk_middleware):
        """Test handling tool result when no active execution exists."""
        input_data = RunAgentInput(
            thread_id="nonexistent_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(input_data):
            events.append(event)
        
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "NO_ACTIVE_EXECUTION"
        assert "No active execution found" in events[0].message
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_with_active_execution(self, adk_middleware):
        """Test handling tool result with active execution."""
        thread_id = "test_thread"
        
        # Create a mock execution state
        mock_execution = MagicMock()
        mock_execution.resolve_tool_result.return_value = True
        mock_execution.tool_futures = {"call_1": AsyncMock()}  # Add the tool future
        mock_event_queue = AsyncMock()
        
        # Add mock execution to active executions
        async with adk_middleware._execution_lock:
            adk_middleware._active_executions[thread_id] = mock_execution
        
        # Mock the _stream_events method
        mock_events = [
            MagicMock(type=EventType.TEXT_MESSAGE_CONTENT),
            MagicMock(type=EventType.TEXT_MESSAGE_END)
        ]
        
        async def mock_stream_events(execution):
            for event in mock_events:
                yield event
        
        with patch.object(adk_middleware, '_stream_events', side_effect=mock_stream_events):
            input_data = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={}
            )
            
            events = []
            async for event in adk_middleware._handle_tool_result_submission(input_data):
                events.append(event)
            
            # Should receive events from _stream_events
            assert len(events) == 2
            assert mock_execution.resolve_tool_result.called
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_resolve_failure(self, adk_middleware):
        """Test handling when tool result resolution fails."""
        thread_id = "test_thread"
        
        # Create a mock execution that fails to resolve
        mock_execution = MagicMock()
        mock_execution.resolve_tool_result.return_value = False  # Resolution fails
        mock_execution.tool_futures = {"unknown_call": AsyncMock()}  # Add the tool future
        
        async with adk_middleware._execution_lock:
            adk_middleware._active_executions[thread_id] = mock_execution
        
        # Mock _stream_events to return empty
        async def mock_stream_events(execution):
            return
            yield  # Make it a generator
        
        with patch.object(adk_middleware, '_stream_events', side_effect=mock_stream_events):
            input_data = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="unknown_call")
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={}
            )
            
            events = []
            async for event in adk_middleware._handle_tool_result_submission(input_data):
                events.append(event)
            
            # Should still proceed even if resolution failed
            # (warning is logged but execution continues)
            mock_execution.resolve_tool_result.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_invalid_json(self, adk_middleware):
        """Test handling tool result with invalid JSON content."""
        thread_id = "test_thread"
        
        mock_execution = MagicMock()
        mock_execution.tool_futures = {"call_1": AsyncMock()}  # Add the tool future
        async with adk_middleware._execution_lock:
            adk_middleware._active_executions[thread_id] = mock_execution
        
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='invalid json{', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(input_data):
            events.append(event)
        
        # Should emit error event for invalid JSON
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "TOOL_RESULT_ERROR"
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_multiple_results(self, adk_middleware):
        """Test handling multiple tool results in one submission."""
        thread_id = "test_thread"
        
        mock_execution = MagicMock()
        mock_execution.resolve_tool_result.return_value = True
        mock_execution.tool_futures = {"call_1": AsyncMock(), "call_2": AsyncMock()}  # Add both tool futures
        
        async with adk_middleware._execution_lock:
            adk_middleware._active_executions[thread_id] = mock_execution
        
        async def mock_stream_events(execution):
            yield MagicMock(type=EventType.TEXT_MESSAGE_CONTENT)
        
        with patch.object(adk_middleware, '_stream_events', side_effect=mock_stream_events):
            input_data = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    ToolMessage(id="1", role="tool", content='{"result": "first"}', tool_call_id="call_1"),
                    ToolMessage(id="2", role="tool", content='{"result": "second"}', tool_call_id="call_2")
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={}
            )
            
            events = []
            async for event in adk_middleware._handle_tool_result_submission(input_data):
                events.append(event)
            
            # Should resolve both tool results
            assert mock_execution.resolve_tool_result.call_count == 2
            
            # Check the calls
            calls = mock_execution.resolve_tool_result.call_args_list
            call_ids = [call[0][0] for call in calls]  # First arg of each call
            assert "call_1" in call_ids
            assert "call_2" in call_ids
    
    @pytest.mark.asyncio
    async def test_tool_result_flow_integration(self, adk_middleware):
        """Test complete tool result flow through run method."""
        # First, simulate a request that would create an execution
        # (This is complex to mock fully, so we test the routing logic)
        
        # Test tool result routing
        tool_result_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock the _handle_tool_result_submission method
        mock_events = [MagicMock(type=EventType.TEXT_MESSAGE_CONTENT)]
        
        async def mock_handle_tool_result(input_data):
            for event in mock_events:
                yield event
        
        with patch.object(adk_middleware, '_handle_tool_result_submission', side_effect=mock_handle_tool_result):
            events = []
            async for event in adk_middleware.run(tool_result_input):
                events.append(event)
            
            assert len(events) == 1
            assert events[0] == mock_events[0]
    
    @pytest.mark.asyncio
    async def test_new_execution_routing(self, adk_middleware, sample_tool):
        """Test that non-tool messages route to new execution."""
        new_request_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock the _start_new_execution method
        mock_events = [
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id="thread_1", run_id="run_1"),
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="thread_1", run_id="run_1")
        ]
        
        async def mock_start_new_execution(input_data, agent_id):
            for event in mock_events:
                yield event
        
        with patch.object(adk_middleware, '_start_new_execution', side_effect=mock_start_new_execution):
            events = []
            async for event in adk_middleware.run(new_request_input):
                events.append(event)
            
            assert len(events) == 2
            assert isinstance(events[0], RunStartedEvent)
            assert isinstance(events[1], RunFinishedEvent)