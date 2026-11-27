"""Background-task results reach the client.

Strands' Background Tasks hands a finished task back by appending a tool use
and its result to the conversation, a ``get`` on the task under the task's own
id, immediately before the model call that reads them. Neither block is
streamed. Before this was handled the client never saw the result, and the
model's answers on either side of it ran together into one message.

The SDK floor predates Background Tasks, so the delivery is written into the
conversation here by a hook, in the shape the SDK writes it. The harness suite
drives the real thing.
"""

from __future__ import annotations

import pytest
from ag_ui.core import EventType, UserMessage
from strands import Agent, tool
from strands.hooks import BeforeModelCallEvent

from ag_ui_strands.agent import StrandsAgent, _background_task_deliveries
from tests.scripted_model import ScriptedModel, collect, has_tool_result, run_input

TASK_ID = "task-1"


def _delivery(task_id: str = TASK_ID, text: str = "the report") -> list[dict]:
    return [
        {
            "role": "assistant",
            "content": [
                {
                    "toolUse": {
                        "name": "strands_manage_background_task",
                        "toolUseId": task_id,
                        "input": {"mode": "get", "task_id": task_id},
                    }
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "toolResult": {
                        "toolUseId": task_id,
                        "status": "success",
                        "content": [{"text": text}],
                    }
                }
            ],
        },
    ]


class _Agent:
    def __init__(self, messages):
        self.messages = messages


def _ids(found) -> list[str]:
    return [tool_use["toolUseId"] for tool_use, _ in found]


def test_a_delivery_at_the_end_of_the_conversation_is_found():
    agent = _Agent([{"role": "user", "content": [{"text": "go"}]}, *_delivery()])

    ((tool_use, tool_result),) = _background_task_deliveries(agent, set())

    assert tool_use["toolUseId"] == TASK_ID
    assert tool_result["content"] == [{"text": "the report"}]


def test_a_delivery_merged_into_the_models_last_turn_is_found():
    """After the model has spoken, the SDK appends to that turn, not a new one."""
    use, result = _delivery()
    spoken = {"role": "assistant", "content": [{"text": "working on it"}, *use["content"]]}
    agent = _Agent([{"role": "user", "content": [{"text": "go"}]}, spoken, result])

    assert _ids(_background_task_deliveries(agent, set())) == [TASK_ID]


def test_several_deliveries_come_back_oldest_first():
    agent = _Agent([*_delivery("a"), *_delivery("b")])

    assert _ids(_background_task_deliveries(agent, set())) == ["a", "b"]


def test_an_announced_delivery_is_not_found_again():
    agent = _Agent([*_delivery("a"), *_delivery("b")])

    assert _ids(_background_task_deliveries(agent, {"a"})) == ["b"]


def test_nothing_older_than_the_persons_turn_is_read():
    agent = _Agent([*_delivery("old"), {"role": "user", "content": [{"text": "next"}]}])

    assert _background_task_deliveries(agent, set()) == []


def test_an_ordinary_call_to_the_manage_tool_is_not_a_delivery():
    """The model polling a task streams like any call; only the SDK's own
    write carries the task's id as its tool use id."""
    polled = {
        "role": "assistant",
        "content": [
            {
                "toolUse": {
                    "name": "strands_manage_background_task",
                    "toolUseId": "call-9",
                    "input": {"mode": "get", "task_id": TASK_ID},
                }
            }
        ],
    }
    result = {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "call-9", "status": "success", "content": []}}],
    }

    assert _background_task_deliveries(_Agent([polled, result]), set()) == []


@tool
def dispatch(task: str) -> str:
    """Start a task in the background."""
    return f"dispatched {task}"


class _DeliverBeforeSecondCall:
    """Writes the delivery where the SDK does: ahead of the call that reads it."""

    def register_hooks(self, registry, **_kwargs) -> None:
        registry.add_callback(BeforeModelCallEvent, self._deliver)

    def _deliver(self, event) -> None:
        messages = event.agent.messages
        delivered = any(
            block.get("toolUse", {}).get("toolUseId") == TASK_ID
            for message in messages
            for block in message["content"]
        )
        if has_tool_result(messages) and not delivered:
            messages.extend(_delivery())


