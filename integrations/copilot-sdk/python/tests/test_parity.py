"""Python/TypeScript adapter parity regressions."""

import pytest
from test_agent import FRONTEND_TOOL_TURN, FakeClient, collect, make_input
from test_lifecycle import TOOLS

from ag_ui_copilot_sdk import CopilotAgent
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


@pytest.mark.parametrize("overridden", ["tools", "on_event"])
async def test_p3_session_options_cannot_replace_adapter_wiring(overridden):
    client = FakeClient(FRONTEND_TOOL_TURN)
    agent = CopilotAgent(
        client,
        session_options={
            "model": "caller-model",
            overridden: [] if overridden == "tools" else lambda event: None,
        },
        run_timeout=0.1,
    )
    events = await collect(agent, make_input(tools=TOOLS))
    try:
        assert [tool.name for tool in client.options["tools"]] == ["change_background"]
        assert events[-1].type == "RUN_FINISHED", events[-1]
        assert client.options["model"] == "caller-model"
        assert "call-1" in agent._threads["t1"].pending
    finally:
        await agent.close()


def test_p6_tool_result_only_after_start():
    mapper = EventMapper()

    def types(*events):
        return [e.type for event in events for e in mapper.map_event(event)]

    def done(call_id):
        return {
            "type": "tool.execution_complete",
            "data": {"toolCallId": call_id, "success": True, "result": {"content": "r"}},
        }

    def start(call_id, name):
        return {
            "type": "tool.execution_start",
            "data": {"toolCallId": call_id, "toolName": name, "arguments": {}},
        }

    assert types(done("unknown")) == []
    assert types(start("nameless", ""), done("nameless")) == []
    assert types(start("named", "paint"), done("named")) == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
    ]
