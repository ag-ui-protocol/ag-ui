#!/usr/bin/env python
"""Tests for LRO SSE streaming tool-call ID remapping fix.

When SSE streaming is enabled (the default), ADK's populate_client_function_call_id()
generates *different* UUIDs for the same logical function call across the partial
(streaming) and final (persisted) events.  This causes HITL workflows to break
because the client captures ID-A from the partial event, but ADK persists ID-B
in the session — so submitting a FunctionResponse with ID-A fails:

    "No function call event found for function responses ids: ['ID-A']"

The fix captures the ID-A → ID-B mapping when the non-partial event arrives and
remaps tool_call_id values in FunctionResponse construction.

Unit tests (mocked) run without credentials.
Integration tests require GOOGLE_API_KEY or Vertex AI auth.
"""

import asyncio
import os
import uuid
import warnings
import pytest
from typing import Dict, List, Optional
from unittest.mock import MagicMock, AsyncMock, patch

from ag_ui.core import (
    RunAgentInput,
    UserMessage,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    EventType,
    BaseEvent,
    Tool as AGUITool,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    RunStartedEvent,
    RunFinishedEvent,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.event_translator import EventTranslator
from ag_ui_adk.session_manager import SessionManager


# =============================================================================
# Unit Tests — No credentials required
# =============================================================================


class TestExtractLroIdRemap:
    """Unit tests for ADKAgent._extract_lro_id_remap."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def adk_agent(self):
        from google.adk.agents import Agent
        mock = MagicMock(spec=Agent)
        mock.name = "test_agent"
        mock.model_copy = MagicMock(return_value=mock)
        return ADKAgent(adk_agent=mock, app_name="test", user_id="u1")

    @pytest.fixture
    def translator(self):
        return EventTranslator()

    def _make_event(self, fc_name: str, fc_id: str):
        fc = MagicMock()
        fc.id = fc_id
        fc.name = fc_name
        part = MagicMock()
        part.function_call = fc
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part]
        return evt

    def test_remap_detected_when_ids_differ(self, adk_agent, translator):
        """When the translator emitted ID-A but the final event has ID-B, a remap is produced."""
        translator.lro_emitted_ids_by_name["my_tool"] = "partial-id-AAA"
        final_event = self._make_event("my_tool", "final-id-BBB")

        remap = adk_agent._extract_lro_id_remap(final_event, translator)

        assert remap == {"partial-id-AAA": "final-id-BBB"}

    def test_no_remap_when_ids_match(self, adk_agent, translator):
        """When partial and final IDs are the same, no remap is needed."""
        translator.lro_emitted_ids_by_name["my_tool"] = "same-id"
        final_event = self._make_event("my_tool", "same-id")

        remap = adk_agent._extract_lro_id_remap(final_event, translator)

        assert remap == {}

    def test_no_remap_for_unknown_tool(self, adk_agent, translator):
        """If the translator didn't emit for this tool name, no remap."""
        final_event = self._make_event("unknown_tool", "some-id")

        remap = adk_agent._extract_lro_id_remap(final_event, translator)

        assert remap == {}

    def test_no_remap_for_empty_event(self, adk_agent, translator):
        """Events without content produce no remap."""
        translator.lro_emitted_ids_by_name["my_tool"] = "partial-id"
        evt = MagicMock()
        evt.content = None

        remap = adk_agent._extract_lro_id_remap(evt, translator)

        assert remap == {}

    def test_multiple_tools_remapped(self, adk_agent, translator):
        """Multiple LRO tool calls in one event all get remapped."""
        translator.lro_emitted_ids_by_name["tool_a"] = "partial-A"
        translator.lro_emitted_ids_by_name["tool_b"] = "partial-B"

        fc_a = MagicMock(); fc_a.id = "final-A"; fc_a.name = "tool_a"
        fc_b = MagicMock(); fc_b.id = "final-B"; fc_b.name = "tool_b"
        part_a = MagicMock(); part_a.function_call = fc_a
        part_b = MagicMock(); part_b.function_call = fc_b
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part_a, part_b]

        remap = adk_agent._extract_lro_id_remap(evt, translator)

        assert remap == {"partial-A": "final-A", "partial-B": "final-B"}


