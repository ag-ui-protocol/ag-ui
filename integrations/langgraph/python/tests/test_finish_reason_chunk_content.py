"""Regression tests for chunks carrying payload alongside ``finish_reason`` (#3428).

Drives ``_handle_stream_events`` (including ``on_chat_model_end``) to verify that
trailing text, tool-call fragments, and reasoning on ``finish_reason`` chunks are
streamed in order with ``usage_metadata`` recorded, while empty ``finish_reason``
chunks keep existing no-premature-close behavior.
"""

import unittest
from typing import Any, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessage, AIMessageChunk

from ag_ui.core import EventType, RunAgentInput

from tests._helpers import make_agent

TEXT_EVENTS = (
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
)
TOOL_EVENTS = (
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
)


def _text_chunk(
    content: Any,
    *,
    chunk_id: str = "ai-msg-1",
    finish_reason: Optional[str] = None,
    usage_metadata: Any = None,
    reasoning: Optional[str] = None,
) -> AIMessageChunk:
    extra = {"reasoning_content": reasoning} if reasoning is not None else {}
    chunk = AIMessageChunk(content=content, id=chunk_id, additional_kwargs=extra)
    chunk.response_metadata = {"finish_reason": finish_reason} if finish_reason else {}
    chunk.tool_call_chunks = []
    chunk.usage_metadata = usage_metadata
    return chunk


def _tool_chunk(
    *,
    name: Optional[str] = None,
    args: str = "",
    tool_call_id: Optional[str] = None,
    finish_reason: Optional[str] = None,
    usage_metadata: Any = None,
    reasoning: Optional[str] = None,
) -> AIMessageChunk:
    extra = {"reasoning_content": reasoning} if reasoning is not None else {}
    chunk = AIMessageChunk(content="", id="ai-tool-1", additional_kwargs=extra)
    chunk.response_metadata = {"finish_reason": finish_reason} if finish_reason else {}
    has_tc = name is not None or bool(args) or tool_call_id is not None
    chunk.tool_call_chunks = [{"name": name, "args": args, "id": tool_call_id, "index": 0}] if has_tc else []
    chunk.usage_metadata = usage_metadata
    return chunk


def _of_types(events: List[Any], *types: EventType) -> List[Any]:
    return [ev for ev in events if ev.type in types]


async def _run_chunks(
    *chunks: Any,
    end_content: str = "",
    emit_messages: Optional[bool] = None,
) -> List[Any]:
    meta: dict[str, Any] = {
        "langgraph_node": "model",
        "ls_provider": "openai",
        "ls_model_name": "zai.glm-5",
    }
    stream_meta = {**meta, **({"emit-messages": emit_messages} if emit_messages is not None else {})}
    events = [
        {
            "event": "on_chat_model_stream",
            "run_id": "run1",
            "metadata": stream_meta,
            "data": {"chunk": chunk},
            "name": "model",
            "parent_ids": [],
            "tags": [],
        }
        for chunk in chunks
    ] + [
        {
            "event": "on_chat_model_end",
            "run_id": "run1",
            "metadata": meta,
            "data": {"output": AIMessage(content=end_content)},
            "name": "model",
            "parent_ids": [],
            "tags": [],
        }
    ]

    agent = make_agent()
    initial_state = MagicMock(values={"messages": [], "copilotkit": {}}, tasks=[], next=[], metadata={"writes": {}})
    agent.graph.aget_state = AsyncMock(return_value=initial_state)

    async def fake_stream():
        for ev in events:
            yield ev

    prepared = {"stream": fake_stream(), "state": initial_state, "config": {"configurable": {"thread_id": "t1"}}}
    dispatched: List[Any] = []
    original_dispatch = agent._dispatch_event

    def record(ev):
        res = original_dispatch(ev)
        if res is not None:
            dispatched.append(res)
        return res

    run_input = RunAgentInput(
        thread_id="t1", run_id="r1", state={}, messages=[], tools=[], context=[], forwarded_props={}
    )
    schema_keys = {"input": ["messages"], "output": ["messages"], "config": [], "context": []}

    with (
        patch.object(agent, "prepare_stream", new=AsyncMock(return_value=prepared)),
        patch.object(agent, "get_schema_keys", return_value=schema_keys),
        patch.object(agent, "_dispatch_event", side_effect=record),
    ):
        async for _ in agent._handle_stream_events(run_input):
            pass
    return dispatched


