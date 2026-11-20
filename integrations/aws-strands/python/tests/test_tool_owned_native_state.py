"""Application state a tool writes to ``agent.state`` is durable; UI state is not.

A tool that owns application data writes it through ``tool_context.agent.state``.
The SessionManager supplied by ``session_manager_provider`` persists that state
with the session, and a brand-new adapter built on the same storage restores it
next to the unchanged tool history. The adapter keeps its own bookkeeping under
separate keys and never overwrites the tool's.

The AG-UI side is transport only. A ``state_from_args`` STATE_SNAPSHOT and the
inbound ``RunAgentInput.state`` reach the client and the prompt respectively,
but neither is written into ``agent.state``.

Everything runs the real Strands ``Agent``, the real adapter run lifecycle and
real session managers over local storage. Only the model is scripted.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from strands import Agent, ToolContext, tool
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior

AGENT_ID = "todo-agent"
TODOS_KEY = "todos"

FIRST = [{"id": "a", "title": "Call Acme", "completed": False}]
SECOND = [
    {"id": "a", "title": "Call Acme", "completed": True},
    {"id": "b", "title": "Email Globex", "completed": False},
]
OTHER = [{"id": "z", "title": "Other thread item", "completed": False}]

# The tool call the model makes for each user prompt. Keyed on the prompt so a
# restored agent picks the script up wherever the stored history left it.
SCRIPT: dict[str, tuple[str, list[dict[str, Any]]]] = {
    "add a todo": ("save_todos", FIRST),
    "complete it and add another": ("save_todos", SECOND),
    "add the other todo": ("save_todos", OTHER),
    "show the todos": ("announce_todos", SECOND),
}

_HAS_SNAPSHOT_SESSIONS = (
    importlib.util.find_spec("strands.session.snapshot_session_manager") is not None
)


@tool(name="save_todos", description="Replace the todo list", context=True)
def _save_todos(todos: list, tool_context: ToolContext) -> str:
    tool_context.agent.state.set(TODOS_KEY, todos)
    return f"saved {len(todos)}"


@tool(name="announce_todos", description="Show todos without storing them")
def _announce_todos(todos: list) -> str:
    return f"showing {len(todos)}"


def _todos_from_args(context) -> dict[str, Any]:
    tool_input = context.tool_input
    if isinstance(tool_input, str):
        tool_input = json.loads(tool_input)
    return {TODOS_KEY: tool_input[TODOS_KEY]}


class _ScriptedModel(Model):
    """Calls the scripted tool for a new prompt, then answers in words."""

    def __init__(self) -> None:
        self.calls = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):  # pragma: no cover
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        texts = [block["text"] for block in messages[-1]["content"] if "text" in block]
        scripted = SCRIPT.get(texts[-1]) if texts else None
        yield {"messageStart": {"role": "assistant"}}
        if scripted is not None:
            name, todos = scripted
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {"toolUseId": f"call-{self.calls}", "name": name}
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": json.dumps({TODOS_KEY: todos})}}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def _file_manager(root: Path, thread_id: str):
    return FileSessionManager(session_id=thread_id, storage_dir=str(root))


def _snapshot_manager(root: Path, thread_id: str):
    from strands.session.snapshot_session_manager import SnapshotSessionManager
    from strands.storage import LocalFileStorage

    return SnapshotSessionManager(session_id=thread_id, storage=LocalFileStorage(str(root)))


@pytest.fixture(
    params=[
        pytest.param(_file_manager, id="file"),
        pytest.param(
            _snapshot_manager,
            id="snapshot",
            marks=pytest.mark.skipif(
                not _HAS_SNAPSHOT_SESSIONS,
                reason="SnapshotSessionManager ships in newer strands-agents releases",
            ),
        ),
    ]
)
def make_manager(request):
    return request.param


def _adapter(make_manager, root: Path) -> StrandsAgent:
    return StrandsAgent(
        Agent(
            model=_ScriptedModel(),
            callback_handler=None,
            agent_id=AGENT_ID,
            tools=[_save_todos, _announce_todos],
        ),
        name="tool-owned-state",
        config=StrandsAgentConfig(
            session_manager_provider=lambda input_data: make_manager(
                root, input_data.thread_id
            ),
            tool_behaviors={
                "save_todos": ToolBehavior(state_from_args=_todos_from_args),
                "announce_todos": ToolBehavior(state_from_args=_todos_from_args),
            },
        ),
    )


def _input(thread_id: str, run_id: str, prompt: str, state=None) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state=state or {},
        messages=[UserMessage(id=f"u-{run_id}", content=prompt)],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _run(adapter: StrandsAgent, input_data: RunAgentInput) -> list[Any]:
    events = [event async for event in adapter.run(input_data)]
    assert [e for e in events if e.type == EventType.RUN_ERROR] == [], events
    return events


def _restore(make_manager, root: Path, thread_id: str) -> Agent:
    """A plain Strands agent rebuilt from storage, with no adapter involved."""
    return Agent(
        model=_ScriptedModel(),
        callback_handler=None,
        agent_id=AGENT_ID,
        session_manager=make_manager(root, thread_id),
    )


def _without_tracking_ids(messages) -> list[dict[str, Any]]:
    return [
        {key: value for key, value in message.items() if key != "tracking_id"}
        for message in messages
    ]


def _tool_blocks(messages, kind: str) -> list[dict[str, Any]]:
    return [
        block[kind]
        for message in messages
        for block in message.get("content", [])
        if kind in block
    ]


def _state_snapshots(events) -> list[Any]:
    return [e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT]


@pytest.mark.asyncio
async def test_tool_written_state_survives_a_fresh_adapter_on_the_same_storage(
    tmp_path, make_manager
):
    adapter = _adapter(make_manager, tmp_path)
    await _run(adapter, _input("thread-1", "run-1", "add a todo"))
    live = adapter._agents_by_thread["thread-1"]
    assert live.state.get(TODOS_KEY) == FIRST
    # The adapter's own bookkeeping sits beside the tool's key, not over it.
    assert live.state.get("agui_context") == []
    history = _without_tracking_ids(live.messages)

    restored = _restore(make_manager, tmp_path, "thread-1")
    assert restored.state.get(TODOS_KEY) == FIRST
    assert _without_tracking_ids(restored.messages) == history
    [tool_use] = _tool_blocks(restored.messages, "toolUse")
    [tool_result] = _tool_blocks(restored.messages, "toolResult")
    assert tool_use["name"] == "save_todos"
    assert tool_use["input"] == {TODOS_KEY: FIRST}
    assert tool_result["toolUseId"] == tool_use["toolUseId"]
    assert tool_result["content"] == [{"text": "saved 1"}]

    fresh = _adapter(make_manager, tmp_path)
    await _run(fresh, _input("thread-1", "run-2", "anything new?"))
    reloaded = fresh._agents_by_thread["thread-1"]
    assert reloaded.state.get(TODOS_KEY) == FIRST
    assert _without_tracking_ids(reloaded.messages)[: len(history)] == history


@pytest.mark.asyncio
async def test_only_the_latest_tool_write_is_restored(tmp_path, make_manager):
    adapter = _adapter(make_manager, tmp_path)
    await _run(adapter, _input("thread-1", "run-1", "add a todo"))
    events = await _run(
        adapter, _input("thread-1", "run-2", "complete it and add another")
    )
    assert {TODOS_KEY: SECOND} in _state_snapshots(events)

    restored = _restore(make_manager, tmp_path, "thread-1")
    assert restored.state.get(TODOS_KEY) == SECOND
    uses = _tool_blocks(restored.messages, "toolUse")
    results = _tool_blocks(restored.messages, "toolResult")
    assert [use["input"] for use in uses] == [{TODOS_KEY: FIRST}, {TODOS_KEY: SECOND}]
    assert [r["toolUseId"] for r in results] == [u["toolUseId"] for u in uses]
    assert [r["content"] for r in results] == [
        [{"text": "saved 1"}],
        [{"text": "saved 2"}],
    ]


@pytest.mark.asyncio
async def test_each_thread_restores_only_its_own_tool_state(tmp_path, make_manager):
    adapter = _adapter(make_manager, tmp_path)
    await _run(adapter, _input("thread-1", "run-1", "add a todo"))
    await _run(adapter, _input("thread-2", "run-2", "add the other todo"))
    await _run(adapter, _input("thread-3", "run-3", "anything new?"))

    assert _restore(make_manager, tmp_path, "thread-1").state.get(TODOS_KEY) == FIRST
    assert _restore(make_manager, tmp_path, "thread-2").state.get(TODOS_KEY) == OTHER
    assert _restore(make_manager, tmp_path, "thread-3").state.get(TODOS_KEY) is None


@pytest.mark.asyncio
async def test_ag_ui_state_alone_never_reaches_agent_state(tmp_path, make_manager):
    ui_state = {TODOS_KEY: [{"id": "ui", "title": "Edited in the UI"}]}
    adapter = _adapter(make_manager, tmp_path)

    events = await _run(
        adapter, _input("thread-1", "run-1", "show the todos", state=ui_state)
    )

    # The snapshot does go to the client ...
    assert {TODOS_KEY: SECOND} in _state_snapshots(events)
    # ... but neither it nor the inbound UI state is written to native state.
    live = adapter._agents_by_thread["thread-1"]
    assert live.state.get(TODOS_KEY) is None
    restored = _restore(make_manager, tmp_path, "thread-1")
    assert restored.state.get(TODOS_KEY) is None
    assert [use["name"] for use in _tool_blocks(restored.messages, "toolUse")] == [
        "announce_todos"
    ]
