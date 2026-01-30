"""Integration tests for streaming function call arguments with Vertex AI.

These tests require:
- GOOGLE_API_KEY or Vertex AI credentials
- GOOGLE_GENAI_USE_VERTEXAI=TRUE
- GOOGLE_CLOUD_PROJECT set
- GOOGLE_CLOUD_LOCATION=global (for Gemini 3 models)

Tests are skipped when Vertex AI credentials are not available.
"""

import os
import uuid
import pytest

from ag_ui.core import (
    RunAgentInput, EventType, UserMessage,
)

from ag_ui_adk import ADKAgent, PredictStateMapping, AGUIToolset
from ag_ui_adk.session_manager import SessionManager

from google.adk.agents import LlmAgent
from google.adk.tools import ToolContext
from google.genai import types


def _has_vertex_ai_credentials() -> bool:
    """Check if Vertex AI credentials are available."""
    if os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").upper() != "TRUE":
        return False
    if not os.getenv("GOOGLE_CLOUD_PROJECT"):
        return False
    try:
        from google.auth import default
        credentials, project = default()
        return credentials is not None
    except Exception:
        return False


def _has_streaming_function_call_support() -> bool:
    """Check if the ADK supports stream_function_call_arguments.

    Requires:
    - google-genai SDK with stream_function_call_arguments field
    - ADK with PROGRESSIVE_SSE_STREAMING feature enabled (>= ~1.20.0)
    """
    try:
        has_field = (
            hasattr(types, "FunctionCallingConfig")
            and hasattr(types.FunctionCallingConfig, "model_fields")
            and "stream_function_call_arguments" in types.FunctionCallingConfig.model_fields
        )
        if not has_field:
            return False
        # PROGRESSIVE_SSE_STREAMING is required for streaming FC args to work
        # correctly.  The feature module was introduced in ADK ~1.20.0.
        from google.adk.features._feature_registry import FeatureName, is_feature_enabled
        return is_feature_enabled(FeatureName.PROGRESSIVE_SSE_STREAMING)
    except Exception:
        return False


_can_stream = _has_vertex_ai_credentials() and _has_streaming_function_call_support()

pytestmark = pytest.mark.skipif(
    not _can_stream,
    reason="Requires Vertex AI credentials and stream_function_call_arguments support"
)


