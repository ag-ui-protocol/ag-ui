"""Regression tests for reasoning duplication on the final aggregated event.

When a response streams thoughts followed by text, the first partial text
chunk closes the reasoning stream. The final aggregated event (partial=False)
re-contains the full thought part, and the closed-stream state alone could not
detect that the reasoning had already been emitted — re-emitting it produced a
second, identical reasoning block after the answer.

Related issue: https://github.com/ag-ui-protocol/ag-ui/issues/2937
"""

from types import SimpleNamespace
from typing import List, Optional

import pytest
from unittest.mock import MagicMock

from ag_ui.core import BaseEvent, EventType
from ag_ui_adk.event_translator import EventTranslator

REASONING_EVENTS = {
    EventType.REASONING_START,
    EventType.REASONING_END,
    EventType.REASONING_MESSAGE_START,
    EventType.REASONING_MESSAGE_CONTENT,
    EventType.REASONING_MESSAGE_END,
}


def _part(text: str, thought: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        text=text, thought=True if thought else None, thought_signature=None
    )


def _adk_event(parts, partial: bool, final: bool) -> MagicMock:
    event = MagicMock()
    event.id = "test_event_id"
    event.author = "model"
    event.content = SimpleNamespace(parts=list(parts))
    event.partial = partial
    event.turn_complete = final
    event.is_final_response = final
    event.usage_metadata = None
    event.get_function_calls = MagicMock(return_value=[])
    event.get_function_responses = MagicMock(return_value=[])
    return event


async def _translate_all(events, run_id: str = "run_1") -> List[BaseEvent]:
    translator = EventTranslator()
    out: List[BaseEvent] = []
    for ev in events:
        async for ag_event in translator.translate(ev, "thread_1", run_id):
            out.append(ag_event)
    return out


def _reasoning_starts(events: List[BaseEvent]) -> List[BaseEvent]:
    return [e for e in events if e.type == EventType.REASONING_START]


def _reasoning_after_first_text(events: List[BaseEvent]) -> List[BaseEvent]:
    """Reasoning events emitted after the first TEXT_MESSAGE_START (the UI bug)."""
    out = []
    seen_text_start = False
    for e in events:
        if e.type == EventType.TEXT_MESSAGE_START:
            seen_text_start = True
        if seen_text_start and e.type in REASONING_EVENTS:
            out.append(e)
    return out


@pytest.mark.asyncio
async def test_streamed_thoughts_then_text_aggregate_not_duplicated():
    """The #2937 repro: streamed thought + text, then the final aggregate."""
    events = [
        _adk_event([_part("Let me think.", thought=True)], partial=True, final=False),
        _adk_event([_part("Hello")], partial=True, final=False),
        _adk_event(
            [_part("Let me think.", thought=True), _part("Hello")],
            partial=False,
            final=True,
        ),
    ]
    out = await _translate_all(events)

    assert len(_reasoning_starts(out)) == 1
    assert _reasoning_after_first_text(out) == []

    text_deltas = [
        e.delta for e in out if e.type == EventType.TEXT_MESSAGE_CONTENT
    ]
    assert text_deltas == ["Hello"]


@pytest.mark.asyncio
async def test_thoughts_only_aggregate_not_duplicated():
    """Thoughts-only response: the aggregate must not re-emit reasoning."""
    events = [
        _adk_event([_part("Thinking...", thought=True)], partial=True, final=False),
        _adk_event(
            [_part("Thinking...", thought=True)], partial=False, final=True
        ),
    ]
    out = await _translate_all(events)

    assert len(_reasoning_starts(out)) == 1
    content_deltas = [
        e.delta for e in out if e.type == EventType.REASONING_MESSAGE_CONTENT
    ]
    assert content_deltas == ["Thinking..."]


@pytest.mark.asyncio
async def test_non_streaming_aggregate_still_emits_reasoning():
    """StreamingMode.NONE: a single partial=False event carries the only copy."""
    events = [
        _adk_event(
            [_part("Only copy.", thought=True), _part("Answer")],
            partial=False,
            final=True,
        ),
    ]
    out = await _translate_all(events)

    assert len(_reasoning_starts(out)) == 1
    reasoning_content = [
        e.delta for e in out if e.type == EventType.REASONING_MESSAGE_CONTENT
    ]
    assert reasoning_content == ["Only copy."]
    text_deltas = [
        e.delta for e in out if e.type == EventType.TEXT_MESSAGE_CONTENT
    ]
    assert text_deltas == ["Answer"]


@pytest.mark.asyncio
async def test_new_run_emits_reasoning_again():
    """The per-response marker resets across runs on the same translator."""
    translator = EventTranslator()
    collected: List[BaseEvent] = []
    for run_id in ("run_1", "run_2"):
        events = [
            _adk_event(
                [_part(f"thought-{run_id}", thought=True)], partial=True, final=False
            ),
            _adk_event([_part(f"answer-{run_id}")], partial=True, final=False),
            _adk_event(
                [
                    _part(f"thought-{run_id}", thought=True),
                    _part(f"answer-{run_id}"),
                ],
                partial=False,
                final=True,
            ),
        ]
        for ev in events:
            async for ag_event in translator.translate(ev, "thread_1", run_id):
                collected.append(ag_event)

    assert len(_reasoning_starts(collected)) == 2

    reasoning_content = [
        e.delta for e in collected if e.type == EventType.REASONING_MESSAGE_CONTENT
    ]
    assert reasoning_content == ["thought-run_1", "thought-run_2"]
