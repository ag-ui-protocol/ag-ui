#!/usr/bin/env python
"""Test ExecutionState class functionality."""

import pytest
import asyncio
import time
from unittest.mock import MagicMock

from ag_ui_adk.execution_state import ExecutionState


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
        return MagicMock()

    @pytest.fixture
    def execution_state(self, mock_task, mock_queue):
        """Create a test ExecutionState instance."""
        return ExecutionState(
            task=mock_task,
            thread_id="test_thread_123",
            event_queue=mock_queue
        )

    def test_initialization(self, execution_state, mock_task, mock_queue):
        """Test ExecutionState initialization."""
        assert execution_state.task == mock_task
        assert execution_state.thread_id == "test_thread_123"
        assert execution_state.event_queue == mock_queue
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

    @pytest.mark.asyncio
    async def test_cancel_with_pending_task(self, mock_queue):
        """Test cancelling execution with pending task."""
        # Create a real asyncio task for testing
        async def dummy_task():
            await asyncio.sleep(10)  # Long running task

        real_task = asyncio.create_task(dummy_task())

        execution_state = ExecutionState(
            task=real_task,
            thread_id="test_thread",
            event_queue=mock_queue
        )

        await execution_state.cancel()

        # Should cancel task
        assert real_task.cancelled() is True
        assert execution_state.is_complete is True

    @pytest.mark.asyncio
    async def test_cancel_with_completed_task(self, execution_state, mock_task):
        """Test cancelling execution with already completed task."""
        # Mock task as already done
        mock_task.done.return_value = True

        await execution_state.cancel()

        # Should not try to cancel completed task
        mock_task.cancel.assert_not_called()
        assert execution_state.is_complete is True

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

    def test_get_status_running(self, execution_state):
        """Test get_status when execution is running normally."""
        status = execution_state.get_status()
        assert status == "running"

    def test_string_representation(self, execution_state):
        """Test __repr__ method."""
        repr_str = repr(execution_state)

        assert "ExecutionState" in repr_str
        assert "test_thread_123" in repr_str
        assert "runtime=" in repr_str
        assert "status=" in repr_str

    def test_execution_time_progression(self, execution_state):
        """Test that execution time increases over time."""
        time1 = execution_state.get_execution_time()
        time.sleep(0.01)  # Small delay
        time2 = execution_state.get_execution_time()

        assert time2 > time1