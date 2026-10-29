"""Native JSON results survive a cold resume without replaying completed results."""

from __future__ import annotations

import copy
import json

import pytest
from ag_ui.core import (
    AssistantMessage,
    CustomEvent,
    EventType,
    FunctionCall,
    ResumeEntry,
    RunAgentInput,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands import Agent, ToolContext, tool
from strands.models.model import Model
from strands.session import FileSessionManager

from ag_ui_strands import StrandsAgent, StrandsAgentConfig, ToolBehavior


@tool(context=True)
def approve_native(tool_context: ToolContext) -> dict:
    """Approve a shipment through a native interrupt."""
    answer = tool_context.interrupt("approve_native", reason="Approve shipment?")
    return {"status": "success", "content": [{"json": {"approved": answer}}]}


@tool
def calculator() -> dict:
    """Return a structured result without interrupting."""
    return {
        "status": "success",
        "content": [{"json": {"expression": "6*7", "result": 42}}],
    }


class TranscriptModel(Model):
    def __init__(self, calls=()):
        self.calls = calls

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        calls, self.calls = self.calls, ()
        yield {"messageStart": {"role": "assistant"}}
        for ident, name in calls:
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": ident, "name": name}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
        if not calls:
            yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
            yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use" if calls else "end_turn"}}


def run_input(sid, messages, resume=None):
    return RunAgentInput(
        thread_id=sid,
        run_id="run",
        messages=messages,
        resume=resume,
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )


@pytest.mark.parametrize(
    "mixed,existing_result",
    [(False, None), (True, None), (True, "same"), (True, "stale")],
)
@pytest.mark.parametrize("emit_snapshots", [False, True])
async def test_cold_native_resume_preserves_transcript(
    tmp_path, mixed, existing_result, emit_snapshots, stop_after_result=False
):
    sid = "original-native-session"
    routed_ids = []

    def manager(inp=None):
        actual = inp.thread_id if inp else sid
        routed_ids.append(actual)
        return FileSessionManager(session_id=actual, storage_dir=str(tmp_path))

    calls = ([("completed-calculator", "calculator")] if mixed else []) + [
        ("native-approval", "approve_native")
    ]
    native = Agent(
        model=TranscriptModel(calls),
        tools=[calculator, approve_native],
        session_manager=manager(),
        callback_handler=None,
    )
    paused = StrandsAgent(
        native,
        name="pause",
        config=StrandsAgentConfig(session_manager_provider=manager),
    )
    pause_events = [
        event
        async for event in paused.run(
            run_input(sid, [UserMessage(id="user", content="Approve shipment")])
        )
    ]
    interrupt_id = pause_events[-1].outcome.interrupts[0].id
    messages = [
        UserMessage(id="user", content="Approve shipment"),
        AssistantMessage(
            id="calls",
            content="",
            tool_calls=[
                ToolCall(id=ident, function=FunctionCall(name=name, arguments="{}"))
                for ident, name in calls
            ],
        ),
    ]
    if mixed and existing_result:
        messages.append(
            ToolMessage(
                id="existing-calculator",
                tool_call_id="completed-calculator",
                content=json.dumps(
                    {
                        "expression": "6*7",
                        "result": 41 if existing_result == "stale" else 42,
                    }
                ),
            )
        )
    original = copy.deepcopy(messages)
    hook_calls = []

    def state_from_result(context):
        hook_calls.append(("state", context.tool_use_id))
        return {"calculator_completed": True}

    async def custom_result_handler(context):
        hook_calls.append(("custom", context.tool_use_id))
        yield CustomEvent(
            type=EventType.CUSTOM, name="calculator_completed", value=True
        )

    adapter = StrandsAgent(
        Agent(
            model=TranscriptModel(),
            tools=[calculator, approve_native],
            callback_handler=None,
        ),
        name="resume",
        config=StrandsAgentConfig(
            session_manager_provider=manager,
            emit_messages_snapshot=emit_snapshots,
            tool_behaviors={
                "calculator": ToolBehavior(
                    stop_streaming_after_result=stop_after_result,
                    state_from_result=state_from_result,
                    custom_result_handler=custom_result_handler,
                )
            },
        ),
    )
    events = [
        event
        async for event in adapter.run(
            run_input(
                sid,
                messages,
                [
                    ResumeEntry(
                        interrupt_id=interrupt_id, status="resolved", payload=True
                    )
                ],
            )
        )
    ]
    assert not [e for e in events if e.type == EventType.RUN_ERROR]
    results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
    expected_ids = (
        ["completed-calculator"] if mixed and existing_result != "same" else []
    ) + ([] if stop_after_result else ["native-approval"])
    assert [e.tool_call_id for e in results] == expected_ids
    if not stop_after_result:
        assert json.loads(results[-1].content) == {"approved": {"response": True}}
    if emit_snapshots:
        final = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][
            -1
        ].messages
        expected_prefix = copy.deepcopy(original)
        if existing_result == "stale":
            expected_prefix[-1].content = '{"expression":"6*7","result":42}'
        assert final[: len(original)] == expected_prefix
        tool_messages = [m for m in final if m.role == "tool"]
        assert [m.tool_call_id for m in tool_messages] == (
            ["completed-calculator"] if mixed else []
        ) + ([] if stop_after_result else ["native-approval"])
        if not stop_after_result:
            assert final[-1].content == "Done."
        assert len({m.id for m in final}) == len(final)
    else:
        assert not [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
    assert hook_calls == (
        [("state", "completed-calculator"), ("custom", "completed-calculator")]
        if mixed
        else []
    )
    if mixed:
        assert any(
            e.type == EventType.STATE_SNAPSHOT
            and e.snapshot.get("calculator_completed")
            for e in events
        )
        assert any(
            e.type == EventType.CUSTOM and e.name == "calculator_completed"
            for e in events
        )
    if stop_after_result:
        assert not any(e.type == EventType.TEXT_MESSAGE_CONTENT for e in events)
    assert messages == original
    assert events[-1].outcome.type == "success"

    restored = Agent(
        model=TranscriptModel(),
        tools=[calculator, approve_native],
        session_manager=manager(),
        callback_handler=None,
    )
    assert not restored._interrupt_state.activated
    native_results = [
        b["toolResult"]
        for m in restored.messages
        for b in m["content"]
        if "toolResult" in b
    ]
    assert [r["toolUseId"] for r in native_results] == (
        ["completed-calculator"] if mixed else []
    ) + ["native-approval"]
    assert native_results[-1]["content"] == [{"json": {"approved": {"response": True}}}]
    assert set(routed_ids) == {sid}


async def test_normal_structured_tool_control():
    adapter = StrandsAgent(
        Agent(
            model=TranscriptModel([("normal-calculator", "calculator")]),
            tools=[calculator],
            callback_handler=None,
        ),
        name="control",
    )
    events = [
        e
        async for e in adapter.run(
            run_input("control", [UserMessage(id="user", content="Calculate")])
        )
    ]
    results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
    assert [e.tool_call_id for e in results] == ["normal-calculator"]
    assert json.loads(results[0].content) == {"expression": "6*7", "result": 42}
    final = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages
    assert [m.tool_call_id for m in final if m.role == "tool"] == ["normal-calculator"]


@pytest.mark.parametrize("emit_snapshots", [False, True])
async def test_matching_resume_result_still_stops_streaming(tmp_path, emit_snapshots):
    await test_cold_native_resume_preserves_transcript(
        tmp_path, True, "same", emit_snapshots, stop_after_result=True
    )
