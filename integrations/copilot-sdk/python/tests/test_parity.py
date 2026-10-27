"""Python/TypeScript adapter parity regressions."""

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
