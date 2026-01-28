#!/usr/bin/env python
"""Test HeartbeatPlugin functionality for SSE connection keep-alive."""

import asyncio
from unittest.mock import MagicMock

import pytest
from ag_ui.core import ActivitySnapshotEvent, EventType

from ag_ui_adk.heartbeat import (
    HeartbeatPlugin,
    emit_progress,
    get_event_queue,
    reset_event_queue,
    set_event_queue,
)


class TestContextVar:
    """Test ContextVar-based event queue management."""

    def test_set_and_get_event_queue(self):
        """Test set/get/reset cycle for event queue."""
        queue = asyncio.Queue()

        assert get_event_queue() is None
        token = set_event_queue(queue)
        assert get_event_queue() is queue
        reset_event_queue(token)
        assert get_event_queue() is None

    def test_set_event_queue_returns_token(self):
        """Test set_event_queue returns a token for restoration."""
        queue = asyncio.Queue()
        token = set_event_queue(queue)
        assert token is not None
        reset_event_queue(token)

    def test_nested_context_restoration(self):
        """Test that nested set/reset preserves outer value."""
        outer_queue = asyncio.Queue()
        inner_queue = asyncio.Queue()

        outer_token = set_event_queue(outer_queue)
        assert get_event_queue() is outer_queue

        inner_token = set_event_queue(inner_queue)
        assert get_event_queue() is inner_queue

        reset_event_queue(inner_token)
        assert get_event_queue() is outer_queue

        reset_event_queue(outer_token)
        assert get_event_queue() is None

    def test_set_event_queue_logs_debug(self, caplog):
        """Test debug logging when setting event queue."""
        import logging

        caplog.set_level(logging.DEBUG)

        queue = asyncio.Queue()
        token = set_event_queue(queue)
        assert "Event queue set for heartbeat emission" in caplog.text
        reset_event_queue(token)


