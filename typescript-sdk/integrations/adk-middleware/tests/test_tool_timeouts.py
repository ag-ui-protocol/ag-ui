#!/usr/bin/env python
"""Test tool timeout scenarios."""

import pytest
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import EventType, RunErrorEvent
from adk_middleware.execution_state import ExecutionState
from adk_middleware.client_proxy_tool import ClientProxyTool
from adk_middleware.client_proxy_toolset import ClientProxyToolset
from ag_ui.core import Tool as AGUITool


class TestToolTimeouts:
    """Test cases for various timeout scenarios."""
    
    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool definition."""
        return AGUITool(
            name="slow_tool",
            description="A tool that might timeout",
            parameters={
                "type": "object",
                "properties": {
                    "delay": {"type": "number"}
                }
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
    def mock_tool_context(self):
        """Create a properly mocked tool context."""
        mock_context = MagicMock()
        mock_context.function_call_id = "test-function-call-id"
        return mock_context
    
    def test_execution_state_is_stale_boundary_conditions(self):
        """Test ExecutionState staleness detection at boundary conditions."""
        # Create execution state
        mock_task = MagicMock()
        mock_queue = AsyncMock()
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=mock_queue,
            tool_futures={}
        )
        
        # Test exact timeout boundary
        timeout = 60  # 1 minute
        current_time = time.time()
        
        # Should not be stale immediately
        assert execution.is_stale(timeout) is False
        
        # Artificially age the execution to exactly timeout
        execution.start_time = current_time - timeout
        # Should be stale at exact boundary (uses > so this should pass)
        assert execution.is_stale(timeout) is True
        
        # Age it past timeout
        execution.start_time = current_time - (timeout + 0.1)
        assert execution.is_stale(timeout) is True
    
    def test_execution_state_is_stale_zero_timeout(self):
        """Test ExecutionState with zero timeout."""
        mock_task = MagicMock()
        mock_queue = AsyncMock()
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=mock_queue,
            tool_futures={}
        )
        
        # With zero timeout, execution should be stale immediately after any time passes
        initial_time = time.time()
        execution.start_time = initial_time - 0.001  # 1ms ago
        assert execution.is_stale(0) is True
    
    def test_execution_state_is_stale_negative_timeout(self):
        """Test ExecutionState with negative timeout."""
        mock_task = MagicMock()
        mock_queue = AsyncMock()
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=mock_queue,
            tool_futures={}
        )
        
        # Negative timeout should immediately be stale
        assert execution.is_stale(-1) is True
        assert execution.is_stale(-100) is True
    
    @pytest.mark.asyncio
    async def test_client_proxy_tool_timeout_immediate(self, sample_tool, mock_event_queue, tool_futures, mock_tool_context):
        """Test ClientProxyTool with immediate timeout."""
        # Create tool with very short timeout
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            is_long_running = False,
            timeout_seconds=0.001  # 1ms timeout
        )
        
        args = {"delay": 5}
        
        # Should timeout very quickly
        with pytest.raises(TimeoutError) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_tool_context)
        
        assert "timed out after 0.001 seconds" in str(exc_info.value)
        
        # Future should be cleaned up
        assert len(tool_futures) == 0
    
    @pytest.mark.asyncio
    async def test_client_proxy_tool_timeout_cleanup(self, sample_tool, mock_event_queue, tool_futures, mock_tool_context):
        """Test that ClientProxyTool properly cleans up on timeout."""
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            is_long_running = False,
            tool_futures=tool_futures,
            timeout_seconds=0.01  # 10ms timeout
        )
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="timeout-test")
            
            args = {"delay": 1}
            
            # Start the execution
            task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_tool_context)
            )
            
            # Wait for future to be created
            await asyncio.sleep(0.005)
            
            # Future should exist initially
            assert "test-function-call-id" in tool_futures
            
            # Wait for timeout
            with pytest.raises(TimeoutError):
                await task
            
            # Future should be cleaned up after timeout
            assert "test-function-call-id" not in tool_futures
    
    @pytest.mark.asyncio
    async def test_client_proxy_tool_timeout_vs_completion_race(self, sample_tool, mock_event_queue, tool_futures, mock_tool_context):
        """Test race condition between timeout and completion."""
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            is_long_running = False,
            tool_futures=tool_futures,
            timeout_seconds=0.05  # 50ms timeout
        )
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="race-test")
            
            args = {"delay": 1}
            
            # Start the execution
            task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_tool_context)
            )
            
            # Wait for future to be created  
            await asyncio.sleep(0.01)
            
            # Complete the future before timeout
            future = tool_futures["test-function-call-id"]
            future.set_result({"success": True})
            
            # Should complete successfully, not timeout
            result = await task
            assert result == {"success": True}
    
    @pytest.mark.asyncio
    async def test_stream_events_execution_timeout(self):
        """Test _stream_events detecting execution timeout."""
        from adk_middleware.adk_agent import ADKAgent
        
        # Create a minimal ADKAgent for testing
        agent = ADKAgent(execution_timeout_seconds=0.05)  # 50ms timeout
        
        # Create execution state with old start time
        mock_task = MagicMock()
        mock_task.done.return_value = False
        event_queue = asyncio.Queue()
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="timeout_thread",
            event_queue=event_queue,
            tool_futures={}
        )
        
        # Age the execution to be stale
        execution.start_time = time.time() - 1.0  # 1 second ago
        
        # Stream events should detect timeout
        events = []
        async for event in agent._stream_events(execution):
            events.append(event)
            break  # Just get the first event
        
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "EXECUTION_TIMEOUT"
        assert "timed out" in events[0].message
    
    @pytest.mark.asyncio
    async def test_stream_events_task_completion_detection(self):
        """Test _stream_events detecting task completion."""
        from adk_middleware.adk_agent import ADKAgent
        
        agent = ADKAgent(execution_timeout_seconds=60)
        
        # Create execution state with completed task
        mock_task = MagicMock()
        mock_task.done.return_value = True  # Task is done
        event_queue = asyncio.Queue()
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="completed_thread",
            event_queue=event_queue,
            tool_futures={}
        )
        
        # Should exit quickly when task is done
        events = []
        async for event in agent._stream_events(execution):
            events.append(event)
        
        # Should not yield any events and exit
        assert len(events) == 0
        assert execution.is_complete is True
    
    @pytest.mark.asyncio
    async def test_stream_events_normal_completion(self):
        """Test _stream_events with normal completion signal."""
        from adk_middleware.adk_agent import ADKAgent
        
        agent = ADKAgent(execution_timeout_seconds=60)
        
        mock_task = MagicMock()
        mock_task.done.return_value = False
        event_queue = asyncio.Queue()
        
        execution = ExecutionState(
            task=mock_task,
            thread_id="normal_thread",
            event_queue=event_queue,
            tool_futures={}
        )
        
        # Put some events in queue, ending with None (completion signal)
        await event_queue.put(MagicMock(type=EventType.TEXT_MESSAGE_CONTENT))
        await event_queue.put(MagicMock(type=EventType.TEXT_MESSAGE_END))
        await event_queue.put(None)  # Completion signal
        
        events = []
        async for event in agent._stream_events(execution):
            events.append(event)
        
        assert len(events) == 3  # Two content events + RUN_FINISHED event
        assert execution.is_complete is True
        
        # Check that we got the expected events
        assert events[0].type == EventType.TEXT_MESSAGE_CONTENT
        assert events[1].type == EventType.TEXT_MESSAGE_END
        assert events[2].type == EventType.RUN_FINISHED
    
    @pytest.mark.asyncio
    async def test_cleanup_stale_executions(self):
        """Test cleanup of stale executions."""
        from adk_middleware.adk_agent import ADKAgent
        
        agent = ADKAgent(execution_timeout_seconds=0.05)  # 50ms timeout
        
        # Create some executions - one fresh, one stale
        fresh_task = MagicMock()
        fresh_task.done.return_value = False
        fresh_execution = ExecutionState(
            task=fresh_task,
            thread_id="fresh_thread",
            event_queue=AsyncMock(),
            tool_futures={}
        )
        
        stale_task = MagicMock()
        stale_task.done.return_value = False
        stale_execution = ExecutionState(
            task=stale_task,
            thread_id="stale_thread",
            event_queue=AsyncMock(),
            tool_futures={}
        )
        # Age the stale execution
        stale_execution.start_time = time.time() - 1.0
        
        # Add to active executions
        agent._active_executions["fresh_thread"] = fresh_execution
        agent._active_executions["stale_thread"] = stale_execution
        
        # Mock the cancel method
        fresh_execution.cancel = AsyncMock()
        stale_execution.cancel = AsyncMock()
        
        # Run cleanup
        await agent._cleanup_stale_executions()
        
        # Fresh execution should remain
        assert "fresh_thread" in agent._active_executions
        fresh_execution.cancel.assert_not_called()
        
        # Stale execution should be removed and cancelled
        assert "stale_thread" not in agent._active_executions
        stale_execution.cancel.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_toolset_close_timeout_cleanup(self, sample_tool, mock_event_queue):
        """Test that toolset close properly handles timeout cleanup."""
        tool_futures = {}
        toolset = ClientProxyToolset(
            ag_ui_tools=[sample_tool],
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            tool_timeout_seconds=1
        )
        
        # Add some futures - mix of pending and completed
        pending_future = asyncio.Future()
        completed_future = asyncio.Future()
        completed_future.set_result("done")
        cancelled_future = asyncio.Future()
        cancelled_future.cancel()
        
        tool_futures["pending"] = pending_future
        tool_futures["completed"] = completed_future
        tool_futures["cancelled"] = cancelled_future
        
        # Close should cancel only pending futures
        await toolset.close()
        
        assert pending_future.cancelled() is True
        assert completed_future.done() is True  # Should remain done
        assert completed_future.cancelled() is False  # But not cancelled
        assert cancelled_future.cancelled() is True  # Was already cancelled
        
        # All futures should be cleared from dict
        assert len(tool_futures) == 0
    
    @pytest.mark.asyncio
    async def test_multiple_timeout_scenarios(self, sample_tool, mock_event_queue, mock_tool_context):
        """Test multiple timeout scenarios in sequence."""
        tool_futures = {}
        
        # Test with different timeout values
        timeouts = [0.001, 0.01, 0.1]  # 1ms, 10ms, 100ms
        
        for timeout in timeouts:
            proxy_tool = ClientProxyTool(
                ag_ui_tool=sample_tool,
                event_queue=mock_event_queue,
                is_long_running = False,
                tool_futures=tool_futures,
                timeout_seconds=timeout
            )
            
            args = {"delay": 5}
            
            start_time = time.time()
            with pytest.raises(TimeoutError):
                await proxy_tool.run_async(args=args, tool_context=mock_tool_context)
            
            elapsed = time.time() - start_time
            
            # Should timeout approximately at the specified time
            # Allow some tolerance for timing variations
            assert elapsed >= timeout * 0.8  # At least 80% of timeout
            assert elapsed <= timeout * 5.0  # No more than 5x timeout (generous for CI)
            
            # Futures should be cleaned up after each timeout
            assert len(tool_futures) == 0
    
    @pytest.mark.asyncio
    async def test_concurrent_tool_timeouts(self, sample_tool, mock_event_queue, mock_tool_context):
        """Test multiple tools timing out concurrently."""
        tool_futures = {}
        
        # Create multiple proxy tools with short timeouts
        tools = []
        for i in range(3):
            tool = ClientProxyTool(
                ag_ui_tool=sample_tool,
                event_queue=mock_event_queue,
                is_long_running = False,
                tool_futures=tool_futures,
                timeout_seconds=0.02  # 20ms timeout
            )
            tools.append(tool)
        
        # Start all tools concurrently
        tasks = []
        for i, tool in enumerate(tools):
            task = asyncio.create_task(
                tool.run_async(args={"delay": 5}, tool_context=mock_tool_context)
            )
            tasks.append(task)
        
        # All should timeout
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        for result in results:
            assert isinstance(result, TimeoutError)
        
        # All futures should be cleaned up
        assert len(tool_futures) == 0


    @pytest.mark.asyncio
    async def test_client_proxy_tool_long_running_no_timeout(self, sample_tool, mock_event_queue, tool_futures, mock_tool_context):
        """Test ClientProxyTool with is_long_running=True does not timeout."""
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            timeout_seconds=0.01,  # Very short timeout, but should be ignored
            is_long_running=True
        )
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="long-running-test")
            
            args = {"delay": 5}
            
            # Start the execution
            task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_tool_context)
            )
            
            # Wait for future to be created
            await asyncio.sleep(0.02)  # Wait longer than the timeout
            
            # Long-running tools should NOT create futures (fire-and-forget)
            assert len(tool_futures) == 0
            assert task.done()
            


    @pytest.mark.asyncio
    async def test_client_proxy_tool_long_running_vs_regular_timeout_behavior(self, sample_tool, mock_event_queue, mock_tool_context):
        """Test that regular tools timeout while long-running tools don't."""
        tool_futures_regular = {}
        tool_futures_long = {}
        
        # Create regular tool with short timeout
        regular_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures_regular,
            timeout_seconds=0.01,  # 10ms timeout
            is_long_running=False
        )
        
        # Create long-running tool with same timeout setting
        long_running_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures_long,
            timeout_seconds=0.01,  # Same timeout, but should be ignored
            is_long_running=True
        )
        
        with patch('uuid.uuid4') as mock_uuid:
            # Mock UUIDs for each tool
            call_count = 0
            def side_effect():
                nonlocal call_count
                call_count += 1
                mock_id = MagicMock()
                mock_id.__str__ = MagicMock(return_value=f"test-{call_count}")
                return mock_id
            
            mock_uuid.side_effect = side_effect
            
            args = {"delay": 5}
            
            # Start both tools
            regular_task = asyncio.create_task(
                regular_tool.run_async(args=args, tool_context=mock_tool_context)
            )
            
            long_running_task = asyncio.create_task(
                long_running_tool.run_async(args=args, tool_context=mock_tool_context)
            )
            
            # Wait for both futures to be created
            await asyncio.sleep(0.005)
            
            # Only regular tool should have futures, long-running should not
            assert len(tool_futures_regular) == 1
            assert len(tool_futures_long) == 0  # Long-running tools don't create futures
            
            # Wait past the timeout
            await asyncio.sleep(0.02)
            
            # Regular tool should timeout
            with pytest.raises(TimeoutError):
                await regular_task
            
            # Long-running tool should be done (remember tool is still in pending state)
            assert long_running_task.done()
            


    @pytest.mark.asyncio
    async def test_client_proxy_tool_long_running_cleanup_on_error(self, sample_tool, tool_futures, mock_tool_context):
        """Test that long-running tools clean up properly on event emission errors."""
        # Create a mock event queue that raises an exception
        mock_event_queue = AsyncMock()
        mock_event_queue.put.side_effect = RuntimeError("Event queue error")
        
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            timeout_seconds=0.01,
            is_long_running=True
        )
        
        args = {"delay": 5}
        
        # Should raise the event queue error and clean up
        with pytest.raises(RuntimeError) as exc_info:
            await proxy_tool.run_async(args=args, tool_context=mock_tool_context)
        
        assert str(exc_info.value) == "Event queue error"
        
        # Tool futures should be empty (cleaned up)
        assert len(tool_futures) == 0



    @pytest.mark.asyncio
    async def test_client_proxy_tool_long_running_multiple_concurrent(self, sample_tool, mock_event_queue, mock_tool_context):
        """Test multiple long-running tools executing concurrently."""
        tool_futures = {}
        
        # Create multiple long-running tools
        tools = []
        for i in range(3):
            tool = ClientProxyTool(
                ag_ui_tool=sample_tool,
                event_queue=mock_event_queue,
                tool_futures=tool_futures,
                timeout_seconds=0.01,  # Short timeout, but ignored
                is_long_running=True
            )
            tools.append(tool)
        
        with patch('uuid.uuid4') as mock_uuid:
            call_count = 0
            def side_effect():
                nonlocal call_count
                call_count += 1
                mock_id = MagicMock()
                mock_id.__str__ = MagicMock(return_value=f"concurrent-{call_count}")
                return mock_id
            
            mock_uuid.side_effect = side_effect
            
            # Start all tools concurrently
            tasks = []
            for i, tool in enumerate(tools):
                task = asyncio.create_task(
                    tool.run_async(args={"delay": 5}, tool_context=mock_tool_context)
                )
                tasks.append(task)
            
            # Wait for all futures to be created
            await asyncio.sleep(0.01)
            
            # Long-running tools should NOT create futures
            assert len(tool_futures) == 0
            
            # All should be done (no waiting for timeouts)
            for task in tasks:
                assert task.done()
            


    @pytest.mark.asyncio
    async def test_client_proxy_tool_long_running_event_emission_sequence(self, sample_tool, tool_futures, mock_tool_context):
        """Test that long-running tools emit events in correct sequence."""
        # Use a real queue to capture events
        event_queue = asyncio.Queue()
        
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=0.01,
            is_long_running=True
        )
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="event-test")
            
            args = {"delay": 5}
            
            # Start the execution
            task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_tool_context)
            )
            
            # Wait a bit for events to be emitted
            await asyncio.sleep(0.005)
            
            # Check that events were emitted in correct order
            events = []
            try:
                while True:
                    event = event_queue.get_nowait()
                    events.append(event)
            except asyncio.QueueEmpty:
                pass
            
            # Should have 3 events
            assert len(events) == 3
            
            # Check event types and order
            assert events[0].type == EventType.TOOL_CALL_START
            assert events[0].tool_call_id == "test-function-call-id"
            assert events[0].tool_call_name == sample_tool.name
            
            assert events[1].type == EventType.TOOL_CALL_ARGS
            assert events[1].tool_call_id == "test-function-call-id"
            # Check that args were properly JSON serialized
            import json
            assert json.loads(events[1].delta) == args
            
            assert events[2].type == EventType.TOOL_CALL_END
            assert events[2].tool_call_id == "test-function-call-id"
            


    @pytest.mark.asyncio
    async def test_client_proxy_tool_is_long_running_property(self, sample_tool, mock_event_queue, tool_futures, mock_tool_context):
        """Test that is_long_running property is correctly set and accessible."""
        # Test with is_long_running=True
        long_running_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            timeout_seconds=60,
            is_long_running=True
        )
        
        assert long_running_tool.is_long_running is True
        
        # Test with is_long_running=False
        regular_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            timeout_seconds=60,
            is_long_running=False
        )
        
        assert regular_tool.is_long_running is False
        
        # Test default value (should be True based on constructor)
        default_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            timeout_seconds=60
            # is_long_running not specified, should default to True
        )
        
        assert default_tool.is_long_running is True

        """Test that long-running tools actually wait much longer than timeout setting."""
        proxy_tool = ClientProxyTool(
            ag_ui_tool=sample_tool,
            event_queue=mock_event_queue,
            tool_futures=tool_futures,
            timeout_seconds=0.001,  # 1ms - extremely short
            is_long_running=True
        )
        
        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = MagicMock()
            mock_uuid.return_value.__str__ = MagicMock(return_value="wait-test")
            
            args = {"delay": 5}
            
            start_time = asyncio.get_event_loop().time()
            
            # Start the execution
            task = asyncio.create_task(
                proxy_tool.run_async(args=args, tool_context=mock_tool_context)
            )
            
            # Wait much longer than the timeout setting
            await asyncio.sleep(0.05)  # 50ms, much longer than 1ms timeout
            
            # Task should be done
            assert task.done()
            