class TestFinishReasonTextContent(unittest.IsolatedAsyncioTestCase):
    """Text attached to the ``finish_reason`` chunk must be streamed."""

    async def test_text_payload_on_finish_reason_chunk_is_emitted(self):
        cases = [
            (
                "trailing_text_with_usage",
                (
                    _text_chunk("Hello "),
                    _text_chunk("world!", finish_reason="stop", usage_metadata={"input_tokens": 12, "output_tokens": 5, "total_tokens": 17}),
                ),
                "Hello world!",
                ["Hello ", "world!"],
                "ai-msg-1",
                (12, 5, 17),
            ),
            (
                "single_chunk_with_usage",
                (_text_chunk("Done.", chunk_id="ai-single-1", finish_reason="stop", usage_metadata={"input_tokens": 8, "output_tokens": 2, "total_tokens": 10}),),
                "Done.",
                ["Done."],
                "ai-single-1",
                (8, 2, 10),
            ),
            (
                "list_block_text",
                (
                    _text_chunk([{"type": "text", "text": "Part 1 "}]),
                    _text_chunk([{"type": "text", "text": "Part 2"}], finish_reason="stop"),
                ),
                "Part 1 Part 2",
                ["Part 1 ", "Part 2"],
                "ai-msg-1",
                None,
            ),
            (
                "dict_chunk",
                ({"id": "ai-dict-1", "content": "Final dict text", "response_metadata": {"finish_reason": "stop"}, "tool_call_chunks": []},),
                "Final dict text",
                ["Final dict text"],
                "ai-dict-1",
                None,
            ),
        ]

        for name, chunks, end_content, expected_deltas, expected_id, expected_usage in cases:
            with self.subTest(case=name):
                dispatched = await _run_chunks(*chunks, end_content=end_content)
                text_events = _of_types(dispatched, *TEXT_EVENTS)
                self.assertEqual(
                    [ev.type for ev in text_events],
                    [EventType.TEXT_MESSAGE_START]
                    + [EventType.TEXT_MESSAGE_CONTENT] * len(expected_deltas)
                    + [EventType.TEXT_MESSAGE_END],
                )
                self.assertEqual(
                    [ev.delta for ev in text_events if ev.type == EventType.TEXT_MESSAGE_CONTENT],
                    expected_deltas,
                )
                self.assertEqual({ev.message_id for ev in text_events}, {expected_id})
                self.assertEqual(text_events[-1].raw_event["event"], "on_chat_model_end")
                if expected_usage is not None:
                    finished = next(ev for ev in dispatched if ev.type == EventType.RUN_FINISHED)
                    self.assertEqual(len(finished.usage), 1)
                    u = finished.usage[0]
                    self.assertEqual((u.input_tokens, u.output_tokens, u.total_tokens), expected_usage)

    async def test_emit_messages_false_still_suppresses_finish_reason_text(self):
        dispatched = await _run_chunks(
            _text_chunk("Hidden", finish_reason="stop"), end_content="Hidden", emit_messages=False
        )
        self.assertEqual(_of_types(dispatched, *TEXT_EVENTS), [])


class TestFinishReasonToolCallChunks(unittest.IsolatedAsyncioTestCase):
    """Tool-call fragments attached to ``finish_reason="tool_calls"`` chunks must stream."""

    async def test_tool_call_on_finish_reason_chunk_is_emitted(self):
        usage = {"input_tokens": 20, "output_tokens": 11, "total_tokens": 31}
        cases = [
            (
                "args_continuation",
                (
                    _tool_chunk(name="get_weather", tool_call_id="tc-1"),
                    _tool_chunk(args='{"city":'),
                    _tool_chunk(args='"Tokyo"}', finish_reason="tool_calls", usage_metadata=usage),
                ),
                "tc-1",
                "get_weather",
                ['{"city":', '"Tokyo"}'],
                31,
            ),
            (
                "single_chunk_start",
                (_tool_chunk(name="ping", tool_call_id="tc-ping", finish_reason="tool_calls"),),
                "tc-ping",
                "ping",
                [],
                None,
            ),
        ]

        for name, chunks, expected_id, expected_tool, expected_args, expected_total in cases:
            with self.subTest(case=name):
                dispatched = await _run_chunks(*chunks)
                tool_events = _of_types(dispatched, *TOOL_EVENTS)
                self.assertEqual(
                    [ev.type for ev in tool_events],
                    [EventType.TOOL_CALL_START]
                    + [EventType.TOOL_CALL_ARGS] * len(expected_args)
                    + [EventType.TOOL_CALL_END],
                )
                self.assertEqual({ev.tool_call_id for ev in tool_events}, {expected_id})
                self.assertEqual(tool_events[0].tool_call_name, expected_tool)
                self.assertEqual(
                    [ev.delta for ev in tool_events if ev.type == EventType.TOOL_CALL_ARGS],
                    expected_args,
                )
                self.assertEqual(tool_events[-1].raw_event["event"], "on_chat_model_end")
                if expected_total is not None:
                    finished = next(ev for ev in dispatched if ev.type == EventType.RUN_FINISHED)
                    self.assertEqual(finished.usage[0].total_tokens, expected_total)