class TestLroIdRemapSessionState:
    """Test storing and retrieving LRO ID remap from session state."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def adk_agent(self):
        from google.adk.agents import Agent
        mock = MagicMock(spec=Agent)
        mock.name = "test_agent"
        mock.model_copy = MagicMock(return_value=mock)
        return ADKAgent(adk_agent=mock, app_name="test", user_id="u1")

    @pytest.mark.asyncio
    async def test_store_and_retrieve_remap(self, adk_agent):
        """Round-trip: store a remap, then retrieve it."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread1", {}
        )
        remap = {"partial-AAA": "final-BBB"}
        await adk_agent._store_lro_id_remap(remap, session_id, "test", "u1")

        retrieved = await adk_agent._get_lro_id_remap(session_id, "test", "u1")
        assert retrieved == {"partial-AAA": "final-BBB"}

    @pytest.mark.asyncio
    async def test_store_merges_existing(self, adk_agent):
        """Subsequent stores merge into the existing remap."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread2", {}
        )
        await adk_agent._store_lro_id_remap({"id-1": "final-1"}, session_id, "test", "u1")
        await adk_agent._store_lro_id_remap({"id-2": "final-2"}, session_id, "test", "u1")

        retrieved = await adk_agent._get_lro_id_remap(session_id, "test", "u1")
        assert retrieved == {"id-1": "final-1", "id-2": "final-2"}

    @pytest.mark.asyncio
    async def test_consume_removes_entry(self, adk_agent):
        """_consume_lro_id_remap returns the remapped ID and removes the entry."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread3", {}
        )
        await adk_agent._store_lro_id_remap(
            {"partial-X": "final-X", "partial-Y": "final-Y"},
            session_id, "test", "u1",
        )

        result = await adk_agent._consume_lro_id_remap("partial-X", session_id, "test", "u1")
        assert result == "final-X"

        # partial-X should be removed, partial-Y still present
        remaining = await adk_agent._get_lro_id_remap(session_id, "test", "u1")
        assert remaining == {"partial-Y": "final-Y"}

    @pytest.mark.asyncio
    async def test_consume_returns_original_when_no_remap(self, adk_agent):
        """_consume_lro_id_remap returns the original ID when there's no remap."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread4", {}
        )

        result = await adk_agent._consume_lro_id_remap("no-such-id", session_id, "test", "u1")
        assert result == "no-such-id"


class TestEventTranslatorLroTracking:
    """Test that EventTranslator.translate_lro_function_calls records emitted IDs by name."""

    @pytest.fixture
    def translator(self):
        return EventTranslator()

    def _make_lro_event(self, fc_name: str, fc_id: str):
        fc = MagicMock()
        fc.id = fc_id
        fc.name = fc_name
        fc.args = {"key": "val"}
        part = MagicMock()
        part.function_call = fc
        part.text = None
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part]
        evt.long_running_tool_ids = [fc_id]
        return evt

    @pytest.mark.asyncio
    async def test_lro_emitted_ids_by_name_populated(self, translator):
        """translate_lro_function_calls should record name→ID in lro_emitted_ids_by_name."""
        evt = self._make_lro_event("get_approval", "adk-partial-123")

        events = []
        async for e in translator.translate_lro_function_calls(evt):
            events.append(e)

        # Should have emitted TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END
        assert len(events) == 3
        assert events[0].type == EventType.TOOL_CALL_START
        assert events[0].tool_call_id == "adk-partial-123"

        # Verify the name→ID mapping
        assert translator.lro_emitted_ids_by_name == {"get_approval": "adk-partial-123"}

    @pytest.mark.asyncio
    async def test_lro_emitted_ids_cleared_on_reset(self, translator):
        """reset() should clear lro_emitted_ids_by_name."""
        translator.lro_emitted_ids_by_name["some_tool"] = "some-id"
        translator.reset()
        assert translator.lro_emitted_ids_by_name == {}


class TestDrainPathCapturesRemap:
    """Test that the LRO drain path captures the ID remap from the non-partial event."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def adk_agent(self):
        from google.adk.agents import Agent
        mock = MagicMock(spec=Agent)
        mock.name = "test_agent"
        mock.model_copy = MagicMock(return_value=mock)
        return ADKAgent(adk_agent=mock, app_name="test", user_id="u1")

    @pytest.mark.asyncio
    async def test_drain_captures_remap_from_final_event(self, adk_agent):
        """When LRO is detected on partial event and we drain to non-partial,
        the remap from partial-ID → final-ID should be stored in session state."""
        partial_fc_id = f"adk-partial-{uuid.uuid4().hex[:8]}"
        final_fc_id = f"adk-final-{uuid.uuid4().hex[:8]}"

        def create_event(partial, fc_id):
            fc = MagicMock()
            fc.id = fc_id
            fc.name = "client_tool"
            fc.args = {"key": "value"}
            part = MagicMock()
            part.text = None
            part.function_call = fc
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [part]
            evt.partial = partial
            evt.turn_complete = not partial
            evt.is_final_response = MagicMock(return_value=not partial)
            evt.get_function_calls = MagicMock(return_value=[fc])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = [fc_id]
            evt.invocation_id = "inv-test"
            return evt

        async def mock_run_async(**kwargs):
            # Event 1: partial=True with fc_id = partial_fc_id
            yield create_event(partial=True, fc_id=partial_fc_id)
            # Event 2: partial=False with fc_id = final_fc_id (DIFFERENT!)
            yield create_event(partial=False, fc_id=final_fc_id)

        mock_runner = MagicMock()
        mock_runner.run_async = mock_run_async

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="u1", role="user", content="Test")],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_agent, "_create_runner", return_value=mock_runner):
            events = []
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                async for e in adk_agent.run(input_data):
                    events.append(e)

        # Verify tool call events were emitted with the partial ID
        tool_call_starts = [e for e in events if isinstance(e, ToolCallStartEvent)]
        assert len(tool_call_starts) >= 1
        assert tool_call_starts[0].tool_call_id == partial_fc_id

        # Verify the remap was stored in session state
        metadata = adk_agent._get_session_metadata(thread_id)
        assert metadata is not None
        session_id, app_name, user_id = metadata
        remap = await adk_agent._get_lro_id_remap(session_id, app_name, user_id)
        assert remap.get(partial_fc_id) == final_fc_id, (
            f"Expected remap {partial_fc_id} -> {final_fc_id}, got: {remap}"
        )


