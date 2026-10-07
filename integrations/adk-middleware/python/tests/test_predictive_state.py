"""Tests for predictive state updates functionality."""

import pytest
from unittest.mock import MagicMock
import uuid

from ag_ui.core import EventType, CustomEvent
from ag_ui_adk.event_translator import EventTranslator
from ag_ui_adk.config import PredictStateMapping, normalize_predict_state


class TestPredictStateMapping:
    """Tests for PredictStateMapping configuration."""

    def test_predict_state_mapping_creation(self):
        """Test creating a PredictStateMapping instance."""
        mapping = PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="content",
        )
        assert mapping.state_key == "document"
        assert mapping.tool == "write_document"
        assert mapping.tool_argument == "content"

    def test_predict_state_mapping_to_payload(self):
        """Test converting PredictStateMapping to payload format."""
        mapping = PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="content",
        )
        payload = mapping.to_payload()
        assert payload == {
            "state_key": "document",
            "tool": "write_document",
            "tool_argument": "content",
        }


class TestNormalizePredictState:
    """Tests for normalize_predict_state helper."""

    def test_normalize_none(self):
        """Test normalizing None returns empty list."""
        result = normalize_predict_state(None)
        assert result == []

    def test_normalize_single_mapping(self):
        """Test normalizing a single mapping returns list."""
        mapping = PredictStateMapping(
            state_key="doc",
            tool="write",
            tool_argument="content",
        )
        result = normalize_predict_state(mapping)
        assert len(result) == 1
        assert result[0] == mapping

    def test_normalize_list_of_mappings(self):
        """Test normalizing a list of mappings."""
        mappings = [
            PredictStateMapping(state_key="doc1", tool="tool1", tool_argument="arg1"),
            PredictStateMapping(state_key="doc2", tool="tool2", tool_argument="arg2"),
        ]
        result = normalize_predict_state(mappings)
        assert len(result) == 2
        assert result == mappings


