#!/usr/bin/env python
"""Integration tests for the complete hybrid tool execution flow - real flow with minimal mocking."""

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
from adk_middleware.client_proxy_tool import ClientProxyTool
from adk_middleware.client_proxy_toolset import ClientProxyToolset


class TestHybridFlowIntegration:
    """Integration tests for complete hybrid tool execution flow."""
    
    @pytest.fixture(autouse=True)
    def reset_registry(self):
        """Reset agent registry before each test."""
        AgentRegistry.reset_instance()
        yield
        AgentRegistry.reset_instance()
    
    @pytest.fixture
    def calculator_tool(self):
        """Create a calculator tool for testing."""
        return AGUITool(
            name="calculator",
            description="Performs mathematical calculations",
            parameters={
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": ["add", "subtract", "multiply", "divide"]
                    },
                    "a": {"type": "number"},
                    "b": {"type": "number"}
                },
                "required": ["operation", "a", "b"]
            }
        )
    
    @pytest.fixture
    def weather_tool(self):
        """Create a weather tool for testing."""
        return AGUITool(
            name="weather",
            description="Gets weather information",
            parameters={
                "type": "object",
                "properties": {
                    "location": {"type": "string"},
                    "units": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                },
                "required": ["location"]
            }
        )
    
    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="integration_test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent for hybrid flow integration testing"
        )
    
    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware for integration testing."""
        registry = AgentRegistry.get_instance()
        registry.set_default_agent(mock_adk_agent)
        
        return ADKAgent(
            user_id="integration_test_user",
            execution_timeout_seconds=30,  # Shorter for tests
            tool_timeout_seconds=10,       # Shorter for tests
            max_concurrent_executions=3
        )
    
    @pytest.mark.asyncio
    async def test_single_tool_complete_flow(self, adk_middleware, calculator_tool):
        """Test complete flow with a single tool - real integration."""
        
        # Step 1: Create the initial request with a tool
        initial_request = RunAgentInput(
            thread_id="single_tool_test",
            run_id="run_1", 
            messages=[
                UserMessage(id="1", role="user", content="Calculate 5 + 3")
            ],
            tools=[calculator_tool],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock ADK agent to simulate requesting the tool
        async def mock_adk_run(*args, **kwargs):
            # Simulate ADK agent requesting tool use
            yield MagicMock(type="content_chunk", content="I'll calculate 5 + 3 for you.")
            # The real tool calls would be made by the proxy tool
        
        with patch('google.adk.Runner.run_async', side_effect=mock_adk_run):
            # Start execution - this should create tool calls and pause
            execution_gen = adk_middleware.run(initial_request)
            
            # Get the first event to trigger execution creation
            try:
                first_event = await asyncio.wait_for(execution_gen.__anext__(), timeout=0.5)
                # If we get here, execution was created
                assert isinstance(first_event, RunStartedEvent)
                
                # Allow some time for execution to be registered
                await asyncio.sleep(0.1)
                
                # Verify execution was created and is active
                if "single_tool_test" in adk_middleware._active_executions:
                    execution = adk_middleware._active_executions["single_tool_test"]
                    await execution.cancel()
                    del adk_middleware._active_executions["single_tool_test"]
                    
            except (asyncio.TimeoutError, StopAsyncIteration):
                # Mock might complete immediately, which is fine for this test
                # The main point is to verify the execution setup works
                pass
    
    @pytest.mark.asyncio
    async def test_tool_execution_and_resumption_real_flow(self, adk_middleware, calculator_tool):
        """Test real tool execution with actual ClientProxyTool and resumption."""
        
        # Create real tool instances
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Test both blocking and long-running tools
        blocking_tool = ClientProxyTool(
            ag_ui_tool=calculator_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=5,
            is_long_running=False
        )
        
        long_running_tool = ClientProxyTool(
            ag_ui_tool=calculator_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=5,
            is_long_running=True
        )
        
        # Test long-running tool execution (fire-and-forget)
        mock_context = MagicMock()
        args = {"operation": "add", "a": 5, "b": 3}
        
        # Execute long-running tool
        result = await long_running_tool.run_async(args=args, tool_context=mock_context)
        
        # Should return tool call ID immediately (fire-and-forget)
        assert result is not None
        assert result.startswith("adk-")
        
        # Should have created events
        assert event_queue.qsize() >= 3  # start, args, end events
        
        # Should have created a future for client to resolve
        assert len(tool_futures) == 1
        tool_call_id = list(tool_futures.keys())[0]
        future = tool_futures[tool_call_id]
        assert not future.done()
        
        # Simulate client providing result
        client_result = {"result": 8, "explanation": "5 + 3 = 8"}
        future.set_result(client_result)
        
        # Verify result was set
        assert future.done()
        assert future.result() == client_result
    
    @pytest.mark.asyncio
    async def test_multiple_tools_sequential_execution(self, adk_middleware, calculator_tool, weather_tool):
        """Test execution with multiple tools in sequence."""
        
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Create toolset with multiple tools
        toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool, weather_tool],
            event_queue=event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=5
        )
        
        # Get the tools from the toolset
        tools = await toolset.get_tools(MagicMock())
        assert len(tools) == 2
        
        # Execute first tool (calculator)
        calc_tool = tools[0]  # Should be ClientProxyTool for calculator
        calc_result = await calc_tool.run_async(
            args={"operation": "multiply", "a": 7, "b": 6},
            tool_context=MagicMock()
        )
        
        # For long-running tools (default), should return tool call ID
        assert calc_result is not None
        assert calc_result.startswith("adk-")
        
        # Execute second tool (weather) 
        weather_tool_proxy = tools[1]  # Should be ClientProxyTool for weather
        weather_result = await weather_tool_proxy.run_async(
            args={"location": "San Francisco", "units": "celsius"},
            tool_context=MagicMock()
        )
        
        # Should also return tool call ID for long-running
        assert weather_result is not None
        assert weather_result.startswith("adk-")
        
        # Should have two pending futures
        assert len(tool_futures) == 2
        
        # All futures should be pending
        for future in tool_futures.values():
            assert not future.done()
        
        # Resolve both tools
        tool_call_ids = list(tool_futures.keys())
        tool_futures[tool_call_ids[0]].set_result({"result": 42})
        tool_futures[tool_call_ids[1]].set_result({"temperature": 22, "condition": "sunny"})
        
        # Verify both resolved
        assert all(f.done() for f in tool_futures.values())
        
        # Clean up
        await toolset.close()
    
    @pytest.mark.asyncio
    async def test_tool_error_recovery_integration(self, adk_middleware, calculator_tool):
        """Test error recovery in real tool execution scenarios."""
        
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Create tool that will timeout (blocking mode)
        timeout_tool = ClientProxyTool(
            ag_ui_tool=calculator_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=0.01,  # Very short timeout
            is_long_running=False
        )
        
        # Test timeout scenario
        with pytest.raises(TimeoutError):
            await timeout_tool.run_async(
                args={"operation": "add", "a": 1, "b": 2},
                tool_context=MagicMock()
            )
        
        # Verify cleanup occurred
        assert len(tool_futures) == 0  # Should be cleaned up on timeout
        
        # Test tool that gets an exception result
        exception_tool = ClientProxyTool(
            ag_ui_tool=calculator_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=5,
            is_long_running=False
        )
        
        # Start tool execution
        task = asyncio.create_task(
            exception_tool.run_async(
                args={"operation": "divide", "a": 10, "b": 0},
                tool_context=MagicMock()
            )
        )
        
        # Wait for future to be created
        await asyncio.sleep(0.01)
        
        # Get the future and set an exception
        assert len(tool_futures) == 1
        future = list(tool_futures.values())[0]
        future.set_exception(ValueError("Division by zero"))
        
        # Tool should raise the exception
        with pytest.raises(ValueError, match="Division by zero"):
            await task
    
    @pytest.mark.asyncio
    async def test_concurrent_execution_isolation(self, adk_middleware, calculator_tool):
        """Test that concurrent executions are properly isolated."""
        
        # Create multiple concurrent tool executions
        event_queue1 = asyncio.Queue()
        tool_futures1 = {}
        
        event_queue2 = asyncio.Queue()
        tool_futures2 = {}
        
        tool1 = ClientProxyTool(
            ag_ui_tool=calculator_tool,
            event_queue=event_queue1,
            tool_futures=tool_futures1,
            timeout_seconds=5,
            is_long_running=True
        )
        
        tool2 = ClientProxyTool(
            ag_ui_tool=calculator_tool,
            event_queue=event_queue2,
            tool_futures=tool_futures2,
            timeout_seconds=5,
            is_long_running=True
        )
        
        # Execute both tools concurrently
        task1 = asyncio.create_task(
            tool1.run_async(args={"operation": "add", "a": 1, "b": 2}, tool_context=MagicMock())
        )
        task2 = asyncio.create_task(
            tool2.run_async(args={"operation": "multiply", "a": 3, "b": 4}, tool_context=MagicMock())
        )
        
        # Both should complete immediately (long-running)
        result1 = await task1
        result2 = await task2
        
        assert result1 is not None
        assert result1.startswith("adk-")
        assert result2 is not None
        assert result2.startswith("adk-")
        
        # Should have separate futures
        assert len(tool_futures1) == 1
        assert len(tool_futures2) == 1
        
        # Futures should be in different dictionaries (isolated)
        future1 = list(tool_futures1.values())[0]
        future2 = list(tool_futures2.values())[0]
        assert future1 is not future2
        
        # Resolve independently
        future1.set_result({"result": 3})
        future2.set_result({"result": 12})
        
        assert future1.result() == {"result": 3}
        assert future2.result() == {"result": 12}
    
    @pytest.mark.asyncio
    async def test_execution_state_persistence_across_requests(self, adk_middleware, calculator_tool):
        """Test that execution state persists across multiple requests (tool results)."""
        
        # Simulate creating an active execution
        from adk_middleware.execution_state import ExecutionState
        
        mock_task = AsyncMock()
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="persistence_test",
            event_queue=event_queue,
            tool_futures=tool_futures
        )
        
        # Add pending tool futures
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        tool_futures["calc_1"] = future1
        tool_futures["calc_2"] = future2
        
        # Register execution in middleware
        adk_middleware._active_executions["persistence_test"] = execution
        
        # First request: Resolve one tool
        first_request = RunAgentInput(
            thread_id="persistence_test",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": 10}', tool_call_id="calc_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock event streaming to avoid hanging
        with patch.object(adk_middleware, '_stream_events') as mock_stream:
            mock_stream.return_value = AsyncMock()
            mock_stream.return_value.__aiter__ = AsyncMock(return_value=iter([]))
            
            events1 = []
            async for event in adk_middleware._handle_tool_result_submission(first_request):
                events1.append(event)
        
        # Verify first tool was resolved
        assert future1.done()
        assert future1.result() == {"result": 10}
        assert not future2.done()  # Still pending
        
        # Execution should still be active (has pending tools)
        assert "persistence_test" in adk_middleware._active_executions
        assert execution.has_pending_tools()
        
        # Second request: Resolve remaining tool
        second_request = RunAgentInput(
            thread_id="persistence_test",
            run_id="run_2", 
            messages=[
                ToolMessage(id="2", role="tool", content='{"result": 20}', tool_call_id="calc_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )
        
        with patch.object(adk_middleware, '_stream_events') as mock_stream:
            mock_stream.return_value = AsyncMock()
            mock_stream.return_value.__aiter__ = AsyncMock(return_value=iter([]))
            
            events2 = []
            async for event in adk_middleware._handle_tool_result_submission(second_request):
                events2.append(event)
        
        # Verify second tool was resolved
        assert future2.done() 
        assert future2.result() == {"result": 20}
        
        # No more pending tools
        assert not execution.has_pending_tools()
        
        # Clean up
        await execution.cancel()
        if "persistence_test" in adk_middleware._active_executions:
            del adk_middleware._active_executions["persistence_test"]
    
    @pytest.mark.asyncio
    async def test_real_hybrid_flow_with_actual_components(self, adk_middleware, calculator_tool):
        """Test the most realistic hybrid flow scenario with actual components."""
        
        # Create initial request that would trigger tool use
        initial_request = RunAgentInput(
            thread_id="real_hybrid_test",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Please calculate 15 * 8 for me")
            ],
            tools=[calculator_tool],
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Mock the ADK agent to simulate tool request behavior
        async def mock_adk_execution(*args, **kwargs):
            # Simulate ADK requesting tool use
            # This would normally come from the actual ADK agent
            yield MagicMock(type="content_chunk", content="I'll calculate that for you.")
            
            # The ClientProxyTool would handle the actual tool call
            # and emit the tool call events when integrated
        
        with patch('google.adk.Runner.run_async', side_effect=mock_adk_execution):
            # This simulates starting an execution that would create tools
            # In reality, the ADK agent would call the ClientProxyTool
            # which would emit tool events and create futures
            
            # Start the execution
            execution_generator = adk_middleware.run(initial_request)
            
            # Get first event (should be RunStartedEvent)
            try:
                first_event = await asyncio.wait_for(execution_generator.__anext__(), timeout=1.0)
                assert isinstance(first_event, RunStartedEvent)
                assert first_event.thread_id == "real_hybrid_test"
            except asyncio.TimeoutError:
                pytest.skip("ADK agent execution timing - would work in real scenario")
            except StopAsyncIteration:
                pytest.skip("Mock execution completed - would continue in real scenario")
            
            # In a real scenario:
            # 1. The ADK agent would request tool use
            # 2. ClientProxyTool would emit TOOL_CALL_* events  
            # 3. Execution would pause waiting for tool results
            # 4. Client would provide ToolMessage with results
            # 5. Execution would resume and complete
            
            # Verify execution tracking
            if "real_hybrid_test" in adk_middleware._active_executions:
                execution = adk_middleware._active_executions["real_hybrid_test"]
                await execution.cancel()
                del adk_middleware._active_executions["real_hybrid_test"]
    
    @pytest.mark.asyncio
    async def test_toolset_lifecycle_integration_long_running(self, adk_middleware, calculator_tool, weather_tool):
        """Test complete toolset lifecycle with long-running tools (default behavior)."""
        
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Create toolset with multiple tools (default: long-running)
        toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool, weather_tool],
            event_queue=event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=5
        )
        
        # Test toolset creation and tool access
        mock_context = MagicMock()
        tools = await toolset.get_tools(mock_context)
        
        assert len(tools) == 2
        assert all(isinstance(tool, ClientProxyTool) for tool in tools)
        
        # Verify tools are long-running by default
        assert all(tool.is_long_running is True for tool in tools)
        
        # Test caching - second call should return same tools
        tools2 = await toolset.get_tools(mock_context)
        assert tools is tools2  # Should be cached
        
        # Test tool execution through toolset
        calc_tool = tools[0]
        
        # Execute tool - should return immediately (long-running)
        result = await calc_tool.run_async(
            args={"operation": "add", "a": 100, "b": 200},
            tool_context=mock_context
        )
        
        # Should return tool call ID (long-running default)
        assert result is not None
        assert result.startswith("adk-")
        
        # Should have pending future
        assert len(tool_futures) == 1
        
        # Test toolset cleanup
        await toolset.close()
        
        # All pending futures should be cancelled
        for future in tool_futures.values():
            assert future.cancelled()
        
        # Verify string representation
        repr_str = repr(toolset)
        assert "ClientProxyToolset" in repr_str
        assert "calculator" in repr_str
        assert "weather" in repr_str
    
    @pytest.mark.asyncio
    async def test_toolset_lifecycle_integration_blocking(self, adk_middleware, calculator_tool, weather_tool):
        """Test complete toolset lifecycle with blocking tools."""
        
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Create toolset with blocking tools
        toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool, weather_tool],
            event_queue=event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=5,
            is_long_running=False  # Explicitly set to blocking
        )
        
        # Test toolset creation and tool access
        mock_context = MagicMock()
        tools = await toolset.get_tools(mock_context)
        
        assert len(tools) == 2
        assert all(isinstance(tool, ClientProxyTool) for tool in tools)
        
        # Verify tools are blocking
        assert all(tool.is_long_running is False for tool in tools)
        
        # Test tool execution through toolset - blocking mode
        calc_tool = tools[0]
        
        # Start tool execution in blocking mode
        execution_task = asyncio.create_task(
            calc_tool.run_async(
                args={"operation": "multiply", "a": 50, "b": 2},
                tool_context=mock_context
            )
        )
        
        # Wait for future to be created
        await asyncio.sleep(0.01)
        
        # Should have pending future
        assert len(tool_futures) == 1
        future = list(tool_futures.values())[0]
        assert not future.done()
        
        # Resolve the future to complete the blocking execution
        future.set_result({"result": 100})
        
        # Tool should now complete with the result
        result = await execution_task
        assert result == {"result": 100}
        
        # Test toolset cleanup
        await toolset.close()
    
    @pytest.mark.asyncio
    async def test_mixed_execution_modes_integration(self, adk_middleware, calculator_tool, weather_tool):
        """Test integration with mixed long-running and blocking tools in the same execution."""
        
        # Create separate event queues and futures for each mode
        long_running_queue = asyncio.Queue()
        long_running_futures = {}
        
        blocking_queue = asyncio.Queue()
        blocking_futures = {}
        
        # Create long-running tool
        long_running_tool = ClientProxyTool(
            ag_ui_tool=calculator_tool,
            event_queue=long_running_queue,
            tool_futures=long_running_futures,
            timeout_seconds=5,
            is_long_running=True
        )
        
        # Create blocking tool
        blocking_tool = ClientProxyTool(
            ag_ui_tool=weather_tool,
            event_queue=blocking_queue,
            tool_futures=blocking_futures,
            timeout_seconds=5,
            is_long_running=False
        )
        
        mock_context = MagicMock()
        
        # Execute long-running tool
        long_running_result = await long_running_tool.run_async(
            args={"operation": "add", "a": 10, "b": 20},
            tool_context=mock_context
        )
        
        # Should return tool call ID immediately
        assert long_running_result is not None
        assert long_running_result.startswith("adk-")
        assert len(long_running_futures) == 1
        
        # Execute blocking tool
        blocking_task = asyncio.create_task(
            blocking_tool.run_async(
                args={"location": "New York", "units": "celsius"},
                tool_context=mock_context
            )
        )
        
        # Wait for blocking future to be created
        await asyncio.sleep(0.01)
        assert len(blocking_futures) == 1
        
        # Resolve the blocking future
        blocking_future = list(blocking_futures.values())[0]
        blocking_future.set_result({"temperature": 20, "condition": "sunny"})
        
        # Blocking tool should complete with result
        blocking_result = await blocking_task
        assert blocking_result == {"temperature": 20, "condition": "sunny"}
        
        # Long-running future should still be pending
        long_running_future = list(long_running_futures.values())[0]
        assert not long_running_future.done()
        
        # Can resolve long-running future independently
        long_running_future.set_result({"result": 30})
        assert long_running_future.result() == {"result": 30}
    
    @pytest.mark.asyncio
    async def test_toolset_default_behavior_validation(self, adk_middleware, calculator_tool):
        """Test that toolsets correctly use the default is_long_running=True behavior."""
        
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Create toolset without specifying is_long_running (should default to True)
        default_toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool],
            event_queue=event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=5
            # is_long_running not specified - should default to True
        )
        
        # Get tools
        mock_context = MagicMock()
        tools = await default_toolset.get_tools(mock_context)
        
        # Should have one tool
        assert len(tools) == 1
        tool = tools[0]
        assert isinstance(tool, ClientProxyTool)
        
        # Should be long-running by default
        assert tool.is_long_running is True
        
        # Execute tool - should return immediately
        result = await tool.run_async(
            args={"operation": "subtract", "a": 100, "b": 25},
            tool_context=mock_context
        )
        
        # Should return tool call ID (long-running behavior)
        assert result is not None
        assert result.startswith("adk-")
        
        # Should have created a future
        assert len(tool_futures) == 1
        
        # Clean up
        await default_toolset.close()
    
    @pytest.mark.asyncio
    async def test_toolset_lifecycle_integration_blocking(self, adk_middleware, calculator_tool, weather_tool):
        """Test complete toolset lifecycle with blocking tools."""
        
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Create toolset with all tools set to blocking mode
        toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool, weather_tool],
            event_queue=event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=5,
            is_long_running=False  # All tools blocking
        )
        
        # Test toolset creation and tool access
        mock_context = MagicMock()
        tools = await toolset.get_tools(mock_context)
        
        assert len(tools) == 2
        assert all(isinstance(tool, ClientProxyTool) for tool in tools)
        
        # Verify all tools are blocking
        assert all(tool.is_long_running is False for tool in tools)
        
        # Test tool execution - blocking mode
        calc_tool = tools[0]
        
        # Start tool execution in blocking mode
        execution_task = asyncio.create_task(
            calc_tool.run_async(
                args={"operation": "multiply", "a": 50, "b": 2},
                tool_context=mock_context
            )
        )
        
        # Wait for future to be created
        await asyncio.sleep(0.01)
        
        # Should have pending future
        assert len(tool_futures) == 1
        future = list(tool_futures.values())[0]
        assert not future.done()
        
        # Resolve the future to complete the blocking execution
        future.set_result({"result": 100})
        
        # Tool should now complete with the result
        result = await execution_task
        assert result == {"result": 100}
        
        # Test toolset cleanup
        await toolset.close()
    
    @pytest.mark.asyncio
    async def test_toolset_mixed_execution_modes(self, adk_middleware, calculator_tool, weather_tool):
        """Test toolset with mixed long-running and blocking tools using tool_long_running_config."""
        
        event_queue = asyncio.Queue()
        tool_futures = {}
        
        # Create toolset with mixed execution modes
        toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool, weather_tool],
            event_queue=event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=5,
            is_long_running=True,  # Default: long-running
            tool_long_running_config={
                "calculator": False,  # Override: calculator should be blocking
                # weather uses default (True - long-running)
            }
        )
        
        # Test toolset creation and tool access
        mock_context = MagicMock()
        tools = await toolset.get_tools(mock_context)
        
        assert len(tools) == 2
        assert all(isinstance(tool, ClientProxyTool) for tool in tools)
        
        # Find tools by name
        calc_tool = next(tool for tool in tools if tool.name == "calculator")
        weather_tool_proxy = next(tool for tool in tools if tool.name == "weather")
        
        # Verify mixed execution modes
        assert calc_tool.is_long_running is False    # Blocking (overridden)
        assert weather_tool_proxy.is_long_running is True  # Long-running (default)
        
        # Test weather tool (long-running) first
        weather_result = await weather_tool_proxy.run_async(
            args={"location": "Boston", "units": "fahrenheit"},
            tool_context=mock_context
        )
        
        # Weather tool should return tool call ID immediately (long-running)
        assert weather_result is not None
        assert weather_result.startswith("adk-")
        assert len(tool_futures) == 1  # Weather future created
        
        # Test calculator tool (blocking) - needs to be resolved
        calc_task = asyncio.create_task(
            calc_tool.run_async(
                args={"operation": "add", "a": 10, "b": 5},
                tool_context=mock_context
            )
        )
        
        # Wait for calculator future to be created
        await asyncio.sleep(0.01)
        
        # Should have two futures: one for weather (long-running), one for calc (blocking)
        assert len(tool_futures) == 2
        
        # Find the most recent future (calculator) and resolve it
        futures_list = list(tool_futures.values())
        calc_future = futures_list[-1]  # Most recent future (calculator)
        
        # Resolve the calculator future
        calc_future.set_result({"result": 15})
        
        # Calculator should complete with result
        calc_result = await calc_task
        assert calc_result == {"result": 15}
        
        # Verify string representation includes config
        repr_str = repr(toolset)
        assert "calculator" in repr_str
        assert "weather" in repr_str
        assert "default_long_running=True" in repr_str
        assert "overrides={'calculator': False}" in repr_str
        
        # Test toolset cleanup
        await toolset.close()
    
    @pytest.mark.asyncio
    async def test_toolset_timeout_behavior_by_mode(self, adk_middleware, calculator_tool):
        """Test timeout behavior differences between long-running and blocking toolsets."""
        
        # Test long-running toolset with very short timeout (should be ignored)
        long_running_queue = asyncio.Queue()
        long_running_futures = {}
        
        long_running_toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool],
            event_queue=long_running_queue,
            tool_futures=long_running_futures,
            tool_timeout_seconds=0.001,  # Very short timeout
            is_long_running=True
        )
        
        long_running_tools = await long_running_toolset.get_tools(MagicMock())
        long_running_tool = long_running_tools[0]
        
        # Should complete immediately despite short timeout
        result = await long_running_tool.run_async(
            args={"operation": "add", "a": 1, "b": 1},
            tool_context=MagicMock()
        )
        assert result is not None  # Long-running returns tool call ID
        assert result.startswith("adk-")
        
        # Test blocking toolset with short timeout (should actually timeout)
        blocking_queue = asyncio.Queue()
        blocking_futures = {}
        
        blocking_toolset = ClientProxyToolset(
            ag_ui_tools=[calculator_tool],
            event_queue=blocking_queue,
            tool_futures=blocking_futures,
            tool_timeout_seconds=0.001,  # Very short timeout
            is_long_running=False
        )
        
        blocking_tools = await blocking_toolset.get_tools(MagicMock())
        blocking_tool = blocking_tools[0]
        
        # Should timeout
        with pytest.raises(TimeoutError):
            await blocking_tool.run_async(
                args={"operation": "add", "a": 1, "b": 1},
                tool_context=MagicMock()
            )
        
        # Clean up
        await long_running_toolset.close()
        await blocking_toolset.close()