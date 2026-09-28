"""Frontend tool answers reconciled into a snapshot-persisted session.

A client-executed tool leaves a ``Forwarded to client`` placeholder in the
native history, and the real answer only arrives on the next run. With a
``SnapshotSessionManager`` that answer has to replace the placeholder under the
same ``toolUseId``, land in ``snapshot_latest``, and come back on a fresh
restore, exactly as it does for the repository-backed ``FileSessionManager``.

Everything here runs the real Strands ``Agent``, the real adapter run lifecycle
and the real snapshot manager over local storage. Only the model is scripted.
"""

from __future__ import annotations

import copy
import importlib.metadata
import json
from pathlib import Path
from typing import Any, Iterable

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    ResumeEntry,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands import Agent, ToolContext, tool
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.client_proxy_tool import PROXY_RESULT_PLACEHOLDER
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands.interrupt_checkpoint import parked_tool_results
from ag_ui_strands.session_reconcile import AG_UI_FRONTEND_CALL_IDS_STATE_KEY

snapshot_module = pytest.importorskip(
    "strands.session.snapshot_session_manager",
    reason="SnapshotSessionManager ships in newer strands-agents releases",
)
storage_module = pytest.importorskip("strands.storage")

SnapshotSessionManager = snapshot_module.SnapshotSessionManager


def _sdk_saves_a_halted_turn_before_the_run_ends() -> bool:
    """Whether the installed Strands closes its run loop when a stream closes.

    A frontend-tool halt closes ``stream_async`` early. Only from 1.55.0 does
    that close the SDK's inner run loop too; before it, the loop's
    ``AfterInvocationEvent`` (a snapshot session's only save) runs whenever the
    event loop finalizes the orphan, after RUN_FINISHED. No public symbol marks
    the change, so the release number is the probe.
    """
    parts = importlib.metadata.version("strands-agents").split(".")[:2]
    return tuple(int(part) for part in parts) >= (1, 55)


_needs_halted_turn_saved = pytest.mark.skipif(
    not _sdk_saves_a_halted_turn_before_the_run_ends(),
    reason=(
        "strands-agents < 1.55 writes a halted turn's snapshot only when the "
        "abandoned run loop is finalized, after RUN_FINISHED, so an immediate "
        "restore finds nothing of that turn to reconcile"
    ),
)

THREAD = "snapshot-thread"
AGENT_ID = "snapshot-agent"
LOOKUP_ANSWER = "backend fact"


@tool(name="lookup", description="A server-side tool")
def _lookup() -> str:
    return LOOKUP_ANSWER


@tool(name="server_approval", description="Approve server work", context=True)
def _server_approval(tool_context: ToolContext) -> str:
    response = tool_context.interrupt("server_approval", reason={"question": "ok?"})
    return f"server response: {response!r}"


def _frontend(name: str) -> Tool:
    return Tool(name=name, description=name, parameters={"type": "object"})


FRONTEND_TOOLS = [_frontend("get_weather"), _frontend("get_time")]

# The tool calls the model makes for each user prompt. Keyed on the prompt so a
# restarted process picks the script up where the stored history left it.
SCRIPT: dict[str, list[tuple[str, str]]] = {
    "look it up": [("backend-1", "lookup")],
    "weather?": [("native-w", "get_weather")],
    "both?": [("native-0", "get_weather"), ("native-1", "get_time")],
    "twice?": [("native-a", "get_weather"), ("native-b", "get_weather")],
    "mixed?": [("native-client", "get_weather"), ("native-server", "server_approval")],
}