class TestEventTranslatorPredictState:
    """Tests for EventTranslator predictive state functionality."""

    @pytest.fixture
    def translator_with_predict_state(self):
        """Create translator with predictive state config."""
        return EventTranslator(
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document",
                    tool_argument="document",
                )
            ]
        )

    @pytest.fixture
    def translator_without_predict_state(self):
        """Create translator without predictive state config."""
        return EventTranslator()

    @pytest.mark.asyncio
    async def test_predict_state_event_emitted_for_matching_tool(
        self, translator_with_predict_state
    ):
        """Test that PredictState CustomEvent is emitted for matching tool."""
        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "Hello world"}

        events = []
        async for event in translator_with_predict_state._translate_function_calls(
            [func_call]
        ):
            events.append(event)

        # Should have: PredictState, ToolCallStart, ToolCallArgs, ToolCallEnd
        # Note: No StateSnapshot - frontend handles state from TOOL_CALL_ARGS via PredictState
        assert len(events) == 4

        # First event should be PredictState CustomEvent
        predict_state_event = events[0]
        assert isinstance(predict_state_event, CustomEvent)
        assert predict_state_event.type == EventType.CUSTOM
        assert predict_state_event.name == "PredictState"
        assert predict_state_event.value == [
            {
                "state_key": "document",
                "tool": "write_document",
                "tool_argument": "document",
            }
        ]

        # Fourth event should be ToolCallEnd
        from ag_ui.core import ToolCallEndEvent
        tool_call_end_event = events[3]
        assert isinstance(tool_call_end_event, ToolCallEndEvent)

    @pytest.mark.asyncio
    async def test_no_predict_state_event_for_non_matching_tool(
        self, translator_with_predict_state
    ):
        """Test that no PredictState event is emitted for non-matching tool."""
        # Create mock function call for a different tool
        func_call = MagicMock()
        func_call.name = "other_tool"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"data": "some data"}

        events = []
        async for event in translator_with_predict_state._translate_function_calls(
            [func_call]
        ):
            events.append(event)

        # Should only have: ToolCallStart, ToolCallArgs, ToolCallEnd
        assert len(events) == 3

        # None should be PredictState
        for event in events:
            if isinstance(event, CustomEvent):
                assert event.name != "PredictState"

    @pytest.mark.asyncio
    async def test_no_predict_state_event_without_config(
        self, translator_without_predict_state
    ):
        """Test that no PredictState event is emitted without config."""
        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "Hello world"}

        events = []
        async for event in translator_without_predict_state._translate_function_calls(
            [func_call]
        ):
            events.append(event)

        # Should only have: ToolCallStart, ToolCallArgs, ToolCallEnd
        assert len(events) == 3

        # None should be PredictState
        for event in events:
            if isinstance(event, CustomEvent):
                assert event.name != "PredictState"

    @pytest.mark.asyncio
    async def test_predict_state_event_only_emitted_once(
        self, translator_with_predict_state
    ):
        """Test that PredictState event is only emitted once per tool."""
        # Create two calls to the same tool
        func_call1 = MagicMock()
        func_call1.name = "write_document"
        func_call1.id = str(uuid.uuid4())
        func_call1.args = {"document": "First document"}

        func_call2 = MagicMock()
        func_call2.name = "write_document"
        func_call2.id = str(uuid.uuid4())
        func_call2.args = {"document": "Second document"}

        # First call
        events1 = []
        async for event in translator_with_predict_state._translate_function_calls(
            [func_call1]
        ):
            events1.append(event)

        # Second call
        events2 = []
        async for event in translator_with_predict_state._translate_function_calls(
            [func_call2]
        ):
            events2.append(event)

        # First call should have PredictState
        predict_state_count = sum(
            1
            for e in events1
            if isinstance(e, CustomEvent) and e.name == "PredictState"
        )
        assert predict_state_count == 1

        # Second call should NOT have PredictState
        predict_state_count = sum(
            1
            for e in events2
            if isinstance(e, CustomEvent) and e.name == "PredictState"
        )
        assert predict_state_count == 0

    @pytest.mark.asyncio
    async def test_predict_state_tracking_reset(self, translator_with_predict_state):
        """Test that reset clears predict state tracking."""
        # First call emits PredictState
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "First"}

        events1 = []
        async for event in translator_with_predict_state._translate_function_calls(
            [func_call]
        ):
            events1.append(event)

        # Reset translator
        translator_with_predict_state.reset()

        # Second call should emit PredictState again after reset
        func_call2 = MagicMock()
        func_call2.name = "write_document"
        func_call2.id = str(uuid.uuid4())
        func_call2.args = {"document": "Second"}

        events2 = []
        async for event in translator_with_predict_state._translate_function_calls(
            [func_call2]
        ):
            events2.append(event)

        # Both should have PredictState
        predict_state_count_1 = sum(
            1
            for e in events1
            if isinstance(e, CustomEvent) and e.name == "PredictState"
        )
        predict_state_count_2 = sum(
            1
            for e in events2
            if isinstance(e, CustomEvent) and e.name == "PredictState"
        )
        assert predict_state_count_1 == 1
        assert predict_state_count_2 == 1

    def test_multiple_predict_state_mappings(self):
        """Test translator with multiple predict state mappings."""
        translator = EventTranslator(
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document",
                    tool_argument="document",
                ),
                PredictStateMapping(
                    state_key="title",
                    tool="write_document",
                    tool_argument="title",
                ),
                PredictStateMapping(
                    state_key="other_state",
                    tool="other_tool",
                    tool_argument="data",
                ),
            ]
        )

        # Should have two tools in the mapping
        assert len(translator._predict_state_by_tool) == 2
        assert "write_document" in translator._predict_state_by_tool
        assert "other_tool" in translator._predict_state_by_tool

        # write_document should have two mappings
        assert len(translator._predict_state_by_tool["write_document"]) == 2

        # other_tool should have one mapping
        assert len(translator._predict_state_by_tool["other_tool"]) == 1