class TestFunctionResponseRemapping:
    """Test that FunctionResponse construction applies the LRO ID remap."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def sample_tool(self):
        return AGUITool(
            name="client_tool",
            description="A client-side tool",
            parameters={
                "type": "object",
                "properties": {"action": {"type": "string"}},
            },
        )

    @pytest.mark.asyncio
    async def test_tool_result_uses_remapped_id(self, sample_tool):
        """End-to-end: partial ID emitted to client, final ID used in FunctionResponse."""
        from google.adk.agents import Agent

        partial_fc_id = f"adk-partial-{uuid.uuid4().hex[:8]}"
        final_fc_id = f"adk-final-{uuid.uuid4().hex[:8]}"

        mock_agent = MagicMock(spec=Agent)
        mock_agent.name = "test_agent"
        mock_agent.model_copy = MagicMock(return_value=mock_agent)

        adk_middleware = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        # --- Run 1: LRO tool call with SSE streaming ID mismatch ---
        def create_event(partial, fc_id):
            fc = MagicMock()
            fc.id = fc_id
            fc.name = "client_tool"
            fc.args = {"action": "deploy"}
            part = MagicMock()
            part.text = None
            part.function_call = fc
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [part]
            evt.partial = partial
            evt.turn_complete = not partial
            evt.is_final_response = MagicMock(return_value=not partial)
            evt.get_function_calls = MagicMock(return_value=[fc])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = [fc_id]
            evt.invocation_id = "inv-run1"
            return evt

        async def mock_run_async_run1(**kwargs):
            yield create_event(partial=True, fc_id=partial_fc_id)
            yield create_event(partial=False, fc_id=final_fc_id)

        mock_runner1 = MagicMock()
        mock_runner1.run_async = mock_run_async_run1

        run1_input = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[UserMessage(id="u1", role="user", content="Deploy the app")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_middleware, "_create_runner", return_value=mock_runner1):
            run1_events = []
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                async for e in adk_middleware.run(run1_input):
                    run1_events.append(e)

        # Client received partial_fc_id in TOOL_CALL events
        tool_call_ends = [e for e in run1_events if isinstance(e, ToolCallEndEvent)]
        assert len(tool_call_ends) >= 1
        assert tool_call_ends[0].tool_call_id == partial_fc_id

        # --- Run 2: Submit tool result with client-facing partial_fc_id ---

        # Track what FunctionResponse ID is actually sent to ADK
        captured_function_response_ids = []

        async def mock_run_async_run2(**kwargs):
            # Capture the FunctionResponse ID from the new_message
            new_msg = kwargs.get("new_message")
            if new_msg and hasattr(new_msg, "parts"):
                for part in new_msg.parts:
                    if hasattr(part, "function_response") and part.function_response:
                        captured_function_response_ids.append(part.function_response.id)

            # Yield a simple text response
            text_part = MagicMock()
            text_part.text = "Deployment complete!"
            text_part.function_call = None
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [text_part]
            evt.partial = False
            evt.turn_complete = True
            evt.is_final_response = MagicMock(return_value=True)
            evt.get_function_calls = MagicMock(return_value=[])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = []
            evt.invocation_id = "inv-run2"
            yield evt

        mock_runner2 = MagicMock()
        mock_runner2.run_async = mock_run_async_run2

        run2_input = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="u1", role="user", content="Deploy the app"),
                AssistantMessage(
                    id="a1",
                    role="assistant",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=partial_fc_id,
                            type="function",
                            function=FunctionCall(
                                name="client_tool",
                                arguments='{"action": "deploy"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(
                    id="t1",
                    role="tool",
                    tool_call_id=partial_fc_id,
                    content='{"status": "success"}',
                ),
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_middleware, "_create_runner", return_value=mock_runner2):
            run2_events = []
            async for e in adk_middleware.run(run2_input):
                run2_events.append(e)

        # CRITICAL ASSERTION: The FunctionResponse sent to ADK should use
        # the final (persisted) ID, not the partial (client-facing) ID
        assert len(captured_function_response_ids) >= 1, (
            "No FunctionResponse was sent to ADK — tool result was not submitted"
        )
        assert captured_function_response_ids[0] == final_fc_id, (
            f"FunctionResponse should use remapped ID {final_fc_id}, "
            f"but used {captured_function_response_ids[0]}. "
            f"The LRO ID remap was not applied!"
        )


# =============================================================================
# Integration Tests — Require Google AI or Vertex AI auth
# =============================================================================


def _has_google_auth():
    """Check if Google AI or Vertex AI authentication is available."""
    if os.environ.get("GOOGLE_API_KEY"):
        return True
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").upper() == "TRUE":
        if os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("VERTEXAI_PROJECT"):
            return True
    return False


class TestLROSSEIdRemapIntegration:
    """Integration tests that verify HITL works with SSE streaming.

    These verify the full round-trip:
    1. Agent calls an LRO tool (SSE streaming produces partial → final with different IDs)
    2. Client submits tool result using the ID from the partial event
    3. ADK processes the tool result successfully (the remap makes IDs match)
    """

    pytestmark = pytest.mark.skipif(
        not _has_google_auth(),
        reason="No Google authentication available (set GOOGLE_API_KEY or configure Vertex AI)",
    )

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def lro_tool(self):
        return AGUITool(
            name="get_approval",
            description="Ask the user to approve an action. Always use this tool.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to approve",
                    }
                },
                "required": ["action"],
            },
        )

    @pytest.mark.asyncio
    async def test_hitl_round_trip_with_sse_streaming(self, lro_tool):
        """Full HITL round-trip: tool call → tool result → agent continues.

        This is the primary regression test for the streaming ID mismatch bug.
        With SSE streaming enabled, the partial event carries ID-A and the final
        event carries ID-B.  Without the remap fix, submitting the tool result
        with ID-A would fail.
        """
        from google.adk.agents import LlmAgent
        from google.adk.sessions import InMemorySessionService
        from google.adk.agents.run_config import RunConfig, StreamingMode
        from ag_ui_adk.agui_toolset import AGUIToolset

        session_service = InMemorySessionService()
        app_name = f"test_hitl_remap_{uuid.uuid4().hex[:8]}"

        agent = LlmAgent(
            name="approval_agent",
            model="gemini-2.0-flash",
            instruction=(
                "When asked to do anything, ALWAYS use the get_approval tool first. "
                "Pass the action description as the 'action' parameter."
            ),
            tools=[AGUIToolset()],
        )

        def sse_config(inp):
            return RunConfig(streaming_mode=StreamingMode.SSE)

        adk_agent = ADKAgent(
            adk_agent=agent,
            app_name=app_name,
            user_id="test_user",
            session_service=session_service,
            run_config_factory=sse_config,
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        # --- Run 1: Trigger the LRO tool call ---
        run1_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0")
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        run1_events: list[BaseEvent] = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run1_input):
                run1_events.append(event)

        # Find the tool_call_id the client received
        tool_call_id = None
        tool_call_name = None
        for evt in run1_events:
            if isinstance(evt, ToolCallStartEvent):
                tool_call_id = evt.tool_call_id
                tool_call_name = evt.tool_call_name
                break

        assert tool_call_id is not None, (
            f"No TOOL_CALL_START event found. Events: "
            f"{[type(e).__name__ for e in run1_events]}"
        )

        # --- Run 2: Submit tool result using the client-facing ID ---
        run2_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0"),
                AssistantMessage(
                    id="a1",
                    role="assistant",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            type="function",
                            function=FunctionCall(
                                name=tool_call_name or "get_approval",
                                arguments='{"action": "deploy version 2.0"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(
                    id="t1",
                    role="tool",
                    tool_call_id=tool_call_id,
                    content='{"approved": true, "message": "Deployment approved"}',
                ),
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        # This is the critical step: if the remap doesn't work, ADK will raise
        # "No function call event found for function responses ids: [<client_id>]"
        run2_events: list[BaseEvent] = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run2_input):
                run2_events.append(event)

        run2_types = [str(e.type).split(".")[-1] for e in run2_events]

        # Verify the run completed successfully (no RUN_ERROR)
        assert "RUN_ERROR" not in run2_types, (
            f"Run 2 failed with error. This likely means the LRO ID remap "
            f"did not work — ADK couldn't find the FunctionCall matching the "
            f"tool_call_id '{tool_call_id}'. Events: {run2_types}"
        )
        assert "RUN_STARTED" in run2_types, f"Missing RUN_STARTED. Got: {run2_types}"
        assert "RUN_FINISHED" in run2_types, f"Missing RUN_FINISHED. Got: {run2_types}"

    @pytest.mark.asyncio
    async def test_hitl_without_streaming_still_works(self, lro_tool):
        """Baseline: HITL works without streaming (no ID mismatch occurs)."""
        from google.adk.agents import LlmAgent
        from google.adk.sessions import InMemorySessionService
        from google.adk.agents.run_config import RunConfig, StreamingMode
        from ag_ui_adk.agui_toolset import AGUIToolset

        session_service = InMemorySessionService()
        app_name = f"test_hitl_no_stream_{uuid.uuid4().hex[:8]}"

        agent = LlmAgent(
            name="approval_agent",
            model="gemini-2.0-flash",
            instruction=(
                "When asked to do anything, ALWAYS use the get_approval tool first. "
                "Pass the action description as the 'action' parameter."
            ),
            tools=[AGUIToolset()],
        )

        def no_streaming_config(inp):
            return RunConfig(streaming_mode=StreamingMode.NONE)

        adk_agent = ADKAgent(
            adk_agent=agent,
            app_name=app_name,
            user_id="test_user",
            session_service=session_service,
            run_config_factory=no_streaming_config,
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        # --- Run 1 ---
        run1_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0")
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        run1_events = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run1_input):
                run1_events.append(event)

        tool_call_id = None
        tool_call_name = None
        for evt in run1_events:
            if isinstance(evt, ToolCallStartEvent):
                tool_call_id = evt.tool_call_id
                tool_call_name = evt.tool_call_name
                break

        if tool_call_id is None:
            pytest.skip("Agent did not call the tool (non-streaming baseline)")

        # --- Run 2 ---
        run2_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0"),
                AssistantMessage(
                    id="a1",
                    role="assistant",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            type="function",
                            function=FunctionCall(
                                name=tool_call_name or "get_approval",
                                arguments='{"action": "deploy version 2.0"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(
                    id="t1",
                    role="tool",
                    tool_call_id=tool_call_id,
                    content='{"approved": true}',
                ),
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        run2_events = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run2_input):
                run2_events.append(event)

        run2_types = [str(e.type).split(".")[-1] for e in run2_events]
        assert "RUN_ERROR" not in run2_types, (
            f"Baseline (no streaming) failed. Events: {run2_types}"
        )


# =============================================================================
# Direct Execution
# =============================================================================

if __name__ == "__main__":
    if _has_google_auth():
        print("Running all tests (Google authentication available)")
        pytest.main([__file__, "-v", "-s"])
    else:
        print("No Google authentication — running unit tests only")
        print("Set GOOGLE_API_KEY or configure Vertex AI to run integration tests")
        pytest.main([__file__, "-v", "-s", "-k", "not Integration"])