def _adapter() -> tuple[StrandsAgent, ScriptedModel]:
    def script(model, messages):
        if not has_tool_result(messages):
            return ("dispatch", {"task": "report"})
        return f"answer {model.calls}"

    model = ScriptedModel(script)
    adapter = StrandsAgent(
        agent=Agent(model=model, tools=[dispatch], callback_handler=None),
        name="background",
        hooks=[_DeliverBeforeSecondCall()],
    )
    return adapter, model


@pytest.mark.asyncio
async def test_a_delivery_is_announced_as_a_tool_call_with_its_result():
    adapter, _ = _adapter()

    events = await collect(adapter, run_input())

    trace = [
        (event.type.value, getattr(event, "tool_call_id", None))
        for event in events
        if event.type.value.startswith(("TOOL_CALL", "TEXT_MESSAGE_START"))
    ]
    assert trace == [
        ("TOOL_CALL_START", "call-1"),
        ("TOOL_CALL_ARGS", "call-1"),
        ("TOOL_CALL_END", "call-1"),
        ("TOOL_CALL_RESULT", "call-1"),
        ("TOOL_CALL_START", TASK_ID),
        ("TOOL_CALL_ARGS", TASK_ID),
        ("TOOL_CALL_END", TASK_ID),
        ("TOOL_CALL_RESULT", TASK_ID),
        # The answer that read the result comes after it.
        ("TEXT_MESSAGE_START", None),
    ]
    (start,) = [
        e for e in events if e.type == EventType.TOOL_CALL_START and e.tool_call_id == TASK_ID
    ]
    assert start.tool_call_name == "strands_manage_background_task"
    (result,) = [
        e for e in events if e.type == EventType.TOOL_CALL_RESULT and e.tool_call_id == TASK_ID
    ]
    assert "the report" in result.content
    assert events[-1].outcome.type == "success"


@pytest.mark.asyncio
async def test_the_snapshot_holds_the_delivery_between_the_turns_around_it():
    adapter, _ = _adapter()

    events = await collect(adapter, run_input())

    snapshot = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages
    shape = [
        (m.role, [c.id for c in m.tool_calls] if getattr(m, "tool_calls", None) else None)
        for m in snapshot
    ]
    assert shape == [
        ("user", None),
        ("assistant", ["call-1"]),
        ("tool", None),
        ("assistant", [TASK_ID]),
        ("tool", None),
        ("assistant", None),
    ]
    assert snapshot[4].tool_call_id == TASK_ID
    assert len({m.id for m in snapshot}) == len(snapshot)


@pytest.mark.asyncio
async def test_the_next_turn_runs_on_the_history_the_client_sends_back():
    adapter, model = _adapter()
    first = await collect(adapter, run_input())
    snapshot = [e for e in first if e.type == EventType.MESSAGES_SNAPSHOT][-1].messages

    second = await collect(
        adapter,
        run_input(run_id="r2", messages=[*snapshot, UserMessage(id="u2", content="and then?")]),
    )

    assert second[-1].type == EventType.RUN_FINISHED
    assert second[-1].outcome.type == "success"
    # The model still holds the delivered result on the next turn.
    seen = str(model.seen_messages[-1])
    assert "the report" in seen and "and then?" in seen


def test_a_note_injected_beside_the_result_does_not_hide_the_delivery():
    """A context injector writes into the latest user turn before the model is
    called, and after a delivery that turn is the delivery's result."""
    use, result = _delivery()
    result["content"].append({"injected": {"text": "<system-reminder>todos</system-reminder>"}})
    agent = _Agent([{"role": "user", "content": [{"text": "go"}]}, use, result])

    assert _ids(_background_task_deliveries(agent, set())) == [TASK_ID]
