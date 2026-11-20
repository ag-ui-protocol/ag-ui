"""Regression tests for chunks carrying payload alongside ``finish_reason`` (#3428).

Some OpenAI-compatible providers (e.g. ``zai.glm-5``) attach trailing text,
tool-call fragments, or reasoning on the same final ``AIMessageChunk`` that
carries ``response_metadata["finish_reason"]``. Previously, ``OnChatModelStream``
returned as soon as ``finish_reason`` was truthy, dropping any content on that
chunk while still recording ``usage_metadata``.

These tests drive the full ``_handle_stream_events`` pipeline (including
``on_chat_model_end``) and verify:

1. Trailing text on a ``finish_reason`` chunk (continuation of an open text
   stream, single-chunk text response, list-block text content, and raw dict
   chunk) is streamed in order and ``usage_metadata`` is still recorded.
2. Tool-call data on a ``finish_reason="tool_calls"`` chunk (argument
   continuation and single-chunk tool start) is streamed in order and closed
   cleanly at ``on_chat_model_end``.
3. Reasoning content on a ``finish_reason`` chunk is streamed rather than
   dropped.
4. Standard empty ``finish_reason`` chunks (``content=""`` or ``content=[]``,
   no tool-call payload) preserve existing behavior: no spurious events and no
   premature stream closure before ``on_chat_model_end``.
"""

import unittest
from typing import Any, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessage, AIMessageChunk

from ag_ui.core import EventType, RunAgentInput

from tests._helpers import make_agent


def _stream_event(
    chunk: Any,
    *,
    node: str = "model",
    run_id: str = "run1",
    emit_messages: Optional[bool] = None,
    emit_tool_calls: Optional[bool] = None,
    provider: str = "openai",
    model: str = "zai.glm-5",
) -> dict:
    metadata: dict[str, Any] = {
        "langgraph_node": node,
        "ls_provider": provider,
        "ls_model_name": model,
    }
    if emit_messages is not None:
        metadata["emit-messages"] = emit_messages
    if emit_tool_calls is not None:
        metadata["emit-tool-calls"] = emit_tool_calls
    return {
        "event": "on_chat_model_stream",
        "run_id": run_id,
        "metadata": metadata,
        "data": {"chunk": chunk},
        "name": node,
        "parent_ids": [],
        "tags": [],
    }


def _model_end_event(
    *,
    content: str = "",
    node: str = "model",
    run_id: str = "run1",
    provider: str = "openai",
    model: str = "zai.glm-5",
) -> dict:
    return {
        "event": "on_chat_model_end",
        "run_id": run_id,
        "metadata": {
            "langgraph_node": node,
            "ls_provider": provider,
            "ls_model_name": model,
        },
        "data": {"output": AIMessage(content=content)},
        "name": node,
        "parent_ids": [],
        "tags": [],
    }


def _text_chunk(
    content: Any,
    *,
    chunk_id: str = "ai-msg-1",
    finish_reason: Optional[str] = None,
    usage_metadata: Any = None,
    additional_kwargs: Optional[dict] = None,
) -> AIMessageChunk:
    chunk = AIMessageChunk(
        content=content,
        id=chunk_id,
        additional_kwargs=additional_kwargs or {},
    )
    chunk.response_metadata = {"finish_reason": finish_reason} if finish_reason else {}
    chunk.tool_call_chunks = []
    chunk.usage_metadata = usage_metadata
    return chunk


def _tool_chunk(
    *,
    name: Optional[str] = None,
    args: str = "",
    tool_call_id: Optional[str] = None,
    chunk_id: str = "ai-tool-1",
    finish_reason: Optional[str] = None,
    usage_metadata: Any = None,
) -> AIMessageChunk:
    chunk = AIMessageChunk(content="", id=chunk_id)
    chunk.response_metadata = {"finish_reason": finish_reason} if finish_reason else {}
    if name is not None or args or tool_call_id is not None:
        chunk.tool_call_chunks = [
            {"name": name, "args": args, "id": tool_call_id, "index": 0}
        ]
    else:
        chunk.tool_call_chunks = []
    chunk.usage_metadata = usage_metadata
    return chunk