class TestHeartbeatPlugin:
    """Test HeartbeatPlugin class."""

    @pytest.fixture
    def plugin(self):
        """Create test plugin instance."""
        return HeartbeatPlugin(
            interval_seconds=1.0,
            activity_type="TEST_ACTIVITY",
            name="test_heartbeat",
        )

    @pytest.fixture
    def mock_tool(self):
        """Create mock ADK tool."""
        tool = MagicMock()
        tool.name = "test_tool"
        return tool

    @pytest.fixture
    def mock_tool_context(self):
        """Create mock ADK ToolContext."""
        context = MagicMock()
        context.function_call_id = "call_123"
        return context

    @pytest.fixture
    def event_queue(self):
        """Create test event queue."""
        return asyncio.Queue()

    def test_initialization(self, plugin):
        """Test custom initialization values."""
        assert plugin.name == "test_heartbeat"
        assert plugin.interval_seconds == 1.0
        assert plugin.activity_type == "TEST_ACTIVITY"

    def test_default_initialization(self):
        """Test default initialization values."""
        plugin = HeartbeatPlugin()
        assert plugin.name == "heartbeat"
        assert plugin.interval_seconds == 5.0
        assert plugin.activity_type == "TOOL_EXECUTION"

    def test_instance_has_own_registry(self):
        """Test each plugin instance has its own heartbeat registry."""
        plugin1 = HeartbeatPlugin()
        plugin2 = HeartbeatPlugin()

        assert plugin1._active_heartbeats is not plugin2._active_heartbeats
        assert plugin1._lock is not plugin2._lock
        assert plugin1._context_call_ids is not plugin2._context_call_ids

    @pytest.mark.asyncio
    async def test_before_tool_callback_no_queue(
        self, plugin, mock_tool, mock_tool_context
    ):
        """Test before_tool_callback returns None when no queue set."""
        token = set_event_queue(None)

        try:
            result = await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={"arg1": "value1"},
                tool_context=mock_tool_context,
            )

            assert result is None
            assert mock_tool_context.function_call_id not in plugin._active_heartbeats
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_before_tool_callback_starts_heartbeat(
        self, plugin, mock_tool, mock_tool_context, event_queue
    ):
        """Test before_tool_callback starts heartbeat task and emits starting event."""
        token = set_event_queue(event_queue)

        try:
            result = await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={"arg1": "value1"},
                tool_context=mock_tool_context,
            )

            assert result is None
            call_id = mock_tool_context.function_call_id
            assert call_id in plugin._active_heartbeats
            assert not plugin._active_heartbeats[call_id].done()

            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert isinstance(event, ActivitySnapshotEvent)
            assert event.type == EventType.ACTIVITY_SNAPSHOT
            assert event.activity_type == "TEST_ACTIVITY"
            assert event.content["status"] == "starting"
            assert event.content["tool_name"] == "test_tool"
        finally:
            await plugin.close()
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_heartbeat_emits_periodically(
        self, mock_tool, mock_tool_context, event_queue
    ):
        """Test heartbeat emits processing events at regular intervals."""
        plugin = HeartbeatPlugin(interval_seconds=0.1)
        token = set_event_queue(event_queue)

        try:
            await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context,
            )

            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "starting"

            await asyncio.sleep(0.15)

            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "processing"
            assert event.content["heartbeat"] == 1
            assert event.content["elapsed_seconds"] == 0.1
        finally:
            await plugin.close()
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_after_tool_callback_stops_heartbeat(
        self, plugin, mock_tool, mock_tool_context, event_queue
    ):
        """Test after_tool_callback stops heartbeat and emits complete event."""
        token = set_event_queue(event_queue)

        try:
            await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context,
            )
            await event_queue.get()

            result = await plugin.after_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context,
                result={"output": "success"},
            )

            assert result is None
            assert mock_tool_context.function_call_id not in plugin._active_heartbeats

            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "complete"
            assert event.content["tool_name"] == "test_tool"
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_on_tool_error_callback_stops_heartbeat(
        self, plugin, mock_tool, mock_tool_context, event_queue
    ):
        """Test on_tool_error_callback stops heartbeat and emits error event."""
        token = set_event_queue(event_queue)

        try:
            await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context,
            )
            await event_queue.get()

            error = ValueError("Something went wrong")
            result = await plugin.on_tool_error_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context,
                error=error,
            )

            assert result is None
            assert mock_tool_context.function_call_id not in plugin._active_heartbeats

            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "error"
            assert event.content["tool_name"] == "test_tool"
            assert "Something went wrong" in event.content["error"]
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_close_cleans_up_only_own_heartbeats(self, mock_tool, event_queue):
        """Test close() only cleans up tasks owned by this instance."""
        plugin1 = HeartbeatPlugin(interval_seconds=1.0)
        plugin2 = HeartbeatPlugin(interval_seconds=1.0)
        token = set_event_queue(event_queue)

        try:
            # Start heartbeats on both plugins
            ctx1 = MagicMock()
            ctx1.function_call_id = "call_plugin1"
            ctx2 = MagicMock()
            ctx2.function_call_id = "call_plugin2"

            await plugin1.before_tool_callback(
                tool=mock_tool, tool_args={}, tool_context=ctx1
            )
            await plugin2.before_tool_callback(
                tool=mock_tool, tool_args={}, tool_context=ctx2
            )

            assert len(plugin1._active_heartbeats) == 1
            assert len(plugin2._active_heartbeats) == 1

            # Close plugin1 - should only affect its own tasks
            await plugin1.close()

            assert len(plugin1._active_heartbeats) == 0
            assert len(plugin2._active_heartbeats) == 1  # Still has its task

            await plugin2.close()
            assert len(plugin2._active_heartbeats) == 0
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_close_awaits_cancelled_tasks(self, plugin, mock_tool, event_queue):
        """Test close() properly awaits cancelled tasks."""
        token = set_event_queue(event_queue)

        try:
            for i in range(3):
                context = MagicMock()
                context.function_call_id = f"call_{i}"
                await plugin.before_tool_callback(
                    tool=mock_tool,
                    tool_args={},
                    tool_context=context,
                )

            assert len(plugin._active_heartbeats) == 3

            # close() should await all tasks without warnings
            await plugin.close()
            assert len(plugin._active_heartbeats) == 0
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_after_tool_callback_without_heartbeat(
        self, plugin, mock_tool, mock_tool_context
    ):
        """Test after_tool_callback handles missing heartbeat gracefully."""
        result = await plugin.after_tool_callback(
            tool=mock_tool,
            tool_args={},
            tool_context=mock_tool_context,
            result={"output": "success"},
        )
        assert result is None


