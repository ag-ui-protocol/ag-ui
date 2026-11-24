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


async def _translate_all(
    events, run_id: str = "run_1", translator: Optional[EventTranslator] = None
) -> List[BaseEvent]:
    translator = translator or EventTranslator()
    out: List[BaseEvent] = []
    for ev in events:
        async for ag_event in translator.translate(ev, "thread_1", run_id):
            out.append(ag_event)
    return out


def _reasoning_starts(events: List[BaseEvent]) -> List[BaseEvent]:
    return [e for e in events if e.type == EventType.REASONING_START]


def _reasoning_texts(events: List[BaseEvent]) -> List[str]:
    return [e.delta for e in events if e.type == EventType.REASONING_MESSAGE_CONTENT]


def _text_deltas(events: List[BaseEvent]) -> List[str]:
    return [e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]


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

    assert _text_deltas(out) == ["Hello"]


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
    assert _reasoning_texts(out) == ["Thinking..."]


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
    assert _reasoning_texts(out) == ["Only copy."]
    assert _text_deltas(out) == ["Answer"]


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [True, False], ids=["sse", "non_streaming"])
async def test_text_only_response_emits_no_reasoning(streaming):
    """A response without thoughts: closing on partial=False must emit nothing."""
    events = [_adk_event([_part("Hello")], partial=True, final=False)] if streaming else []
    events.append(_adk_event([_part("Hello")], partial=False, final=True))
    out = await _translate_all(events)

    assert [e for e in out if e.type in REASONING_EVENTS] == []
    assert _text_deltas(out) == ["Hello"]


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
        collected += await _translate_all(events, run_id, translator)

    assert len(_reasoning_starts(collected)) == 2

    assert _reasoning_texts(collected) == ["thought-run_1", "thought-run_2"]


@pytest.mark.asyncio
async def test_non_streaming_second_response_in_same_run_keeps_reasoning():
    """StreamingMode.NONE, two model responses in one run (e.g. a tool loop).

    Each partial=False event carries the only copy of its response's thoughts,
    so the second response's reasoning must not be mistaken for a duplicate.
    """
    events = [
        _adk_event(
            [_part("Plan A", thought=True), _part("Checking.")],
            partial=False,
            final=False,
        ),
        _adk_event(
            [_part("Plan B", thought=True), _part("Done.")],
            partial=False,
            final=True,
        ),
    ]
    out = await _translate_all(events, run_id="run_1")

    assert _reasoning_texts(out) == ["Plan A", "Plan B"]


@pytest.mark.asyncio
async def test_non_streaming_tool_loop_keeps_reasoning_of_each_response():
    """StreamingMode.NONE tool loop: thoughts-only call, tool result, answer.

    Response 1 carries only thoughts plus a function call; response 2 carries
    thoughts plus the answer. Both thoughts must reach the client, each in its
    own reasoning message that is closed before the next step starts.
    """
    call = SimpleNamespace(id="fc_1", name="get_weather", args={"city": "Oslo"})
    tool_call = _adk_event(
        [_part("I need the weather.", thought=True)], partial=False, final=False
    )
    tool_call.long_running_tool_ids = []
    tool_call.get_function_calls = MagicMock(return_value=[call])

    tool_result = _adk_event([], partial=False, final=False)
    tool_result.author = "user"
    tool_result.get_function_responses = MagicMock(
        return_value=[SimpleNamespace(id="fc_1", name="get_weather", response={"temp": 3})]
    )

    answer = _adk_event(
        [_part("It is cold.", thought=True), _part("3 degrees in Oslo.")],
        partial=False,
        final=True,
    )
    out = await _translate_all([tool_call, tool_result, answer])

    assert _reasoning_texts(out) == ["I need the weather.", "It is cold."]

    # One complete reasoning message per model response, with distinct IDs.
    reasoning = [(e.type, e.message_id) for e in out if e.type in REASONING_EVENTS]
    first_id, second_id = reasoning[0][1], reasoning[-1][1]
    assert first_id != second_id
    assert reasoning == [
        (EventType.REASONING_START, first_id),
        (EventType.REASONING_MESSAGE_START, first_id),
        (EventType.REASONING_MESSAGE_CONTENT, first_id),
        (EventType.REASONING_MESSAGE_END, first_id),
        (EventType.REASONING_END, first_id),
        (EventType.REASONING_START, second_id),
        (EventType.REASONING_MESSAGE_START, second_id),
        (EventType.REASONING_MESSAGE_CONTENT, second_id),
        (EventType.REASONING_MESSAGE_END, second_id),
        (EventType.REASONING_END, second_id),
    ]

    # The first reasoning message is closed before the tool call is emitted.
    types = [e.type for e in out]
    assert types.count(EventType.TOOL_CALL_START) == 1
    assert types.index(EventType.REASONING_END) < types.index(EventType.TOOL_CALL_START)


@pytest.mark.asyncio
async def test_streaming_two_responses_in_same_run_not_duplicated():
    """SSE, two model responses in one run: each aggregate is still deduped.

    Guards the other direction of the per-response reset: clearing the marker
    before the aggregate is checked would bring back the #2937 duplicate.
    """
    events = []
    for n in (1, 2):
        events += [
            _adk_event([_part(f"thought-{n}", thought=True)], partial=True, final=False),
            _adk_event([_part(f"answer-{n}")], partial=True, final=False),
            _adk_event(
                [_part(f"thought-{n}", thought=True), _part(f"answer-{n}")],
                partial=False,
                final=n == 2,
            ),
        ]
    out = await _translate_all(events, run_id="run_1")

    assert _reasoning_texts(out) == ["thought-1", "thought-2"]
    assert len(_reasoning_starts(out)) == 2
    assert _text_deltas(out) == ["answer-1", "answer-2"]


@pytest.mark.asyncio
async def test_new_run_after_interrupted_stream_keeps_reasoning():
    """A run whose stream stopped before its partial=False event (e.g. cancelled).

    The per-response reset never ran, so the run_id fallback must clear the
    marker; otherwise the next run's only copy of its thoughts would be dropped.
    """
    translator = EventTranslator()
    interrupted = [
        _adk_event([_part("Half a thought", thought=True)], partial=True, final=False),
    ]
    out = await _translate_all(interrupted, "run_1", translator)

    non_streaming = [
        _adk_event(
            [_part("Fresh thought", thought=True), _part("Answer")],
            partial=False,
            final=True,
        ),
    ]
    out += await _translate_all(non_streaming, "run_2", translator)

    assert _reasoning_texts(out) == ["Half a thought", "Fresh thought"]
    assert _text_deltas(out) == ["Answer"]