async def _run_pipeline(events: List[dict]) -> List[Any]:
    agent = make_agent()

    initial_state = MagicMock()
    initial_state.values = {"messages": [], "copilotkit": {}}
    initial_state.tasks = []
    initial_state.next = []
    initial_state.metadata = {"writes": {}}
    agent.graph.aget_state = AsyncMock(return_value=initial_state)

    async def fake_stream():
        for ev in events:
            yield ev

    prepared = {
        "stream": fake_stream(),
        "state": initial_state,
        "config": {"configurable": {"thread_id": "t1"}},
    }

    dispatched: List[Any] = []
    original_dispatch = agent._dispatch_event

    def record(ev):
        res = original_dispatch(ev)
        if res is not None:
            dispatched.append(res)
        return res

    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[],
        tools=[],
        context=[],
        forwarded_props={},
    )

    with (
        patch.object(agent, "prepare_stream", new=AsyncMock(return_value=prepared)),
        patch.object(agent, "get_schema_keys", return_value={
            "input": ["messages"],
            "output": ["messages"],
            "config": [],
            "context": [],
        }),
        patch.object(agent, "_dispatch_event", side_effect=record),
    ):
        async for _ in agent._handle_stream_events(run_input):
            pass

    return dispatched


class TestFinishReasonTextContent(unittest.IsolatedAsyncioTestCase):
    """Text attached to the ``finish_reason`` chunk must be streamed."""

    async def test_trailing_text_on_finish_reason_chunk_is_emitted_and_usage_recorded(self):
        usage = {"input_tokens": 12, "output_tokens": 5, "total_tokens": 17}
        events = [
            _stream_event(_text_chunk("Hello ")),
            _stream_event(
                _text_chunk("world!", finish_reason="stop", usage_metadata=usage)
            ),
            _model_end_event(content="Hello world!"),
        ]

        dispatched = await _run_pipeline(events)
        text_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]

        self.assertEqual(
            [ev.type for ev in text_events],
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )
        self.assertEqual(
            [ev.delta for ev in text_events if ev.type == EventType.TEXT_MESSAGE_CONTENT],
            ["Hello ", "world!"],
        )
        # All events belong to the same message and close at on_chat_model_end.
        self.assertEqual({ev.message_id for ev in text_events}, {"ai-msg-1"})
        self.assertEqual(text_events[-1].raw_event["event"], "on_chat_model_end")

        finished = next(ev for ev in dispatched if ev.type == EventType.RUN_FINISHED)
        self.assertIsNotNone(finished.usage)
        self.assertEqual(len(finished.usage), 1)
        self.assertEqual(
            (finished.usage[0].input_tokens, finished.usage[0].output_tokens, finished.usage[0].total_tokens),
            (12, 5, 17),
        )

    async def test_single_chunk_text_with_finish_reason_starts_streams_and_ends(self):
        usage = {"input_tokens": 8, "output_tokens": 2, "total_tokens": 10}
        events = [
            _stream_event(
                _text_chunk("Done.", chunk_id="ai-single-1", finish_reason="stop", usage_metadata=usage)
            ),
            _model_end_event(content="Done."),
        ]

        dispatched = await _run_pipeline(events)
        text_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]

        self.assertEqual(
            [ev.type for ev in text_events],
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )
        self.assertEqual(text_events[1].delta, "Done.")
        self.assertEqual({ev.message_id for ev in text_events}, {"ai-single-1"})

        finished = next(ev for ev in dispatched if ev.type == EventType.RUN_FINISHED)
        self.assertEqual(finished.usage[0].total_tokens, 10)

    async def test_list_block_text_on_finish_reason_chunk_is_emitted(self):
        events = [
            _stream_event(_text_chunk([{"type": "text", "text": "Part 1 "}])),
            _stream_event(
                _text_chunk([{"type": "text", "text": "Part 2"}], finish_reason="stop")
            ),
            _model_end_event(content="Part 1 Part 2"),
        ]

        dispatched = await _run_pipeline(events)
        deltas = [
            ev.delta for ev in dispatched
            if ev.type == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertEqual(deltas, ["Part 1 ", "Part 2"])

    async def test_dict_chunk_text_on_finish_reason_is_emitted(self):
        dict_chunk = {
            "id": "ai-dict-1",
            "content": "Final dict text",
            "response_metadata": {"finish_reason": "stop"},
            "tool_call_chunks": [],
        }
        events = [
            _stream_event(dict_chunk),
            _model_end_event(content="Final dict text"),
        ]

        dispatched = await _run_pipeline(events)
        deltas = [
            ev.delta for ev in dispatched
            if ev.type == EventType.TEXT_MESSAGE_CONTENT
        ]
        self.assertEqual(deltas, ["Final dict text"])

    async def test_emit_messages_false_still_suppresses_finish_reason_text(self):
        events = [
            _stream_event(
                _text_chunk("Hidden", finish_reason="stop"),
                emit_messages=False,
            ),
            _model_end_event(content="Hidden"),
        ]

        dispatched = await _run_pipeline(events)
        text_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]
        self.assertEqual(text_events, [])


