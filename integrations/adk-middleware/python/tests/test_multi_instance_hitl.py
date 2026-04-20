# tests/test_multi_instance_hitl.py

"""
Multi-instance ADK deployment HITL test.

Simulates two ADKAgent instances (pods) sharing a common session store
(InMemorySessionService acting as a shared database). Verifies that when
Instance A creates a session with pending HITL tool calls, Instance B
(with a cold cache) can discover and process them correctly.
"""

import pytest
from unittest.mock import patch

from ag_ui.core import (
    RunAgentInput, UserMessage, AssistantMessage, ToolMessage,
    ToolCall, FunctionCall, Tool as AGUITool,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    EventType, RunErrorEvent,
)
from google.adk.agents import LlmAgent
from google.adk.sessions import InMemorySessionService

from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager


class TestMultiInstanceHITL:
    """Test HITL tool flow across simulated multi-instance deployment."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset the SessionManager singleton between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def shared_session_service(self):
        """Shared InMemorySessionService acting as the database."""
        return InMemorySessionService()

    @pytest.fixture
    def sample_tool(self):
        return AGUITool(
            name="approve_plan",
            description="Approval tool",
            parameters={
                "type": "object",
                "properties": {"approved": {"type": "boolean"}},
            },
        )

    @pytest.fixture
    def instance_a(self, shared_session_service):
        """First ADKAgent instance (Pod A). Initializes the SessionManager singleton."""
        agent = LlmAgent(name="test_agent", model="gemini-2.0-flash", instruction="Test")
        return ADKAgent(
            adk_agent=agent,
            app_name="test_app",
            user_id="test_user",
            session_service=shared_session_service,
        )

    @pytest.fixture
    def instance_b(self, shared_session_service, instance_a):
        """Second ADKAgent instance (Pod B). Depends on instance_a for singleton order."""
        agent = LlmAgent(name="test_agent", model="gemini-2.0-flash", instruction="Test")
        return ADKAgent(
            adk_agent=agent,
            app_name="test_app",
            user_id="test_user",
            session_service=shared_session_service,
        )

    @pytest.mark.asyncio
    async def test_cross_instance_hitl_tool_result_flow(
        self, instance_a, instance_b, sample_tool,
    ):
        """End-to-end: A emits tool call, B (cold cache) processes tool result."""
        thread_id = "multi_pod_thread"
        tool_call_id = "tool_call_abc123"

        # --- Phase 1: Instance A creates session and pending tool call ---

        # Pre-create the session so the cache is populated before the mock
        # replaces _run_adk_in_background (which normally calls _ensure_session_exists).
        await instance_a._ensure_session_exists(
            app_name="test_app", user_id="test_user",
            thread_id=thread_id, initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[UserMessage(id="msg_1", role="user", content="Plan something")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        async def mock_run_a(*args, **kwargs):
            eq = kwargs["event_queue"]
            await eq.put(ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name="approve_plan",
            ))
            await eq.put(ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta="{}",
            ))
            await eq.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id,
            ))
            await eq.put(None)

        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run_a):
            async for _ in instance_a.run(input_a):
                pass

        # Verify A stored pending tool call and B's cache is cold
        assert await instance_a._has_pending_tool_calls(thread_id, "test_user")
        assert (thread_id, "test_user") not in instance_b._session_lookup_cache

        # --- Phase 2: Instance B receives tool result ---
        input_b = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="Plan something"),
                AssistantMessage(
                    id="msg_tc",
                    role="assistant",
                    content=None,
                    tool_calls=[ToolCall(
                        id=tool_call_id,
                        function=FunctionCall(name="approve_plan", arguments="{}"),
                    )],
                ),
                ToolMessage(
                    id="msg_tr",
                    role="tool",
                    content='{"approved": true}',
                    tool_call_id=tool_call_id,
                ),
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        captured_kwargs = {}

        async def mock_run_b(*args, **kwargs):
            captured_kwargs.update(kwargs)
            eq = kwargs["event_queue"]
            await eq.put(None)

        with patch.object(instance_b, "_run_adk_in_background", side_effect=mock_run_b):
            events_b = []
            async for event in instance_b.run(input_b):
                events_b.append(event)

        # --- Assertions ---
        # B hydrated its cache
        assert (thread_id, "test_user") in instance_b._session_lookup_cache

        # B took the HITL path (tool_results passed to _run_adk_in_background)
        assert "tool_results" in captured_kwargs, \
            "Instance B should route through HITL path"
        tool_results = captured_kwargs["tool_results"]
        assert len(tool_results) >= 1
        submitted_ids = [tr["message"].tool_call_id for tr in tool_results]
        assert tool_call_id in submitted_ids

        # No errors
        assert not any(isinstance(e, RunErrorEvent) for e in events_b)

        # Pending calls cleared after processing
        assert not await instance_b._has_pending_tool_calls(thread_id, "test_user")

    @pytest.mark.asyncio
    async def test_cache_hydration_discovers_other_instances_session(
        self, instance_a, instance_b,
    ):
        """Instance B discovers Instance A's session via DB hydration."""
        thread_id = "hydration_thread"

        # Pre-create session so A's cache is populated
        await instance_a._ensure_session_exists(
            app_name="test_app", user_id="test_user",
            thread_id=thread_id, initial_state={},
        )

        input_a = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[UserMessage(id="msg_1", role="user", content="Hello")],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        async def mock_run(*args, **kwargs):
            eq = kwargs["event_queue"]
            await eq.put(None)

        with patch.object(instance_a, "_run_adk_in_background", side_effect=mock_run):
            async for _ in instance_a.run(input_a):
                pass

        cached_a = instance_a._session_lookup_cache.get((thread_id, "test_user"))
        assert cached_a is not None
        session_id_a = cached_a[0]

        # B's cache is cold
        assert (thread_id, "test_user") not in instance_b._session_lookup_cache

        # B runs on the same thread
        input_b = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="msg_1", role="user", content="Hello"),
                UserMessage(id="msg_2", role="user", content="Follow-up"),
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(instance_b, "_run_adk_in_background", side_effect=mock_run):
            async for _ in instance_b.run(input_b):
                pass

        # B found the same session
        cached_b = instance_b._session_lookup_cache.get((thread_id, "test_user"))
        assert cached_b is not None
        assert cached_b[0] == session_id_a, "Instance B should find Instance A's session"

    @pytest.mark.asyncio
    async def test_independent_caches_shared_session_service(
        self, instance_a, instance_b,
    ):
        """Each instance has an independent cache but shares the session service."""
        thread_id = "independence_thread"

        session_a, sid_a = await instance_a._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id=thread_id,
            initial_state={},
        )

        # A has it cached, B does not
        assert (thread_id, "test_user") in instance_a._session_lookup_cache
        assert (thread_id, "test_user") not in instance_b._session_lookup_cache

        # B can find it via the shared session service
        found = await instance_b._session_manager._find_session_by_thread_id(
            "test_app", "test_user", thread_id,
        )
        assert found is not None
        assert found.id == sid_a
