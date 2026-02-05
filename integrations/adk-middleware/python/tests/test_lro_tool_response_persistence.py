#!/usr/bin/env python
"""Integration tests for LRO tool response persistence and invocation_id handling.

These tests verify that function_response events are correctly persisted to the
ADK session with proper invocation_id values. This is critical for:

1. DatabaseSessionService compatibility - requires invocation_id on all events
2. HITL (Human-in-the-Loop) resumption - SequentialAgent needs consistent invocation_id
3. Preventing duplicate function_response events (GitHub issue #1074)

The tests cover two main code paths in adk_agent.py:
- Tool results WITH a trailing user message (append_event + user message as new_message)
- Tool results WITHOUT a user message (function_response as new_message)

See:
- https://github.com/ag-ui-protocol/ag-ui/issues/1074
- https://github.com/ag-ui-protocol/ag-ui/issues/957
- https://github.com/ag-ui-protocol/ag-ui/pull/958
"""

import asyncio
import time
import pytest
from typing import List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput,
    EventType,
    UserMessage,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    Tool as AGUITool,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager, INVOCATION_ID_STATE_KEY
from google.adk.agents import LlmAgent
from google.adk.sessions import InMemorySessionService
from google.genai import types


class TestLROToolResponsePersistence:
    """Integration tests for LRO tool response persistence.

    These tests verify the function_response event persistence behavior
    that is critical for DatabaseSessionService compatibility.
    """

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent for LRO persistence testing"
        )

    @pytest.fixture
    def adk_agent(self, mock_adk_agent):
        """Create ADK middleware with InMemorySessionService."""
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_lro_app",
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30,
            use_in_memory_services=True,
        )
        return agent

    def _create_tool_input(
        self,
        thread_id: str,
        run_id: str,
        tool_call_id: str,
        tool_name: str = "test_lro_tool",
        tool_result: str = '{"status": "completed"}',
        include_trailing_user_message: bool = False,
        trailing_message_content: str = "Continue please",
    ) -> RunAgentInput:
        """Create a RunAgentInput with tool result submission."""
        messages = [
            UserMessage(id="user_1", role="user", content="Initial request"),
            AssistantMessage(
                id="assistant_1",
                role="assistant",
                content=None,
                tool_calls=[
                    ToolCall(
                        id=tool_call_id,
                        function=FunctionCall(name=tool_name, arguments="{}")
                    )
                ]
            ),
            ToolMessage(
                id="tool_result_1",
                role="tool",
                content=tool_result,
                tool_call_id=tool_call_id
            ),
        ]

        if include_trailing_user_message:
            messages.append(
                UserMessage(id="user_2", role="user", content=trailing_message_content)
            )

        return RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=messages,
            tools=[
                AGUITool(
                    name=tool_name,
                    description="Test LRO tool",
                    parameters={"type": "object", "properties": {}}
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

    async def _setup_session_with_function_call(
        self,
        adk_agent: ADKAgent,
        input_data: RunAgentInput,
        tool_call_id: str,
        tool_name: str,
    ) -> str:
        """Set up session with a pending function call event.

        Returns the backend_session_id for verification.
        """
        app_name = adk_agent._get_app_name(input_data)
        user_id = adk_agent._get_user_id(input_data)

        # Mark initial messages as processed
        adk_agent._session_manager.mark_messages_processed(
            app_name, input_data.thread_id, ["user_1", "assistant_1"]
        )

        # Create session
        session, backend_session_id = await adk_agent._ensure_session_exists(
            app_name=app_name,
            user_id=user_id,
            thread_id=input_data.thread_id,
            initial_state={}
        )

        # Add pending tool call
        await adk_agent._add_pending_tool_call_with_context(
            input_data.thread_id, tool_call_id, app_name, user_id
        )

        # Add the original FunctionCall event to session (simulating ADK behavior)
        from google.adk.sessions.session import Event

        function_call_content = types.Content(
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=tool_call_id,
                        name=tool_name,
                        args={}
                    )
                )
            ],
            role="model"
        )
        function_call_event = Event(
            timestamp=time.time(),
            author="test_agent",
            content=function_call_content,
            invocation_id=input_data.run_id,
        )
        await adk_agent._session_manager._session_service.append_event(
            session, function_call_event
        )

        return backend_session_id

    def _count_function_responses(
        self,
        session,
        tool_call_id: str,
    ) -> tuple[int, List]:
        """Count FunctionResponse events for a given tool_call_id.

        Returns (count, list of events with their invocation_ids).
        """
        responses = []
        for event in session.events:
            if event.content and hasattr(event.content, 'parts'):
                for part in event.content.parts:
                    if hasattr(part, 'function_response') and part.function_response:
                        fr = part.function_response
                        if hasattr(fr, 'id') and fr.id == tool_call_id:
                            responses.append({
                                'event': event,
                                'invocation_id': getattr(event, 'invocation_id', None),
                                'function_response': fr,
                            })
        return len(responses), responses

    @pytest.mark.asyncio
    async def test_tool_results_only_persists_single_function_response(self, adk_agent):
        """Test that tool results WITHOUT user message persist exactly ONE function_response.

        This tests the `elif active_tool_results:` branch in adk_agent.py.
        The function_response should be persisted with correct invocation_id.

        Regression test for GitHub issue #1074.
        """
        thread_id = "test_thread_tool_only"
        tool_call_id = "tool_call_single_response"
        run_id = "run_tool_only_123"
        tool_name = "test_lro_tool"

        input_data = self._create_tool_input(
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            include_trailing_user_message=False,  # Tool results ONLY
        )

        backend_session_id = await self._setup_session_with_function_call(
            adk_agent, input_data, tool_call_id, tool_name
        )

        # Mock the runner to avoid LLM calls
        class MockRunner:
            async def run_async(self, **kwargs):
                return
                yield

        app_name = adk_agent._get_app_name(input_data)
        user_id = adk_agent._get_user_id(input_data)

        tool_results = [
            {
                'tool_name': tool_name,
                'message': input_data.messages[2]  # ToolMessage
            }
        ]

        with patch.object(adk_agent, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()

            await adk_agent._run_adk_in_background(
                input=input_data,
                adk_agent=adk_agent._adk_agent,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=None,  # No trailing user message
            )

        # Verify: exactly ONE function_response event should exist
        session = await adk_agent._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id
        )

        count, responses = self._count_function_responses(session, tool_call_id)

        assert count == 1, (
            f"Expected exactly 1 FunctionResponse event, found {count}. "
            f"This indicates duplicate persistence (GitHub issue #1074)."
        )

        # Verify invocation_id is set correctly
        assert responses[0]['invocation_id'] == run_id, (
            f"FunctionResponse invocation_id should be '{run_id}', "
            f"got '{responses[0]['invocation_id']}'"
        )

    @pytest.mark.asyncio
    async def test_tool_results_with_user_message_persists_single_function_response(
        self, adk_agent
    ):
        """Test that tool results WITH user message persist exactly ONE function_response.

        This tests the `if active_tool_results and user_message:` branch in adk_agent.py.
        The function_response should be persisted separately, then user message sent.

        Regression test for GitHub issue #1074.
        """
        thread_id = "test_thread_with_user_msg"
        tool_call_id = "tool_call_with_user"
        run_id = "run_with_user_456"
        tool_name = "test_lro_tool"

        input_data = self._create_tool_input(
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            include_trailing_user_message=True,  # Tool results WITH user message
            trailing_message_content="Thanks, now continue",
        )

        backend_session_id = await self._setup_session_with_function_call(
            adk_agent, input_data, tool_call_id, tool_name
        )

        # Mock the runner to avoid LLM calls
        class MockRunner:
            async def run_async(self, **kwargs):
                return
                yield

        app_name = adk_agent._get_app_name(input_data)
        user_id = adk_agent._get_user_id(input_data)

        tool_results = [
            {
                'tool_name': tool_name,
                'message': input_data.messages[2]  # ToolMessage
            }
        ]
        message_batch = [input_data.messages[3]]  # Trailing UserMessage

        with patch.object(adk_agent, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()

            await adk_agent._run_adk_in_background(
                input=input_data,
                adk_agent=adk_agent._adk_agent,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=message_batch,
            )

        # Verify: exactly ONE function_response event should exist
        session = await adk_agent._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id
        )

        count, responses = self._count_function_responses(session, tool_call_id)

        assert count == 1, (
            f"Expected exactly 1 FunctionResponse event, found {count}. "
            f"This indicates duplicate persistence (GitHub issue #1074)."
        )

        # Verify invocation_id is set correctly
        assert responses[0]['invocation_id'] == run_id, (
            f"FunctionResponse invocation_id should be '{run_id}', "
            f"got '{responses[0]['invocation_id']}'"
        )

    @pytest.mark.asyncio
    async def test_stored_invocation_id_used_for_hitl_resumption(self, adk_agent):
        """Test that stored_invocation_id is used for HITL resumption.

        When resuming after HITL pause, the stored invocation_id from session state
        should be used instead of the new run_id. This ensures SequentialAgent
        state (current_sub_agent position) is restored correctly.

        Regression test for PR #958.
        """
        thread_id = "test_thread_hitl_resume"
        tool_call_id = "tool_call_hitl"
        new_run_id = "new_run_789"
        stored_invocation = "original_invocation_stored"
        tool_name = "test_lro_tool"

        input_data = self._create_tool_input(
            thread_id=thread_id,
            run_id=new_run_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            include_trailing_user_message=False,
        )

        app_name = adk_agent._get_app_name(input_data)
        user_id = adk_agent._get_user_id(input_data)

        # Mark initial messages as processed
        adk_agent._session_manager.mark_messages_processed(
            app_name, input_data.thread_id, ["user_1", "assistant_1"]
        )

        # Create session WITH stored invocation_id in state (simulating HITL pause)
        initial_state = {INVOCATION_ID_STATE_KEY: stored_invocation}
        session, backend_session_id = await adk_agent._ensure_session_exists(
            app_name=app_name,
            user_id=user_id,
            thread_id=input_data.thread_id,
            initial_state=initial_state
        )

        # Update session state with the stored invocation_id
        await adk_agent._session_manager.update_session_state(
            backend_session_id, app_name, user_id, initial_state
        )

        # Add pending tool call
        await adk_agent._add_pending_tool_call_with_context(
            input_data.thread_id, tool_call_id, app_name, user_id
        )

        # Add the original FunctionCall event
        from google.adk.sessions.session import Event

        function_call_content = types.Content(
            parts=[
                types.Part(
                    function_call=types.FunctionCall(
                        id=tool_call_id,
                        name=tool_name,
                        args={}
                    )
                )
            ],
            role="model"
        )
        function_call_event = Event(
            timestamp=time.time(),
            author="test_agent",
            content=function_call_content,
            invocation_id=stored_invocation,
        )
        await adk_agent._session_manager._session_service.append_event(
            session, function_call_event
        )

        # Mock the runner to avoid LLM calls
        class MockRunner:
            async def run_async(self, **kwargs):
                return
                yield

        tool_results = [
            {
                'tool_name': tool_name,
                'message': input_data.messages[2]
            }
        ]

        with patch.object(adk_agent, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()

            await adk_agent._run_adk_in_background(
                input=input_data,
                adk_agent=adk_agent._adk_agent,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=None,
            )

        # Verify: FunctionResponse should use stored_invocation_id, not new_run_id
        session = await adk_agent._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id
        )

        count, responses = self._count_function_responses(session, tool_call_id)

        assert count >= 1, "Expected at least 1 FunctionResponse event"

        # The invocation_id should be the STORED one for HITL resumption
        assert responses[0]['invocation_id'] == stored_invocation, (
            f"FunctionResponse should use stored invocation_id '{stored_invocation}' "
            f"for HITL resumption, got '{responses[0]['invocation_id']}'. "
            f"This breaks SequentialAgent state restoration."
        )

    @pytest.mark.asyncio
    async def test_multiple_tool_results_persist_all_with_same_invocation_id(
        self, adk_agent
    ):
        """Test that multiple tool results all get the same invocation_id.

        When multiple LRO tools complete simultaneously, all their FunctionResponse
        events should share the same invocation_id for consistency.
        """
        thread_id = "test_thread_multi_tool"
        tool_call_id_1 = "tool_call_multi_1"
        tool_call_id_2 = "tool_call_multi_2"
        run_id = "run_multi_tool_999"
        tool_name = "test_lro_tool"

        # Create input with multiple tool results
        messages = [
            UserMessage(id="user_1", role="user", content="Initial request"),
            AssistantMessage(
                id="assistant_1",
                role="assistant",
                content=None,
                tool_calls=[
                    ToolCall(
                        id=tool_call_id_1,
                        function=FunctionCall(name=tool_name, arguments='{"task": 1}')
                    ),
                    ToolCall(
                        id=tool_call_id_2,
                        function=FunctionCall(name=tool_name, arguments='{"task": 2}')
                    )
                ]
            ),
            ToolMessage(
                id="tool_result_1",
                role="tool",
                content='{"result": "task1_done"}',
                tool_call_id=tool_call_id_1
            ),
            ToolMessage(
                id="tool_result_2",
                role="tool",
                content='{"result": "task2_done"}',
                tool_call_id=tool_call_id_2
            ),
        ]

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=messages,
            tools=[
                AGUITool(
                    name=tool_name,
                    description="Test LRO tool",
                    parameters={"type": "object", "properties": {"task": {"type": "integer"}}}
                )
            ],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = adk_agent._get_app_name(input_data)
        user_id = adk_agent._get_user_id(input_data)

        # Mark initial messages as processed
        adk_agent._session_manager.mark_messages_processed(
            app_name, thread_id, ["user_1", "assistant_1"]
        )

        # Create session
        session, backend_session_id = await adk_agent._ensure_session_exists(
            app_name=app_name,
            user_id=user_id,
            thread_id=thread_id,
            initial_state={}
        )

        # Add pending tool calls
        await adk_agent._add_pending_tool_call_with_context(
            thread_id, tool_call_id_1, app_name, user_id
        )
        await adk_agent._add_pending_tool_call_with_context(
            thread_id, tool_call_id_2, app_name, user_id
        )

        # Add original FunctionCall events
        from google.adk.sessions.session import Event

        for tc_id, task_num in [(tool_call_id_1, 1), (tool_call_id_2, 2)]:
            function_call_content = types.Content(
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            id=tc_id,
                            name=tool_name,
                            args={"task": task_num}
                        )
                    )
                ],
                role="model"
            )
            function_call_event = Event(
                timestamp=time.time(),
                author="test_agent",
                content=function_call_content,
                invocation_id=run_id,
            )
            await adk_agent._session_manager._session_service.append_event(
                session, function_call_event
            )

        # Mock the runner
        class MockRunner:
            async def run_async(self, **kwargs):
                return
                yield

        tool_results = [
            {'tool_name': tool_name, 'message': messages[2]},
            {'tool_name': tool_name, 'message': messages[3]},
        ]

        with patch.object(adk_agent, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()

            await adk_agent._run_adk_in_background(
                input=input_data,
                adk_agent=adk_agent._adk_agent,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=None,
            )

        # Verify both function responses have same invocation_id
        session = await adk_agent._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id
        )

        count_1, responses_1 = self._count_function_responses(session, tool_call_id_1)
        count_2, responses_2 = self._count_function_responses(session, tool_call_id_2)

        assert count_1 == 1, f"Expected 1 FunctionResponse for tool_call_1, found {count_1}"
        assert count_2 == 1, f"Expected 1 FunctionResponse for tool_call_2, found {count_2}"

        # Both should have the same invocation_id
        inv_id_1 = responses_1[0]['invocation_id']
        inv_id_2 = responses_2[0]['invocation_id']

        assert inv_id_1 == inv_id_2 == run_id, (
            f"Both FunctionResponse events should have invocation_id='{run_id}'. "
            f"Got tool_1='{inv_id_1}', tool_2='{inv_id_2}'"
        )