class TestFinishReasonReasoningContent(unittest.IsolatedAsyncioTestCase):
    """Reasoning content and mixed-payload chunks must emit every payload cleanly."""

    async def test_reasoning_on_finish_reason_chunk_streams_and_closes(self):
        dispatched = await _run_chunks(
            _text_chunk("", reasoning="Step 1. "),
            _text_chunk("", reasoning="Step 2.", finish_reason="length"),
        )
        self.assertEqual(
            [ev.delta for ev in dispatched if ev.type == EventType.REASONING_MESSAGE_CONTENT],
            ["Step 1. ", "Step 2."],
        )

        single = await _run_chunks(_text_chunk("", reasoning="Only thought.", finish_reason="length"))
        types = [ev.type for ev in single]
        self.assertLess(types.index(EventType.REASONING_MESSAGE_END), types.index(EventType.REASONING_END))
        self.assertLess(types.index(EventType.REASONING_END), types.index(EventType.RUN_FINISHED))

    async def test_combined_payload_chunks_emit_both_payloads_in_order(self):
        cases = [
            (
                "reasoning_and_text_on_finish",
                (_text_chunk("Final answer.", reasoning="Quick thought.", finish_reason="stop"),),
                "Final answer.",
                [(EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_END), (EventType.REASONING_END, EventType.TEXT_MESSAGE_START)],
                ["Final answer."],
                None,
            ),
            (
                "reasoning_and_text_on_non_finish",
                (_text_chunk("Hello ", reasoning="Thinking."), _text_chunk("world", finish_reason="stop")),
                "Hello world",
                [(EventType.REASONING_END, EventType.TEXT_MESSAGE_START)],
                ["Hello ", "world"],
                None,
            ),
            (
                "trailing_text_after_open_tool_call",
                (_tool_chunk(name="search", tool_call_id="tc-1"), _tool_chunk(args='{"q":"ag-ui"}'), _text_chunk("Done.", finish_reason="stop")),
                "Done.",
                [(EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END), (EventType.TOOL_CALL_END, EventType.TEXT_MESSAGE_START)],
                ["Done."],
                '{"q":"ag-ui"}',
            ),
            (
                "reasoning_and_tool_args_on_finish",
                (_tool_chunk(name="search", tool_call_id="tc-1"), _tool_chunk(args='{"q":"ag-ui"'), _tool_chunk(args="}", finish_reason="tool_calls", reasoning="Ready.")),
                "",
                [(EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_END), (EventType.REASONING_END, EventType.TOOL_CALL_END)],
                None,
                '{"q":"ag-ui"}',
            ),
            (
                "redacted_thinking_and_text_on_finish",
                (
                    _text_chunk("", reasoning="Step 1."),
                    _text_chunk([{"type": "redacted_thinking", "data": "encrypted-blob"}, {"type": "text", "text": "Visible answer."}], finish_reason="stop"),
                ),
                "Visible answer.",
                [(EventType.REASONING_ENCRYPTED_VALUE, EventType.REASONING_END), (EventType.REASONING_END, EventType.TEXT_MESSAGE_START)],
                ["Visible answer."],
                None,
            ),
            (
                "named_tool_opener_with_reasoning_closes_open_text",
                (
                    _text_chunk("Let me check."),
                    _tool_chunk(name="search", tool_call_id="tc-open", reasoning="Need a lookup."),
                    _tool_chunk(args='{"q":"ag-ui"}', finish_reason="tool_calls"),
                ),
                "",
                [(EventType.TEXT_MESSAGE_END, EventType.TOOL_CALL_START), (EventType.REASONING_END, EventType.TOOL_CALL_END), (EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS)],
                ["Let me check."],
                '{"q":"ag-ui"}',
            ),
        ]

        for name, chunks, end_content, ordering_pairs, expected_text, expected_tool_args in cases:
            with self.subTest(case=name):
                dispatched = await _run_chunks(*chunks, end_content=end_content)
                types = [ev.type for ev in dispatched]
                for earlier, later in ordering_pairs:
                    self.assertIn(earlier, types)
                    self.assertIn(later, types)
                    self.assertLess(types.index(earlier), types.index(later))
                if expected_text is not None:
                    self.assertEqual(
                        [ev.delta for ev in dispatched if ev.type == EventType.TEXT_MESSAGE_CONTENT],
                        expected_text,
                    )
                if expected_tool_args is not None:
                    self.assertEqual(
                        "".join(ev.delta for ev in dispatched if ev.type == EventType.TOOL_CALL_ARGS),
                        expected_tool_args,
                    )

    async def test_redacted_thinking_on_finish_reason_with_and_without_active_reasoning(self):
        with self.subTest(active_reasoning=True):
            dispatched = await _run_chunks(
                _text_chunk("", reasoning="Step 1. "),
                _text_chunk([{"type": "redacted_thinking", "data": "encrypted-blob"}], finish_reason="length"),
            )
            reasoning_start = next(ev for ev in dispatched if ev.type == EventType.REASONING_MESSAGE_START)
            encrypted = _of_types(dispatched, EventType.REASONING_ENCRYPTED_VALUE)
            self.assertEqual(len(encrypted), 1)
            self.assertEqual(
                (encrypted[0].subtype, encrypted[0].entity_id, encrypted[0].encrypted_value),
                ("message", reasoning_start.message_id, "encrypted-blob"),
            )

        with self.subTest(active_reasoning=False):
            dispatched = await _run_chunks(
                _text_chunk("Hello"),
                _text_chunk([{"type": "redacted_thinking", "data": "orphan-blob"}], finish_reason="stop"),
                end_content="Hello",
            )
            self.assertEqual(_of_types(dispatched, EventType.REASONING_ENCRYPTED_VALUE), [])
            text_events = _of_types(dispatched, *TEXT_EVENTS)
            self.assertEqual([ev.type for ev in text_events], list(TEXT_EVENTS))
            self.assertEqual(text_events[1].delta, "Hello")
            self.assertEqual(text_events[2].raw_event["event"], "on_chat_model_end")