class TestEmitProgress:
    """Test emit_progress helper function."""

    @pytest.fixture
    def event_queue(self):
        """Create test event queue."""
        return asyncio.Queue()

    @pytest.mark.asyncio
    async def test_emit_progress_no_queue(self):
        """Test emit_progress returns False when no queue set."""
        token = set_event_queue(None)
        try:
            result = await emit_progress(
                activity_type="TEST", content={"status": "processing"}
            )
            assert result is False
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_emit_progress_with_queue(self, event_queue):
        """Test emit_progress emits event to queue."""
        token = set_event_queue(event_queue)

        try:
            result = await emit_progress(
                activity_type="EXTRACTION",
                content={"status": "processing", "page": 5, "total_pages": 10},
            )
            assert result is True

            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert isinstance(event, ActivitySnapshotEvent)
            assert event.type == EventType.ACTIVITY_SNAPSHOT
            assert event.activity_type == "EXTRACTION"
            assert event.content["status"] == "processing"
            assert event.content["page"] == 5
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_emit_progress_custom_message_id(self, event_queue):
        """Test emit_progress with custom message_id."""
        token = set_event_queue(event_queue)

        try:
            await emit_progress(
                activity_type="TEST",
                content={"status": "done"},
                message_id="custom_id_123",
            )
            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.message_id == "custom_id_123"
        finally:
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_emit_progress_replace_false(self, event_queue):
        """Test emit_progress with replace=False."""
        token = set_event_queue(event_queue)

        try:
            await emit_progress(
                activity_type="TEST", content={"status": "done"}, replace=False
            )
            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.replace is False
        finally:
            reset_event_queue(token)


class TestIntervalValidation:
    """Test interval_seconds parameter validation."""

    def test_negative_interval_raises_error(self):
        """Test negative interval_seconds raises ValueError."""
        with pytest.raises(ValueError) as exc_info:
            HeartbeatPlugin(interval_seconds=-1.0)
        assert "interval_seconds must be positive" in str(exc_info.value)

    def test_zero_interval_raises_error(self):
        """Test zero interval_seconds raises ValueError."""
        with pytest.raises(ValueError) as exc_info:
            HeartbeatPlugin(interval_seconds=0)
        assert "interval_seconds must be positive" in str(exc_info.value)

    def test_positive_interval_works(self):
        """Test positive interval_seconds is accepted."""
        plugin = HeartbeatPlugin(interval_seconds=0.1)
        assert plugin.interval_seconds == 0.1


class TestOrphanedHeartbeatHandling:
    """Test heartbeat handling when function_call_id is None."""

    @pytest.fixture
    def plugin(self):
        """Create test plugin instance."""
        return HeartbeatPlugin(interval_seconds=1.0)

    @pytest.fixture
    def mock_tool(self):
        """Create mock ADK tool."""
        tool = MagicMock()
        tool.name = "test_tool"
        return tool

    @pytest.fixture
    def mock_tool_context_no_id(self):
        """Create mock ToolContext without function_call_id."""
        context = MagicMock()
        context.function_call_id = None
        return context

    @pytest.fixture
    def event_queue(self):
        """Create test event queue."""
        return asyncio.Queue()

    @pytest.mark.asyncio
    async def test_heartbeat_with_generated_call_id(
        self, plugin, mock_tool, mock_tool_context_no_id, event_queue
    ):
        """Test heartbeat works with generated call_id when function_call_id is None."""
        token = set_event_queue(event_queue)

        try:
            await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context_no_id,
            )

            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "starting"
            assert len(plugin._active_heartbeats) == 1

            await plugin.after_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context_no_id,
                result={"output": "success"},
            )

            assert len(plugin._active_heartbeats) == 0
            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "complete"
        finally:
            await plugin.close()
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_error_callback_with_generated_call_id(
        self, plugin, mock_tool, mock_tool_context_no_id, event_queue
    ):
        """Test error callback works with generated call_id."""
        token = set_event_queue(event_queue)

        try:
            await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context_no_id,
            )
            await event_queue.get()
            assert len(plugin._active_heartbeats) == 1

            error = RuntimeError("Tool failed")
            await plugin.on_tool_error_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=mock_tool_context_no_id,
                error=error,
            )

            assert len(plugin._active_heartbeats) == 0
            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "error"
            assert "Tool failed" in event.content["error"]
        finally:
            await plugin.close()
            reset_event_queue(token)