class TestFunctionResponseEventStructure:
    """Tests verifying the structure of persisted FunctionResponse events."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset singleton SessionManager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent"
        )

    @pytest.fixture
    def adk_agent(self, mock_adk_agent):
        """Create ADK middleware."""
        return ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
        )

    @pytest.mark.asyncio
    async def test_function_response_has_required_fields(self, adk_agent):
        """Test that persisted FunctionResponse has all required fields.

        DatabaseSessionService requires:
        - invocation_id on the Event
        - Proper Content structure with FunctionResponse part
        - author='user' (tool results come from user)
        """
        thread_id = "test_thread_structure"
        tool_call_id = "tool_call_structure"
        run_id = "run_structure_test"
        tool_name = "test_tool"
        tool_result_content = '{"status": "success", "data": {"key": "value"}}'

        messages = [
            UserMessage(id="user_1", role="user", content="Request"),
            AssistantMessage(
                id="assistant_1",
                role="assistant",
                content=None,
                tool_calls=[
                    ToolCall(
                        id=tool_call_id,
                        function=FunctionCall(name=tool_name, arguments="{}")
                    )
                ]
            ),
            ToolMessage(
                id="tool_result_1",
                role="tool",
                content=tool_result_content,
                tool_call_id=tool_call_id
            ),
        ]

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=messages,
            tools=[AGUITool(name=tool_name, description="Test", parameters={})],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = adk_agent._get_app_name(input_data)
        user_id = adk_agent._get_user_id(input_data)

        adk_agent._session_manager.mark_messages_processed(
            app_name, thread_id, ["user_1", "assistant_1"]
        )

        session, backend_session_id = await adk_agent._ensure_session_exists(
            app_name=app_name,
            user_id=user_id,
            thread_id=thread_id,
            initial_state={}
        )

        await adk_agent._add_pending_tool_call_with_context(
            thread_id, tool_call_id, app_name, user_id
        )

        # Add FunctionCall event
        from google.adk.sessions.session import Event

        function_call_event = Event(
            timestamp=time.time(),
            author="test_agent",
            content=types.Content(
                parts=[types.Part(function_call=types.FunctionCall(
                    id=tool_call_id, name=tool_name, args={}
                ))],
                role="model"
            ),
            invocation_id=run_id,
        )
        await adk_agent._session_manager._session_service.append_event(
            session, function_call_event
        )

        class MockRunner:
            async def run_async(self, **kwargs):
                return
                yield

        tool_results = [{'tool_name': tool_name, 'message': messages[2]}]

        with patch.object(adk_agent, '_create_runner', return_value=MockRunner()):
            event_queue = asyncio.Queue()
            await adk_agent._run_adk_in_background(
                input=input_data,
                adk_agent=adk_agent._adk_agent,
                user_id=user_id,
                app_name=app_name,
                event_queue=event_queue,
                client_proxy_toolsets=[],
                tool_results=tool_results,
                message_batch=None,
            )

        # Verify event structure
        session = await adk_agent._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id
        )

        # Find the FunctionResponse event
        fr_event = None
        for event in session.events:
            if event.content and hasattr(event.content, 'parts'):
                for part in event.content.parts:
                    if hasattr(part, 'function_response') and part.function_response:
                        fr = part.function_response
                        if hasattr(fr, 'id') and fr.id == tool_call_id:
                            fr_event = event
                            break

        assert fr_event is not None, "FunctionResponse event not found"

        # Verify required fields
        assert hasattr(fr_event, 'invocation_id'), "Event missing invocation_id"
        assert fr_event.invocation_id == run_id, f"Wrong invocation_id: {fr_event.invocation_id}"

        assert hasattr(fr_event, 'author'), "Event missing author"
        assert fr_event.author == 'user', f"Expected author='user', got '{fr_event.author}'"

        assert hasattr(fr_event, 'timestamp'), "Event missing timestamp"
        assert fr_event.timestamp > 0, "Invalid timestamp"

        # Verify Content structure
        assert fr_event.content is not None, "Event missing content"
        assert fr_event.content.role == 'user', f"Expected role='user', got '{fr_event.content.role}'"
        assert len(fr_event.content.parts) >= 1, "Content missing parts"

        # Verify FunctionResponse part
        fr_part = None
        for part in fr_event.content.parts:
            if hasattr(part, 'function_response') and part.function_response:
                fr_part = part.function_response
                break

        assert fr_part is not None, "FunctionResponse part not found"
        assert fr_part.id == tool_call_id, f"Wrong tool_call_id: {fr_part.id}"
        assert fr_part.name == tool_name, f"Wrong tool name: {fr_part.name}"
        assert fr_part.response is not None, "FunctionResponse missing response"


# Run tests with pytest
if __name__ == "__main__":
    pytest.main([__file__, "-v"])