class TestDeferredConfirmChangesEvents:
    """Tests for deferred confirm_changes events functionality.

    The confirm_changes events must be emitted LAST, right before RUN_FINISHED,
    to ensure the frontend shows the confirmation dialog with buttons enabled.
    If emitted too early, subsequent events can cause the dialog to transition
    away from "executing" status, disabling the buttons.
    """

    @pytest.fixture
    def translator_with_emit_confirm(self):
        """Create translator with predictive state config that emits confirm_changes."""
        return EventTranslator(
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document",
                    tool_argument="document",
                    emit_confirm_tool=True,  # Default, but explicit for clarity
                )
            ]
        )

    @pytest.fixture
    def translator_without_emit_confirm(self):
        """Create translator with predictive state config that does NOT emit confirm_changes."""
        return EventTranslator(
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document",
                    tool_argument="document",
                    emit_confirm_tool=False,
                )
            ]
        )

    def test_has_deferred_confirm_events_initially_false(self, translator_with_emit_confirm):
        """Test that has_deferred_confirm_events returns False initially."""
        assert translator_with_emit_confirm.has_deferred_confirm_events() is False

    def test_get_and_clear_deferred_confirm_events_initially_empty(self, translator_with_emit_confirm):
        """Test that get_and_clear_deferred_confirm_events returns empty list initially."""
        events = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()
        assert events == []

    @pytest.mark.asyncio
    async def test_confirm_changes_events_are_deferred_not_yielded(
        self, translator_with_emit_confirm
    ):
        """Test that confirm_changes events are deferred (stored) instead of yielded immediately."""
        from ag_ui.core import ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent

        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "Hello world"}

        yielded_events = []
        async for event in translator_with_emit_confirm._translate_function_calls([func_call]):
            yielded_events.append(event)

        # Should NOT yield confirm_changes events directly
        confirm_changes_in_yielded = [
            e for e in yielded_events
            if isinstance(e, (ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent))
            and (hasattr(e, 'tool_call_name') and e.tool_call_name == "confirm_changes")
        ]
        assert len(confirm_changes_in_yielded) == 0

        # Should have deferred events stored
        assert translator_with_emit_confirm.has_deferred_confirm_events() is True

    @pytest.mark.asyncio
    async def test_deferred_events_contain_confirm_changes_trio(
        self, translator_with_emit_confirm
    ):
        """Test that deferred events contain START, ARGS, END for confirm_changes."""
        from ag_ui.core import ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent

        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "Hello world"}

        async for _ in translator_with_emit_confirm._translate_function_calls([func_call]):
            pass

        # Get deferred events
        deferred_events = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()

        # Should have exactly 3 events: START, ARGS, END
        assert len(deferred_events) == 3

        # Check event types and order
        assert isinstance(deferred_events[0], ToolCallStartEvent)
        assert deferred_events[0].tool_call_name == "confirm_changes"

        assert isinstance(deferred_events[1], ToolCallArgsEvent)
        assert deferred_events[1].delta == "{}"

        assert isinstance(deferred_events[2], ToolCallEndEvent)

        # All should have the same tool_call_id
        tool_call_id = deferred_events[0].tool_call_id
        assert deferred_events[1].tool_call_id == tool_call_id
        assert deferred_events[2].tool_call_id == tool_call_id

    @pytest.mark.asyncio
    async def test_get_and_clear_actually_clears_events(
        self, translator_with_emit_confirm
    ):
        """Test that get_and_clear_deferred_confirm_events clears the internal list."""
        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "Hello world"}

        async for _ in translator_with_emit_confirm._translate_function_calls([func_call]):
            pass

        # First call should return events
        first_call = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()
        assert len(first_call) == 3

        # Second call should return empty list
        second_call = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()
        assert len(second_call) == 0

        # has_deferred_confirm_events should now be False
        assert translator_with_emit_confirm.has_deferred_confirm_events() is False

    @pytest.mark.asyncio
    async def test_no_confirm_changes_when_emit_confirm_tool_false(
        self, translator_without_emit_confirm
    ):
        """Test that no confirm_changes events are deferred when emit_confirm_tool=False."""
        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "Hello world"}

        async for _ in translator_without_emit_confirm._translate_function_calls([func_call]):
            pass

        # Should NOT have any deferred events
        assert translator_without_emit_confirm.has_deferred_confirm_events() is False
        assert translator_without_emit_confirm.get_and_clear_deferred_confirm_events() == []

    @pytest.mark.asyncio
    async def test_confirm_changes_only_emitted_once_per_tool(
        self, translator_with_emit_confirm
    ):
        """Test that confirm_changes events are only deferred once per tool type."""
        # Create two function calls for the same tool
        func_call1 = MagicMock()
        func_call1.name = "write_document"
        func_call1.id = str(uuid.uuid4())
        func_call1.args = {"document": "First document"}

        func_call2 = MagicMock()
        func_call2.name = "write_document"
        func_call2.id = str(uuid.uuid4())
        func_call2.args = {"document": "Second document"}

        # Process first call
        async for _ in translator_with_emit_confirm._translate_function_calls([func_call1]):
            pass

        # Get and clear first batch
        first_batch = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()
        assert len(first_batch) == 3  # START, ARGS, END

        # Process second call
        async for _ in translator_with_emit_confirm._translate_function_calls([func_call2]):
            pass

        # Second call should NOT generate more confirm_changes events
        # (already emitted for this tool type)
        second_batch = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()
        assert len(second_batch) == 0

    @pytest.mark.asyncio
    async def test_reset_clears_deferred_confirm_events(
        self, translator_with_emit_confirm
    ):
        """Test that reset() clears deferred confirm_changes events."""
        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "Hello world"}

        async for _ in translator_with_emit_confirm._translate_function_calls([func_call]):
            pass

        # Should have deferred events
        assert translator_with_emit_confirm.has_deferred_confirm_events() is True

        # Reset translator
        translator_with_emit_confirm.reset()

        # Deferred events should be cleared
        assert translator_with_emit_confirm.has_deferred_confirm_events() is False
        assert translator_with_emit_confirm.get_and_clear_deferred_confirm_events() == []

    @pytest.mark.asyncio
    async def test_reset_allows_confirm_changes_to_be_emitted_again(
        self, translator_with_emit_confirm
    ):
        """Test that after reset, confirm_changes can be emitted for the same tool again."""
        # Create mock function call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = str(uuid.uuid4())
        func_call.args = {"document": "First document"}

        # Process first call
        async for _ in translator_with_emit_confirm._translate_function_calls([func_call]):
            pass
        first_batch = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()
        assert len(first_batch) == 3

        # Reset translator
        translator_with_emit_confirm.reset()

        # Process another call after reset
        func_call2 = MagicMock()
        func_call2.name = "write_document"
        func_call2.id = str(uuid.uuid4())
        func_call2.args = {"document": "Second document"}

        async for _ in translator_with_emit_confirm._translate_function_calls([func_call2]):
            pass

        # Should have deferred events again after reset
        second_batch = translator_with_emit_confirm.get_and_clear_deferred_confirm_events()
        assert len(second_batch) == 3

    def test_emit_confirm_tool_default_is_true(self):
        """Test that emit_confirm_tool defaults to True in PredictStateMapping."""
        mapping = PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="content",
        )
        assert mapping.emit_confirm_tool is True

    def test_emit_confirm_tool_can_be_set_to_false(self):
        """Test that emit_confirm_tool can be explicitly set to False."""
        mapping = PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="content",
            emit_confirm_tool=False,
        )
        assert mapping.emit_confirm_tool is False

    @pytest.mark.asyncio
    async def test_multiple_tools_with_different_emit_confirm_settings(self):
        """Test translator with multiple tools having different emit_confirm_tool settings."""
        translator = EventTranslator(
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document",
                    tool_argument="document",
                    emit_confirm_tool=True,
                ),
                PredictStateMapping(
                    state_key="config",
                    tool="update_config",
                    tool_argument="config",
                    emit_confirm_tool=False,
                ),
            ]
        )

        # Call write_document (emit_confirm_tool=True)
        func_call1 = MagicMock()
        func_call1.name = "write_document"
        func_call1.id = str(uuid.uuid4())
        func_call1.args = {"document": "doc content"}

        async for _ in translator._translate_function_calls([func_call1]):
            pass

        # Should have deferred events for write_document
        write_doc_events = translator.get_and_clear_deferred_confirm_events()
        assert len(write_doc_events) == 3

        # Call update_config (emit_confirm_tool=False)
        func_call2 = MagicMock()
        func_call2.name = "update_config"
        func_call2.id = str(uuid.uuid4())
        func_call2.args = {"config": {"key": "value"}}

        async for _ in translator._translate_function_calls([func_call2]):
            pass

        # Should NOT have deferred events for update_config
        update_config_events = translator.get_and_clear_deferred_confirm_events()
        assert len(update_config_events) == 0


