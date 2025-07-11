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
    
    @pytest.mark.asyncio
    async def test_extract_tool_results_single_tool(self, adk_middleware):
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
        
        tool_results = await adk_middleware._extract_tool_results(input_data)
        
        assert len(tool_results) == 1
        assert tool_results[0]['message'].role == "tool"
        assert tool_results[0]['message'].tool_call_id == "call_1"
        assert tool_results[0]['message'].content == '{"result": "success"}'
        assert tool_results[0]['tool_name'] == "unknown"  # No tool_calls in messages
    
    @pytest.mark.asyncio
    async def test_extract_tool_results_multiple_tools(self, adk_middleware):
        """Test extraction of most recent tool result when multiple exist."""
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
        
        tool_results = await adk_middleware._extract_tool_results(input_data)
        
        # Should only extract the most recent tool result to prevent API errors
        assert len(tool_results) == 1
        assert tool_results[0]['message'].tool_call_id == "call_2"
        assert tool_results[0]['message'].content == '{"result": "second"}'
    
    @pytest.mark.asyncio
    async def test_extract_tool_results_mixed_messages(self, adk_middleware):
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
        
        tool_results = await adk_middleware._extract_tool_results(input_data)
        
        # Should only extract the most recent tool message to prevent API errors
        assert len(tool_results) == 1
        assert tool_results[0]['message'].role == "tool"
        assert tool_results[0]['message'].tool_call_id == "call_2"
        assert tool_results[0]['message'].content == '{"result": "done"}'
    
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
        
        # In all-long-running architecture, tool results without active execution
        # are treated as standalone results from LongRunningTools and start new executions
        # However, ADK may error if there's no conversation history for the tool result
        assert len(events) >= 1  # At least RUN_STARTED, potentially RUN_ERROR and RUN_FINISHED
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_no_active_execution_no_tools(self, adk_middleware):
        """Test handling tool result when no tool results exist."""
        input_data = RunAgentInput(
            thread_id="nonexistent_thread",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")  # No tool messages
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        events = []
        async for event in adk_middleware._handle_tool_result_submission(input_data):
            events.append(event)
        
        # When there are no tool results, should emit error for missing tool results
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "NO_TOOL_RESULTS"
        assert "No tool results found in submission" in events[0].message
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_with_active_execution(self, adk_middleware):
        """Test handling tool result - starts new execution regardless of existing executions."""
        thread_id = "test_thread"
        
        # Mock the _stream_events method to simulate new execution
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
            
            # Should receive RUN_STARTED + mock events + RUN_FINISHED (4 total)
            assert len(events) == 4
            assert events[0].type == EventType.RUN_STARTED
            assert events[-1].type == EventType.RUN_FINISHED
            # In all-long-running architecture, tool results start new executions
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_streaming_error(self, adk_middleware):
        """Test handling when streaming events fails."""
        thread_id = "test_thread"
        
        # Mock _stream_events to raise an exception
        async def mock_stream_events(execution):
            raise RuntimeError("Streaming failed")
            yield  # Make it a generator
        
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
            
            # Should emit RUN_STARTED then error event when streaming fails
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert isinstance(events[1], RunErrorEvent)
            assert events[1].code == "EXECUTION_ERROR"
            assert "Streaming failed" in events[1].message
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_invalid_json(self, adk_middleware):
        """Test handling tool result with invalid JSON content."""
        thread_id = "test_thread"
        
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
        
        # Should start new execution, handle invalid JSON gracefully, and complete
        # Invalid JSON is handled gracefully in _run_adk_in_background by providing error result
        assert len(events) >= 2  # At least RUN_STARTED and some completion
        assert events[0].type == EventType.RUN_STARTED
    
    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_multiple_results(self, adk_middleware):
        """Test handling multiple tool results in one submission - only most recent is extracted."""
        thread_id = "test_thread"
        
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
        
        # Should extract only the most recent tool result to prevent API errors
        tool_results = await adk_middleware._extract_tool_results(input_data)
        assert len(tool_results) == 1
        assert tool_results[0]['message'].tool_call_id == "call_2"
        assert tool_results[0]['message'].content == '{"result": "second"}'
    
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
        
        # In the all-long-running architecture, tool result inputs are processed as new executions
        # Mock the background execution to avoid ADK library errors
        async def mock_start_new_execution(input_data, agent_id):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )
            # In all-long-running architecture, tool results are processed through ADK sessions
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )
        
        with patch.object(adk_middleware, '_start_new_execution', side_effect=mock_start_new_execution):
            events = []
            async for event in adk_middleware.run(tool_result_input):
                events.append(event)
            
            # Should get RUN_STARTED and RUN_FINISHED events
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert events[1].type == EventType.RUN_FINISHED
    
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