class TestEmptyFinishReasonChunkPreservesBehavior(unittest.IsolatedAsyncioTestCase):
    """Standard empty ``finish_reason`` chunks must remain no-ops (no premature close)."""

    async def test_empty_finish_reason_chunk_does_not_prematurely_close(self):
        cases = [
            ("empty_string_after_text", (_text_chunk("Hello"), _text_chunk("", finish_reason="stop")), "Hello", TEXT_EVENTS),
            ("empty_list_after_text", (_text_chunk([{"type": "text", "text": "Hello"}]), _text_chunk([], finish_reason="stop")), "Hello", TEXT_EVENTS),
            (
                "empty_tool_chunk_after_tool_call",
                (_tool_chunk(name="search", tool_call_id="tc-1"), _tool_chunk(args='{"q":"ag-ui"}'), _tool_chunk(finish_reason="tool_calls")),
                "",
                TOOL_EVENTS,
            ),
        ]

        for name, chunks, end_content, expected_types in cases:
            with self.subTest(case=name):
                dispatched = await _run_chunks(*chunks, end_content=end_content)
                relevant = _of_types(dispatched, *expected_types)
                self.assertEqual([ev.type for ev in relevant], list(expected_types))
                self.assertEqual(relevant[-1].raw_event["event"], "on_chat_model_end")

    async def test_empty_finish_reason_chunk_with_no_open_stream_emits_no_content_events(self):
        dispatched = await _run_chunks(
            _text_chunk("", finish_reason="stop", usage_metadata={"input_tokens": 4, "output_tokens": 0, "total_tokens": 4})
        )
        self.assertEqual(_of_types(dispatched, *TEXT_EVENTS, *TOOL_EVENTS), [])
        finished = next(ev for ev in dispatched if ev.type == EventType.RUN_FINISHED)
        self.assertEqual(finished.usage[0].input_tokens, 4)


if __name__ == "__main__":
    unittest.main()
