"""Tests for ToolCallStartEvent.parent_message_id correctness (issue #1610).

The adapter previously emitted TOOL_CALL_START with parent_message_id
pointing at a UUID that had not been emitted to the client — either the
rotated id reserved for the *next* text segment, or the upfront id from
run() initialization that was never emitted at all. parent_message_id
must reference a message the client has already observed, or be None
when no parent message exists.

These tests pin the post-fix invariant: parent_message_id equals the most
recently emitted text message id, persisting across back-to-back tool
calls until a new text segment opens; None when no text has been emitted.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from ag_ui.core import EventType, RunAgentInput, Tool, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


# ---------------------------------------------------------------------------
# Shared helpers (mirrors test_parallel_tool_call_handling.py for consistency)
# ---------------------------------------------------------------------------

def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(thread_id: str, stream_events: list) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )

    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()

    async def _stream(_msg: str):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _run_input(thread_id: str, tools: list | None = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content="hello")],
        tools=tools or [],
        context=[],
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

THREAD = "parent-msg-id-thread"
TOOLS = [Tool(name="frontend_tool", description="d", parameters={})]

# Realistic Strands stream: assistant emits some text, then calls a tool.
STREAM_TEXT_THEN_TOOL = [
    {"data": "Let me check those tables:"},
    {"current_tool_use": {"name": "frontend_tool", "toolUseId": "st-1", "input": {}}},
    {"event": {"contentBlockStop": {}}},
]


async def test_tool_call_parent_id_matches_preceding_text_message():
    """parent_message_id on TOOL_CALL_START must equal the just-ended text message id.

    The pre-fix adapter rotated message_id *before* emitting the tool call,
    so parent_message_id pointed at a UUID never seen by the client.
    """
    agent = _build_agent(THREAD + "-1", STREAM_TEXT_THEN_TOOL)
    events = await _collect(agent, _run_input(THREAD + "-1", tools=TOOLS))

    text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)
    tool_start = next(e for e in events if e.type == EventType.TOOL_CALL_START)

    # Ordering invariant: text message must close before the tool call starts.
    assert events.index(text_end) < events.index(tool_start), (
        "TEXT_MESSAGE_END must precede TOOL_CALL_START in the event stream"
    )

    assert tool_start.parent_message_id == text_end.message_id, (
        f"parent_message_id={tool_start.parent_message_id!r} should equal the "
        f"preceding TEXT_MESSAGE_END.message_id={text_end.message_id!r}, but "
        "instead points at a message that has not been emitted yet."
    )


async def test_tool_call_parent_id_is_an_already_seen_message_id():
    """parent_message_id must reference a message the client has already observed.

    Stronger framing of the same invariant — any TEXT_MESSAGE_START seen so far
    is acceptable; what's NOT acceptable is referencing an id that only ever
    appears later in the stream (or never). None is also acceptable when the
    tool call has no preceding text message (see test_tool_call_no_preceding_text).
    """
    agent = _build_agent(THREAD + "-2", STREAM_TEXT_THEN_TOOL)
    events = await _collect(agent, _run_input(THREAD + "-2", tools=TOOLS))

    seen_text_message_ids: set[str] = set()
    asserted_at_least_once = False
    for event in events:
        if event.type == EventType.TEXT_MESSAGE_START:
            seen_text_message_ids.add(event.message_id)
        elif event.type == EventType.TOOL_CALL_START:
            asserted_at_least_once = True
            # parent_message_id is Optional; None is fine, but a non-None value
            # must always reference a message the client has already started.
            if event.parent_message_id is not None:
                assert event.parent_message_id in seen_text_message_ids, (
                    f"TOOL_CALL_START.parent_message_id={event.parent_message_id!r} "
                    f"references a message that has not been started yet. Seen so "
                    f"far: {seen_text_message_ids!r}"
                )
    assert asserted_at_least_once, "No TOOL_CALL_START event was emitted"


async def test_tool_call_with_no_preceding_text_has_no_parent():
    """When the tool call comes before any text, parent_message_id must be None.

    The schema declares parent_message_id as Optional[str]. The previous code
    would set it to the upfront UUID generated when run() began — a UUID that
    was never emitted as a TEXT_MESSAGE_START to the client. Setting it to
    None is the only correct value when no parent message exists.
    """
    stream = [
        # Tool call arrives before any text streaming.
        {"current_tool_use": {"name": "frontend_tool", "toolUseId": "st-1", "input": {}}},
        {"event": {"contentBlockStop": {}}},
    ]
    agent = _build_agent(THREAD + "-no-text", stream)
    events = await _collect(agent, _run_input(THREAD + "-no-text", tools=TOOLS))

    text_starts = [e for e in events if e.type == EventType.TEXT_MESSAGE_START]
    tool_start = next(e for e in events if e.type == EventType.TOOL_CALL_START)

    assert len(text_starts) == 0, (
        f"Stream had no text data; expected 0 TEXT_MESSAGE_START events, "
        f"got {len(text_starts)}"
    )
    assert tool_start.parent_message_id is None, (
        f"With no preceding text message, parent_message_id should be None, "
        f"got {tool_start.parent_message_id!r} (a UUID the client has never seen)"
    )


async def test_back_to_back_tool_calls_share_parent_message_id():
    """Multiple tool calls after one text segment should all reference that text.

    When the LLM emits text and then two consecutive tool calls (no text between
    them), both tools were "triggered by" the same preceding text message. They
    must both have parent_message_id pointing at that text — not at phantom
    UUIDs reserved for never-emitted future text segments.
    """
    stream = [
        {"data": "Calling two tools:"},
        {"current_tool_use": {"name": "frontend_tool", "toolUseId": "st-a", "input": {}}},
        {"event": {"contentBlockStop": {}}},  # closes tool A (and ends text)
        {"current_tool_use": {"name": "frontend_tool", "toolUseId": "st-b", "input": {}}},
        {"event": {"contentBlockStop": {}}},  # closes tool B (no text in between)
    ]
    agent = _build_agent(THREAD + "-btb", stream)
    events = await _collect(agent, _run_input(THREAD + "-btb", tools=TOOLS))

    text_ends = [e for e in events if e.type == EventType.TEXT_MESSAGE_END]
    tool_starts = [e for e in events if e.type == EventType.TOOL_CALL_START]

    # Adapter must emit exactly one TEXT_MESSAGE_END for the single text segment.
    # Otherwise the assertion below would silently encode an adapter assumption.
    assert len(text_ends) == 1, f"Expected 1 TEXT_MESSAGE_END, got {len(text_ends)}"
    assert len(tool_starts) == 2, f"Expected 2 TOOL_CALL_START events, got {len(tool_starts)}"
    for tool_start in tool_starts:
        assert tool_start.parent_message_id == text_ends[0].message_id, (
            f"Both tool calls share the same triggering text message "
            f"({text_ends[0].message_id!r}); got parent_message_id="
            f"{tool_start.parent_message_id!r} for tool {tool_start.tool_call_name!r}"
        )


async def test_subsequent_text_message_does_not_reuse_parent_id():
    """The next text segment after the tool call must use a fresh message_id.

    The fix must NOT collapse the two ids together — the rotation that the
    current code performs is correct, it just happens before the wrong
    consumer reads message_id.
    """
    stream = STREAM_TEXT_THEN_TOOL + [
        {"data": "Here are the results..."},
    ]
    agent = _build_agent(THREAD + "-2", stream)
    events = await _collect(agent, _run_input(THREAD + "-2", tools=TOOLS))

    text_starts = [e for e in events if e.type == EventType.TEXT_MESSAGE_START]
    tool_start = next(e for e in events if e.type == EventType.TOOL_CALL_START)

    assert len(text_starts) == 2, f"Expected 2 TEXT_MESSAGE_START events, got {len(text_starts)}"
    first_id, second_id = text_starts[0].message_id, text_starts[1].message_id

    assert first_id != second_id, "Each text segment must have its own message_id"
    assert tool_start.parent_message_id == first_id, (
        "parent_message_id should reference the first (preceding) text message, "
        f"not the second one. first={first_id!r}, second={second_id!r}, "
        f"parent={tool_start.parent_message_id!r}"
    )