class TestSetattrFallback:
    """Test WeakKeyDictionary fallback when setattr fails."""

    @pytest.fixture
    def plugin(self):
        """Create test plugin instance."""
        return HeartbeatPlugin(interval_seconds=1.0)

    @pytest.fixture
    def mock_tool(self):
        """Create mock ADK tool."""
        tool = MagicMock()
        tool.name = "test_tool"
        return tool

    @pytest.fixture
    def event_queue(self):
        """Create test event queue."""
        return asyncio.Queue()

    @pytest.mark.asyncio
    async def test_fallback_when_setattr_fails(self, plugin, mock_tool, event_queue):
        """Test WeakKeyDictionary fallback when setattr raises."""

        class FrozenContext:
            """Context that doesn't allow new attribute setting but supports weakref."""

            __slots__ = ("function_call_id", "__weakref__")

            def __init__(self):
                self.function_call_id = None

        frozen_context = FrozenContext()
        token = set_event_queue(event_queue)

        try:
            await plugin.before_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=frozen_context,
            )

            # Task should be created
            assert len(plugin._active_heartbeats) == 1
            # call_id should be in fallback dict
            assert frozen_context in plugin._context_call_ids

            await event_queue.get()  # starting event

            # after_tool_callback should find the call_id via fallback
            await plugin.after_tool_callback(
                tool=mock_tool,
                tool_args={},
                tool_context=frozen_context,
                result={"output": "success"},
            )

            assert len(plugin._active_heartbeats) == 0
            event = await asyncio.wait_for(event_queue.get(), timeout=1.0)
            assert event.content["status"] == "complete"
        finally:
            await plugin.close()
            reset_event_queue(token)


class TestThreadSafety:
    """Test thread-safe operations."""

    @pytest.mark.asyncio
    async def test_concurrent_heartbeat_operations(self):
        """Test concurrent heartbeat start/stop operations don't race."""
        plugin = HeartbeatPlugin(interval_seconds=0.5)
        queue = asyncio.Queue()
        token = set_event_queue(queue)

        try:
            contexts = []
            for i in range(5):
                ctx = MagicMock()
                ctx.function_call_id = f"concurrent_call_{i}"
                contexts.append(ctx)

            mock_tool = MagicMock()
            mock_tool.name = "concurrent_tool"

            start_tasks = [
                plugin.before_tool_callback(
                    tool=mock_tool, tool_args={}, tool_context=ctx
                )
                for ctx in contexts
            ]
            await asyncio.gather(*start_tasks)
            assert len(plugin._active_heartbeats) == 5

            stop_tasks = [
                plugin.after_tool_callback(
                    tool=mock_tool, tool_args={}, tool_context=ctx, result={}
                )
                for ctx in contexts
            ]
            await asyncio.gather(*stop_tasks)
            assert len(plugin._active_heartbeats) == 0
        finally:
            await plugin.close()
            reset_event_queue(token)

    @pytest.mark.asyncio
    async def test_multiple_plugins_concurrent(self):
        """Test multiple plugin instances don't interfere."""
        plugin1 = HeartbeatPlugin(interval_seconds=0.5, name="plugin1")
        plugin2 = HeartbeatPlugin(interval_seconds=0.5, name="plugin2")
        queue = asyncio.Queue()
        token = set_event_queue(queue)

        try:
            mock_tool = MagicMock()
            mock_tool.name = "test_tool"

            # Create contexts for both plugins
            contexts1 = [MagicMock(function_call_id=f"p1_call_{i}") for i in range(3)]
            contexts2 = [MagicMock(function_call_id=f"p2_call_{i}") for i in range(3)]

            # Start heartbeats on both plugins concurrently
            all_starts = [
                plugin1.before_tool_callback(
                    tool=mock_tool, tool_args={}, tool_context=ctx
                )
                for ctx in contexts1
            ] + [
                plugin2.before_tool_callback(
                    tool=mock_tool, tool_args={}, tool_context=ctx
                )
                for ctx in contexts2
            ]
            await asyncio.gather(*all_starts)

            assert len(plugin1._active_heartbeats) == 3
            assert len(plugin2._active_heartbeats) == 3

            # Close plugin1 - should not affect plugin2
            await plugin1.close()
            assert len(plugin1._active_heartbeats) == 0
            assert len(plugin2._active_heartbeats) == 3

            await plugin2.close()
            assert len(plugin2._active_heartbeats) == 0
        finally:
            reset_event_queue(token)
