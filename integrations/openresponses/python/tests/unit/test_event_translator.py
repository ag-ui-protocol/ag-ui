"""Unit tests for reasoning and refusal event translation."""

import pytest

from ag_ui.core import EventType

from ag_ui_openresponses.response.event_translator import EventTranslator
from ag_ui_openresponses.response.tool_call_handler import ToolCallHandler
from ag_ui_openresponses.types import OpenResponsesSSEEvent


@pytest.fixture
def translator():
    return EventTranslator()


@pytest.fixture
def tool_handler():
    return ToolCallHandler()


def _sse(event_type: str, data: dict | None = None) -> OpenResponsesSSEEvent:
    return OpenResponsesSSEEvent(type=event_type, data=data or {})


# ── Reasoning text events ────────────────────────────────────────────────


class TestReasoningTextEvents:
    """Tests for response.reasoning_text.delta/done → THINKING_TEXT_MESSAGE_*."""

    def test_reasoning_delta_emits_start_and_content(self, translator, tool_handler):
        events = translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "Let me think"}),
            tool_handler,
        )
        assert len(events) == 3
        assert events[0].type == EventType.THINKING_START
        assert events[1].type == EventType.THINKING_TEXT_MESSAGE_START
        assert events[2].type == EventType.THINKING_TEXT_MESSAGE_CONTENT
        assert events[2].delta == "Let me think"

    def test_reasoning_subsequent_deltas_no_extra_start(self, translator, tool_handler):
        translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "first"}),
            tool_handler,
        )
        events = translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "second"}),
            tool_handler,
        )
        assert len(events) == 1
        assert events[0].type == EventType.THINKING_TEXT_MESSAGE_CONTENT
        assert events[0].delta == "second"

    def test_reasoning_done_emits_end(self, translator, tool_handler):
        translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "think"}),
            tool_handler,
        )
        events = translator.translate(
            _sse("response.reasoning_text.done"),
            tool_handler,
        )
        assert len(events) == 2
        assert events[0].type == EventType.THINKING_TEXT_MESSAGE_END
        assert events[1].type == EventType.THINKING_END

    def test_reasoning_done_without_start_is_noop(self, translator, tool_handler):
        events = translator.translate(
            _sse("response.reasoning_text.done"),
            tool_handler,
        )
        assert len(events) == 0

    def test_reasoning_consistent_message_id(self, translator, tool_handler):
        events1 = translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "a"}),
            tool_handler,
        )
        events2 = translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "b"}),
            tool_handler,
        )
        events3 = translator.translate(
            _sse("response.reasoning_text.done"),
            tool_handler,
        )
        msg_id = events1[1].message_id  # THINKING_TEXT_MESSAGE_START event
        assert events1[2].message_id == msg_id
        assert events2[0].message_id == msg_id
        assert events3[0].message_id == msg_id

    def test_reasoning_empty_delta_ignored(self, translator, tool_handler):
        translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "start"}),
            tool_handler,
        )
        events = translator.translate(
            _sse("response.reasoning_text.delta", {"delta": ""}),
            tool_handler,
        )
        assert len(events) == 0


# ── Refusal events ───────────────────────────────────────────────────────


class TestRefusalEvents:
    """Tests for response.refusal.delta/done → TEXT_MESSAGE_*."""

    def test_refusal_delta_emits_start_and_content(self, translator, tool_handler):
        events = translator.translate(
            _sse("response.refusal.delta", {"delta": "I cannot"}),
            tool_handler,
        )
        assert len(events) == 2
        assert events[0].type == EventType.TEXT_MESSAGE_START
        assert events[0].role == "assistant"
        assert events[1].type == EventType.TEXT_MESSAGE_CONTENT
        assert events[1].delta == "I cannot"

    def test_refusal_subsequent_deltas_no_extra_start(self, translator, tool_handler):
        translator.translate(
            _sse("response.refusal.delta", {"delta": "I"}),
            tool_handler,
        )
        events = translator.translate(
            _sse("response.refusal.delta", {"delta": " cannot"}),
            tool_handler,
        )
        assert len(events) == 1
        assert events[0].type == EventType.TEXT_MESSAGE_CONTENT

    def test_refusal_done_emits_end(self, translator, tool_handler):
        translator.translate(
            _sse("response.refusal.delta", {"delta": "refused"}),
            tool_handler,
        )
        events = translator.translate(
            _sse("response.refusal.done"),
            tool_handler,
        )
        assert len(events) == 1
        assert events[0].type == EventType.TEXT_MESSAGE_END

    def test_refusal_done_without_start_is_noop(self, translator, tool_handler):
        events = translator.translate(
            _sse("response.refusal.done"),
            tool_handler,
        )
        assert len(events) == 0

    def test_refusal_consistent_message_id(self, translator, tool_handler):
        e1 = translator.translate(
            _sse("response.refusal.delta", {"delta": "I"}),
            tool_handler,
        )
        e2 = translator.translate(
            _sse("response.refusal.delta", {"delta": " cannot"}),
            tool_handler,
        )
        e3 = translator.translate(
            _sse("response.refusal.done"),
            tool_handler,
        )
        msg_id = e1[0].message_id
        assert e1[1].message_id == msg_id
        assert e2[0].message_id == msg_id
        assert e3[0].message_id == msg_id

    def test_refusal_empty_delta_ignored(self, translator, tool_handler):
        translator.translate(
            _sse("response.refusal.delta", {"delta": "x"}),
            tool_handler,
        )
        events = translator.translate(
            _sse("response.refusal.delta", {"delta": ""}),
            tool_handler,
        )
        assert len(events) == 0


# ── State cleanup ────────────────────────────────────────────────────────


class TestStateCleanup:
    """Tests for state cleanup on completed/reset."""

    def test_completed_resets_thinking_state(self, translator, tool_handler):
        translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "think"}),
            tool_handler,
        )
        translator.translate(_sse("response.completed"), tool_handler)

        # Next reasoning delta should emit fresh THINKING_START + THINKING_TEXT_MESSAGE_START
        events = translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "new"}),
            tool_handler,
        )
        assert events[0].type == EventType.THINKING_START
        assert events[1].type == EventType.THINKING_TEXT_MESSAGE_START

    def test_reset_clears_all_state(self, translator, tool_handler):
        translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "a"}),
            tool_handler,
        )
        translator.translate(
            _sse("response.refusal.delta", {"delta": "b"}),
            tool_handler,
        )
        translator.reset()

        # All should emit fresh START events
        reasoning = translator.translate(
            _sse("response.reasoning_text.delta", {"delta": "x"}),
            tool_handler,
        )
        assert reasoning[0].type == EventType.THINKING_START
        assert reasoning[1].type == EventType.THINKING_TEXT_MESSAGE_START

        refusal = translator.translate(
            _sse("response.refusal.delta", {"delta": "y"}),
            tool_handler,
        )
        assert refusal[0].type == EventType.TEXT_MESSAGE_START