class TestPredictiveStateToolCallResultSuppression:
    """Tests for suppressing TOOL_CALL_RESULT events for predictive state tools.

    When a tool has predictive state configuration, the frontend handles state
    updates via the PredictState mechanism. We must suppress TOOL_CALL_RESULT
    events for these tools to avoid "No function call event found" errors.
    """

    @pytest.fixture
    def translator_with_predict_state(self):
        """Create translator with predictive state config."""
        return EventTranslator(
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document",
                    tool_argument="document",
                )
            ]
        )

    @pytest.fixture
    def translator_without_predict_state(self):
        """Create translator without predictive state config."""
        return EventTranslator()

    @pytest.mark.asyncio
    async def test_predictive_state_tool_call_ids_tracked(
        self, translator_with_predict_state
    ):
        """Test that tool call IDs for predictive state tools are tracked."""
        # Create mock function call for a predictive state tool
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = "call_123"
        func_call.args = {"document": "Hello world"}

        # Process the function call
        events = []
        async for event in translator_with_predict_state._translate_function_calls([func_call]):
            events.append(event)

        # The tool call ID should be tracked in _predictive_state_tool_call_ids
        assert "call_123" in translator_with_predict_state._predictive_state_tool_call_ids

    @pytest.mark.asyncio
    async def test_non_predictive_state_tool_call_ids_not_tracked(
        self, translator_with_predict_state
    ):
        """Test that tool call IDs for non-predictive state tools are NOT tracked."""
        # Create mock function call for a non-predictive state tool
        func_call = MagicMock()
        func_call.name = "search_tool"  # Not in predict_state config
        func_call.id = "call_456"
        func_call.args = {"query": "test"}

        # Process the function call
        events = []
        async for event in translator_with_predict_state._translate_function_calls([func_call]):
            events.append(event)

        # The tool call ID should NOT be tracked
        assert "call_456" not in translator_with_predict_state._predictive_state_tool_call_ids

    @pytest.mark.asyncio
    async def test_tool_call_result_suppressed_for_predictive_state_tools(
        self, translator_with_predict_state
    ):
        """Test that TOOL_CALL_RESULT events are suppressed for predictive state tools."""
        from ag_ui.core import ToolCallResultEvent

        # First, process a predictive state tool call to track the ID
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = "call_789"
        func_call.args = {"document": "Hello world"}

        async for _ in translator_with_predict_state._translate_function_calls([func_call]):
            pass

        # Verify the tool call ID is tracked
        assert "call_789" in translator_with_predict_state._predictive_state_tool_call_ids

        # Now simulate a function response for this tool
        func_response = MagicMock()
        func_response.id = "call_789"
        func_response.name = "write_document"
        func_response.response = {"success": True}

        # Process the function response
        result_events = []
        async for event in translator_with_predict_state._translate_function_response([func_response]):
            result_events.append(event)

        # Should NOT emit any TOOL_CALL_RESULT events
        assert len(result_events) == 0

    @pytest.mark.asyncio
    async def test_tool_call_result_not_suppressed_for_regular_tools(
        self, translator_with_predict_state
    ):
        """Test that TOOL_CALL_RESULT events are NOT suppressed for regular tools."""
        from ag_ui.core import ToolCallResultEvent

        # First, process a regular (non-predictive state) tool call
        func_call = MagicMock()
        func_call.name = "search_tool"  # Not in predict_state config
        func_call.id = "call_regular"
        func_call.args = {"query": "test"}

        async for _ in translator_with_predict_state._translate_function_calls([func_call]):
            pass

        # Verify the tool call ID is NOT tracked (it's not a predictive state tool)
        assert "call_regular" not in translator_with_predict_state._predictive_state_tool_call_ids

        # Now simulate a function response for this regular tool
        func_response = MagicMock()
        func_response.id = "call_regular"
        func_response.name = "search_tool"
        func_response.response = {"results": ["item1"]}

        # Process the function response
        result_events = []
        async for event in translator_with_predict_state._translate_function_response([func_response]):
            result_events.append(event)

        # Should emit TOOL_CALL_RESULT event for regular tools
        assert len(result_events) == 1
        assert isinstance(result_events[0], ToolCallResultEvent)
        assert result_events[0].tool_call_id == "call_regular"

    @pytest.mark.asyncio
    async def test_reset_clears_predictive_state_tool_call_ids(
        self, translator_with_predict_state
    ):
        """Test that reset() clears the _predictive_state_tool_call_ids set."""
        # Process a predictive state tool call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = "call_to_clear"
        func_call.args = {"document": "Hello"}

        async for _ in translator_with_predict_state._translate_function_calls([func_call]):
            pass

        # Verify it's tracked
        assert "call_to_clear" in translator_with_predict_state._predictive_state_tool_call_ids

        # Reset the translator
        translator_with_predict_state.reset()

        # The tracking set should be cleared
        assert len(translator_with_predict_state._predictive_state_tool_call_ids) == 0
        assert "call_to_clear" not in translator_with_predict_state._predictive_state_tool_call_ids

    @pytest.mark.asyncio
    async def test_reset_allows_tool_call_result_after_reset(
        self, translator_with_predict_state
    ):
        """Test that after reset, new tool call IDs are not in the suppression set."""
        from ag_ui.core import ToolCallResultEvent

        # Process a predictive state tool call
        func_call = MagicMock()
        func_call.name = "write_document"
        func_call.id = "call_before_reset"
        func_call.args = {"document": "Hello"}

        async for _ in translator_with_predict_state._translate_function_calls([func_call]):
            pass

        # Reset the translator
        translator_with_predict_state.reset()

        # Simulate a response for the original tool call ID
        # After reset, this ID should no longer be tracked for suppression
        func_response = MagicMock()
        func_response.id = "call_before_reset"
        func_response.name = "write_document"
        func_response.response = {"success": True}

        result_events = []
        async for event in translator_with_predict_state._translate_function_response([func_response]):
            result_events.append(event)

        # After reset, the ID is no longer tracked, so TOOL_CALL_RESULT should be emitted
        # (Note: This assumes the response arrives after reset, which is a test scenario)
        assert len(result_events) == 1
        assert isinstance(result_events[0], ToolCallResultEvent)

    @pytest.mark.asyncio
    async def test_no_config_means_no_suppression(
        self, translator_without_predict_state
    ):
        """Test that without predict_state config, no tool results are suppressed."""
        from ag_ui.core import ToolCallResultEvent

        # Process any function call (without predict_state config)
        func_call = MagicMock()
        func_call.name = "any_tool"
        func_call.id = "call_any"
        func_call.args = {"data": "value"}

        async for _ in translator_without_predict_state._translate_function_calls([func_call]):
            pass

        # The tracking set should remain empty
        assert len(translator_without_predict_state._predictive_state_tool_call_ids) == 0

        # Function response should be emitted
        func_response = MagicMock()
        func_response.id = "call_any"
        func_response.name = "any_tool"
        func_response.response = {"result": "success"}

        result_events = []
        async for event in translator_without_predict_state._translate_function_response([func_response]):
            result_events.append(event)

        assert len(result_events) == 1
        assert isinstance(result_events[0], ToolCallResultEvent)