class TestStreamingFCArgsIntegration:
    """Live integration tests for streaming function call arguments via Gemini 3."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass
        yield
        try:
            SessionManager.reset_instance()
        except RuntimeError:
            pass

    @pytest.fixture
    def streaming_agent(self):
        """Create an ADKAgent with streaming FC args enabled using Gemini 3."""

        def write_document_local(tool_context: ToolContext, document: str) -> dict:
            """Write a document."""
            return {"status": "ok", "length": len(document)}

        generate_config = types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="ANY",
                    stream_function_call_arguments=True,
                )
            )
        )

        adk_agent = LlmAgent(
            name="streaming_fc_test_agent",
            model="gemini-3-flash-preview",
            instruction=(
                "You are a document writer. You MUST ALWAYS call the "
                "write_document_local tool. NEVER respond with plain text. "
                "Put the full text into the 'document' argument."
            ),
            tools=[write_document_local, AGUIToolset()],
            generate_content_config=generate_config,
        )

        return ADKAgent(
            adk_agent=adk_agent,
            app_name="streaming_fc_test",
            user_id="test_user",
            use_in_memory_services=True,
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document_local",
                    tool_argument="document",
                )
            ],
            streaming_function_call_arguments=True,
        )

    @pytest.mark.asyncio
    async def test_streaming_fc_emits_incremental_tool_call_args(self, streaming_agent):
        """Verify that streaming FC args produces multiple TOOL_CALL_ARGS events.

        With stream_function_call_arguments=True and Gemini 3, the model sends
        function call arguments incrementally.  The middleware should emit
        multiple TOOL_CALL_ARGS events as the argument content streams in.
        """
        thread_id = f"stream_fc_test_{uuid.uuid4().hex[:8]}"

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Write a short 3-paragraph story about a robot learning to paint.",
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={},
        )

        events = []
        async for event in streaming_agent.run(input_data):
            events.append(event)

        event_types = [str(e.type).split(".")[-1] for e in events]

        # Basic lifecycle
        assert "RUN_STARTED" in event_types, f"Missing RUN_STARTED: {event_types}"
        assert "RUN_FINISHED" in event_types, f"Missing RUN_FINISHED: {event_types}"

        # Tool call events should be present
        assert "TOOL_CALL_START" in event_types, (
            f"Missing TOOL_CALL_START — model may not have called the tool: {event_types}"
        )
        assert "TOOL_CALL_END" in event_types, f"Missing TOOL_CALL_END: {event_types}"

        # Count TOOL_CALL_ARGS — streaming should produce multiple
        args_events = [e for e in events if str(e.type).split(".")[-1] == "TOOL_CALL_ARGS"]
        assert len(args_events) > 1, (
            f"Expected multiple TOOL_CALL_ARGS events for streaming FC args, "
            f"got {len(args_events)}. Event types: {event_types}"
        )

        # All TOOL_CALL_ARGS should reference the same tool_call_id as START/END
        start_event = next(e for e in events if str(e.type).split(".")[-1] == "TOOL_CALL_START")
        end_event = next(e for e in events if str(e.type).split(".")[-1] == "TOOL_CALL_END")
        assert start_event.tool_call_id == end_event.tool_call_id, (
            f"START and END tool_call_ids don't match: "
            f"{start_event.tool_call_id} vs {end_event.tool_call_id}"
        )
        for args_event in args_events:
            assert args_event.tool_call_id == start_event.tool_call_id, (
                f"TOOL_CALL_ARGS tool_call_id {args_event.tool_call_id} doesn't match "
                f"START tool_call_id {start_event.tool_call_id}"
            )

        # PredictState custom event should have been emitted
        assert "CUSTOM" in event_types, (
            f"Missing PredictState CUSTOM event: {event_types}"
        )

    @pytest.mark.asyncio
    async def test_streaming_fc_tool_call_ids_consistent_across_result(self, streaming_agent):
        """Verify that ToolCallResultEvent uses the same id as the streamed tool call.

        With PROGRESSIVE_SSE_STREAMING, ADK assigns different ids to partial vs
        confirmed events.  The EventTranslator must remap the confirmed id so
        that ToolCallResultEvent references the same tool_call_id emitted in
        TOOL_CALL_START/END.
        """
        thread_id = f"stream_id_test_{uuid.uuid4().hex[:8]}"

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(
                    id="msg_1",
                    role="user",
                    content="Write a one-sentence document about clouds.",
                )
            ],
            state={},
            context=[],
            tools=[],
            forwarded_props={},
        )

        events = []
        async for event in streaming_agent.run(input_data):
            events.append(event)

        # Collect tool call ids from each event type
        start_ids = [
            e.tool_call_id for e in events
            if str(e.type).split(".")[-1] == "TOOL_CALL_START"
        ]
        end_ids = [
            e.tool_call_id for e in events
            if str(e.type).split(".")[-1] == "TOOL_CALL_END"
        ]

        assert start_ids, (
            "Model didn't call a tool despite mode=ANY — check model/tool config"
        )

        # START and END should match
        assert start_ids[0] == end_ids[0], (
            f"START id {start_ids[0]} != END id {end_ids[0]}"
        )

        # There should be no duplicate TOOL_CALL_START for the same tool
        # (the confirmed event should have been filtered)
        tool_start_names = [
            e.tool_call_name for e in events
            if str(e.type).split(".")[-1] == "TOOL_CALL_START"
        ]
        assert len(start_ids) == len(set(tool_start_names)), (
            f"Duplicate TOOL_CALL_START events detected: {start_ids}, names: {tool_start_names}"
        )
