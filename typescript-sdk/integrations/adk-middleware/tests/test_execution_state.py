#!/usr/bin/env python
"""Test ExecutionState class functionality."""

import pytest
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

from adk_middleware.execution_state import ExecutionState


class TestExecutionState:
    """Test cases for ExecutionState class."""
    
    @pytest.fixture
    def mock_task(self):
        """Create a mock asyncio task."""
        task = MagicMock()
        task.done.return_value = False
        task.cancel = MagicMock()
        return task
    
    @pytest.fixture
    def mock_queue(self):
        """Create a mock asyncio queue."""
        return AsyncMock()
    
    @pytest.fixture
    def sample_tool_futures(self):
        """Create sample tool futures."""
        future1 = asyncio.Future()
        future2 = asyncio.Future()
        return {
            "tool_call_1": future1,
            "tool_call_2": future2
        }
    
    @pytest.fixture
    def execution_state(self, mock_task, mock_queue, sample_tool_futures):
        """Create a test ExecutionState instance."""
        return ExecutionState(
            task=mock_task,
            thread_id="test_thread_123",
            event_queue=mock_queue,
            tool_futures=sample_tool_futures
        )
    
    def test_initialization(self, execution_state, mock_task, mock_queue, sample_tool_futures):
        """Test ExecutionState initialization."""
        assert execution_state.task == mock_task
        assert execution_state.thread_id == "test_thread_123"
        assert execution_state.event_queue == mock_queue
        assert execution_state.tool_futures == sample_tool_futures
        assert execution_state.is_complete is False
        assert isinstance(execution_state.start_time, float)
        assert execution_state.start_time <= time.time()
    
    def test_is_stale_fresh_execution(self, execution_state):
        """Test is_stale returns False for fresh execution."""
        # Should not be stale immediately
        assert execution_state.is_stale(600) is False
        assert execution_state.is_stale(1) is False
    
    def test_is_stale_old_execution(self, execution_state):
        """Test is_stale returns True for old execution."""
        # Artificially age the execution
        execution_state.start_time = time.time() - 700  # 700 seconds ago
        
        assert execution_state.is_stale(600) is True  # 10 minute timeout
        assert execution_state.is_stale(800) is False  # 13+ minute timeout
    
    def test_has_pending_tools_all_done(self, execution_state, sample_tool_futures):
        """Test has_pending_tools when all futures are done."""
        # Mark all futures as done
        for future in sample_tool_futures.values():
            future.set_result("completed")
        
        assert execution_state.has_pending_tools() is False
    
    def test_has_pending_tools_some_pending(self, execution_state, sample_tool_futures):
        """Test has_pending_tools when some futures are pending."""
        # Mark only one future as done
        tool_futures = list(sample_tool_futures.values())
        tool_futures[0].set_result("completed")
        # tool_futures[1] remains pending
        
        assert execution_state.has_pending_tools() is True
    
    def test_has_pending_tools_no_tools(self, mock_task, mock_queue):
        """Test has_pending_tools when no tools exist."""
        execution = ExecutionState(
            task=mock_task,
            thread_id="test_thread",
            event_queue=mock_queue,
            tool_futures={}
        )
        
        assert execution.has_pending_tools() is False
    
    def test_resolve_tool_result_success(self, execution_state, sample_tool_futures):
        """Test successful tool result resolution."""
        result = {"status": "success", "data": "test_result"}
        
        success = execution_state.resolve_tool_result("tool_call_1", result)
        
        assert success is True
        future = sample_tool_futures["tool_call_1"]
        assert future.done() is True
        assert future.result() == result
    
    def test_resolve_tool_result_nonexistent_tool(self, execution_state):
        """Test resolving result for non-existent tool."""
        result = {"status": "success"}
        
        success = execution_state.resolve_tool_result("nonexistent_tool", result)
        
        assert success is False
    
    def test_resolve_tool_result_already_done(self, execution_state, sample_tool_futures):
        """Test resolving result for already completed tool."""
        # Pre-complete the future
        sample_tool_futures["tool_call_1"].set_result("first_result")
        
        success = execution_state.resolve_tool_result("tool_call_1", "second_result")
        
        assert success is False
        # Original result should be preserved
        assert sample_tool_futures["tool_call_1"].result() == "first_result"
    
    def test_resolve_tool_result_with_exception(self, execution_state, sample_tool_futures):
        """Test resolving tool result when setting result raises exception."""
        # Create a future that will raise when setting result
        problematic_future = MagicMock()
        problematic_future.done.return_value = False
        problematic_future.set_result.side_effect = RuntimeError("Future error")
        problematic_future.set_exception = MagicMock()
        
        execution_state.tool_futures["problematic_tool"] = problematic_future
        
        success = execution_state.resolve_tool_result("problematic_tool", "result")
        
        # Should still return True because it handled the exception
        assert success is True
        problematic_future.set_exception.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_cancel_with_pending_task(self, mock_task, mock_queue, sample_tool_futures):
        """Test cancelling execution with pending task."""
        # Create a real asyncio task for testing
        async def dummy_task():
            await asyncio.sleep(10)  # Long running task
        
        real_task = asyncio.create_task(dummy_task())
        
        execution_state = ExecutionState(
            task=real_task,
            thread_id="test_thread",
            event_queue=mock_queue,
            tool_futures=sample_tool_futures
        )
        
        await execution_state.cancel()
        
        # Should cancel task and all futures
        assert real_task.cancelled() is True
        assert execution_state.is_complete is True
        
        # All futures should be cancelled
        for future in sample_tool_futures.values():
            assert future.cancelled() is True
    
    @pytest.mark.asyncio
    async def test_cancel_with_completed_task(self, execution_state, mock_task, sample_tool_futures):
        """Test cancelling execution with already completed task."""
        # Mock task as already done
        mock_task.done.return_value = True
        
        await execution_state.cancel()
        
        # Should not try to cancel completed task
        mock_task.cancel.assert_not_called()
        assert execution_state.is_complete is True
        
        # Futures should still be cancelled
        for future in sample_tool_futures.values():
            assert future.cancelled() is True
    
    def test_get_execution_time(self, execution_state):
        """Test get_execution_time returns reasonable value."""
        execution_time = execution_state.get_execution_time()
        
        assert isinstance(execution_time, float)
        assert execution_time >= 0
        assert execution_time < 1.0  # Should be very small for fresh execution
    
    def test_get_status_complete(self, execution_state):
        """Test get_status when execution is complete."""
        execution_state.is_complete = True
        
        assert execution_state.get_status() == "complete"
    
    def test_get_status_task_done(self, execution_state, mock_task):
        """Test get_status when task is done but execution not marked complete."""
        mock_task.done.return_value = True
        
        assert execution_state.get_status() == "task_done"
    
    def test_get_status_waiting_for_tools(self, execution_state, sample_tool_futures):
        """Test get_status when waiting for tool results."""
        # One future pending, one done
        tool_futures = list(sample_tool_futures.values())
        tool_futures[0].set_result("done")
        # tool_futures[1] remains pending
        
        status = execution_state.get_status()
        assert status == "waiting_for_tools (1 pending)"
    
    def test_get_status_running(self, execution_state, sample_tool_futures):
        """Test get_status when execution is running normally."""
        # Complete all tool futures so it's not waiting for tools
        for future in sample_tool_futures.values():
            future.set_result("done")
        
        status = execution_state.get_status()
        assert status == "running"
    
    def test_string_representation(self, execution_state):
        """Test __repr__ method."""
        repr_str = repr(execution_state)
        
        assert "ExecutionState" in repr_str
        assert "test_thread_123" in repr_str
        assert "tools=2" in repr_str  # Should show 2 tool futures
        assert "runtime=" in repr_str
        assert "status=" in repr_str
    
    def test_execution_time_progression(self, execution_state):
        """Test that execution time increases over time."""
        time1 = execution_state.get_execution_time()
        time.sleep(0.01)  # Small delay
        time2 = execution_state.get_execution_time()
        
        assert time2 > time1