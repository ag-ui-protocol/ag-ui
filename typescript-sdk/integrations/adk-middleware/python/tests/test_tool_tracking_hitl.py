#!/usr/bin/env python
"""Test HITL tool call tracking functionality."""

import pytest
import asyncio
from unittest.mock import MagicMock, AsyncMock, patch

from ag_ui.core import (
    RunAgentInput, UserMessage, Tool as AGUITool,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    RunStartedEvent, RunFinishedEvent, EventType
)

from ag_ui_adk import ADKAgent
from ag_ui_adk.execution_state import ExecutionState


class TestHITLToolTracking:
    """Test cases for HITL tool call tracking."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        from ag_ui_adk.session_manager import SessionManager
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent"
        )

    @pytest.fixture
    def adk_middleware(self, mock_adk_agent):
        """Create ADK middleware."""
        return ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user"
        )

    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool."""
        return AGUITool(
            name="test_tool",
            description="A test tool",
            parameters={
                "type": "object",
                "properties": {
                    "param": {"type": "string"}
                }
            }
        )

    @pytest.mark.asyncio
    async def test_tool_call_tracking(self, adk_middleware, sample_tool):
        """Test that tool calls are tracked in session state."""
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # Ensure session exists first
        await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            session_id="test_thread",
            initial_state={}
        )

        # Mock background execution to emit tool events
        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']

            # Emit some events including a tool call
            await event_queue.put(RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id="test_thread",
                run_id="run_1"
            ))

            # Emit tool call events
            tool_call_id = "test_tool_call_123"
            await event_queue.put(ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name="test_tool"
            ))
            await event_queue.put(ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta='{"param": "value"}'
            ))
            await event_queue.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            ))

            # Signal completion
            await event_queue.put(None)

        # Use the mock
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Verify events were emitted
            assert any(isinstance(e, ToolCallEndEvent) for e in events)

            # Check if tool call was tracked
            has_pending = await adk_middleware._has_pending_tool_calls("test_thread")
            assert has_pending, "Tool call should be tracked as pending"

            # Verify session state contains the tool call
            session = await adk_middleware._session_manager._session_service.get_session(
                session_id="test_thread",
                app_name="test_app",
                user_id="test_user"
            )
            assert session is not None
            assert session.state is not None
            assert "pending_tool_calls" in session.state
            assert "test_tool_call_123" in session.state["pending_tool_calls"]

    @pytest.mark.asyncio
    async def test_execution_not_cleaned_up_with_pending_tools(self, adk_middleware, sample_tool):
        """Test that executions with pending tool calls are not cleaned up."""
        # Create input
        input_data = RunAgentInput(
            thread_id="test_thread",
            run_id="run_1",
            messages=[UserMessage(id="1", role="user", content="Test")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # Ensure session exists first
        await adk_middleware._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            session_id="test_thread",
            initial_state={}
        )

        # Mock background execution to emit tool events
        async def mock_run_adk_in_background(*args, **kwargs):
            event_queue = kwargs['event_queue']

            # Emit tool call events
            tool_call_id = "test_tool_call_456"
            await event_queue.put(ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            ))

            # Signal completion
            await event_queue.put(None)

        # Use the mock
        with patch.object(adk_middleware, '_run_adk_in_background', side_effect=mock_run_adk_in_background):
            events = []
            async for event in adk_middleware._start_new_execution(input_data):
                events.append(event)

            # Execution should NOT be cleaned up due to pending tool call
            assert "test_thread" in adk_middleware._active_executions
            execution = adk_middleware._active_executions["test_thread"]
            assert execution.is_complete