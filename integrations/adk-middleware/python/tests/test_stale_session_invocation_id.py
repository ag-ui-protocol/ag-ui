"""Tests for deferred invocation_id storage to prevent stale session errors.

When using DatabaseSessionService with ResumabilityConfig, calling
session_manager.update_session_state() during the ADK run loop causes a
stale session error because it updates the DB timestamp via a fresh session
object, while the runner's session object retains the old last_update_time.

The fix defers the invocation_id storage to AFTER the run loop completes,
when it is safe to update session state without conflicting with the runner.
"""

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from ag_ui.core import EventType, RunAgentInput
from ag_ui.core import Tool as AGUITool
from ag_ui.core import UserMessage
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig

from ag_ui_adk import ADKAgent, AGUIToolset
from ag_ui_adk.session_manager import INVOCATION_ID_STATE_KEY, SessionManager


class TestDeferredInvocationIdStorage:
    """Tests that invocation_id is NOT stored mid-run (avoiding stale session)."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def simple_agent(self):
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="You are a helpful assistant.",
        )

    @pytest.fixture
    def resumable_adk_agent(self, simple_agent):
        """ADKAgent with ResumabilityConfig enabled."""
        app = App(
            name="test_app",
            root_agent=simple_agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        return ADKAgent.from_app(app, user_id="test_user")

    @pytest.fixture
    def non_resumable_adk_agent(self, simple_agent):
        """ADKAgent without ResumabilityConfig."""
        app = App(name="test_app", root_agent=simple_agent)
        return ADKAgent.from_app(app, user_id="test_user")

    def _make_mock_event(
        self,
        *,
        author="test_agent",
        text="Hello",
        partial=False,
        invocation_id="inv_123",
        has_lro=False,
        lro_tool_name="approve_plan",
    ):
        """Create a mock ADK event with sensible defaults."""
        event = MagicMock()
        event.author = author
        event.partial = partial
        event.invocation_id = invocation_id
        event.turn_complete = not partial
        event.actions = None

        # Content with text part
        text_part = MagicMock()
        text_part.text = text
        text_part.function_call = None
        text_part.function_response = None

        parts = [text_part]

        if has_lro:
            fc_part = MagicMock()
            fc_part.text = None
            fc = MagicMock()
            fc.name = lro_tool_name
            fc.id = f"fc_{uuid.uuid4().hex[:8]}"
            fc.args = {"plan": {"topic": "test"}}
            fc_part.function_call = fc
            fc_part.function_response = None
            parts.append(fc_part)
            event.long_running_tool_ids = [fc.id]
        else:
            event.long_running_tool_ids = []

        event.content = MagicMock()
        event.content.parts = parts

        event.is_final_response = MagicMock(return_value=not partial)
        event.get_function_calls = MagicMock(return_value=[])
        event.get_function_responses = MagicMock(return_value=[])

        return event

    @pytest.mark.asyncio
    async def test_no_mid_run_update_session_state_for_invocation_id(
        self, resumable_adk_agent
    ):
        """Verify update_session_state is NOT called with INVOCATION_ID during the run loop.

        This is the core regression test. Previously, update_session_state was
        called on the first event with an invocation_id, which updated the DB
        timestamp and made the runner's session object stale.
        """
        adk_agent = resumable_adk_agent
        assert adk_agent._is_adk_resumable() is True

        # Track all calls to update_session_state with their arguments
        update_calls = []
        run_loop_active = False

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append(
                {
                    "state": dict(state) if state else {},
                    "during_run_loop": run_loop_active,
                }
            )
            return True

        # Mock the runner to emit events with invocation_id
        async def mock_run_async(**kwargs):
            nonlocal run_loop_active
            run_loop_active = True
            yield self._make_mock_event(
                text="Hello", partial=True, invocation_id="inv_abc123"
            )
            yield self._make_mock_event(
                text="Hello world", partial=False, invocation_id="inv_abc123"
            )
            run_loop_active = False

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Hello")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # The key assertion: NO update_session_state call with INVOCATION_ID
        # should happen while the run loop is active
        mid_run_invocation_calls = [
            c
            for c in update_calls
            if c["during_run_loop"] and INVOCATION_ID_STATE_KEY in c["state"]
        ]
        assert mid_run_invocation_calls == [], (
            f"update_session_state was called with {INVOCATION_ID_STATE_KEY} "
            f"during the run loop, which causes stale session errors. "
            f"Calls: {mid_run_invocation_calls}"
        )

    @pytest.mark.asyncio
    async def test_invocation_id_stored_after_lro_pause(self, resumable_adk_agent):
        """Verify invocation_id IS stored after run completes with LRO pause."""
        adk_agent = resumable_adk_agent

        update_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            # First event: partial text with invocation_id
            yield self._make_mock_event(
                text="Let me plan", partial=True, invocation_id="inv_lro_test"
            )
            # Second event: LRO tool call (non-partial)
            event = self._make_mock_event(
                text="",
                partial=False,
                invocation_id="inv_lro_test",
                has_lro=True,
                lro_tool_name="approve_plan",
            )
            yield event

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Plan something")],
            state={},
            tools=[
                AGUITool(
                    name="approve_plan",
                    description="Approve a plan",
                    parameters={"type": "object", "properties": {}},
                )
            ],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # After LRO pause, invocation_id should be stored post-run
        invocation_store_calls = [
            c
            for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is not None
        ]
        assert len(invocation_store_calls) >= 1, (
            f"invocation_id should be stored after LRO pause. "
            f"All update_session_state calls: {update_calls}"
        )
        assert (
            invocation_store_calls[0]["state"][INVOCATION_ID_STATE_KEY]
            == "inv_lro_test"
        )

    @pytest.mark.asyncio
    async def test_invocation_id_cleared_after_normal_run(self, resumable_adk_agent):
        """Verify invocation_id is cleared after a normal (non-LRO) completed run."""
        adk_agent = resumable_adk_agent

        update_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            yield self._make_mock_event(
                text="Hello", partial=True, invocation_id="inv_normal"
            )
            yield self._make_mock_event(
                text="Hello world", partial=False, invocation_id="inv_normal"
            )

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Hello")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # After a normal run, invocation_id should be cleared (set to None)
        invocation_clear_calls = [
            c
            for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is None
        ]
        assert len(invocation_clear_calls) >= 1, (
            f"invocation_id should be cleared after normal (non-LRO) run. "
            f"All update_session_state calls: {update_calls}"
        )

    @pytest.mark.asyncio
    async def test_no_invocation_id_storage_without_resumability(
        self, non_resumable_adk_agent
    ):
        """Verify no invocation_id operations happen without ResumabilityConfig."""
        adk_agent = non_resumable_adk_agent
        assert adk_agent._is_adk_resumable() is False

        update_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            yield self._make_mock_event(
                text="Response", partial=False, invocation_id="inv_nonresumable"
            )

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Hello")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # No calls should reference INVOCATION_ID_STATE_KEY
        invocation_calls = [
            c for c in update_calls if INVOCATION_ID_STATE_KEY in c["state"]
        ]
        assert invocation_calls == [], (
            f"No invocation_id operations should happen without ResumabilityConfig. "
            f"Calls with invocation_id: {invocation_calls}"
        )

    @pytest.mark.asyncio
    async def test_text_message_with_stored_invocation_id_starts_fresh_run(
        self, resumable_adk_agent
    ):
        """Verify that a text message (no tool results) clears a stale invocation_id.

        When the user types a message instead of clicking a HITL tool button,
        the middleware should NOT attempt HITL resumption. It should clear the
        stored invocation_id and start a fresh run.
        """
        adk_agent = resumable_adk_agent

        update_calls = []
        run_async_kwargs_capture = {}

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            run_async_kwargs_capture.update(kwargs)
            yield self._make_mock_event(
                text="Fresh response", partial=False, invocation_id="inv_fresh"
            )

        # Simulate state with a stored invocation_id from a previous LRO pause
        async def mock_get_state(session_id, app_name, user_id):
            return {INVOCATION_ID_STATE_KEY: "inv_stale_from_lro"}

        # Plain text message - no tool results
        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="I dont know")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(
            adk_agent._session_manager,
            "get_session_state",
            side_effect=mock_get_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # The stale invocation_id should be cleared (set to None) BEFORE the run
        invocation_clear_calls = [
            c
            for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is None
        ]
        assert len(invocation_clear_calls) >= 1, (
            f"Stale invocation_id should be cleared when user sends text instead of tool result. "
            f"All update_session_state calls: {update_calls}"
        )

        # run_async should NOT receive the stale invocation_id
        assert "invocation_id" not in run_async_kwargs_capture, (
            f"run_async should not receive invocation_id for a text message. "
            f"Got kwargs: {run_async_kwargs_capture}"
        )
