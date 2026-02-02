"""Unit tests for SSE parser, including data-only (no event: line) format."""

import pytest

from ag_ui_openresponses.response.sse_parser import SSEParser
from ag_ui_openresponses.types import OpenResponsesSSEEvent


class FakeStreamReader:
    """Minimal async iterator simulating aiohttp StreamReader.iter_any()."""

    def __init__(self, raw: str):
        self._chunks = [raw.encode("utf-8")]

    async def iter_any(self):
        for chunk in self._chunks:
            yield chunk


async def _parse_all(raw: str) -> list[OpenResponsesSSEEvent]:
    parser = SSEParser()
    reader = FakeStreamReader(raw)
    return [event async for event in parser.parse(reader)]


# ── Standard SSE format (explicit event: lines) ──────────────────────────


class TestStandardSSEFormat:
    """Events that include explicit 'event:' lines (e.g. OpenAI direct)."""

    @pytest.mark.asyncio
    async def test_parses_event_with_explicit_event_line(self):
        raw = (
            "event: response.output_text.delta\n"
            'data: {"delta": "Hello"}\n'
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 1
        assert events[0].type == "response.output_text.delta"
        assert events[0].data["delta"] == "Hello"

    @pytest.mark.asyncio
    async def test_explicit_event_line_takes_precedence_over_json_type(self):
        raw = (
            "event: response.output_text.delta\n"
            'data: {"type": "response.output_text.delta", "delta": "Hi"}\n'
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 1
        assert events[0].type == "response.output_text.delta"

    @pytest.mark.asyncio
    async def test_multiple_events_with_explicit_event_lines(self):
        raw = (
            "event: response.created\n"
            'data: {"response": {"id": "r1"}}\n'
            "\n"
            "event: response.output_text.delta\n"
            'data: {"delta": "Hi"}\n'
            "\n"
            "event: response.completed\n"
            'data: {"response": {"id": "r1"}}\n'
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 3
        assert events[0].type == "response.created"
        assert events[1].type == "response.output_text.delta"
        assert events[2].type == "response.completed"


# ── Data-only SSE format (no event: lines, type in JSON) ─────────────────


class TestDataOnlySSEFormat:
    """Events without 'event:' lines, type extracted from JSON payload.

    This is the format used by the Hugging Face router.
    """

    @pytest.mark.asyncio
    async def test_parses_event_from_json_type_field(self):
        raw = (
            'data: {"type": "response.output_text.delta", "delta": "Hello"}\n'
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 1
        assert events[0].type == "response.output_text.delta"
        assert events[0].data["delta"] == "Hello"

    @pytest.mark.asyncio
    async def test_full_hf_router_stream(self):
        """Simulate a realistic HF router stream with reasoning + text."""
        raw = (
            'data: {"type":"response.created","response":{"id":"r1","status":"in_progress"}}\n'
            "\n"
            'data: {"type":"response.reasoning_text.delta","delta":"thinking"}\n'
            "\n"
            'data: {"type":"response.reasoning_text.done","text":"thinking"}\n'
            "\n"
            'data: {"type":"response.output_item.added","item":{"id":"msg1","type":"message","role":"assistant"}}\n'
            "\n"
            'data: {"type":"response.output_text.delta","delta":"Hello!"}\n'
            "\n"
            'data: {"type":"response.output_text.done","text":"Hello!"}\n'
            "\n"
            'data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n'
            "\n"
        )
        events = await _parse_all(raw)
        types = [e.type for e in events]
        assert types == [
            "response.created",
            "response.reasoning_text.delta",
            "response.reasoning_text.done",
            "response.output_item.added",
            "response.output_text.delta",
            "response.output_text.done",
            "response.completed",
        ]

    @pytest.mark.asyncio
    async def test_data_only_with_no_type_field_is_skipped(self):
        raw = (
            'data: {"delta": "no type here"}\n'
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 0


# ── DONE signal ───────────────────────────────────────────────────────────


class TestDoneSignal:
    @pytest.mark.asyncio
    async def test_done_signal_stops_parsing(self):
        raw = (
            'data: {"type": "response.created", "response": {"id": "r1"}}\n'
            "\n"
            "data: [DONE]\n"
            "\n"
            'data: {"type": "response.completed", "response": {"id": "r1"}}\n'
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 1
        assert events[0].type == "response.created"


# ── Edge cases ────────────────────────────────────────────────────────────


class TestEdgeCases:
    @pytest.mark.asyncio
    async def test_invalid_json_is_skipped(self):
        raw = (
            "event: response.created\n"
            "data: {invalid json}\n"
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_empty_stream(self):
        events = await _parse_all("")
        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_trailing_data_with_terminating_newlines(self):
        """Trailing event data is emitted when terminated by blank line."""
        raw = (
            'data: {"type": "response.created", "response": {"id": "r1"}}\n'
            "\n"
        )
        events = await _parse_all(raw)
        assert len(events) == 1
        assert events[0].type == "response.created"