class TestConfirmChangesDecisionReachesModel:
    """The user's approve/reject decision on confirm_changes is handed to the
    model as user text on the next run, whether it arrives as the dojo's
    ToolMessage (``respond({accepted})`` -> ``'{"accepted":true}'``) or as a
    ``resume`` entry. A resume works whether or not RUN_FINISHED reports the
    confirm_changes interrupt (``emit_interrupt_outcome``); a ToolMessage answer
    is the flag-off path, since with the flag on an open interrupt must be
    answered through ``resume`` (see test_interrupt_enforcement.py)."""

    emit_outcome = False

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        from ag_ui_adk.session_manager import SessionManager

        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def _agent(self):
        from google.adk.agents.llm_agent import LlmAgent
        from google.adk.sessions import InMemorySessionService
        from ag_ui_adk import ADKAgent
        from tests.hitl_helpers import ScriptedLlm

        def write_document_local(document: str) -> dict:
            """Write the document."""
            return {"status": "written"}

        llm = ScriptedLlm(
            model="scripted",
            first_call={"name": "write_document_local", "args": {"document": "Hi"}},
        )
        agent = ADKAgent(
            adk_agent=LlmAgent(name="doc_agent", model=llm, tools=[write_document_local]),
            app_name="doc_app",
            user_id="test_user",
            session_service=InMemorySessionService(),
            predict_state=[
                PredictStateMapping(
                    state_key="document",
                    tool="write_document_local",
                    tool_argument="document",
                )
            ],
            emit_interrupt_outcome=self.emit_outcome,
        )
        return agent, llm

    async def _propose(self, thread_id):
        from ag_ui.core import AssistantMessage, FunctionCall, ToolCall, UserMessage
        from tests.hitl_helpers import collect, run_finished, run_input, tool_call

        agent, llm = self._agent()
        user = UserMessage(id="u-1", role="user", content="Write it")
        turn1 = await collect(agent, run_input(thread_id, "run-1", [user]))
        write_id, write_args = tool_call(turn1, "write_document_local")
        confirm_id, _ = tool_call(turn1, "confirm_changes")
        assert write_id and confirm_id
        assert (run_finished(turn1).outcome is not None) is self.emit_outcome
        # The backend tool runs in-stream, so the model already answered once more.
        self.turns_after_proposal = llm.turn_count
        history = [
            user,
            AssistantMessage(
                id="a-1",
                role="assistant",
                content=None,
                tool_calls=[
                    ToolCall(
                        id=write_id,
                        function=FunctionCall(name="write_document_local", arguments=write_args),
                    ),
                    ToolCall(
                        id=confirm_id,
                        function=FunctionCall(name="confirm_changes", arguments="{}"),
                    ),
                ],
            ),
        ]
        return agent, llm, confirm_id, history

    @staticmethod
    def _assert_well_formed(events):
        from tests.hitl_helpers import run_finished

        assert events[0].type == EventType.RUN_STARTED
        assert not [e for e in events if e.type == EventType.RUN_ERROR]
        run_finished(events)

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "content,expected",
        [
            ('{"accepted":false}', "rejected"),
            ('{"accepted":true}', "accepted"),
            ('{"approved": false}', "rejected"),
            ("rejected", "rejected"),
        ],
    )
    async def test_tool_message_decision_reaches_model(self, content, expected):
        from ag_ui.core import ToolMessage
        from tests.hitl_helpers import collect, content_text, run_input

        agent, llm, confirm_id, history = await self._propose(f"t-decide-{expected}-{len(content)}")
        turn2 = await collect(
            agent,
            run_input(
                f"t-decide-{expected}-{len(content)}",
                "run-2",
                history + [ToolMessage(id="t-1", role="tool", tool_call_id=confirm_id, content=content)],
            ),
        )

        self._assert_well_formed(turn2)
        assert llm.turn_count == self.turns_after_proposal + 1, "the decision must start one model turn"
        text = content_text(llm.last_contents[-1]).lower()
        assert f"user {expected} the proposed changes" in text
        # A decision is not a tool result: ADK never called confirm_changes.
        assert not any(
            p.function_response is not None for p in (llm.last_contents[-1].parts or [])
        )

    @pytest.mark.asyncio
    async def test_decision_is_combined_with_trailing_user_message(self):
        from ag_ui.core import ToolMessage, UserMessage
        from tests.hitl_helpers import collect, content_text, run_input

        agent, llm, confirm_id, history = await self._propose("t-decide-trailing")
        turn2 = await collect(
            agent,
            run_input(
                "t-decide-trailing",
                "run-2",
                history
                + [
                    ToolMessage(id="t-1", role="tool", tool_call_id=confirm_id, content='{"accepted":false}'),
                    UserMessage(id="u-2", role="user", content="Now add a title"),
                ],
            ),
        )

        self._assert_well_formed(turn2)
        assert llm.turn_count == self.turns_after_proposal + 1
        text = content_text(llm.last_contents[-1])
        assert "user rejected the proposed changes" in text.lower()
        assert "Now add a title" in text

    @pytest.mark.asyncio
    @pytest.mark.parametrize("emit_outcome", [False, True], ids=["outcome_off", "outcome_on"])
    async def test_resume_decision_reaches_model(self, emit_outcome):
        from ag_ui.core import ResumeEntry
        from tests.hitl_helpers import collect, content_text, run_input

        self.emit_outcome = emit_outcome

        agent, llm, confirm_id, history = await self._propose("t-decide-resume")
        turn2 = await collect(
            agent,
            run_input(
                "t-decide-resume",
                "run-2",
                history,
                resume=[ResumeEntry(interrupt_id=confirm_id, status="resolved", payload={"accepted": False})],
            ),
        )

        self._assert_well_formed(turn2)
        assert llm.turn_count == self.turns_after_proposal + 1
        assert "user rejected the proposed changes" in content_text(llm.last_contents[-1]).lower()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("emit_outcome", [False, True], ids=["outcome_off", "outcome_on"])
    async def test_resume_decision_without_history_reaches_model(self, emit_outcome):
        """Only the recorded open interrupt correlates this resume: the replayed
        history does not contain the confirm_changes call."""
        from ag_ui.core import ResumeEntry
        from tests.hitl_helpers import collect, content_text, run_input

        self.emit_outcome = emit_outcome

        agent, llm, confirm_id, history = await self._propose("t-decide-bare")
        turn2 = await collect(
            agent,
            run_input(
                "t-decide-bare",
                "run-2",
                history[:1],
                resume=[ResumeEntry(interrupt_id=confirm_id, status="cancelled")],
            ),
        )

        self._assert_well_formed(turn2)
        assert llm.turn_count == self.turns_after_proposal + 1
        assert "user rejected the proposed changes" in content_text(llm.last_contents[-1]).lower()

    @pytest.mark.asyncio
    async def test_replayed_decision_does_not_start_another_turn(self):
        from ag_ui.core import ToolMessage
        from tests.hitl_helpers import collect, run_input

        agent, llm, confirm_id, history = await self._propose("t-decide-replay")
        messages = history + [
            ToolMessage(id="t-1", role="tool", tool_call_id=confirm_id, content='{"accepted":true}')
        ]
        await collect(agent, run_input("t-decide-replay", "run-2", messages))
        replay = await collect(agent, run_input("t-decide-replay", "run-3", messages))

        self._assert_well_formed(replay)
        assert llm.turn_count == self.turns_after_proposal + 1
