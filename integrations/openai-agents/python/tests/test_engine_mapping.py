"""
Tests for OpenAIToAGUITranslator's streaming event mapping.

The rest of the suite pins ids (test_snapshot) and the wire strings
(test_stream_types_drift); this one pins the actual translation: feed the
engine the SDK stream events a real run emits — raw Responses deltas,
run-item commits, agent-updated signals — and assert the exact AG-UI event
sequence it yields. No network, no model; just the mapping.

Events are driven through ``translate`` (the tier-1 dispatcher ``to_agui``
calls per event), so raw dispatch, family dispatch, and the per-type methods
are all on the path. Raw deltas are duck-typed SimpleNamespaces (the engine
reads them via ``read_attr``, exactly as it does the real payloads); run
items use the SDK's own item classes so the isinstance dispatch is real.
"""

from __future__ import annotations

from types import SimpleNamespace

from agents import (
    Agent,
    HandoffCallItem,
    HandoffOutputItem,
    MCPApprovalRequestItem,
)
from agents.items import ToolCallOutputItem
from openai.types.responses import ResponseFunctionToolCall
from openai.types.responses.response_output_item import McpApprovalRequest

from ag_ui.core import EventType
from ag_ui_openai_agents.engine import OpenAIToAGUITranslator
from ag_ui_openai_agents.engine.stream_types import (
    RawResponseEventType,
    OpenAIItemType,
    OpenAIStreamEventType,
)

_AGENT = Agent(name="test-agent")


# ── event builders — shaped like the SDK's real stream events ────────────


def _raw(kind: RawResponseEventType, **data) -> SimpleNamespace:
    """A RawResponsesStreamEvent wrapping one Responses payload."""
    return SimpleNamespace(
        type=OpenAIStreamEventType.RAW_RESPONSE,
        data=SimpleNamespace(type=kind, **data),
    )


def _added(item_type: OpenAIItemType, output_index: int = 0, **item) -> SimpleNamespace:
    return _raw(
        RawResponseEventType.OUTPUT_ITEM_ADDED,
        item=SimpleNamespace(type=item_type, **item),
        output_index=output_index,
    )


def _done(item_type: OpenAIItemType, output_index: int = 0, **item) -> SimpleNamespace:
    return _raw(
        RawResponseEventType.OUTPUT_ITEM_DONE,
        item=SimpleNamespace(type=item_type, **item),
        output_index=output_index,
    )


def _run_item(item) -> SimpleNamespace:
    return SimpleNamespace(type=OpenAIStreamEventType.RUN_ITEM, name="x", item=item)


def _agent_updated(name: str) -> SimpleNamespace:
    return SimpleNamespace(
        type=OpenAIStreamEventType.AGENT_UPDATED,
        new_agent=SimpleNamespace(name=name),
    )


def _drive(engine: OpenAIToAGUITranslator, *events) -> list:
    out: list = []
    for event in events:
        out.extend(engine.translate(event))
    return out


def _types(events) -> list[EventType]:
    return [e.type for e in events]


# ── text streaming ───────────────────────────────────────────────────────


def test_text_streams_start_content_end_under_one_id():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(RawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="Hel"),
        _raw(RawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="lo"),
        _done(OpenAIItemType.MESSAGE, id="msg_1"),
    )
    assert _types(events) == [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ]
    ids = {e.message_id for e in events}
    assert ids == {"msg_1"}, "the whole window must carry the real item id"
    assert events[0].role == "assistant"
    assert [e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT] == [
        "Hel",
        "lo",
    ]


def test_text_delta_lazily_opens_window_without_output_item_added():
    # Some backends jump straight to deltas with no output_item.added first.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(RawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="hi"),
    )
    assert _types(events) == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]


def test_text_done_closes_window_when_output_item_done_is_skipped():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(RawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="hi"),
        _raw(RawResponseEventType.TEXT_DONE, item_id="msg_1", output_index=0),
    )
    assert _types(events)[-1] == EventType.TEXT_MESSAGE_END


def test_refusal_delta_streams_into_the_text_window():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(RawResponseEventType.REFUSAL_DELTA, item_id="msg_1", output_index=0, delta="no"),
    )
    assert _types(events) == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]
    assert events[1].delta == "no"


def test_text_less_message_item_wrapping_a_tool_call_emits_no_window():
    # Some backends can announce a message item even on a pure tool-call turn
    # that never carries text: an
    # output_item.added(message), the whole tool call, then
    # output_item.done(message) — with no text delta in between. The message
    # window must never open, so the tool call stays a clean sibling and no
    # empty TEXT_MESSAGE_START/END brackets it on the wire.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, output_index=0, id="msg_1"),
        _added(
            OpenAIItemType.FUNCTION_CALL,
            output_index=1,
            id="fc_1",
            call_id="call_1",
            name="change_background",
        ),
        _raw(
            RawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=1,
            delta='{"background":"red"}',
        ),
        _done(
            OpenAIItemType.FUNCTION_CALL,
            output_index=1,
            id="fc_1",
            call_id="call_1",
            name="change_background",
        ),
        _done(OpenAIItemType.MESSAGE, output_index=0, id="msg_1"),
    )
    assert _types(events) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert EventType.TEXT_MESSAGE_START not in _types(events)
    assert EventType.TEXT_MESSAGE_END not in _types(events)


# ── tool-call streaming ──────────────────────────────────────────────────


