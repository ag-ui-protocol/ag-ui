#!/usr/bin/env python
"""Test tool result submission flow in ADKAgent."""

import pytest
import json
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import (
    RunAgentInput, BaseEvent, EventType, Tool as AGUITool,
    UserMessage, ToolMessage, RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    AssistantMessage, ToolCall, FunctionCall,
)

from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager


class TestToolResultFlow:
    """Test cases for tool result submission flow."""


    @pytest.fixture
    def sample_tool(self):
        """Create a sample tool definition."""
        return AGUITool(
            name="test_tool",
            description="A test tool",
            parameters={
                "type": "object",
                "properties": {
                    "input": {"type": "string"}
                }
            }
        )

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        from google.adk.agents import LlmAgent
        return LlmAgent(
            name="test_agent",
            model="gemini-2.0-flash",
            instruction="Test agent for tool flow testing"
        )

    @pytest.fixture
    def ag_ui_adk(self, mock_adk_agent):
        """Create ADK middleware with mocked dependencies."""
        SessionManager.reset_instance()
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            user_id="test_user",
            execution_timeout_seconds=60,
            tool_timeout_seconds=30
        )
        try:
            yield agent
        finally:
            SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_with_tool_message(self, ag_ui_adk):
        """Test detection of tool result submission."""
        # Input with tool message as last message
        input_with_tool = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Do something"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        assert await ag_ui_adk._is_tool_result_submission(input_with_tool) is True

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_with_user_message(self, ag_ui_adk):
        """Test detection when last message is not a tool result."""
        # Input with user message as last message
        input_without_tool = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                UserMessage(id="2", role="user", content="How are you?")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        assert await ag_ui_adk._is_tool_result_submission(input_without_tool) is False

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_empty_messages(self, ag_ui_adk):
        """Test detection with empty messages."""
        empty_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        assert await ag_ui_adk._is_tool_result_submission(empty_input) is False

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_ignores_processed_history(self, ag_ui_adk):
        """Ensure previously processed tool messages are ignored."""
        replay_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Do something"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(replay_input)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, replay_input.thread_id, ["1", "2"])

        assert await ag_ui_adk._is_tool_result_submission(replay_input) is False

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_multiple_tool_messages(self, ag_ui_adk):
        """Detect tool submissions when multiple unseen tool results arrive together."""
        batched_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="First"),
                ToolMessage(id="2", role="tool", content='{"result": "partial"}', tool_call_id="call_1"),
                ToolMessage(id="3", role="tool", content='{"result": "done"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(batched_input)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, batched_input.thread_id, ["1"])

        assert await ag_ui_adk._is_tool_result_submission(batched_input) is True

    @pytest.mark.asyncio
    async def test_is_tool_result_submission_new_user_after_tool(self, ag_ui_adk):
        """Treat batched updates that end with a user message as non-tool submissions."""
        batched_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="First"),
                ToolMessage(id="2", role="tool", content='{"result": "intermediate"}', tool_call_id="call_1"),
                UserMessage(id="3", role="user", content="Thanks!")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        app_name = ag_ui_adk._get_app_name(batched_input)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, batched_input.thread_id, ["1"])

        assert await ag_ui_adk._is_tool_result_submission(batched_input) is False

    @pytest.mark.asyncio
    async def test_extract_tool_results_single_tool(self, ag_ui_adk):
        """Test extraction of single tool result."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        tool_results = await ag_ui_adk._extract_tool_results(input_data, input_data.messages)

        assert len(tool_results) == 1
        assert tool_results[0]['message'].role == "tool"
        assert tool_results[0]['message'].tool_call_id == "call_1"
        assert tool_results[0]['message'].content == '{"result": "success"}'
        assert tool_results[0]['tool_name'] == "unknown"  # No tool_calls in messages

    @pytest.mark.asyncio
    async def test_extract_tool_results_multiple_tools(self, ag_ui_adk):
        """Test extraction of all unseen tool results when multiple exist."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "first"}', tool_call_id="call_1"),
                ToolMessage(id="3", role="tool", content='{"result": "second"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        unseen_messages = input_data.messages[1:]
        tool_results = await ag_ui_adk._extract_tool_results(input_data, unseen_messages)

        assert len(tool_results) == 2
        assert [result['message'].tool_call_id for result in tool_results] == ["call_1", "call_2"]

    @pytest.mark.asyncio
    async def test_extract_tool_results_mixed_messages(self, ag_ui_adk):
        """Test extraction when mixed with other message types."""
        input_data = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello"),
                ToolMessage(id="2", role="tool", content='{"result": "success"}', tool_call_id="call_1"),
                UserMessage(id="3", role="user", content="Thanks"),
                ToolMessage(id="4", role="tool", content='{"result": "done"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        unseen_messages = input_data.messages[3:]
        tool_results = await ag_ui_adk._extract_tool_results(input_data, unseen_messages)

        assert len(tool_results) == 1
        assert tool_results[0]['message'].role == "tool"
        assert tool_results[0]['message'].tool_call_id == "call_2"
        assert tool_results[0]['message'].content == '{"result": "done"}'

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_no_active_execution(self, ag_ui_adk):
        """Test handling tool result when no active execution exists."""
        input_data = RunAgentInput(
            thread_id="nonexistent_thread",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        events = []
        async for event in ag_ui_adk._handle_tool_result_submission(input_data):
            events.append(event)

        # In all-long-running architecture, tool results without active execution
        # are treated as standalone results from LongRunningTools and start new executions
        # However, ADK may error if there's no conversation history for the tool result
        assert len(events) >= 1  # At least RUN_STARTED, potentially RUN_ERROR and RUN_FINISHED

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_no_active_execution_no_tools(self, ag_ui_adk):
        """Test handling tool result when no tool results exist."""
        input_data = RunAgentInput(
            thread_id="nonexistent_thread",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")  # No tool messages
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        events = []
        async for event in ag_ui_adk._handle_tool_result_submission(input_data):
            events.append(event)

        # When there are no tool results, should emit error for missing tool results
        assert len(events) == 1
        assert isinstance(events[0], RunErrorEvent)
        assert events[0].code == "NO_TOOL_RESULTS"
        assert "No tool results found in submission" in events[0].message

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_with_active_execution(self, ag_ui_adk):
        """Test handling tool result - starts new execution regardless of existing executions."""
        thread_id = "test_thread"

        # Mock the _stream_events method to simulate new execution
        mock_events = [
            MagicMock(type=EventType.TEXT_MESSAGE_CONTENT),
            MagicMock(type=EventType.TEXT_MESSAGE_END)
        ]

        async def mock_stream_events(execution):
            for event in mock_events:
                yield event

        with patch.object(ag_ui_adk, '_stream_events', side_effect=mock_stream_events):
            input_data = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={}
            )

            events = []
            async for event in ag_ui_adk._handle_tool_result_submission(input_data):
                events.append(event)

            # Should receive RUN_STARTED + mock events + RUN_FINISHED (4 total)
            assert len(events) == 4
            assert events[0].type == EventType.RUN_STARTED
            assert events[-1].type == EventType.RUN_FINISHED
            # In all-long-running architecture, tool results start new executions

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_streaming_error(self, ag_ui_adk):
        """Test handling when streaming events fails."""
        thread_id = "test_thread"

        # Mock _stream_events to raise an exception
        async def mock_stream_events(execution):
            raise RuntimeError("Streaming failed")
            yield  # Make it a generator

        with patch.object(ag_ui_adk, '_stream_events', side_effect=mock_stream_events):
            input_data = RunAgentInput(
                thread_id=thread_id,
                run_id="run_1",
                messages=[
                    ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={}
            )

            events = []
            async for event in ag_ui_adk._handle_tool_result_submission(input_data):
                events.append(event)

            # Should emit RUN_STARTED then error event when streaming fails
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert isinstance(events[1], RunErrorEvent)
            assert events[1].code == "EXECUTION_ERROR"
            assert "Streaming failed" in events[1].message

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_invalid_json(self, ag_ui_adk):
        """Test handling tool result with invalid JSON content."""
        thread_id = "test_thread"

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='invalid json{', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        events = []
        async for event in ag_ui_adk._handle_tool_result_submission(input_data):
            events.append(event)

        # Should start new execution, handle invalid JSON gracefully, and complete
        # Invalid JSON is handled gracefully in _run_adk_in_background by providing error result
        assert len(events) >= 2  # At least RUN_STARTED and some completion
        assert events[0].type == EventType.RUN_STARTED

    @pytest.mark.asyncio
    async def test_handle_tool_result_submission_multiple_results(self, ag_ui_adk):
        """Test handling multiple tool results in one submission preserves all unseen results."""
        thread_id = "test_thread"

        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "first"}', tool_call_id="call_1"),
                ToolMessage(id="2", role="tool", content='{"result": "second"}', tool_call_id="call_2")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        tool_results = await ag_ui_adk._extract_tool_results(input_data, input_data.messages)
        assert len(tool_results) == 2
        assert [result['message'].tool_call_id for result in tool_results] == ["call_1", "call_2"]

    @pytest.mark.asyncio
    async def test_tool_result_flow_integration(self, ag_ui_adk):
        """Test complete tool result flow through run method."""
        # First, simulate a request that would create an execution
        # (This is complex to mock fully, so we test the routing logic)

        # Test tool result routing
        tool_result_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                ToolMessage(id="1", role="tool", content='{"result": "success"}', tool_call_id="call_1")
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={}
        )

        # In the all-long-running architecture, tool result inputs are processed as new executions
        # Mock the background execution to avoid ADK library errors
        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )
            # In all-long-running architecture, tool results are processed through ADK sessions
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )

        with patch.object(ag_ui_adk, '_start_new_execution', side_effect=mock_start_new_execution):
            events = []
            async for event in ag_ui_adk.run(tool_result_input):
                events.append(event)

            # Should get RUN_STARTED and RUN_FINISHED events
            assert len(events) == 2
            assert events[0].type == EventType.RUN_STARTED
            assert events[1].type == EventType.RUN_FINISHED

    @pytest.mark.asyncio
    async def test_run_processes_mixed_unseen_messages(self, ag_ui_adk):
        """Ensure mixed unseen tool and user messages are handled sequentially."""
        input_data = RunAgentInput(
            thread_id="thread_mixed",
            run_id="run_mixed",
            messages=[
                ToolMessage(id="tool_1", role="tool", content='{"result": "value"}', tool_call_id="call_1"),
                UserMessage(id="user_2", role="user", content="Next question"),
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        start_calls = []

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            start_calls.append((tool_results, message_batch))
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        # Mock pending tool call check to return True so tool result is accepted
        async def mock_has_pending_tool_calls(session_id):
            return True

        with patch.object(
            ag_ui_adk,
            '_start_new_execution',
            side_effect=mock_start_new_execution,
        ), patch.object(
            ag_ui_adk,
            '_handle_tool_result_submission',
            wraps=ag_ui_adk._handle_tool_result_submission,
        ) as handle_mock, patch.object(
            ag_ui_adk,
            '_has_pending_tool_calls',
            side_effect=mock_has_pending_tool_calls,
        ), patch.object(
            ag_ui_adk,
            '_remove_pending_tool_call',
            new=AsyncMock(),
        ):
            events = []
            async for event in ag_ui_adk.run(input_data):
                events.append(event)

        # The system optimizes by sending tool result + trailing user message together
        # So we expect ONE run (2 events), not two separate runs (4 events)
        assert len(events) == 2
        assert [event.type for event in events] == [
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
        ]

        # Single call with tool results AND the trailing user message
        assert len(start_calls) == 1
        tool_results, message_batch = start_calls[0]
        assert tool_results is not None and len(tool_results) == 1
        assert tool_results[0]['message'].tool_call_id == "call_1"
        # Trailing user message is included in the same invocation
        assert message_batch == [input_data.messages[1]]

        assert handle_mock.call_count == 1
        assert 'tool_messages' in handle_mock.call_args.kwargs
        tool_messages = handle_mock.call_args.kwargs['tool_messages']
        assert len(tool_messages) == 1
        assert getattr(tool_messages[0], 'id', None) == "tool_1"

    @pytest.mark.asyncio
    async def test_run_skips_assistant_history_before_tool_result(self, ag_ui_adk):
        """Assistant tool call history should not trigger a new execution before tool results arrive."""
        assistant_call = AssistantMessage(
            id="assistant_tool",
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_1",
                    function=FunctionCall(name="test_tool", arguments="{}"),
                )
            ],
        )

        tool_result = ToolMessage(
            id="tool_result",
            role="tool",
            content='{"result": "value"}',
            tool_call_id="call_1",
        )

        input_data = RunAgentInput(
            thread_id="thread_assistant_tool",
            run_id="run_assistant_tool",
            messages=[
                UserMessage(id="user_initial", role="user", content="Initial question"),
                assistant_call,
                tool_result,
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        # Mark the initial user message as already processed so only the assistant call and tool result are unseen
        app_name = ag_ui_adk._get_app_name(input_data)
        ag_ui_adk._session_manager.mark_messages_processed(app_name, input_data.thread_id, ["user_initial"])

        start_calls = []

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            start_calls.append((tool_results, message_batch))

            call_id = None
            if tool_results:
                call_id = tool_results[0]['message'].tool_call_id
            elif message_batch:
                for message in message_batch:
                    tool_calls = getattr(message, "tool_calls", None)
                    if tool_calls:
                        call_id = tool_calls[0].id
                        break

            if call_id:
                await ag_ui_adk._add_pending_tool_call_with_context(
                    input_data.thread_id,
                    call_id,
                    ag_ui_adk._get_app_name(input_data),
                    ag_ui_adk._get_user_id(input_data),
                )

            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        with patch.object(
            ag_ui_adk,
            '_start_new_execution',
            side_effect=mock_start_new_execution,
        ) as start_mock, patch.object(
            ag_ui_adk,
            '_handle_tool_result_submission',
            wraps=ag_ui_adk._handle_tool_result_submission,
        ), patch.object(
            ag_ui_adk,
            '_add_pending_tool_call_with_context',
            new_callable=AsyncMock,
        ) as pending_mock:
            events = []
            async for event in ag_ui_adk.run(input_data):
                events.append(event)

        assert [event.type for event in events] == [
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
        ]

        assert start_mock.call_count == 1
        assert len(start_calls) == 1
        first_tool_results, first_batch = start_calls[0]
        assert first_tool_results is not None
        assert first_batch is None
        assert first_tool_results[0]['message'].id == "tool_result"

        assert pending_mock.await_count == 1
        pending_call = pending_mock.await_args_list[0]
        assert pending_call.args[1] == "call_1"

        processed_ids = ag_ui_adk._session_manager.get_processed_message_ids(app_name, input_data.thread_id)
        assert "assistant_tool" in processed_ids

    @pytest.mark.asyncio
    async def test_run_preserves_order_for_user_then_tool(self, ag_ui_adk):
        """Verify user updates are handled before subsequent tool messages."""
        input_data = RunAgentInput(
            thread_id="thread_order",
            run_id="run_order",
            messages=[
                UserMessage(id="user_1", role="user", content="Question"),
                ToolMessage(id="tool_2", role="tool", content='{"result": "answer"}', tool_call_id="call_2"),
            ],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        call_sequence = []

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            call_sequence.append(("start", tool_results, message_batch))
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        async def mock_handle_tool_result_submission(input_data, *, tool_messages=None, **kwargs):
            call_sequence.append(("tool", tool_messages))
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        with patch.object(
            ag_ui_adk,
            '_start_new_execution',
            side_effect=mock_start_new_execution,
        ), patch.object(
            ag_ui_adk,
            '_handle_tool_result_submission',
            side_effect=mock_handle_tool_result_submission,
        ):
            events = []
            async for event in ag_ui_adk.run(input_data):
                events.append(event)

        assert [event.type for event in events] == [
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
            EventType.RUN_STARTED,
            EventType.RUN_FINISHED,
        ]

        assert call_sequence[0][0] == "start"
        assert call_sequence[0][1] is None
        assert call_sequence[0][2] == [input_data.messages[0]]

        assert call_sequence[1][0] == "tool"
        assert len(call_sequence[1][1]) == 1
        assert getattr(call_sequence[1][1][0], 'id', None) == "tool_2"

    @pytest.mark.asyncio
    async def test_new_execution_routing(self, ag_ui_adk, sample_tool):
        """Test that non-tool messages route to new execution."""
        new_request_input = RunAgentInput(
            thread_id="thread_1",
            run_id="run_1",
            messages=[
                UserMessage(id="1", role="user", content="Hello")
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={}
        )

        # Mock the _start_new_execution method
        mock_events = [
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id="thread_1", run_id="run_1"),
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id="thread_1", run_id="run_1")
        ]

        async def mock_start_new_execution(input_data, *, tool_results=None, message_batch=None):
            for event in mock_events:
                yield event

        with patch.object(ag_ui_adk, '_start_new_execution', side_effect=mock_start_new_execution):
            events = []
            async for event in ag_ui_adk.run(new_request_input):
                events.append(event)

            assert len(events) == 2
            assert isinstance(events[0], RunStartedEvent)
            assert isinstance(events[1], RunFinishedEvent)