class TestFinishReasonToolCallChunks(unittest.IsolatedAsyncioTestCase):
    """Tool-call fragments attached to ``finish_reason="tool_calls"`` chunks must stream."""

    async def test_tool_call_args_continuation_on_finish_reason_chunk_is_emitted(self):
        usage = {"input_tokens": 20, "output_tokens": 11, "total_tokens": 31}
        events = [
            _stream_event(_tool_chunk(name="get_weather", args="", tool_call_id="tc-1")),
            _stream_event(_tool_chunk(args='{"city":')),
            _stream_event(
                _tool_chunk(args='"Tokyo"}', finish_reason="tool_calls", usage_metadata=usage)
            ),
            _model_end_event(),
        ]

        dispatched = await _run_pipeline(events)
        tool_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
            )
        ]

        self.assertEqual(
            [ev.type for ev in tool_events],
            [
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
            ],
        )
        self.assertEqual({ev.tool_call_id for ev in tool_events}, {"tc-1"})
        args_deltas = [ev.delta for ev in tool_events if ev.type == EventType.TOOL_CALL_ARGS]
        self.assertEqual(args_deltas, ['{"city":', '"Tokyo"}'])
        self.assertEqual("".join(args_deltas), '{"city":"Tokyo"}')
        self.assertEqual(tool_events[-1].raw_event["event"], "on_chat_model_end")

        finished = next(ev for ev in dispatched if ev.type == EventType.RUN_FINISHED)
        self.assertEqual(finished.usage[0].total_tokens, 31)

    async def test_single_chunk_tool_call_start_on_finish_reason_chunk_is_emitted(self):
        events = [
            _stream_event(
                _tool_chunk(
                    name="ping",
                    args="",
                    tool_call_id="tc-ping",
                    finish_reason="tool_calls",
                )
            ),
            _model_end_event(),
        ]

        dispatched = await _run_pipeline(events)
        tool_events = [
            ev for ev in dispatched
            if ev.type in (EventType.TOOL_CALL_START, EventType.TOOL_CALL_END)
        ]

        self.assertEqual(
            [ev.type for ev in tool_events],
            [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END],
        )
        self.assertEqual(tool_events[0].tool_call_id, "tc-ping")
        self.assertEqual(tool_events[0].tool_call_name, "ping")
        self.assertEqual(tool_events[1].tool_call_id, "tc-ping")


class TestFinishReasonReasoningContent(unittest.IsolatedAsyncioTestCase):
    """Reasoning content on the ``finish_reason`` chunk must not be dropped."""

    async def test_trailing_reasoning_on_finish_reason_chunk_is_emitted(self):
        events = [
            _stream_event(
                _text_chunk("", additional_kwargs={"reasoning_content": "Step 1. "})
            ),
            _stream_event(
                _text_chunk(
                    "",
                    additional_kwargs={"reasoning_content": "Step 2."},
                    finish_reason="length",
                )
            ),
            _model_end_event(),
        ]

        dispatched = await _run_pipeline(events)
        reasoning_deltas = [
            ev.delta for ev in dispatched
            if ev.type == EventType.REASONING_MESSAGE_CONTENT
        ]
        self.assertEqual(reasoning_deltas, ["Step 1. ", "Step 2."])

    async def test_redacted_thinking_on_finish_reason_with_active_reasoning_emits_encrypted_value(self):
        events = [
            _stream_event(
                _text_chunk("", additional_kwargs={"reasoning_content": "Step 1. "})
            ),
            _stream_event(
                _text_chunk(
                    [{"type": "redacted_thinking", "data": "encrypted-blob"}],
                    finish_reason="length",
                )
            ),
            _model_end_event(),
        ]

        dispatched = await _run_pipeline(events)
        reasoning_start = next(
            ev for ev in dispatched if ev.type == EventType.REASONING_MESSAGE_START
        )
        encrypted_events = [
            ev for ev in dispatched
            if ev.type == EventType.REASONING_ENCRYPTED_VALUE
        ]
        self.assertEqual(len(encrypted_events), 1)
        self.assertEqual(encrypted_events[0].subtype, "message")
        self.assertEqual(encrypted_events[0].entity_id, reasoning_start.message_id)
        self.assertEqual(encrypted_events[0].encrypted_value, "encrypted-blob")

    async def test_redacted_thinking_on_finish_reason_without_active_reasoning_leaves_text_stream_open(self):
        events = [
            _stream_event(_text_chunk("Hello")),
            _stream_event(
                _text_chunk(
                    [{"type": "redacted_thinking", "data": "orphan-blob"}],
                    finish_reason="stop",
                )
            ),
            _model_end_event(content="Hello"),
        ]

        dispatched = await _run_pipeline(events)
        encrypted_events = [
            ev for ev in dispatched
            if ev.type == EventType.REASONING_ENCRYPTED_VALUE
        ]
        self.assertEqual(encrypted_events, [])

        text_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]
        self.assertEqual(
            [ev.type for ev in text_events],
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )
        self.assertEqual(text_events[1].delta, "Hello")
        self.assertEqual(text_events[2].raw_event["event"], "on_chat_model_end")


