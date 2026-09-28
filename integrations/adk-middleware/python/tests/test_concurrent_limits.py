#!/usr/bin/env python
"""Test concurrent execution limits in ADKAgent."""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, RunErrorEvent, CustomEvent
)

from ag_ui_adk import ADKAgent
from tests.constants import LIVE_TEST_MODEL

# The scope the adk_middleware fixture resolves for every run: its static user,
# and its agent's name as the app. Execution keys are (thread_id, user, app).
USER = "test_user"
APP = "test_agent"


def _marker(thread_id):
    """An event only the mocked background producer emits, never the wrapper."""
    return CustomEvent(type=EventType.CUSTOM, name="produced", value=thread_id)


def _shape(events):
    """Event types, with each producer marker replaced by the thread it names."""
    return [e.value if isinstance(e, CustomEvent) else e.type for e in events]


class TestConcurrentLimits:
    """Test cases for concurrent execution limits."""


    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model=LIVE_TEST_MODEL,
            instruction="Test agent for concurrent testing"
        )

    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware with low concurrent limits."""
        return ADKAgent(
            adk_agent=mock_adk_agent,
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30,
            max_concurrent_executions=2  # Low limit for testing
        )

    @pytest.fixture
    def sample_input(self):
        """Create sample run input."""
        return RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

    @pytest.mark.asyncio
    async def test_concurrent_execution_limit_enforcement(self, adk_middleware):
        """Test that concurrent execution limits are enforced."""
        # Use lighter mocking - just mock the ADK runner to avoid external dependencies
        async def mock_run_adk_in_background(*args, **_kwargs):
            # Simulate a long-running background task
            await asyncio.sleep(10)  # Long enough to test concurrency

        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            # Start first execution
            input1 = RunAgentInput(
                thread_id="thread_1", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="First")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            # Start execution as a task (don't await - let it run in background)
            async def consume_events(execution_generator):
                events = []
                async for event in execution_generator:
                    events.append(event)
                    # Consume a few events to let execution get stored
                    if len(events) >= 3:
                        break
                return events

            task1 = asyncio.create_task(
                consume_events(adk_middleware._start_new_execution(input1))
            )

            # Wait for first execution to start and be stored
            await asyncio.sleep(0.1)

            # Start second execution
            input2 = RunAgentInput(
                thread_id="thread_2", run_id="run_2",
                messages=[UserMessage(id="2", role="user", content="Second")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            task2 = asyncio.create_task(
                consume_events(adk_middleware._start_new_execution(input2))
            )

            # Wait for second execution to start
            await asyncio.sleep(0.1)

            # Should have 2 active executions now
            print(f"Active executions: {len(adk_middleware._active_executions)}")
            print(f"Execution keys: {list(adk_middleware._active_executions.keys())}")

            # Try third execution - should fail due to limit
            input3 = RunAgentInput(
                thread_id="thread_3", run_id="run_3",
                messages=[UserMessage(id="3", role="user", content="Third")],
                tools=[], context=[], state={}, forwarded_props={}
            )

            events = []
            async for event in adk_middleware._start_new_execution(input3):
                events.append(event)
                # Look for error events
                if any(isinstance(e, RunErrorEvent) for e in events):
                    break
                if len(events) >= 5:  # Safety limit
                    break

            # Should get an error about max concurrent executions
            error_events = [e for e in events if isinstance(e, RunErrorEvent)]
            if not error_events:
                print(f"No error events found. Events: {[type(e).__name__ for e in events]}")
                print(f"Active executions after third attempt: {len(adk_middleware._active_executions)}")

            assert len(error_events) >= 1, f"Expected error event, got events: {[type(e).__name__ for e in events]}"
            assert "Maximum concurrent executions" in error_events[0].message

            # Clean up
            task1.cancel()
            task2.cancel()
            try:
                await task1
            except asyncio.CancelledError:
                pass
            try:
                await task2
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_stale_execution_cleanup_frees_slots(self, adk_middleware):
        """Test that cleaning up stale executions frees slots for new ones."""
        # Create stale executions manually
        mock_execution1 = MagicMock()
        mock_execution1.thread_id = "stale_thread_1"
        mock_execution1.is_stale.return_value = True
        mock_execution1.cancel = AsyncMock()

        mock_execution2 = MagicMock()
        mock_execution2.thread_id = "stale_thread_2"
        mock_execution2.is_stale.return_value = True
        mock_execution2.cancel = AsyncMock()

        # Add to active executions
        adk_middleware._active_executions[("stale_thread_1", USER, APP)] = mock_execution1
        adk_middleware._active_executions[("stale_thread_2", USER, APP)] = mock_execution2

        # Should be at limit
        assert len(adk_middleware._active_executions) == 2

        # Cleanup should remove stale executions
        await adk_middleware._cleanup_stale_executions()

        # Should be empty now
        assert len(adk_middleware._active_executions) == 0

        # Should have called cancel on both
        mock_execution1.cancel.assert_called_once()
        mock_execution2.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_mixed_stale_and_active_executions(self, adk_middleware):
        """Test cleanup with mix of stale and active executions."""
        # Create one stale and one active execution
        stale_execution = MagicMock()
        stale_execution.thread_id = "stale_thread"
        stale_execution.is_stale.return_value = True
        stale_execution.cancel = AsyncMock()

        active_execution = MagicMock()
        active_execution.thread_id = "active_thread"
        active_execution.is_stale.return_value = False
        active_execution.cancel = AsyncMock()

        adk_middleware._active_executions[("stale_thread", USER, APP)] = stale_execution
        adk_middleware._active_executions[("active_thread", USER, APP)] = active_execution

        await adk_middleware._cleanup_stale_executions()

        # Only stale should be removed
        assert ("stale_thread", USER, APP) not in adk_middleware._active_executions
        assert ("active_thread", USER, APP) in adk_middleware._active_executions

        # Only stale should be cancelled
        stale_execution.cancel.assert_called_once()
        active_execution.cancel.assert_not_called()

    @pytest.mark.asyncio
    async def test_zero_concurrent_limit(self):
        """Test behavior with zero concurrent execution limit."""
        # Create ADK middleware with zero limit
        from google.adk.agents import LlmAgent
        mock_agent = LlmAgent(name="test", model=LIVE_TEST_MODEL, instruction="test")

        zero_limit_middleware = ADKAgent(
            adk_agent=mock_agent,
            user_id="test_user",
            max_concurrent_executions=0
        )

        input_data = RunAgentInput(
            thread_id="thread_1", run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[], context=[], state={}, forwarded_props={}
        )

        # Should immediately fail
        events = []
        async for event in zero_limit_middleware._start_new_execution(input_data):
            events.append(event)
            if len(events) >= 2:
                break

        error_events = [e for e in events if isinstance(e, RunErrorEvent)]
        assert len(error_events) >= 1
        assert "Maximum concurrent executions (0) reached" in error_events[0].message

    @pytest.mark.asyncio
    async def test_execution_completion_frees_slot(self, adk_middleware):
        """A completed run with no pending tool calls releases its slot, so a
        later run fits under the limit."""
        # Occupy one of the two slots with a live, non-stale run.
        busy = MagicMock()
        busy.is_stale.return_value = False
        busy.cancel = AsyncMock()
        adk_middleware._active_executions[("busy", USER, APP)] = busy

        started = []

        async def background(**kwargs):
            started.append(kwargs["input"].thread_id)
            await kwargs["event_queue"].put(_marker(kwargs["input"].thread_id))
            await kwargs["event_queue"].put(None)

        def run(thread_id):
            return adk_middleware._start_new_execution(RunAgentInput(
                thread_id=thread_id, run_id=f"run_{thread_id}",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[], context=[], state={}, forwarded_props={}
            ))

        with (
            patch.object(adk_middleware, "_run_adk_in_background", side_effect=background),
            patch.object(adk_middleware, "_has_pending_tool_calls", AsyncMock(return_value=False)),
        ):
            first = [e async for e in run("thread_1")]
            assert _shape(first) == [EventType.RUN_STARTED, "thread_1", EventType.RUN_FINISHED]
            # The finished run gave its slot back; only the busy one remains.
            assert list(adk_middleware._active_executions) == [("busy", USER, APP)]

            # With the slot freed, a second run is admitted instead of hitting the limit.
            second = [e async for e in run("thread_2")]
            assert _shape(second) == [EventType.RUN_STARTED, "thread_2", EventType.RUN_FINISHED]

        assert started == ["thread_1", "thread_2"]
        busy.cancel.assert_not_called()

    @pytest.mark.asyncio
    async def test_execution_with_pending_tools_not_cleaned(self, adk_middleware):
        """A finished run with pending tool calls stays tracked under its scope."""
        async def finish_immediately(**kwargs):
            await kwargs["event_queue"].put(None)

        input_data = RunAgentInput(
            thread_id="thread_1", run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[], context=[], state={}, forwarded_props={}
        )
        with (
            patch.object(adk_middleware, "_run_adk_in_background", side_effect=finish_immediately),
            patch.object(
                adk_middleware, "_has_pending_tool_calls", AsyncMock(return_value=True)
            ) as has_pending,
        ):
            events = [e async for e in adk_middleware._start_new_execution(input_data)]

        assert [e.type for e in events] == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
        # The real finally block kept it, under the exact resolved scope.
        assert list(adk_middleware._active_executions) == [("thread_1", USER, APP)]
        assert adk_middleware._active_executions[("thread_1", USER, APP)].is_complete
        has_pending.assert_awaited_once_with("thread_1", USER, app_name=APP)

    @pytest.mark.asyncio
    async def test_same_thread_in_another_app_does_not_share_an_execution(self, mock_adk_agent):
        """A run in one app neither waits on nor replaces the same thread's
        in-flight run in another app for the same user."""
        middleware = ADKAgent(
            adk_agent=mock_adk_agent,
            user_id=USER,
            app_name_extractor=lambda i: i.forwarded_props["app"],
            max_concurrent_executions=2,
        )
        release_first = asyncio.Event()

        async def background(**kwargs):
            if kwargs["app_name"] == "first":
                await release_first.wait()
            await kwargs["event_queue"].put(None)

        def run_in(app):
            return middleware._start_new_execution(RunAgentInput(
                thread_id="shared", run_id=f"run_{app}",
                messages=[UserMessage(id="1", role="user", content="Hi")],
                tools=[], context=[], state={}, forwarded_props={"app": app},
            ))

        async def drain(gen):
            return [e async for e in gen]

        with (
            patch.object(middleware, "_run_adk_in_background", side_effect=background),
            patch.object(middleware, "_has_pending_tool_calls", AsyncMock(return_value=False)),
        ):
            first = asyncio.create_task(drain(run_in("first")))
            for _ in range(100):
                if middleware._active_executions:
                    break
                await asyncio.sleep(0.01)
            [first_execution] = middleware._active_executions.values()

            # Sharing the first app's key would make this wait on its task.
            second_events = await asyncio.wait_for(drain(run_in("second")), timeout=2)

            assert [e.type for e in second_events] == [
                EventType.RUN_STARTED, EventType.RUN_FINISHED
            ]
            assert list(middleware._active_executions) == [("shared", USER, "first")]
            assert middleware._active_executions[("shared", USER, "first")] is first_execution
            assert not first_execution.is_complete

            release_first.set()
            await asyncio.wait_for(first, timeout=2)
        assert middleware._active_executions == {}

    @pytest.mark.asyncio
    async def test_high_concurrent_limit(self):
        """A configured high limit admits runs past the default limit of 10."""
        from google.adk.agents import LlmAgent
        mock_agent = LlmAgent(name="test", model=LIVE_TEST_MODEL, instruction="test")

        high_limit_middleware = ADKAgent(
            adk_agent=mock_agent,
            user_id="test_user",
            max_concurrent_executions=1000  # Very high limit
        )

        # Ten live runs would saturate the default limit.
        existing = {}
        for i in range(10):
            mock_execution = MagicMock()
            mock_execution.is_stale.return_value = False
            mock_execution.cancel = AsyncMock()
            existing[(f"thread_{i}", USER, "test")] = mock_execution
        high_limit_middleware._active_executions.update(existing)

        async def background(**kwargs):
            await kwargs["event_queue"].put(_marker(kwargs["input"].thread_id))
            await kwargs["event_queue"].put(None)

        with (
            patch.object(high_limit_middleware, "_run_adk_in_background", side_effect=background),
            patch.object(
                high_limit_middleware, "_has_pending_tool_calls", AsyncMock(return_value=False)
            ),
        ):
            events = [e async for e in high_limit_middleware._start_new_execution(RunAgentInput(
                thread_id="thread_new", run_id="run_new",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[], context=[], state={}, forwarded_props={}
            ))]

        # The eleventh run was admitted and actually ran.
        assert _shape(events) == [EventType.RUN_STARTED, "thread_new", EventType.RUN_FINISHED]
        # Staying under the limit never triggered stale cleanup of the live runs.
        assert high_limit_middleware._active_executions == existing
        for execution in existing.values():
            execution.is_stale.assert_not_called()
            execution.cancel.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_during_limit_check(self, adk_middleware):
        """At the limit, stale runs are cancelled and evicted so the new run proceeds."""
        # Create real ExecutionState objects that will actually be stale
        import time
        from ag_ui_adk.execution_state import ExecutionState

        # Create stale executions
        stale = []
        for i in range(2):  # At the limit (max_concurrent_executions=2)
            mock_task = MagicMock()
            mock_queue = AsyncMock()
            execution = ExecutionState(
                task=mock_task,
                thread_id=f"stale_{i}",
                event_queue=mock_queue
            )
            # Make them stale by setting an old start time
            execution.start_time = time.time() - 1000  # 1000 seconds ago, definitely stale
            execution.cancel = AsyncMock()  # Mock the cancel method
            adk_middleware._active_executions[(f"stale_{i}", USER, APP)] = execution
            stale.append(execution)

        async def background(**kwargs):
            await kwargs["event_queue"].put(_marker(kwargs["input"].thread_id))
            await kwargs["event_queue"].put(None)

        with (
            patch.object(adk_middleware, "_run_adk_in_background", side_effect=background),
            patch.object(adk_middleware, "_has_pending_tool_calls", AsyncMock(return_value=False)),
        ):
            input_data = RunAgentInput(
                thread_id="new_thread", run_id="run_1",
                messages=[UserMessage(id="1", role="user", content="Test")],
                tools=[], context=[], state={}, forwarded_props={}
            )
            events = [e async for e in adk_middleware._start_new_execution(input_data)]

        # Cleanup freed the slots, so the new run was admitted and actually ran.
        assert _shape(events) == [EventType.RUN_STARTED, "new_thread", EventType.RUN_FINISHED]

        # Both stale runs were cancelled and evicted.
        for execution in stale:
            execution.cancel.assert_awaited_once()
        assert adk_middleware._active_executions == {}