def test_function_call_streams_start_args_end_under_the_call_id():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.FUNCTION_CALL, id="fc_1", call_id="call_1", name="get_weather"),
        _raw(
            RawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=0,
            delta='{"city":',
        ),
        _raw(
            RawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=0,
            delta='"Cairo"}',
        ),
        _done(OpenAIItemType.FUNCTION_CALL, id="fc_1", call_id="call_1", name="get_weather"),
    )
    assert _types(events) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert {e.tool_call_id for e in events} == {"call_1"}
    assert events[0].tool_call_name == "get_weather"
    assert "".join(e.delta for e in events if e.type == EventType.TOOL_CALL_ARGS) == (
        '{"city":"Cairo"}'
    )


def test_function_call_args_delta_lazily_opens_the_call():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(
            RawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=0,
            delta="{}",
        ),
    )
    assert _types(events) == [EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS]


def test_tool_output_item_emits_tool_call_result():
    engine = OpenAIToAGUITranslator()
    item = ToolCallOutputItem(
        agent=_AGENT,
        raw_item={"type": "function_call_output", "call_id": "call_1", "output": "sunny"},
        output="sunny",
    )
    events = _drive(engine, _run_item(item))
    assert _types(events) == [EventType.TOOL_CALL_RESULT]
    assert events[0].tool_call_id == "call_1"
    assert events[0].content == "sunny"


# ── reasoning streaming ──────────────────────────────────────────────────


def test_reasoning_summary_delta_opens_phase_and_part():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(
            RawResponseEventType.REASONING_SUMMARY_DELTA,
            item_id="rs_1",
            output_index=0,
            delta="thinking",
        ),
        _raw(RawResponseEventType.REASONING_SUMMARY_PART_DONE, item_id="rs_1", output_index=0),
    )
    assert _types(events) == [
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
    ]
    assert events[2].delta == "thinking"
    # The phase stays open until finalize (only the part closed above).
    assert _types(engine.finalize()) == [EventType.REASONING_END]


def test_reasoning_auto_closes_when_text_output_starts():
    # Once real output begins, any open reasoning must be closed first —
    # reasoning must never bleed into the answer window.
    engine = OpenAIToAGUITranslator()
    _drive(
        engine,
        _raw(
            RawResponseEventType.REASONING_TEXT_DELTA,
            item_id="rs_1",
            output_index=0,
            delta="hmm",
        ),
    )
    # output_item.added closes reasoning right away (output has begun), but
    # holds back TEXT_MESSAGE_START — that waits for a real delta so a
    # text-less item can't emit an empty window.
    events = _drive(engine, _added(OpenAIItemType.MESSAGE, id="msg_1"))
    assert _types(events) == [
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
    ]
    events = _drive(
        engine,
        _raw(RawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="ok"),
    )
    assert _types(events) == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]
    assert events[0].message_id == "msg_1", "deferred START must carry the reserved id"


# ── multi-agent steps ────────────────────────────────────────────────────


def test_agent_updated_opens_a_step_finalize_closes_it():
    engine = OpenAIToAGUITranslator()
    events = _drive(engine, _agent_updated("triage_agent"))
    assert _types(events) == [EventType.STEP_STARTED]
    assert events[0].step_name == "triage_agent"
    closing = engine.finalize()
    assert _types(closing) == [EventType.STEP_FINISHED]
    assert closing[0].step_name == "triage_agent"


def test_handoff_pairs_step_finished_with_the_next_step_started():
    engine = OpenAIToAGUITranslator()
    _drive(engine, _agent_updated("triage_agent"))
    events = _drive(engine, _agent_updated("billing_agent"))
    assert _types(events) == [EventType.STEP_FINISHED, EventType.STEP_STARTED]
    assert events[0].step_name == "triage_agent"
    assert events[1].step_name == "billing_agent"


# ── handoff items (surface as a tool call + result) ──────────────────────


def test_handoff_call_and_output_items_map_to_tool_call_and_result():
    engine = OpenAIToAGUITranslator()
    call = HandoffCallItem(
        agent=_AGENT,
        raw_item=ResponseFunctionToolCall(
            id="fc_h",
            type="function_call",
            call_id="call_h",
            name="transfer_to_billing",
            arguments="{}",
        ),
    )
    output = HandoffOutputItem(
        agent=_AGENT,
        raw_item={"type": "function_call_output", "call_id": "call_h", "output": "done"},
        source_agent=_AGENT,
        target_agent=Agent(name="billing_agent"),
    )
    call_events = _drive(engine, _run_item(call))
    assert _types(call_events) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert {e.tool_call_id for e in call_events} == {"call_h"}
    assert call_events[0].tool_call_name == "transfer_to_billing"

    result_events = _drive(engine, _run_item(output))
    assert _types(result_events) == [EventType.TOOL_CALL_RESULT]
    assert result_events[0].tool_call_id == "call_h"
    assert result_events[0].content == "done"


# ── MCP approval → CUSTOM (no native AG-UI shape yet) ────────────────────


def test_mcp_approval_request_maps_to_a_custom_event():
    engine = OpenAIToAGUITranslator()
    item = MCPApprovalRequestItem(
        agent=_AGENT,
        raw_item=McpApprovalRequest(
            id="mcpr_1",
            type="mcp_approval_request",
            name="do_it",
            arguments="{}",
            server_label="srv",
        ),
    )
    events = _drive(engine, _run_item(item))
    assert _types(events) == [EventType.CUSTOM]
    assert events[0].name == "mcp_approval_request"
    assert events[0].value["name"] == "do_it"


# ── graceful degradation ─────────────────────────────────────────────────


def test_unknown_stream_event_type_translates_to_nothing():
    engine = OpenAIToAGUITranslator()
    assert engine.translate(SimpleNamespace(type="something_new", data=None)) == []
