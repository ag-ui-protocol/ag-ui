import pytest
from langchain_core.messages import AIMessageChunk

from ag_ui.core import EventType
from ag_ui_langgraph.types import LangGraphEventTypes
from tests._helpers import make_agent


def _make_agent():
    agent = make_agent()
    agent.active_run = {
        "id": "run-1",
        "thread_id": "thread-1",
        "reasoning_process": None,
        "node_name": "model",
        "has_function_streaming": False,
        "model_made_tool_call": False,
        "state_reliable": True,
    }
    return agent


def _ai_chunk(*, name="", args="", tool_call_id="tc-A", chunk_id="msg-1"):
    chunk = AIMessageChunk(content="", id=chunk_id)
    chunk.response_metadata = {}
    chunk.tool_call_chunks = (
        [{"name": name, "args": args, "id": tool_call_id, "index": 0}]
        if name or args
        else []
    )
    return chunk


def _stream_event(chunk):
    return {
        "event": LangGraphEventTypes.OnChatModelStream.value,
        "run_id": "run-1",
        "metadata": {"langgraph_node": "model"},
        "data": {"chunk": chunk},
        "name": "model",
        "parent_ids": [],
        "tags": [],
    }


async def _collect_events(agent, events):
    collected = []
    for event in events:
        async for emitted in agent._handle_single_event(event, {}):
            collected.append(emitted)
    return collected


@pytest.mark.asyncio
async def test_sequential_parallel_tool_calls_keep_separate_ids():
    agent = _make_agent()

    events = await _collect_events(
        agent,
        [
            _stream_event(_ai_chunk(name="search", tool_call_id="tc-A")),
            _stream_event(_ai_chunk(args='{"q":"alpha"}', tool_call_id="tc-A")),
            _stream_event(_ai_chunk(name="search", tool_call_id="tc-B")),
            _stream_event(_ai_chunk(args='{"q":"beta"}', tool_call_id="tc-B")),
            _stream_event(_ai_chunk()),
        ],
    )

    tool_events = [
        event for event in events
        if event.type in {
            EventType.TOOL_CALL_START,
            EventType.TOOL_CALL_ARGS,
            EventType.TOOL_CALL_END,
        }
    ]

    assert [
        (event.type, event.tool_call_id, getattr(event, "delta", None))
        for event in tool_events
    ] == [
        (EventType.TOOL_CALL_START, "tc-A", None),
        (EventType.TOOL_CALL_ARGS, "tc-A", '{"q":"alpha"}'),
        (EventType.TOOL_CALL_END, "tc-A", None),
        (EventType.TOOL_CALL_START, "tc-B", None),
        (EventType.TOOL_CALL_ARGS, "tc-B", '{"q":"beta"}'),
        (EventType.TOOL_CALL_END, "tc-B", None),
    ]

    assert agent.get_message_in_progress("run-1") is None
