"""Python/TypeScript adapter parity regressions."""

import pytest

from ag_ui_copilot_sdk.mapper import EventMapper


def test_p1_reused_native_id_keeps_text_separate_from_reasoning():
    mapper = EventMapper()
    events = []
    for kind, data in [
        ("assistant.reasoning_delta", {"reasoningId": "shared", "deltaContent": "Think"}),
        ("assistant.message_delta", {"messageId": "shared", "deltaContent": "Answer"}),
        ("assistant.reasoning", {"reasoningId": "shared", "content": "Think"}),
        ("assistant.message", {"messageId": "shared", "content": ""}),
    ]:
        events.extend(mapper.map_event({"type": kind, "data": data}))
    assert [e.delta for e in events if e.type == "TEXT_MESSAGE_CONTENT"] == ["Answer"]
    assert [e.delta for e in events if e.type == "REASONING_MESSAGE_CONTENT"] == ["Think"]
    assert [e.type for e in events] == [
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_END",
        "TEXT_MESSAGE_END",
    ]
    assert all(e.message_id == "shared" for e in events)
    assert mapper.finish() == []


@pytest.mark.parametrize(
    "kind", ["tool.execution_start", "external_tool.requested", "assistant.message"]
)
def test_p2_empty_tool_name_never_emits_orphan_args_or_end(kind):
    mapper = EventMapper()
    assert (
        mapper.map_event(
            {
                "type": "assistant.tool_call_delta",
                "data": {"toolCallId": "call", "inputDelta": '{"x":1}'},
            }
        )
        == []
    )
    for name in ("", "paint"):
        data = (
            {
                "messageId": "m",
                "content": "",
                "toolRequests": [{"toolCallId": "call", "name": name, "arguments": {"x": 1}}],
            }
            if kind == "assistant.message"
            else {"toolCallId": "call", "toolName": name, "arguments": {"x": 1}}
        )
        events = mapper.map_event({"type": kind, "data": data})
        if not name:
            assert events == []
            assert mapper.finish() == []
        else:
            assert [e.type for e in events] == [
                "TOOL_CALL_START",
                "TOOL_CALL_ARGS",
                "TOOL_CALL_END",
            ]
            assert events[0].tool_call_name == "paint"
            assert events[1].delta == '{"x":1}'
    assert mapper.finish() == []