class _ScriptedModel(Model):
    """Calls the scripted tools for a new prompt, then answers in words."""

    def __init__(self) -> None:
        self.seen: list[list[dict[str, Any]]] = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):  # pragma: no cover
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.seen.append(copy.deepcopy(messages))
        last = messages[-1]
        texts = [block["text"] for block in last["content"] if "text" in block]
        calls = SCRIPT.get(texts[-1], []) if texts else []
        yield {"messageStart": {"role": "assistant"}}
        if calls:
            for tool_use_id, name in calls:
                yield {
                    "contentBlockStart": {
                        "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
                    }
                }
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
                yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _FailingSnapshotManager(SnapshotSessionManager):
    """Refuses the first save that would persist a given answer."""

    def __init__(self, *args: Any, fail_on: str, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.fail_on = fail_on
        self.failures = 0

    async def save_snapshot(self, agent, *, is_latest):
        if self.failures == 0 and any(
            _result_text(result) == self.fail_on
            for result in _all_results(agent)
        ):
            self.failures += 1
            raise RuntimeError("snapshot storage unavailable")
        return await super().save_snapshot(agent, is_latest=is_latest)


class _RecordingSnapshotManager(SnapshotSessionManager):
    """Records what each ``snapshot_latest`` write carried."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.saves: list[dict[str, Any]] = []

    async def save_snapshot(self, agent, *, is_latest):
        self.saves.append(
            {
                "results": {
                    result["toolUseId"]: _result_text(result)
                    for result in _all_results(agent)
                },
                "call_ids": agent.state.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY),
            }
        )
        return await super().save_snapshot(agent, is_latest=is_latest)


def _snapshot_manager(path: Path) -> SnapshotSessionManager:
    return SnapshotSessionManager(
        session_id=THREAD, storage=storage_module.LocalFileStorage(str(path))
    )


def _file_manager(path: Path) -> FileSessionManager:
    return FileSessionManager(session_id=THREAD, storage_dir=str(path))


def _adapter(manager_factory, *, waiting: bool = False, tools=()):
    model = _ScriptedModel()
    behaviors = (
        {t.name: ToolBehavior(continue_after_frontend_call=False) for t in FRONTEND_TOOLS}
        if waiting
        else {}
    )
    adapter = StrandsAgent(
        Agent(
            model=model,
            callback_handler=None,
            agent_id=AGENT_ID,
            tools=[_lookup, _server_approval, *tools],
        ),
        name="snapshot-reconcile",
        config=StrandsAgentConfig(
            session_manager_provider=lambda _input: manager_factory(),
            tool_behaviors=behaviors,
        ),
    )
    return adapter, model


def _input(run_id: str, messages: Iterable[Any], resume=None) -> RunAgentInput:
    return RunAgentInput(
        thread_id=THREAD,
        run_id=run_id,
        state={},
        messages=list(messages),
        tools=FRONTEND_TOOLS,
        context=[],
        forwarded_props={},
        resume=resume,
    )


async def _run(adapter: StrandsAgent, input_data: RunAgentInput) -> list[Any]:
    events = [event async for event in adapter.run(input_data)]
    assert [e for e in events if e.type == EventType.RUN_ERROR] == [], events
    return events


def _calls(*pairs: tuple[str, str]) -> AssistantMessage:
    return AssistantMessage(
        id=f"a-{pairs[0][0]}",
        tool_calls=[
            ToolCall(id=call_id, function=FunctionCall(name=name, arguments="{}"))
            for call_id, name in pairs
        ],
    )


def _all_results(agent: Any) -> list[dict[str, Any]]:
    results = _results(agent.messages)
    state = getattr(agent, "_interrupt_state", None)
    if state is not None and state.activated:
        results.extend(parked_tool_results(state) or [])
    return results


def _results(messages: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        block["toolResult"]
        for message in messages
        for block in message.get("content", [])
        if "toolResult" in block
    ]


def _results_by_id(messages) -> dict[str, dict[str, Any]]:
    return {result["toolUseId"]: result for result in _results(messages)}


def _result_text(result: dict[str, Any]) -> str:
    return "".join(block.get("text", "") for block in result.get("content", []))


def _texts(messages) -> list[str]:
    return [
        block["text"]
        for message in messages
        for block in message.get("content", [])
        if "text" in block
    ]


def _without_tracking_ids(messages) -> list[dict[str, Any]]:
    """Messages minus the per-process ids newer SDKs stamp on each one."""
    return [
        {key: value for key, value in message.items() if key != "tracking_id"}
        for message in messages
    ]


def _disk_snapshot(path: Path) -> dict[str, Any]:
    [latest] = list(path.rglob("snapshot_latest.json"))
    return json.loads(latest.read_text())["data"]


def _restore(path: Path) -> tuple[Agent, _ScriptedModel]:
    model = _ScriptedModel()
    agent = Agent(
        model=model,
        callback_handler=None,
        agent_id=AGENT_ID,
        session_manager=_snapshot_manager(path),
    )
    return agent, model


def _expected(tool_use_id: str, text: str, is_error: bool = False) -> dict[str, Any]:
    return {
        "toolUseId": tool_use_id,
        "status": "error" if is_error else "success",
        "content": [{"text": text}],
    }


def _assert_no_synthetic_answer(messages, *answers: str) -> None:
    for text in _texts(messages):
        assert "returned:" not in text, text
        assert "failed:" not in text, text
        for answer in answers:
            assert answer not in text, text


async def _history_then_frontend_call(adapter: StrandsAgent) -> list[Any]:
    """An earlier backend-tool turn, then a turn that calls a frontend tool."""
    first = [UserMessage(id="u1", content="look it up")]
    await _run(adapter, _input("run-1", first))
    history = [
        *first,
        _calls(("backend-1", "lookup")),
        ToolMessage(id="t-backend", tool_call_id="backend-1", content=LOOKUP_ANSWER),
        AssistantMessage(id="a-done", content="done"),
        UserMessage(id="u2", content="weather?"),
    ]
    await _run(adapter, _input("run-2", history))
    return [*history, _calls(("native-w", "get_weather"))]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "restart",
    [
        pytest.param(False, id="same-process"),
        pytest.param(True, id="restarted", marks=_needs_halted_turn_saved),
    ],
)
@pytest.mark.parametrize(
    ("answer", "error"),
    [("sunny, 22C", None), ("weather service down", "lookup failed")],
    ids=["success", "error"],
)
async def test_a_frontend_answer_replaces_the_placeholder_in_memory_on_disk_and_on_restore(
    tmp_path, answer, error, restart
):
    adapter, model = _adapter(lambda: _snapshot_manager(tmp_path))
    history = await _history_then_frontend_call(adapter)
    before = copy.deepcopy(adapter._agents_by_thread[THREAD].messages)
    assert _results_by_id(before)["native-w"]["content"] == [
        {"text": PROXY_RESULT_PLACEHOLDER}
    ]
    if restart:
        adapter, model = _adapter(lambda: _snapshot_manager(tmp_path))

    await _run(
        adapter,
        _input(
            "run-3",
            [
                *history,
                ToolMessage(
                    id="t-w", tool_call_id="native-w", content=answer, error=error
                ),
            ],
        ),
    )

    expected = _expected("native-w", answer, is_error=error is not None)
    live = adapter._agents_by_thread[THREAD]
    assert _results_by_id(live.messages)["native-w"] == expected
    # The model continued from the corrected result, not from a stub.
    assert _results_by_id(model.seen[-1])["native-w"] == expected
    assert model.seen[-1][-1]["content"] == [{"toolResult": expected}]

    disk = _disk_snapshot(tmp_path)
    assert _results_by_id(disk["messages"])["native-w"] == expected
    assert disk["messages"] == live.messages
    assert AG_UI_FRONTEND_CALL_IDS_STATE_KEY not in disk["state"] or (
        "native-w" not in disk["state"][AG_UI_FRONTEND_CALL_IDS_STATE_KEY]
    )

    restored, restored_model = _restore(tmp_path)
    assert restored.messages == live.messages
    assert _results_by_id(restored.messages)["native-w"] == expected
    assert restored_model.seen == []


@pytest.mark.asyncio
async def test_unrelated_history_is_left_exactly_as_it_was(tmp_path):
    adapter, _ = _adapter(lambda: _snapshot_manager(tmp_path))
    history = await _history_then_frontend_call(adapter)
    before = copy.deepcopy(adapter._agents_by_thread[THREAD].messages)

    await _run(
        adapter,
        _input(
            "run-3",
            [*history, ToolMessage(id="t-w", tool_call_id="native-w", content="sunny")],
        ),
    )

    after = adapter._agents_by_thread[THREAD].messages
    # Every message that existed before is unchanged except the corrected block.
    for index, message in enumerate(before):
        if any(
            block.get("toolResult", {}).get("toolUseId") == "native-w"
            for block in message["content"]
        ):
            assert after[index] == {
                **message,
                "content": [{"toolResult": _expected("native-w", "sunny")}],
            }
        else:
            assert after[index] == message
    assert _results_by_id(after)["backend-1"] == _expected("backend-1", LOOKUP_ANSWER)
    restored, _ = _restore(tmp_path)
    assert restored.messages[: len(before) - 1] == before[:-1]
    assert _results_by_id(restored.messages)["backend-1"] == _expected(
        "backend-1", LOOKUP_ANSWER
    )


@pytest.mark.asyncio
async def test_each_answer_lands_on_its_own_call_when_one_tool_is_called_twice(
    tmp_path,
):
    adapter, model = _adapter(lambda: _snapshot_manager(tmp_path))
    ask = [UserMessage(id="u1", content="twice?")]
    await _run(adapter, _input("run-1", ask))

    # Answered in the opposite order to the calls: only the id may match them.
    await _run(
        adapter,
        _input(
            "run-2",
            [
                *ask,
                _calls(("native-a", "get_weather"), ("native-b", "get_weather")),
                ToolMessage(id="t-b", tool_call_id="native-b", content="answer for b"),
                ToolMessage(id="t-a", tool_call_id="native-a", content="answer for a"),
            ],
        ),
    )

    expected = {
        "native-a": _expected("native-a", "answer for a"),
        "native-b": _expected("native-b", "answer for b"),
    }
    live = adapter._agents_by_thread[THREAD]
    assert _results_by_id(live.messages) == expected
    assert _results_by_id(model.seen[-1]) == expected
    assert _results_by_id(_disk_snapshot(tmp_path)["messages"]) == expected
    restored, _ = _restore(tmp_path)
    assert _results_by_id(restored.messages) == expected


@_needs_halted_turn_saved
@pytest.mark.asyncio
async def test_several_answers_in_one_continuation_are_all_persisted(tmp_path):
    adapter, _ = _adapter(lambda: _snapshot_manager(tmp_path))
    ask = [UserMessage(id="u1", content="both?")]
    await _run(adapter, _input("run-1", ask))
    adapter, model = _adapter(lambda: _snapshot_manager(tmp_path))

    await _run(
        adapter,
        _input(
            "run-2",
            [
                *ask,
                _calls(("native-0", "get_weather"), ("native-1", "get_time")),
                ToolMessage(id="t-0", tool_call_id="native-0", content="sunny"),
                ToolMessage(
                    id="t-1", tool_call_id="native-1", content="clock broke", error="x"
                ),
            ],
        ),
    )

    expected = {
        "native-0": _expected("native-0", "sunny"),
        "native-1": _expected("native-1", "clock broke", is_error=True),
    }
    live = adapter._agents_by_thread[THREAD]
    assert _results_by_id(live.messages) == expected
    assert _results_by_id(model.seen[-1]) == expected
    disk = _disk_snapshot(tmp_path)
    assert _results_by_id(disk["messages"]) == expected
    assert disk["state"].get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, []) == []
    restored, _ = _restore(tmp_path)
    assert _results_by_id(restored.messages) == expected

    # A later ordinary turn re-saves the whole agent and keeps the correction.
    adapter, _ = _adapter(lambda: _snapshot_manager(tmp_path))
    await _run(adapter, _input("run-3", [UserMessage(id="u3", content="thanks")]))
    assert _results_by_id(_disk_snapshot(tmp_path)["messages"]) == expected
    assert _texts(_disk_snapshot(tmp_path)["messages"])[-2:] == ["thanks", "done"]


@pytest.mark.asyncio
async def test_snapshot_and_file_sessions_end_with_the_same_history(tmp_path):
    """No synthetic ``returned:`` prompt when the correction landed, as on files."""
    histories = {}
    seen = {}
    for kind, factory in (
        ("file", lambda: _file_manager(tmp_path / "file")),
        ("snapshot", lambda: _snapshot_manager(tmp_path / "snapshot")),
    ):
        adapter, model = _adapter(factory)
        ask = [UserMessage(id="u1", content="both?")]
        await _run(adapter, _input("run-1", ask))
        await _run(
            adapter,
            _input(
                "run-2",
                [
                    *ask,
                    _calls(("native-0", "get_weather"), ("native-1", "get_time")),
                    ToolMessage(id="t-0", tool_call_id="native-0", content="sunny"),
                    ToolMessage(
                        id="t-1", tool_call_id="native-1", content="12:00", error="x"
                    ),
                ],
            ),
        )
        histories[kind] = adapter._agents_by_thread[THREAD].messages
        seen[kind] = model.seen[-1]

    assert _without_tracking_ids(histories["snapshot"]) == _without_tracking_ids(
        histories["file"]
    )
    assert _without_tracking_ids(seen["snapshot"]) == _without_tracking_ids(
        seen["file"]
    )
    _assert_no_synthetic_answer(histories["snapshot"], "sunny", "12:00")
    restored, _ = _restore(tmp_path / "snapshot")
    assert restored.messages == histories["snapshot"]
    _assert_no_synthetic_answer(restored.messages, "sunny", "12:00")


@pytest.mark.asyncio
async def test_a_waiting_frontend_tool_still_resolves_through_the_native_interrupt(
    tmp_path,
):
    adapter, _ = _adapter(lambda: _snapshot_manager(tmp_path), waiting=True)
    ask = [UserMessage(id="u1", content="weather?")]
    await _run(adapter, _input("run-1", ask))
    # The wait is a native checkpoint, not a proxy placeholder.
    assert adapter._agents_by_thread[THREAD]._interrupt_state.activated
    assert PROXY_RESULT_PLACEHOLDER not in json.dumps(_disk_snapshot(tmp_path))
    adapter, model = _adapter(lambda: _snapshot_manager(tmp_path), waiting=True)

    await _run(
        adapter,
        _input(
            "run-2",
            [
                *ask,
                _calls(("native-w", "get_weather")),
                ToolMessage(id="t-w", tool_call_id="native-w", content="sunny"),
            ],
        ),
    )

    expected = {"native-w": _expected("native-w", "sunny")}
    live = adapter._agents_by_thread[THREAD]
    assert _results_by_id(live.messages) == expected
    assert _results_by_id(model.seen[-1]) == expected
    restored, _ = _restore(tmp_path)
    assert _results_by_id(restored.messages) == expected
    _assert_no_synthetic_answer(restored.messages, "sunny")


def _mixed_resume(events: list[Any]) -> list[ResumeEntry]:
    [finished] = [e for e in events if e.type == EventType.RUN_FINISHED]
    assert finished.outcome.type == "interrupt"
    return [
        ResumeEntry(interrupt_id=interrupt.id, status="resolved", payload=True)
        for interrupt in finished.outcome.interrupts
    ]


def _mixed_answer(ask) -> list[Any]:
    return [
        *ask,
        _calls(("native-client", "get_weather"), ("native-server", "server_approval")),
        ToolMessage(id="t-client", tool_call_id="native-client", content="from client"),
    ]


@pytest.mark.asyncio
async def test_a_parked_proxy_placeholder_is_corrected_when_a_native_interrupt_resumes(
    tmp_path,
):
    adapter, _ = _adapter(lambda: _snapshot_manager(tmp_path))
    ask = [UserMessage(id="u1", content="mixed?")]
    resume = _mixed_resume(await _run(adapter, _input("run-1", ask)))
    adapter, model = _adapter(lambda: _snapshot_manager(tmp_path))

    await _run(adapter, _input("run-2", _mixed_answer(ask), resume=resume))

    live = adapter._agents_by_thread[THREAD]
    assert _results_by_id(live.messages)["native-client"] == _expected(
        "native-client", "from client"
    )
    assert _results_by_id(model.seen[-1])["native-client"] == _expected(
        "native-client", "from client"
    )
    restored, _ = _restore(tmp_path)
    assert restored.messages == live.messages


@pytest.mark.asyncio
async def test_a_failed_save_rolls_back_and_degrades_like_the_repository_path(
    tmp_path,
):
    manager = _FailingSnapshotManager(
        session_id=THREAD,
        storage=storage_module.LocalFileStorage(str(tmp_path)),
        fail_on="sunny",
    )
    adapter, model = _adapter(lambda: manager)
    history = await _history_then_frontend_call(adapter)

    await _run(
        adapter,
        _input(
            "run-3",
            [*history, ToolMessage(id="t-w", tool_call_id="native-w", content="sunny")],
        ),
    )

    assert manager.failures == 1
    live = adapter._agents_by_thread[THREAD]
    # Nothing unsaved is left claiming the call was answered, the id stays
    # recorded for a retry, and the answer reaches the model as a prompt.
    assert _results_by_id(live.messages)["native-w"]["content"] == [
        {"text": PROXY_RESULT_PLACEHOLDER}
    ]
    assert live.state.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY) == ["native-w"]
    assert _results_by_id(model.seen[-1])["native-w"]["content"] == [
        {"text": PROXY_RESULT_PLACEHOLDER}
    ]
    assert any("sunny" in text for text in _texts(model.seen[-1][-1:]))
    restored, _ = _restore(tmp_path)
    assert restored.messages == live.messages


@pytest.mark.asyncio
async def test_a_failed_save_refuses_the_resume_and_leaves_it_retryable(tmp_path):
    managers: list[_FailingSnapshotManager] = []

    def factory():
        manager = _FailingSnapshotManager(
            session_id=THREAD,
            storage=storage_module.LocalFileStorage(str(tmp_path)),
            fail_on="from client",
        )
        managers.append(manager)
        return manager

    adapter, _ = _adapter(factory)
    ask = [UserMessage(id="u1", content="mixed?")]
    resume = _mixed_resume(await _run(adapter, _input("run-1", ask)))
    core = adapter._agents_by_thread[THREAD]
    parked_before = copy.deepcopy(parked_tool_results(core._interrupt_state))

    rejected = [
        event
        async for event in adapter.run(
            _input("run-2", _mixed_answer(ask), resume=resume)
        )
    ]

    [error] = [e for e in rejected if e.type == EventType.RUN_ERROR]
    assert error.code == "INTERRUPT_RECONCILIATION_ERROR"
    assert managers[-1].failures == 1
    assert core._interrupt_state.activated
    assert parked_tool_results(core._interrupt_state) == parked_before

    await _run(adapter, _input("run-3", _mixed_answer(ask), resume=resume))
    assert _results_by_id(core.messages)["native-client"] == _expected(
        "native-client", "from client"
    )
    restored, _ = _restore(tmp_path)
    assert restored.messages == core.messages


async def _answer_weather(adapter: StrandsAgent, ask) -> None:
    await _run(
        adapter,
        _input(
            "run-2",
            [
                *ask,
                _calls(("native-w", "get_weather")),
                ToolMessage(id="t-w", tool_call_id="native-w", content="sunny"),
            ],
        ),
    )


@pytest.mark.asyncio
async def test_the_save_carries_the_call_ids_already_pruned(tmp_path):
    manager = _RecordingSnapshotManager(
        session_id=THREAD, storage=storage_module.LocalFileStorage(str(tmp_path))
    )
    adapter, _ = _adapter(lambda: manager)
    ask = [UserMessage(id="u1", content="weather?")]
    await _run(adapter, _input("run-1", ask))
    live = adapter._agents_by_thread[THREAD]
    assert "native-w" in live.state.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY)
    manager.saves.clear()

    await _answer_weather(adapter, ask)

    # The first write that carries the answer is the reconciliation's own.
    answered = [s for s in manager.saves if s["results"].get("native-w") == "sunny"]
    assert answered and manager.saves[0] is answered[0]
    assert "native-w" not in (answered[0]["call_ids"] or [])


@pytest.mark.asyncio
async def test_a_trigger_only_session_is_not_written_mid_turn(tmp_path):
    fire = {"now": False}
    manager = _RecordingSnapshotManager(
        session_id=THREAD,
        storage=storage_module.LocalFileStorage(str(tmp_path)),
        save_latest_on="trigger",
        snapshot_trigger=lambda **_kwargs: fire["now"],
    )
    adapter, model = _adapter(lambda: manager)
    ask = [UserMessage(id="u1", content="weather?")]
    await _run(adapter, _input("run-1", ask))

    await _answer_weather(adapter, ask)

    # Corrected where the run reads it, and written nowhere.
    live = adapter._agents_by_thread[THREAD]
    assert _results_by_id(live.messages)["native-w"] == _expected("native-w", "sunny")
    assert _results_by_id(model.seen[-1])["native-w"] == _expected("native-w", "sunny")
    assert manager.saves == []
    assert list(tmp_path.rglob("snapshot_latest.json")) == []

    # The user's own trigger then persists it with everything else.
    fire["now"] = True
    await _run(adapter, _input("run-3", [UserMessage(id="u3", content="thanks")]))
    disk = _disk_snapshot(tmp_path)
    assert _results_by_id(disk["messages"])["native-w"] == _expected("native-w", "sunny")
    assert "native-w" not in disk["state"].get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, [])