class TestEmptyFinishReasonChunkPreservesBehavior(unittest.IsolatedAsyncioTestCase):
    """Standard empty ``finish_reason`` chunks must remain no-ops (no premature close)."""

    async def test_empty_string_finish_reason_chunk_after_text_does_not_prematurely_close(self):
        events = [
            _stream_event(_text_chunk("Hello")),
            _stream_event(_text_chunk("", finish_reason="stop")),
            _model_end_event(content="Hello"),
        ]

        dispatched = await _run_pipeline(events)
        text_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]

        self.assertEqual(
            [ev.type for ev in text_events],
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )
        self.assertEqual(text_events[1].delta, "Hello")
        self.assertEqual(text_events[2].raw_event["event"], "on_chat_model_end")

    async def test_empty_list_finish_reason_chunk_after_text_does_not_prematurely_close(self):
        """Anthropic/Bedrock-style empty list content on the finish_reason chunk
        must not prematurely emit TEXT_MESSAGE_END before on_chat_model_end."""
        events = [
            _stream_event(_text_chunk([{"type": "text", "text": "Hello"}])),
            _stream_event(_text_chunk([], finish_reason="stop")),
            _model_end_event(content="Hello"),
        ]

        dispatched = await _run_pipeline(events)
        text_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]

        self.assertEqual(
            [ev.type for ev in text_events],
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )
        self.assertEqual(text_events[2].raw_event["event"], "on_chat_model_end")

    async def test_empty_finish_reason_chunk_after_tool_call_does_not_prematurely_close(self):
        """OpenAI/Anthropic-style empty finish_reason chunk after streaming tool
        call args must leave TOOL_CALL_END to on_chat_model_end."""
        events = [
            _stream_event(_tool_chunk(name="search", args="", tool_call_id="tc-1")),
            _stream_event(_tool_chunk(args='{"q":"ag-ui"}')),
            _stream_event(_tool_chunk(finish_reason="tool_calls")),
            _model_end_event(),
        ]

        dispatched = await _run_pipeline(events)
        tool_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
            )
        ]

        self.assertEqual(
            [ev.type for ev in tool_events],
            [
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
            ],
        )
        self.assertEqual(tool_events[2].raw_event["event"], "on_chat_model_end")

    async def test_empty_finish_reason_chunk_with_no_open_stream_emits_no_content_events(self):
        usage = {"input_tokens": 4, "output_tokens": 0, "total_tokens": 4}
        events = [
            _stream_event(_text_chunk("", finish_reason="stop", usage_metadata=usage)),
            _model_end_event(),
        ]

        dispatched = await _run_pipeline(events)
        stream_content_events = [
            ev for ev in dispatched
            if ev.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
            )
        ]
        self.assertEqual(stream_content_events, [])

        finished = next(ev for ev in dispatched if ev.type == EventType.RUN_FINISHED)
        self.assertEqual(finished.usage[0].input_tokens, 4)


if __name__ == "__main__":
    unittest.main()
