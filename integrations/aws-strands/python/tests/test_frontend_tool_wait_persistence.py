"""Durability and restart coverage for adapter-owned frontend waits."""

from __future__ import annotations

import asyncio
import copy
import threading
from collections.abc import Sequence
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

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
from strands import Agent
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager
from strands.tools.tools import PythonAgentTool

from ag_ui_strands.agent import (
    StrandsAgent,
    _frontend_wait_consumption_is_durable,
    _has_unrecoverable_frontend_wait_result,
    _is_native_interrupt_state,
    _sync_session_state,
    _load_persisted_interrupt_bookkeeping,
    _persist_interrupt_bookkeeping,
    _recover_disjoint_checkpoint_after_consumed_wait,
)
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands.frontend_tool_wait import (
    FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
    FRONTEND_TOOL_WAIT_STATE_KEY,
    FrontendToolWaitBatch,
    FrontendToolWaitCall,
    load_frontend_tool_wait,
)
from ag_ui_strands.session_reconcile import (
    AG_UI_TOOL_CALL_MAP_STATE_KEY,
    AG_UI_WIRE_MAP_STATE_KEY,
)


class _PersistenceModel(Model):
    """Emit one deterministic frontend batch, then one final text turn."""

    def __init__(self, tool_names: Sequence[str] = ("lookup",)) -> None:
        self.tool_names = tuple(tool_names)
        self.calls = 0
        self.seen_messages: list[list[dict[str, Any]]] = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(
        self, output_model, prompt, **kwargs
    ):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls == 1:
            for index, name in enumerate(self.tool_names):
                yield {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": f"native-{index}",
                                "name": name,
                            }
                        }
                    }
                }
                yield {
                    "contentBlockDelta": {
                        "delta": {"toolUse": {"input": '{"value":"requested"}'}}
                    }
                }
                yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _WaitThenServerInterruptModel(_PersistenceModel):
    """Wait on the client first, then reach a server interrupt on resume."""

    def __init__(
        self,
        first_tool_name: str = "lookup",
        second_tool_name: str = "approve_server",
    ) -> None:
        super().__init__()
        self.call_tool_names = (first_tool_name, second_tool_name)

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls <= 2:
            tool_name = self.call_tool_names[self.calls - 1]
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": f"native-{self.calls}",
                            "name": tool_name,
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": '{"value":"requested"}'}}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _CombinedThenServerInterruptModel(_PersistenceModel):
    """Resume one mixed checkpoint into a superseding server checkpoint."""

    def __init__(
        self,
        second_tool_name: str | Sequence[str] = "approve_new",
    ) -> None:
        super().__init__()
        self.second_tool_names = (
            (second_tool_name,)
            if isinstance(second_tool_name, str)
            else tuple(second_tool_name)
        )

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        names = (
            ("lookup", "approve_old")
            if self.calls == 1
            else (self.second_tool_names if self.calls == 2 else ())
        )
        if names:
            for index, name in enumerate(names):
                yield {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "toolUseId": f"native-{self.calls}-{index}",
                                "name": name,
                            }
                        }
                    }
                }
                yield {
                    "contentBlockDelta": {
                        "delta": {"toolUse": {"input": '{"value":"requested"}'}}
                    }
                }
                yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _WaitThenNewWaitModel(_PersistenceModel):
    """Reach a second frontend wait immediately after the first resumes."""

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls <= 2:
            tool_name = "first_lookup" if self.calls == 1 else "second_lookup"
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": f"native-{self.calls}",
                            "name": tool_name,
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": '{"value":"requested"}'}}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _WaitThenRepeatSameToolModel(_PersistenceModel):
    """Call one frontend tool before and after its parked call resumes."""

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen_messages.append(copy.deepcopy(messages))
        yield {"messageStart": {"role": "assistant"}}
        if self.calls <= 2:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": f"native-repeat-{self.calls}",
                            "name": "lookup",
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {"toolUse": {"input": '{"value":"requested"}'}}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": "continued"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


class _FailingWaitSyncManager(FileSessionManager):
    def __init__(
        self,
        *,
        session_id: str,
        storage_dir: str,
        fail_when: str,
        failure_limit: int | None = None,
        failure_counter: dict[str, int] | None = None,
    ) -> None:
        super().__init__(session_id=session_id, storage_dir=storage_dir)
        self.fail_when = fail_when
        self.failure_limit = failure_limit
        self.failure_counter = (
            failure_counter if failure_counter is not None else {"count": 0}
        )
        self.wait_sync_snapshots: list[dict[str, Any]] = []

    def sync_agent(self, agent: Any) -> None:
        raw = agent.state.get(FRONTEND_TOOL_WAIT_STATE_KEY)
        if isinstance(raw, dict):
            self.wait_sync_snapshots.append(copy.deepcopy(raw))
            calls = raw.get("calls", [])
            has_staged = any(
                isinstance(call, dict) and call.get("has_response") is True
                for call in calls
            )
            is_complete = bool(calls) and all(
                isinstance(call, dict) and call.get("has_response") is True
                for call in calls
            )
            has_unanswered_handoff = any(
                isinstance(call, dict)
                and call.get("has_response") is False
                and call.get("end_handed_off") is True
                for call in calls
            )
            is_consumed = not calls and bool(raw.get("last_completed_wire_ids"))
            should_fail = (
                self.fail_when == "initial"
                or (self.fail_when == "staged" and has_staged and not is_complete)
                or (self.fail_when == "complete" and is_complete)
                or (self.fail_when == "handoff" and has_unanswered_handoff)
                or (self.fail_when == "consume" and is_consumed)
            )
            if should_fail and (
                self.failure_limit is None
                or self.failure_counter["count"] < self.failure_limit
            ):
                self.failure_counter["count"] += 1
                raise RuntimeError(f"{self.fail_when} frontend wait sync failed")
        super().sync_agent(agent)


class _FailingBookkeepingSyncManager(FileSessionManager):
    def __init__(
        self,
        *,
        session_id: str,
        storage_dir: str,
        failure_counter: dict[str, int],
    ) -> None:
        super().__init__(session_id=session_id, storage_dir=storage_dir)
        self.failure_counter = failure_counter

    def sync_agent(self, agent: Any) -> None:
        raw = agent.state.get("ag_ui_interrupt_bookkeeping")
        pending = raw.get("pending_interrupts") if isinstance(raw, dict) else None
        if pending and self.failure_counter["count"] == 0:
            self.failure_counter["count"] += 1
            raise RuntimeError("interrupt bookkeeping sync failed")
        super().sync_agent(agent)


class _FailingRecoverySyncManager(FileSessionManager):
    def __init__(
        self,
        *,
        session_id: str,
        storage_dir: str,
        failure_counter: dict[str, int],
    ) -> None:
        super().__init__(session_id=session_id, storage_dir=storage_dir)
        self.failure_counter = failure_counter

    def sync_agent(self, agent: Any) -> None:
        wait = load_frontend_tool_wait(agent.state)
        bookkeeping = agent.state.get("ag_ui_interrupt_bookkeeping")
        pending = (
            bookkeeping.get("pending_interrupts")
            if isinstance(bookkeeping, dict)
            else None
        )
        if (
            not wait.calls
            and wait.last_completed_wire_ids
            and pending
            and self.failure_counter["count"] == 0
        ):
            self.failure_counter["count"] += 1
            raise RuntimeError("atomic recovery sync failed")
        super().sync_agent(agent)


class _FailingSupersedingWaitSyncManager(FileSessionManager):
    def __init__(
        self,
        *,
        session_id: str,
        storage_dir: str,
        failure_counter: dict[str, int],
    ) -> None:
        super().__init__(session_id=session_id, storage_dir=storage_dir)
        self.failure_counter = failure_counter

    def sync_agent(self, agent: Any) -> None:
        wait = load_frontend_tool_wait(agent.state)
        if (
            any(call.native_tool_use_id.startswith("native-2") for call in wait.calls)
            and self.failure_counter["count"] == 0
        ):
            self.failure_counter["count"] += 1
            raise RuntimeError("superseding frontend wait sync failed")
        super().sync_agent(agent)


def _tool(name: str) -> Tool:
    return Tool(
        name=name,
        description=f"Client tool {name}",
        parameters={
            "type": "object",
            "properties": {"value": {"type": "string"}},
        },
    )


def _input(
    thread_id: str,
    tools: Sequence[Tool],
    *,
    run_id: str,
    messages: Sequence[Any],
    resume: Sequence[ResumeEntry] | None = None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=list(messages),
        tools=list(tools),
        context=[],
        forwarded_props={},
        resume=list(resume) if resume is not None else None,
    )


def _adapter(
    model: Model,
    tools: Sequence[Tool],
    storage_dir: Path | None,
    thread_id: str,
    *,
    agent_id: str = "stable-agent",
    manager_type: type[FileSessionManager] = FileSessionManager,
    manager_kwargs: dict[str, Any] | None = None,
    core_tools: Sequence[Any] = (),
    tool_behaviors: dict[str, ToolBehavior] | None = None,
    emit_messages_snapshot: bool = True,
) -> StrandsAgent:
    async def provider(_input_data: RunAgentInput):
        if storage_dir is None:
            return None
        return manager_type(
            session_id=thread_id,
            storage_dir=str(storage_dir),
            **(manager_kwargs or {}),
        )

    return StrandsAgent(
        Agent(model=model, tools=list(core_tools), agent_id=agent_id),
        name="persistence-test",
        config=StrandsAgentConfig(
            session_manager_provider=provider if storage_dir is not None else None,
            tool_behaviors=tool_behaviors or {},
            emit_messages_snapshot=emit_messages_snapshot,
        ),
    )


def _backend_tool(
    name: str,
    calls: list[str] | None = None,
) -> PythonAgentTool:
    def execute(tool_use: dict[str, Any], **_kwargs: Any) -> dict[str, Any]:
        if calls is not None:
            calls.append(tool_use["toolUseId"])
        return {
            "toolUseId": tool_use["toolUseId"],
            "status": "success",
            "content": [{"text": "server-result"}],
        }

    execute.__name__ = name
    return PythonAgentTool(
        tool_name=name,
        tool_spec={
            "name": name,
            "description": name,
            "inputSchema": {"json": {}},
        },
        tool_func=execute,
    )


async def _collect(adapter: StrandsAgent, input_data: RunAgentInput) -> list[Any]:
    return [event async for event in adapter.run(input_data)]


def _types(events: Sequence[Any]) -> list[EventType]:
    return [event.type for event in events]


def _wire_ids(events: Sequence[Any]) -> list[str]:
    return [
        event.tool_call_id
        for event in events
        if event.type == EventType.TOOL_CALL_START
    ]


def _end_ids(events: Sequence[Any]) -> list[str]:
    return [
        event.tool_call_id for event in events if event.type == EventType.TOOL_CALL_END
    ]


def _restored_core(
    model: Model,
    storage_dir: Path,
    thread_id: str,
    *,
    agent_id: str = "stable-agent",
) -> Agent:
    return Agent(
        model=model,
        tools=[],
        agent_id=agent_id,
        session_manager=FileSessionManager(
            session_id=thread_id,
            storage_dir=str(storage_dir),
        ),
    )


async def _start_combined_checkpoint(
    model: Model,
    tools: Sequence[Tool],
    storage_dir: Path,
    thread_id: str,
    *,
    core_tools: Sequence[Any],
    tool_behaviors: dict[str, ToolBehavior],
) -> tuple[str, Any, list[ResumeEntry], ToolMessage]:
    events = await _collect(
        _adapter(
            model,
            tools,
            storage_dir,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=tool_behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="start")],
        ),
    )
    wire_id = next(
        event.tool_call_id
        for event in events
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == "lookup"
    )
    [server_interrupt] = next(
        event for event in events if event.type == EventType.RUN_FINISHED
    ).outcome.interrupts
    resume = [
        ResumeEntry(
            interrupt_id=server_interrupt.id,
            status="resolved",
            payload={"approved": True},
        )
    ]
    result = ToolMessage(
        id="lookup-result",
        tool_call_id=wire_id,
        content="exact",
    )
    return wire_id, server_interrupt, resume, result


def _guard_rejects(
    messages: Sequence[Any],
    *,
    tools: Sequence[Tool] = (),
    behaviors: dict[str, ToolBehavior] | None = None,
    wire_map: Any = None,
    tool_meta: Any = None,
    restored_messages: Sequence[dict[str, Any]] = (),
    core_tools: Sequence[Any] = (),
    tombstones: Sequence[str] = (),
) -> bool:
    core = Agent(model=_PersistenceModel(), tools=list(core_tools))
    core.messages = copy.deepcopy(list(restored_messages))
    if wire_map is not None:
        core.state.set(AG_UI_WIRE_MAP_STATE_KEY, wire_map)
    if tool_meta is not None:
        core.state.set(AG_UI_TOOL_CALL_MAP_STATE_KEY, tool_meta)
    return _has_unrecoverable_frontend_wait_result(
        _input(
            "guard-thread",
            tools,
            run_id="guard-run",
            messages=messages,
        ),
        core,
        FrontendToolWaitBatch(last_completed_wire_ids=tombstones),
        behaviors or {},
    )


@pytest.mark.parametrize("history_shape", ["orphan", "wrong-role", "older-match"])
def test_consumption_proof_rejects_noncanonical_native_result_history(
    history_shape: str,
):
    native_id = "native"
    exact_result = {
        "toolResult": {
            "toolUseId": native_id,
            "status": "success",
            "content": [{"text": "exact"}],
        }
    }
    tool_use = {
        "toolUse": {
            "toolUseId": native_id,
            "name": "lookup",
            "input": {},
        }
    }
    if history_shape == "orphan":
        messages = [{"role": "user", "content": [exact_result]}]
    elif history_shape == "wrong-role":
        messages = [
            {"role": "assistant", "content": [tool_use]},
            {"role": "assistant", "content": [exact_result]},
        ]
    else:
        messages = [
            {"role": "assistant", "content": [tool_use]},
            {"role": "user", "content": [exact_result]},
            {"role": "assistant", "content": [tool_use]},
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": native_id,
                            "status": "success",
                            "content": [{"text": "different"}],
                        }
                    }
                ],
            },
        ]
    core = Agent(model=_PersistenceModel(), tools=[])
    core.messages = messages
    core._interrupt_state = SimpleNamespace(activated=False, interrupts={})
    core.state.set(AG_UI_WIRE_MAP_STATE_KEY, {"wire": native_id})
    core.state.set(
        AG_UI_TOOL_CALL_MAP_STATE_KEY,
        {
            native_id: {
                "strands_tool_id": native_id,
                "is_proxy": True,
                "continue_after_frontend_call": False,
            }
        },
    )
    batch = FrontendToolWaitBatch(
        calls=[
            FrontendToolWaitCall(
                interrupt_id="interrupt",
                native_tool_use_id=native_id,
                wire_tool_call_id="wire",
                content="exact",
                has_response=True,
                end_handed_off=True,
            )
        ]
    )

    assert not _frontend_wait_consumption_is_durable(core, batch)


@pytest.mark.asyncio
async def test_strict_bookkeeping_requires_writable_agent_state():
    with pytest.raises(RuntimeError, match="not writable"):
        await _persist_interrupt_bookkeeping(
            SimpleNamespace(state=SimpleNamespace()),
            {},
            None,
            strict=True,
        )


def test_recovered_hidden_checkpoint_uses_persisted_wire_order():
    core = Agent(model=_PersistenceModel(), tools=[])
    core.state.set(
        AG_UI_WIRE_MAP_STATE_KEY,
        {"wire-1": "native-1", "wire-2": "native-2"},
    )
    core.state.set(
        AG_UI_TOOL_CALL_MAP_STATE_KEY,
        {
            native_id: {
                "strands_tool_id": native_id,
                "name": f"lookup-{index}",
                "is_proxy": True,
                "continue_after_frontend_call": False,
            }
            for index, native_id in enumerate(("native-1", "native-2"), 1)
        },
    )
    reversed_interrupts = {
        "interrupt-2": SimpleNamespace(
            id="interrupt-2",
            name=FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
            reason={
                "name": FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
                "native_tool_use_id": "native-2",
            },
        ),
        "interrupt-1": SimpleNamespace(
            id="interrupt-1",
            name=FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
            reason={
                "name": FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
                "native_tool_use_id": "native-1",
            },
        ),
    }
    old_batch = FrontendToolWaitBatch(
        calls=[
            FrontendToolWaitCall(
                interrupt_id="old-interrupt",
                native_tool_use_id="old-native",
                wire_tool_call_id="old-wire",
                content="exact",
                has_response=True,
                end_handed_off=True,
            )
        ]
    )

    recovered, visible = _recover_disjoint_checkpoint_after_consumed_wait(
        core,
        reversed_interrupts,
        old_batch,
        [],
    )

    assert visible == []
    assert recovered is not None
    assert [call.wire_tool_call_id for call in recovered.calls] == [
        "wire-1",
        "wire-2",
    ]


@pytest.mark.parametrize(
    ("wire_map", "tool_meta", "restored_messages", "tombstones"),
    [
        (None, None, (), ("wire",)),
        (
            {"wire": "native"},
            {
                "native": {
                    "strands_tool_id": "native",
                    "is_proxy": True,
                    "continue_after_frontend_call": True,
                }
            },
            (),
            (),
        ),
        ({"wire": "native"}, None, (), ()),
        (
            {"wire": "native"},
            {
                "native": {
                    "name": "client",
                    "args": "{}",
                    "strands_tool_id": "native",
                }
            },
            (),
            (),
        ),
        (
            None,
            None,
            (
                {
                    "role": "assistant",
                    "content": [
                        {
                            "toolUse": {
                                "toolUseId": "wire",
                                "name": "restored_native",
                            }
                        }
                    ],
                },
            ),
            (),
        ),
    ],
    ids=[
        "tombstone",
        "explicit-true-map",
        "legacy-map-only",
        "legacy-metadata-without-mode",
        "restored-native",
    ],
)
def test_unrecoverable_guard_accepts_approved_persisted_provenance(
    wire_map: Any,
    tool_meta: Any,
    restored_messages: Sequence[dict[str, Any]],
    tombstones: Sequence[str],
):
    assert not _guard_rejects(
        [ToolMessage(id="result", tool_call_id="wire", content="ok")],
        wire_map=wire_map,
        tool_meta=tool_meta,
        restored_messages=restored_messages,
        tombstones=tombstones,
    )


def test_unrecoverable_guard_accepts_full_history_native_or_explicit_continuation():
    native_history = [
        AssistantMessage(
            id="assistant-native",
            content="",
            tool_calls=[
                ToolCall(
                    id="native-wire",
                    function=FunctionCall(name="backend", arguments="{}"),
                )
            ],
        ),
        ToolMessage(id="native-result", tool_call_id="native-wire", content="ok"),
    ]
    assert not _guard_rejects(
        native_history,
        core_tools=[_backend_tool("backend")],
    )

    continuation_history = [
        AssistantMessage(
            id="assistant-continuation",
            content="",
            tool_calls=[
                ToolCall(
                    id="continuation-wire",
                    function=FunctionCall(name="client", arguments="{}"),
                )
            ],
        ),
        ToolMessage(
            id="continuation-result",
            tool_call_id="continuation-wire",
            content="ok",
        ),
    ]
    assert not _guard_rejects(
        continuation_history,
        behaviors={"client": ToolBehavior(continue_after_frontend_call=True)},
    )


@pytest.mark.parametrize(
    ("wire_map", "tool_meta", "restored_messages"),
    [
        (
            {"wire": "native"},
            {
                "native": {
                    "strands_tool_id": "native",
                    "is_proxy": True,
                    "continue_after_frontend_call": False,
                }
            },
            (),
        ),
        (
            {"wire": "native"},
            {
                "native": {
                    "strands_tool_id": "native",
                    "continue_after_frontend_call": True,
                }
            },
            (),
        ),
        ({"wire": "native"}, {"native": "malformed"}, ()),
        (
            {"wire": "native"},
            {
                "native": {
                    "strands_tool_id": "other",
                    "is_proxy": True,
                    "continue_after_frontend_call": True,
                }
            },
            (),
        ),
        (
            None,
            {
                "wire": {
                    "strands_tool_id": "wire",
                    "is_proxy": True,
                    "continue_after_frontend_call": False,
                }
            },
            (
                {
                    "role": "assistant",
                    "content": [{"toolUse": {"toolUseId": "wire", "name": "client"}}],
                },
            ),
        ),
        (
            None,
            None,
            (
                {
                    "role": "user",
                    "content": [
                        {"toolUse": {"toolUseId": "wire", "name": "not-native"}}
                    ],
                },
            ),
        ),
    ],
    ids=[
        "explicit-false",
        "partial-explicit",
        "non-mapping-explicit",
        "mismatched-native-id",
        "direct-false-overrides-restored",
        "non-assistant-restored-id",
    ],
)
def test_unrecoverable_guard_rejects_invalid_or_negative_metadata(
    wire_map: Any,
    tool_meta: Any,
    restored_messages: Sequence[dict[str, Any]],
):
    assert _guard_rejects(
        [ToolMessage(id="result", tool_call_id="wire", content="ok")],
        wire_map=wire_map,
        tool_meta=tool_meta,
        restored_messages=restored_messages,
    )


def test_unrecoverable_guard_rejects_declared_true_or_name_only_opaque_result():
    opaque = [ToolMessage(id="result", tool_call_id="wire", content="ok")]
    assert _guard_rejects(
        opaque,
        tools=[_tool("client")],
        behaviors={"client": ToolBehavior(continue_after_frontend_call=True)},
    )
    assert _guard_rejects(
        opaque,
        tools=[_tool("client")],
        restored_messages=[
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "native", "name": "client"}}],
            },
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "native",
                            "status": "success",
                            "content": [{"text": "Forwarded to client"}],
                        }
                    }
                ],
            },
        ],
    )


def test_unrecoverable_guard_rejects_empty_trailing_tool_call_id():
    malformed = ToolMessage.model_construct(
        id="result",
        role="tool",
        tool_call_id="",
        content="ok",
    )
    assert _guard_rejects([malformed])


@pytest.mark.asyncio
async def test_hidden_wait_is_durable_before_normal_run_finished(tmp_path: Path):
    thread_id = "initial-durable"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    adapter = _adapter(model, tools, tmp_path, thread_id)

    events = await _collect(
        adapter,
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )

    assert EventType.RUN_ERROR not in _types(events)
    assert events[-1].type == EventType.RUN_FINISHED
    restored = _restored_core(model, tmp_path, thread_id)
    batch = load_frontend_tool_wait(restored.state)
    assert len(batch.calls) == 1
    call = batch.calls[0]
    assert {call.interrupt_id, call.native_tool_use_id, call.wire_tool_call_id}
    assert restored._interrupt_state.activated is True
    assert set(restored._interrupt_state.interrupts) == {call.interrupt_id}
    assert restored._interrupt_state.interrupts[call.interrupt_id].name == (
        FRONTEND_TOOL_WAIT_INTERRUPT_NAME
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("custom_args", [False, True], ids=["streaming", "custom"])
async def test_false_mode_end_is_exposed_only_after_wait_checkpoint_is_durable(
    tmp_path: Path,
    custom_args: bool,
):
    thread_id = f"durable-before-end-{custom_args}"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    behaviors: dict[str, ToolBehavior] = {}
    if custom_args:

        async def args_streamer(_context):
            yield '{"value":"requested"}'

        behaviors["lookup"] = ToolBehavior(args_streamer=args_streamer)

    stream = _adapter(
        model,
        tools,
        tmp_path,
        thread_id,
        tool_behaviors=behaviors,
    ).run(
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        )
    )
    exposed_end = None
    try:
        async for event in stream:
            if event.type == EventType.TOOL_CALL_END:
                exposed_end = event
                break
    finally:
        await stream.aclose()

    assert exposed_end is not None
    restored = _restored_core(model, tmp_path, thread_id)
    batch = load_frontend_tool_wait(restored.state)
    assert restored._interrupt_state.activated is True
    assert len(batch.calls) == 1
    call = batch.calls[0]
    assert call.wire_tool_call_id == exposed_end.tool_call_id
    # The consumer took the End and stopped, so it never came back for the next
    # event. The handoff stays unrecorded and the End is re-exposed later; the
    # subject here is only that the checkpoint was already durable by then.
    assert call.end_handed_off is False
    assert all(
        isinstance(identifier, str) and identifier
        for identifier in (
            call.interrupt_id,
            call.native_tool_use_id,
            call.wire_tool_call_id,
        )
    )
    assert set(restored._interrupt_state.interrupts) == {call.interrupt_id}


@pytest.mark.asyncio
@pytest.mark.parametrize("custom_args", [False, True], ids=["streaming", "custom"])
async def test_disconnect_replays_only_unhanded_multiwait_ends_without_strands(
    tmp_path: Path,
    custom_args: bool,
):
    thread_id = f"multiwait-disconnect-{custom_args}"
    model = _PersistenceModel(("first", "second", "third"))
    tools = [_tool("first"), _tool("second"), _tool("third")]
    behaviors: dict[str, ToolBehavior] = {}
    if custom_args:

        async def args_streamer(_context: Any):
            yield '{"value":"requested"}'

        behaviors = {
            tool.name: ToolBehavior(args_streamer=args_streamer) for tool in tools
        }

    stream = _adapter(
        model,
        tools,
        tmp_path,
        thread_id,
        tool_behaviors=behaviors,
    ).run(
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call all three")],
        )
    )
    wire_ids: list[str] = []
    first_end_id = None
    try:
        async for event in stream:
            if event.type == EventType.TOOL_CALL_START:
                wire_ids.append(event.tool_call_id)
            elif event.type == EventType.TOOL_CALL_END:
                first_end_id = event.tool_call_id
                break
    finally:
        await stream.aclose()

    assert len(wire_ids) == 3
    assert first_end_id == wire_ids[0]
    restored = _restored_core(model, tmp_path, thread_id)
    interrupted = load_frontend_tool_wait(restored.state)
    # Nothing is handed off: the consumer broke at the first End without asking
    # for another event, so delivery of even that one is unproven.
    assert [call.end_handed_off for call in interrupted.calls] == [
        False,
        False,
        False,
    ]

    replayed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="result-first",
                    tool_call_id=wire_ids[0],
                    content="one",
                )
            ],
        ),
    )

    assert _types(replayed) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert _end_ids(replayed) == wire_ids[1:]
    assert model.calls == 1
    replayed_state = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert [call.end_handed_off for call in replayed_state.calls] == [
        True,
        True,
        True,
    ]

    completed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id=f"result-{index}",
                    tool_call_id=wire_id,
                    content=answer,
                )
                for index, (wire_id, answer) in enumerate(
                    zip(wire_ids[1:], ("two", "three")),
                    start=2,
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(completed)
    assert model.calls == 2
    consumed = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert consumed.calls == ()
    assert consumed.last_completed_wire_ids == tuple(wire_ids)


@pytest.mark.asyncio
@pytest.mark.parametrize("custom_args", [False, True], ids=["streaming", "custom"])
async def test_reconnect_re_exposes_every_unacknowledged_end(
    tmp_path: Path,
    custom_args: bool,
):
    """An End the consumer never took must be exposed again, in order.

    A handoff is recorded once the yield returns, which is the consumer coming
    back for the next event. Anything short of that — a dropped connection, a
    consumer that stops reading — leaves the End unacknowledged, and the next
    request replays it. Delivery is therefore at least once rather than at most
    once: a duplicate is recoverable, a lost End strands the tool call.
    """
    thread_id = f"multiwait-sequential-reconnect-{custom_args}"
    model = _PersistenceModel(("first", "second", "third"))
    tools = [_tool("first"), _tool("second"), _tool("third")]
    behaviors: dict[str, ToolBehavior] = {}
    if custom_args:

        async def args_streamer(_context: Any):
            yield '{"value":"requested"}'

        behaviors = {
            tool.name: ToolBehavior(args_streamer=args_streamer) for tool in tools
        }

    def handoffs() -> list[bool]:
        return [
            call.end_handed_off
            for call in load_frontend_tool_wait(
                _restored_core(model, tmp_path, thread_id).state
            ).calls
        ]

    async def take_ends(run_id: str, count: int) -> list[str]:
        """Consume until ``count`` Ends have been seen, then drop the stream."""
        stream = _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ).run(
            _input(
                thread_id,
                tools,
                run_id=run_id,
                messages=(
                    [UserMessage(id="user-1", content="call all three")]
                    if run_id == "run-1"
                    else []
                ),
            )
        )
        seen: list[str] = []
        try:
            async for event in stream:
                if event.type == EventType.TOOL_CALL_START:
                    wire_ids.append(event.tool_call_id)
                elif event.type == EventType.TOOL_CALL_END:
                    seen.append(event.tool_call_id)
                    if len(seen) == count:
                        break
        finally:
            await stream.aclose()
        return seen

    wire_ids: list[str] = []
    assert await take_ends("run-1", 1) == [wire_ids[0]]
    assert handoffs() == [False, False, False]

    # Taking two Ends proves the first one was delivered — the consumer came
    # back for another event — and leaves the second unacknowledged.
    assert await take_ends("run-2", 2) == wire_ids[:2]
    assert handoffs() == [True, False, False]

    third = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ),
        _input(thread_id, tools, run_id="run-3", messages=[]),
    )

    assert _types(third) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert _end_ids(third) == wire_ids[1:]
    assert handoffs() == [True, True, True]

    # Nothing is left to replay once every End has been acknowledged.
    fourth = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ),
        _input(thread_id, tools, run_id="run-4", messages=[]),
    )
    assert _types(fourth) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert model.calls == 1


@pytest.mark.asyncio
async def test_scrambled_native_interrupts_replay_in_deferred_end_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    thread_id = "scrambled-native-interrupt-order"
    model_order = (
        "standard-first",
        "custom-first",
        "standard-second",
        "custom-second",
    )
    model = _PersistenceModel(model_order)
    tools = [_tool(name) for name in model_order]

    async def args_streamer(_context: Any):
        yield '{"value":"requested"}'

    behaviors = {
        "custom-first": ToolBehavior(args_streamer=args_streamer),
        "custom-second": ToolBehavior(args_streamer=args_streamer),
    }

    from ag_ui_strands import agent as agent_module

    original_extract = agent_module._extract_interrupts

    def scrambled_interrupts(agent: Any, terminal_result: Any) -> list[Any]:
        return list(reversed(original_extract(agent, terminal_result)))

    monkeypatch.setattr(agent_module, "_extract_interrupts", scrambled_interrupts)
    stream = _adapter(
        model,
        tools,
        tmp_path,
        thread_id,
        tool_behaviors=behaviors,
    ).run(
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call all four")],
        )
    )
    wire_by_name: dict[str, str] = {}
    first_end_id = None
    try:
        async for event in stream:
            if event.type == EventType.TOOL_CALL_START:
                wire_by_name[event.tool_call_name] = event.tool_call_id
            elif event.type == EventType.TOOL_CALL_END:
                first_end_id = event.tool_call_id
                break
    finally:
        await stream.aclose()

    expected_order = [
        wire_by_name["custom-first"],
        wire_by_name["custom-second"],
        wire_by_name["standard-first"],
        wire_by_name["standard-second"],
    ]
    assert first_end_id == expected_order[0]
    restored = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert [call.wire_tool_call_id for call in restored.calls] == expected_order
    assert [call.end_handed_off for call in restored.calls] == [
        False,
        False,
        False,
        False,
    ]

    replayed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ),
        _input(thread_id, tools, run_id="run-2", messages=[]),
    )

    # Every End replays in the persisted deferred order, the interrupted one
    # included: the ordering guarantee is what this test is about, and it now
    # covers the whole batch rather than the tail.
    assert _end_ids(replayed) == expected_order
    assert model.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("reverse_order", [False, True], ids=["forward", "reverse"])
async def test_mixed_custom_backend_standard_disconnect_preserves_replay_order(
    tmp_path: Path,
    reverse_order: bool,
):
    thread_id = "mixed-checkpoint-replay-order"
    first_custom_name = "custom_wait_first"
    second_custom_name = "custom_wait_second"
    backend_name = "backend_lookup"
    standard_name = "standard_wait"
    model_order = (
        (standard_name, second_custom_name, backend_name, first_custom_name)
        if reverse_order
        else (first_custom_name, second_custom_name, backend_name, standard_name)
    )
    model = _PersistenceModel(model_order)
    custom_order = [
        name for name in model_order if name in {first_custom_name, second_custom_name}
    ]
    tools = [
        _tool(first_custom_name),
        _tool(second_custom_name),
        _tool(standard_name),
    ]
    backend_calls: list[str] = []
    callback_calls: list[tuple[str, str]] = []

    async def args_streamer(_context: Any):
        yield '{"value":"requested"}'

    def state_from_result(context: Any) -> dict[str, Any]:
        callback_calls.append((context.tool_use_id, context.message_id))
        return {"backend_result": context.result_data}

    behaviors = {
        first_custom_name: ToolBehavior(args_streamer=args_streamer),
        second_custom_name: ToolBehavior(args_streamer=args_streamer),
        backend_name: ToolBehavior(state_from_result=state_from_result),
    }
    core_tools = [_backend_tool(backend_name, backend_calls)]
    first_stream = _adapter(
        model,
        tools,
        tmp_path,
        thread_id,
        core_tools=core_tools,
        tool_behaviors=behaviors,
        emit_messages_snapshot=False,
    ).run(
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call all three")],
        )
    )
    wire_by_name: dict[str, str] = {}
    initial_backend_results: list[str] = []
    try:
        async for event in first_stream:
            if event.type == EventType.TOOL_CALL_START:
                wire_by_name[event.tool_call_name] = event.tool_call_id
            elif event.type == EventType.TOOL_CALL_RESULT:
                initial_backend_results.append(event.tool_call_id)
            elif (
                event.type == EventType.TOOL_CALL_END
                and event.tool_call_id == wire_by_name.get(custom_order[0])
            ):
                break
    finally:
        await first_stream.aclose()

    assert initial_backend_results == []
    assert len(backend_calls) == 1
    assert callback_calls == []
    restored = _restored_core(model, tmp_path, thread_id)
    interrupted = load_frontend_tool_wait(restored.state)
    assert {
        call.wire_tool_call_id: call.end_handed_off for call in interrupted.calls
    } == {
        wire_by_name[custom_order[0]]: False,
        wire_by_name[custom_order[1]]: False,
        wire_by_name[standard_name]: False,
    }
    callback_message_id = restored.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)[
        backend_calls[0]
    ]["message_id"]

    replayed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(backend_name, backend_calls)],
            tool_behaviors=behaviors,
            emit_messages_snapshot=False,
        ),
        _input(thread_id, tools, run_id="run-2", messages=[]),
    )

    relevant = [
        event.type
        for event in replayed
        if event.type
        in {
            EventType.RUN_STARTED,
            EventType.TOOL_CALL_RESULT,
            EventType.STATE_SNAPSHOT,
            EventType.TOOL_CALL_END,
            EventType.RUN_FINISHED,
        }
    ]
    assert relevant == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.STATE_SNAPSHOT,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    # The interrupted custom End replays alongside the ones that never shipped,
    # and the custom-before-backend-before-standard ordering still holds.
    assert _end_ids(replayed) == [
        wire_by_name[custom_order[0]],
        wire_by_name[custom_order[1]],
        wire_by_name[standard_name],
    ]
    assert len(backend_calls) == 1
    assert callback_calls == [(backend_calls[0], callback_message_id)]
    assert model.calls == 1


@pytest.mark.asyncio
async def test_checkpoint_result_halt_survives_reconnect_and_resume(
    tmp_path: Path,
):
    thread_id = "checkpoint-result-halt"
    frontend_name = "frontend_wait"
    halt_backend_name = "halt_backend"
    later_backend_name = "later_backend"
    model = _PersistenceModel((frontend_name, halt_backend_name, later_backend_name))
    frontend_tools = [_tool(frontend_name)]

    async def args_streamer(_context: Any):
        yield '{"value":"requested"}'

    behaviors = {
        frontend_name: ToolBehavior(args_streamer=args_streamer),
        halt_backend_name: ToolBehavior(stop_streaming_after_result=True),
    }
    core_tools = [
        _backend_tool(halt_backend_name),
        _backend_tool(later_backend_name),
    ]
    first_stream = _adapter(
        model,
        frontend_tools,
        tmp_path,
        thread_id,
        core_tools=core_tools,
        tool_behaviors=behaviors,
        emit_messages_snapshot=False,
    ).run(
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call all three")],
        )
    )
    frontend_wire_id = None
    try:
        async for event in first_stream:
            if (
                event.type == EventType.TOOL_CALL_START
                and event.tool_call_name == frontend_name
            ):
                frontend_wire_id = event.tool_call_id
            elif (
                event.type == EventType.TOOL_CALL_END
                and event.tool_call_id == frontend_wire_id
            ):
                break
    finally:
        await first_stream.aclose()

    reconnect = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
            emit_messages_snapshot=False,
        ),
        _input(thread_id, frontend_tools, run_id="run-2", messages=[]),
    )
    assert [
        event.tool_call_id
        for event in reconnect
        if event.type == EventType.TOOL_CALL_RESULT
    ] == ["native-1"]
    halted = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert halted.stop_streaming_after_result is True

    repeated = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
            emit_messages_snapshot=False,
        ),
        _input(thread_id, frontend_tools, run_id="run-3", messages=[]),
    )
    assert EventType.TOOL_CALL_RESULT not in _types(repeated)

    completed = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
            emit_messages_snapshot=False,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-4",
            messages=[
                ToolMessage(
                    id="frontend-result",
                    tool_call_id=frontend_wire_id,
                    content="answer",
                )
            ],
        ),
    )
    assert EventType.RUN_ERROR not in _types(completed)
    assert "native-2" not in [
        event.tool_call_id
        for event in completed
        if event.type == EventType.TOOL_CALL_RESULT
    ]
    consumed = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert consumed.calls == ()
    assert consumed.stop_streaming_after_result is False
    assert model.calls == 2


@pytest.mark.asyncio
async def test_initial_checkpoint_halt_still_hands_off_standard_frontend_end(
    tmp_path: Path,
):
    thread_id = "initial-checkpoint-halt-standard-end"
    frontend_name = "standard_wait"
    backend_name = "halt_backend"
    model = _PersistenceModel((frontend_name, backend_name))
    frontend_tools = [_tool(frontend_name)]
    backend_calls: list[str] = []
    behaviors = {
        backend_name: ToolBehavior(stop_streaming_after_result=True),
    }

    events = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(backend_name, backend_calls)],
            tool_behaviors=behaviors,
            emit_messages_snapshot=False,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )

    [frontend_wire_id] = [
        event.tool_call_id
        for event in events
        if event.type == EventType.TOOL_CALL_START
        and event.tool_call_name == frontend_name
    ]
    assert _end_ids(events).count(frontend_wire_id) == 1
    persisted = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert persisted.stop_streaming_after_result is True
    assert persisted.calls[0].end_handed_off is True
    assert backend_calls == ["native-1"]
    assert model.calls == 1


@pytest.mark.asyncio
async def test_standard_wait_is_durable_before_checkpoint_backend_result(
    tmp_path: Path,
):
    thread_id = "durable-before-checkpoint-result"
    frontend_name = "standard_wait"
    backend_name = "backend_lookup"
    model = _PersistenceModel((frontend_name, backend_name))
    frontend_tools = [_tool(frontend_name)]
    backend_calls: list[str] = []
    core_tools = [_backend_tool(backend_name, backend_calls)]

    first_stream = _adapter(
        model,
        frontend_tools,
        tmp_path,
        thread_id,
        core_tools=core_tools,
        emit_messages_snapshot=False,
    ).run(
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        )
    )
    frontend_wire_id = None
    frontend_end_seen = False
    try:
        async for event in first_stream:
            if (
                event.type == EventType.TOOL_CALL_START
                and event.tool_call_name == frontend_name
            ):
                frontend_wire_id = event.tool_call_id
            elif (
                event.type == EventType.TOOL_CALL_END
                and event.tool_call_id == frontend_wire_id
            ):
                frontend_end_seen = True
            elif (
                event.type == EventType.TOOL_CALL_RESULT
                and event.tool_call_id == "native-1"
            ):
                break
    finally:
        await first_stream.aclose()

    assert frontend_wire_id is not None
    assert frontend_end_seen is False
    restored = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert [call.wire_tool_call_id for call in restored.calls] == [frontend_wire_id]
    assert restored.calls[0].end_handed_off is False

    replayed = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(backend_name, backend_calls)],
            emit_messages_snapshot=False,
        ),
        _input(thread_id, frontend_tools, run_id="run-2", messages=[]),
    )

    assert _end_ids(replayed) == [frontend_wire_id]
    durable = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert durable.calls[0].end_handed_off is True
    assert backend_calls == ["native-1"]
    assert model.calls == 1


@pytest.mark.asyncio
async def test_new_wrapper_resumes_with_fresh_shared_manager_and_stable_ids(
    tmp_path: Path,
):
    thread_id = "fresh-wrapper"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first_adapter = _adapter(model, tools, tmp_path, thread_id)
    first = await _collect(
        first_adapter,
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    second_adapter = _adapter(model, tools, tmp_path, thread_id)
    second = await _collect(
        second_adapter,
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="result-1",
                    tool_call_id=wire_id,
                    content='{"answer":42}',
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(second)
    assert EventType.RUN_FINISHED in _types(second)
    assert _wire_ids(second) == []
    assert model.calls == 2
    assert '{"answer":42}' in repr(model.seen_messages[-1])
    restored = _restored_core(model, tmp_path, thread_id)
    consumed = load_frontend_tool_wait(restored.state)
    assert consumed.calls == ()
    assert consumed.last_completed_wire_ids == (wire_id,)


@pytest.mark.asyncio
@pytest.mark.parametrize("fresh_wrapper", [False, True], ids=["same", "fresh"])
async def test_wait_resume_does_not_require_current_tool_declaration(
    tmp_path: Path,
    fresh_wrapper: bool,
):
    thread_id = f"resume-without-current-tool-{fresh_wrapper}"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    storage_dir = tmp_path if fresh_wrapper else None
    first_adapter = _adapter(model, tools, storage_dir, thread_id)
    first = await _collect(
        first_adapter,
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    resume_adapter = (
        _adapter(model, tools, storage_dir, thread_id)
        if fresh_wrapper
        else first_adapter
    )
    resumed = await _collect(
        resume_adapter,
        _input(
            thread_id,
            [],
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="result-1",
                    tool_call_id=wire_id,
                    content="exact-client-result",
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(resumed)
    assert model.calls == 2
    assert model.seen_messages[-1][-1]["content"] == [
        {
            "toolResult": {
                "toolUseId": "native-0",
                "status": "success",
                "content": [{"text": "exact-client-result"}],
            }
        }
    ]
    resumed_core = resume_adapter._agents_by_thread[thread_id]
    assert "lookup" not in resumed_core.tool_registry.registry
    assert "lookup" not in resumed_core.tool_registry.dynamic_tools


@pytest.mark.asyncio
async def test_restored_wait_uses_persisted_false_mode_then_current_true_mode(
    tmp_path: Path,
):
    thread_id = "persisted-false-current-true"
    model = _WaitThenRepeatSameToolModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    current_true_adapter = _adapter(
        model,
        tools,
        tmp_path,
        thread_id,
        tool_behaviors={"lookup": ToolBehavior(continue_after_frontend_call=True)},
    )
    resumed = await _collect(
        current_true_adapter,
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="result-1",
                    tool_call_id=wire_id,
                    content="exact-parked-result",
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(resumed)
    assert model.calls == 3
    assert model.seen_messages[1][-1]["content"] == [
        {
            "toolResult": {
                "toolUseId": "native-repeat-1",
                "status": "success",
                "content": [{"text": "exact-parked-result"}],
            }
        }
    ]
    assert model.seen_messages[2][-1]["content"] == [
        {
            "toolResult": {
                "toolUseId": "native-repeat-2",
                "status": "success",
                "content": [{"text": "Forwarded to client"}],
            }
        }
    ]
    consumed = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert consumed.calls == ()


@pytest.mark.asyncio
async def test_partial_results_survive_multiple_reconstructions_out_of_order(
    tmp_path: Path,
):
    thread_id = "partial-restarts"
    model = _PersistenceModel(("first", "second"))
    tools = [_tool("first"), _tool("second")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    wire_ids = _wire_ids(first)
    assert len(wire_ids) == 2

    partial = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(id="result-second", tool_call_id=wire_ids[1], content="two")
            ],
        ),
    )
    assert _types(partial) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert model.calls == 1

    completed = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="duplicate-second", tool_call_id=wire_ids[1], content="changed"
                ),
                ToolMessage(id="result-first", tool_call_id=wire_ids[0], content=""),
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(completed)
    assert model.calls == 2
    visible_results = model.seen_messages[-1][-1]["content"]
    assert [block["toolResult"]["content"][0]["text"] for block in visible_results] == [
        "",
        "two",
    ]


@pytest.mark.asyncio
async def test_mixed_wait_resume_excludes_continue_placeholder_from_corrections(
    tmp_path: Path,
):
    thread_id = "mixed-wait-and-continue"
    model = _PersistenceModel(("wait_tool", "continue_tool"))
    tools = [_tool("wait_tool"), _tool("continue_tool")]
    behaviors = {
        "continue_tool": ToolBehavior(continue_after_frontend_call=True),
    }
    first = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    wait_wire_id, continue_wire_id = _wire_ids(first)
    waiting = load_frontend_tool_wait(_restored_core(model, tmp_path, thread_id).state)
    assert waiting.call_for_wire_id(wait_wire_id) is not None
    assert waiting.call_for_wire_id(continue_wire_id) is None

    resumed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="wait-result",
                    tool_call_id=wait_wire_id,
                    content="exact wait result",
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(resumed)
    assert EventType.RUN_FINISHED in _types(resumed)
    assert model.calls == 2
    transcript = repr(model.seen_messages[-1])
    assert "exact wait result" in transcript
    assert "Forwarded to client" in transcript


@pytest.mark.asyncio
async def test_server_resume_does_not_require_continue_true_proxy_result(
    tmp_path: Path,
):
    thread_id = "continue-proxy-and-server-interrupt"
    server_name = "approve_server"
    model = _PersistenceModel(("continue_tool", server_name))
    frontend_tools = [_tool("continue_tool")]
    behaviors = {
        "continue_tool": ToolBehavior(continue_after_frontend_call=True),
        server_name: ToolBehavior(interrupt_on_call=True),
    }
    first = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(server_name)],
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    finished = next(event for event in first if event.type == EventType.RUN_FINISHED)
    [server_interrupt] = finished.outcome.interrupts
    assert model.calls == 1

    resumed = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(server_name)],
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-2",
            messages=[],
            resume=[
                ResumeEntry(
                    interrupt_id=server_interrupt.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(resumed)
    assert EventType.RUN_FINISHED in _types(resumed)
    assert model.calls == 2
    assert "Forwarded to client" in repr(model.seen_messages[-1])


@pytest.mark.asyncio
async def test_mixed_frontend_and_server_candidates_restore_together(tmp_path: Path):
    thread_id = "mixed-candidate-restarts"
    server_name = "approve_server"
    model = _PersistenceModel(("first", "second", server_name))
    frontend_tools = [_tool("first"), _tool("second")]
    core_tools = [_backend_tool(server_name)]
    behaviors = {server_name: ToolBehavior(interrupt_on_call=True)}

    first = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call all three")],
        ),
    )
    wire_ids = _wire_ids(first)[:2]
    finished = next(event for event in first if event.type == EventType.RUN_FINISHED)
    [server_interrupt] = finished.outcome.interrupts
    assert len(wire_ids) == 2

    partial = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-2",
            messages=[
                ToolMessage(id="second-result", tool_call_id=wire_ids[1], content="two")
            ],
            resume=[
                ResumeEntry(
                    interrupt_id=server_interrupt.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )
    assert _types(partial) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert model.calls == 1

    completed = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-3",
            messages=[
                ToolMessage(id="first-result", tool_call_id=wire_ids[0], content="")
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(completed)
    assert model.calls == 2
    transcript = repr(model.seen_messages[-1])
    assert "'text': ''" in transcript
    assert "'text': 'two'" in transcript
    assert "server-result" in transcript


@pytest.mark.asyncio
async def test_mixed_checkpoint_aborts_before_frontend_end_when_bookkeeping_sync_fails(
    tmp_path: Path,
):
    thread_id = "mixed-bookkeeping-sync-failure"
    server_name = "approve_server"
    model = _PersistenceModel(("lookup", server_name))
    frontend_tools = [_tool("lookup")]
    failure_counter = {"count": 0}

    events = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            manager_type=_FailingBookkeepingSyncManager,
            manager_kwargs={"failure_counter": failure_counter},
            core_tools=[_backend_tool(server_name)],
            tool_behaviors={server_name: ToolBehavior(interrupt_on_call=True)},
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )

    frontend_wire_id = next(
        event.tool_call_id
        for event in events
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == "lookup"
    )
    assert failure_counter["count"] == 1
    assert EventType.RUN_ERROR in _types(events)
    assert EventType.RUN_FINISHED not in _types(events)
    assert frontend_wire_id not in _end_ids(events)


@pytest.mark.asyncio
async def test_pure_server_interrupt_keeps_best_effort_bookkeeping_persistence(
    tmp_path: Path,
):
    thread_id = "server-only-bookkeeping-sync-failure"
    server_name = "approve_server"
    model = _PersistenceModel((server_name,))
    failure_counter = {"count": 0}

    events = await _collect(
        _adapter(
            model,
            [],
            tmp_path,
            thread_id,
            manager_type=_FailingBookkeepingSyncManager,
            manager_kwargs={"failure_counter": failure_counter},
            core_tools=[_backend_tool(server_name)],
            tool_behaviors={server_name: ToolBehavior(interrupt_on_call=True)},
        ),
        _input(
            thread_id,
            [],
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call server")],
        ),
    )

    assert failure_counter["count"] == 1
    assert EventType.RUN_ERROR not in _types(events)
    finished = next(event for event in events if event.type == EventType.RUN_FINISHED)
    assert finished.outcome.type == "interrupt"


@pytest.mark.asyncio
async def test_fresh_wrapper_reconnect_before_original_outcome_reexposes_server_interrupt(
    tmp_path: Path,
):
    thread_id = "mixed-disconnect-before-outcome"
    server_name = "approve_server"
    model = _PersistenceModel(("lookup", server_name))
    frontend_tools = [_tool("lookup")]
    behaviors = {server_name: ToolBehavior(interrupt_on_call=True)}

    first_stream = _adapter(
        model,
        frontend_tools,
        tmp_path,
        thread_id,
        core_tools=[_backend_tool(server_name)],
        tool_behaviors=behaviors,
    ).run(
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        )
    )
    frontend_wire_id = None
    try:
        async for event in first_stream:
            if (
                event.type == EventType.TOOL_CALL_START
                and event.tool_call_name == "lookup"
            ):
                frontend_wire_id = event.tool_call_id
            elif (
                event.type == EventType.TOOL_CALL_END
                and event.tool_call_id == frontend_wire_id
            ):
                break
    finally:
        await first_stream.aclose()

    restored = _restored_core(model, tmp_path, thread_id)
    batch = load_frontend_tool_wait(restored.state)
    server_interrupt_ids = [
        interrupt_id
        for interrupt_id in restored._interrupt_state.interrupts
        if interrupt_id not in {call.interrupt_id for call in batch.calls}
    ]
    assert len(server_interrupt_ids) == 1

    reconnect = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(server_name)],
            tool_behaviors=behaviors,
        ),
        _input(thread_id, frontend_tools, run_id="run-2", messages=[]),
    )

    finished = next(
        event for event in reconnect if event.type == EventType.RUN_FINISHED
    )
    assert finished.outcome.type == "interrupt"
    assert [interrupt.id for interrupt in finished.outcome.interrupts] == (
        server_interrupt_ids
    )
    assert model.calls == 1

    repeated = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(server_name)],
            tool_behaviors=behaviors,
        ),
        _input(thread_id, frontend_tools, run_id="run-3", messages=[]),
    )
    repeated_finished = next(
        event for event in repeated if event.type == EventType.RUN_FINISHED
    )
    assert [interrupt.id for interrupt in repeated_finished.outcome.interrupts] == (
        server_interrupt_ids
    )
    assert model.calls == 1


@pytest.mark.asyncio
async def test_pure_server_checkpoint_without_wait_key_is_unchanged(tmp_path: Path):
    thread_id = "pure-server-restart"
    server_name = "approve_server"
    model = _PersistenceModel((server_name,))
    backend = _backend_tool(server_name)
    behaviors = {server_name: ToolBehavior(interrupt_on_call=True)}
    first = await _collect(
        _adapter(
            model,
            [],
            tmp_path,
            thread_id,
            core_tools=[backend],
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            [],
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call the server")],
        ),
    )
    finished = next(event for event in first if event.type == EventType.RUN_FINISHED)
    [server_interrupt] = finished.outcome.interrupts
    restored = _restored_core(model, tmp_path, thread_id)
    assert restored.state.get(FRONTEND_TOOL_WAIT_STATE_KEY) is None

    second = await _collect(
        _adapter(
            model,
            [],
            tmp_path,
            thread_id,
            core_tools=[_backend_tool(server_name)],
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            [],
            run_id="run-2",
            messages=[],
            resume=[
                ResumeEntry(
                    interrupt_id=server_interrupt.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(second)
    assert EventType.RUN_FINISHED in _types(second)
    assert model.calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("retry_kind", ["exact", "changed", "missing"])
async def test_pure_server_resume_recovers_superseding_wait_after_sync_failure(
    tmp_path: Path,
    retry_kind: str,
):
    thread_id = f"server-resume-superseding-wait-{retry_kind}"
    server_name = "approve_server"
    model = _WaitThenServerInterruptModel(server_name, "lookup")
    frontend_tools = [_tool("lookup")]
    core_tools = [_backend_tool(server_name)]
    behaviors = {server_name: ToolBehavior(interrupt_on_call=True)}
    first = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="start")],
        ),
    )
    [server_interrupt] = next(
        event for event in first if event.type == EventType.RUN_FINISHED
    ).outcome.interrupts
    exact_resume = ResumeEntry(
        interrupt_id=server_interrupt.id,
        status="resolved",
        payload={"approved": True},
    )
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            manager_type=_FailingSupersedingWaitSyncManager,
            manager_kwargs={"failure_counter": failure_counter},
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            frontend_tools,
            run_id="run-2",
            messages=[],
            resume=[exact_resume],
        ),
    )
    second_wire_id = next(
        event.tool_call_id
        for event in failed
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == "lookup"
    )
    assert failure_counter["count"] == 1
    assert EventType.RUN_ERROR in _types(failed)
    assert second_wire_id not in _end_ids(failed)
    assert model.calls == 2

    retry_resume = {
        "exact": [exact_resume],
        "changed": [
            ResumeEntry(
                interrupt_id=server_interrupt.id,
                status="resolved",
                payload={"approved": False},
            )
        ],
        "missing": None,
    }[retry_kind]
    retried = await _collect(
        _adapter(
            model,
            frontend_tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            [],
            run_id="run-3",
            messages=[],
            resume=retry_resume,
        ),
    )

    if retry_kind == "exact":
        assert EventType.RUN_ERROR not in _types(retried)
        assert second_wire_id in _end_ids(retried)
    else:
        assert [
            event.code for event in retried if event.type == EventType.RUN_ERROR
        ] == ["INTERRUPT_RESUME_ERROR"]
        assert second_wire_id not in _end_ids(retried)
    assert model.calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fail_when", ["initial", "handoff", "staged", "complete", "consume"]
)
async def test_explicit_frontend_wait_sync_failure_is_loud_and_never_finishes(
    tmp_path: Path,
    fail_when: str,
):
    thread_id = f"sync-failure-{fail_when}"
    model = _PersistenceModel(("first", "second"))
    tools = [_tool("first"), _tool("second")]
    manager_kwargs = {"fail_when": fail_when}
    adapter = _adapter(
        model,
        tools,
        tmp_path,
        thread_id,
        manager_type=_FailingWaitSyncManager,
        manager_kwargs=manager_kwargs,
    )

    first = await _collect(
        adapter,
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    if fail_when in {"initial", "handoff"}:
        events = first
    else:
        wire_ids = _wire_ids(first)
        assert len(wire_ids) == 2
        result_ids = wire_ids[:1] if fail_when == "staged" else wire_ids
        events = await _collect(
            adapter,
            _input(
                thread_id,
                tools,
                run_id="run-2",
                messages=[
                    ToolMessage(
                        id=f"result-{index}",
                        tool_call_id=wire_id,
                        content=f"answer-{index}",
                    )
                    for index, wire_id in enumerate(result_ids)
                ],
            ),
        )

    assert EventType.RUN_ERROR in _types(events)
    assert EventType.RUN_FINISHED not in _types(events)
    if fail_when == "initial":
        assert EventType.TOOL_CALL_END not in _types(events)
    if fail_when == "handoff":
        assert EventType.TOOL_CALL_END in _types(events)
    if fail_when in {"staged", "complete"}:
        assert model.calls == 1


@pytest.mark.asyncio
async def test_complete_candidate_is_synced_before_native_submission_and_retryable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    thread_id = "preflush-retry"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first_adapter = _adapter(model, tools, tmp_path, thread_id)
    first = await _collect(
        first_adapter,
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    failing_adapter = _adapter(model, tools, tmp_path, thread_id)
    original_core = Agent.stream_async
    attempted = False

    async def fail_before_acceptance(core: Agent, prompt: Any, **kwargs: Any):
        nonlocal attempted
        attempted = True
        restored = _restored_core(model, tmp_path, thread_id)
        persisted = load_frontend_tool_wait(restored.state)
        assert persisted.calls[0].has_response is True
        assert persisted.calls[0].content == "first"
        raise RuntimeError("native submission failed before acceptance")
        yield  # pragma: no cover

    monkeypatch.setattr(Agent, "stream_async", fail_before_acceptance)
    failed = await _collect(
        failing_adapter,
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="first", tool_call_id=wire_id, content="first")],
        ),
    )
    assert attempted is True
    assert EventType.RUN_ERROR in _types(failed)
    assert EventType.RUN_FINISHED not in _types(failed)

    monkeypatch.setattr(Agent, "stream_async", original_core)
    retried = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[
                ToolMessage(id="different", tool_call_id=wire_id, content="different")
            ],
        ),
    )
    assert EventType.RUN_ERROR not in _types(retried)
    assert "first" in repr(model.seen_messages[-1])
    assert "different" not in repr(model.seen_messages[-1])


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_when", ["staged", "consume"])
async def test_same_wrapper_retry_reflushes_equal_candidate_or_tombstone(
    tmp_path: Path,
    fail_when: str,
):
    thread_id = f"same-wrapper-reflush-{fail_when}"
    model = _PersistenceModel(("first", "second"))
    tools = [_tool("first"), _tool("second")]
    failure_counter = {"count": 0}
    adapter = _adapter(
        model,
        tools,
        tmp_path,
        thread_id,
        manager_type=_FailingWaitSyncManager,
        manager_kwargs={
            "fail_when": fail_when,
            "failure_limit": 1,
            "failure_counter": failure_counter,
        },
    )
    first = await _collect(
        adapter,
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    wire_ids = _wire_ids(first)
    submitted_ids = wire_ids[:1] if fail_when == "staged" else wire_ids
    responses = [
        ToolMessage(
            id=f"result-{index}", tool_call_id=wire_id, content=f"answer-{index}"
        )
        for index, wire_id in enumerate(submitted_ids)
    ]

    failed = await _collect(
        adapter,
        _input(thread_id, tools, run_id="run-2", messages=responses),
    )
    retried = await _collect(
        adapter,
        _input(thread_id, tools, run_id="run-3", messages=responses),
    )

    assert EventType.RUN_ERROR in _types(failed)
    assert EventType.RUN_ERROR not in _types(retried)
    restored = _restored_core(model, tmp_path, thread_id)
    batch = load_frontend_tool_wait(restored.state)
    if fail_when == "staged":
        assert batch.calls[0].has_response is True
        assert batch.calls[0].content == "answer-0"
    else:
        assert batch.calls == ()
        assert batch.last_completed_wire_ids == tuple(wire_ids)


@pytest.mark.asyncio
async def test_fresh_wrapper_finalizes_consumed_wait_after_final_sync_failure(
    tmp_path: Path,
):
    thread_id = "consume-sync-recovery"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)
    failure_counter = {"count": 0}
    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "consume",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="exact")],
        ),
    )
    assert EventType.RUN_ERROR in _types(failed)
    assert model.calls == 2

    stranded_core = _restored_core(model, tmp_path, thread_id)
    stranded_batch = load_frontend_tool_wait(stranded_core.state)
    assert stranded_batch.is_complete
    assert stranded_core._interrupt_state.activated is False
    assert any(
        block.get("toolResult", {}).get("toolUseId")
        == stranded_batch.calls[0].native_tool_use_id
        for message in stranded_core.messages
        for block in message.get("content", [])
    )

    recovered = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            [],
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="duplicate-result",
                    tool_call_id=wire_id,
                    content="ignored",
                )
            ],
        ),
    )

    assert _types(recovered) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert model.calls == 2
    finalized = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert finalized.calls == ()
    assert finalized.last_completed_wire_ids == (wire_id,)


@pytest.mark.asyncio
@pytest.mark.parametrize("durable_result_corruption", ["missing", "mismatched"])
async def test_inactive_complete_wait_without_exact_durable_result_fails_closed(
    tmp_path: Path,
    durable_result_corruption: str,
):
    thread_id = f"consume-proof-boundary-{durable_result_corruption}"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)
    failure_counter = {"count": 0}
    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "consume",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="exact")],
        ),
    )
    assert EventType.RUN_ERROR in _types(failed)
    assert model.calls == 2

    stranded_core = _restored_core(model, tmp_path, thread_id)
    stranded_batch = load_frontend_tool_wait(stranded_core.state)
    [waiting_call] = stranded_batch.calls
    session_manager = stranded_core._session_manager
    session_messages = session_manager.session_repository.list_messages(
        session_id=thread_id,
        agent_id="stable-agent",
    )
    for session_message in session_messages:
        message = session_message.message
        content = message.get("content")
        if not isinstance(content, list):
            continue
        matching_blocks = [
            block
            for block in content
            if block.get("toolResult", {}).get("toolUseId")
            == waiting_call.native_tool_use_id
        ]
        if not matching_blocks:
            continue
        if durable_result_corruption == "missing":
            message["content"] = [
                block for block in content if block not in matching_blocks
            ]
        else:
            matching_blocks[0]["toolResult"]["content"] = [{"text": "different"}]
        session_manager.session_repository.update_message(
            session_id=thread_id,
            agent_id="stable-agent",
            session_message=session_message,
        )
        break
    else:  # pragma: no cover - the recovery fixture must contain the native result
        raise AssertionError("expected a persisted native toolResult")

    corrupted_core = _restored_core(model, tmp_path, thread_id)
    corrupted_batch = load_frontend_tool_wait(corrupted_core.state)
    assert corrupted_batch.is_complete
    assert corrupted_core._interrupt_state.activated is False
    assert not _frontend_wait_consumption_is_durable(corrupted_core, corrupted_batch)

    rejected = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="duplicate-result",
                    tool_call_id=wire_id,
                    content="ignored",
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR in _types(rejected)
    assert EventType.RUN_FINISHED not in _types(rejected)
    assert model.calls == 2
    unresolved = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert unresolved.calls == stranded_batch.calls
    assert unresolved.last_completed_wire_ids == ()


@pytest.mark.asyncio
async def test_fresh_retry_recovers_consumed_wait_before_new_server_checkpoint(
    tmp_path: Path,
):
    thread_id = "consume-sync-new-server-checkpoint"
    server_name = "approve_server"
    model = _WaitThenServerInterruptModel()
    tools = [_tool("lookup")]
    core_tools = [_backend_tool(server_name)]
    behaviors = {server_name: ToolBehavior(interrupt_on_call=True)}
    first = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "consume",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="exact")],
        ),
    )
    assert EventType.RUN_ERROR in _types(failed)
    assert model.calls == 2
    stranded = _restored_core(model, tmp_path, thread_id)
    stranded_batch = load_frontend_tool_wait(stranded.state)
    assert stranded_batch.is_complete
    assert stranded._interrupt_state.activated is True
    assert set(stranded._interrupt_state.interrupts).isdisjoint(
        call.interrupt_id for call in stranded_batch.calls
    )

    recovery_failure_counter = {"count": 0}
    recovery_failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingRecoverySyncManager,
            manager_kwargs={"failure_counter": recovery_failure_counter},
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="duplicate-result",
                    tool_call_id=wire_id,
                    content="ignored",
                )
            ],
        ),
    )
    assert EventType.RUN_ERROR in _types(recovery_failed)
    assert recovery_failure_counter["count"] == 1
    assert model.calls == 2
    still_stranded = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert still_stranded.calls == stranded_batch.calls

    recovered = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-4",
            messages=[
                ToolMessage(
                    id="duplicate-result",
                    tool_call_id=wire_id,
                    content="ignored",
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(recovered)
    assert model.calls == 2
    finished = next(
        event for event in recovered if event.type == EventType.RUN_FINISHED
    )
    [server_interrupt] = finished.outcome.interrupts
    finalized = _restored_core(model, tmp_path, thread_id)
    finalized_batch = load_frontend_tool_wait(finalized.state)
    assert finalized_batch.calls == ()
    assert finalized_batch.last_completed_wire_ids == (wire_id,)
    pending, _ = _load_persisted_interrupt_bookkeeping(finalized)
    assert pending is not None
    assert set(pending) == {server_interrupt.id}

    replayed_after_lost_response = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-5",
            messages=[
                ToolMessage(
                    id="duplicate-result-again",
                    tool_call_id=wire_id,
                    content="ignored",
                )
            ],
        ),
    )
    assert EventType.RUN_ERROR not in _types(replayed_after_lost_response)
    replayed_finished = next(
        event
        for event in replayed_after_lost_response
        if event.type == EventType.RUN_FINISHED
    )
    assert replayed_finished.outcome.type == "interrupt"
    assert [interrupt.id for interrupt in replayed_finished.outcome.interrupts] == [
        server_interrupt.id
    ]
    assert model.calls == 2

    resumed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-6",
            messages=[],
            resume=[
                ResumeEntry(
                    interrupt_id=server_interrupt.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )
    assert EventType.RUN_ERROR not in _types(resumed)
    assert model.calls == 3


@pytest.mark.asyncio
async def test_combined_retry_reexposes_superseding_server_checkpoint(
    tmp_path: Path,
):
    thread_id = "combined-resume-new-server-checkpoint"
    model = _CombinedThenServerInterruptModel()
    tools = [_tool("lookup")]
    core_tools = [_backend_tool("approve_old"), _backend_tool("approve_new")]
    behaviors = {
        "approve_old": ToolBehavior(interrupt_on_call=True),
        "approve_new": ToolBehavior(interrupt_on_call=True),
    }
    first = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="start")],
        ),
    )
    wire_id = next(
        event.tool_call_id
        for event in first
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == "lookup"
    )
    first_finished = next(
        event for event in first if event.type == EventType.RUN_FINISHED
    )
    [old_server_interrupt] = first_finished.outcome.interrupts
    old_resume = [
        ResumeEntry(
            interrupt_id=old_server_interrupt.id,
            status="resolved",
            payload={"approved": True},
        )
    ]
    old_result = ToolMessage(
        id="lookup-result",
        tool_call_id=wire_id,
        content="exact",
    )
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "consume",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[old_result],
            resume=old_resume,
        ),
    )
    assert EventType.RUN_ERROR in _types(failed)
    assert model.calls == 2

    recovered = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[old_result],
            resume=old_resume,
        ),
    )

    assert EventType.RUN_ERROR not in _types(recovered)
    recovered_finished = next(
        event for event in recovered if event.type == EventType.RUN_FINISHED
    )
    assert recovered_finished.outcome.type == "interrupt"
    [new_server_interrupt] = recovered_finished.outcome.interrupts
    assert new_server_interrupt.id != old_server_interrupt.id
    assert model.calls == 2

    changed_old_resume = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-4",
            messages=[old_result],
            resume=[
                ResumeEntry(
                    interrupt_id=old_server_interrupt.id,
                    status="resolved",
                    payload={"approved": False},
                )
            ],
        ),
    )
    assert [
        event.code for event in changed_old_resume if event.type == EventType.RUN_ERROR
    ] == ["INTERRUPT_RESUME_ERROR"]
    assert model.calls == 2


@pytest.mark.asyncio
async def test_combined_retry_reconstructs_superseding_frontend_wait(
    tmp_path: Path,
):
    thread_id = "combined-resume-new-frontend-checkpoint"
    model = _CombinedThenServerInterruptModel("second_lookup")
    tools = [_tool("lookup"), _tool("second_lookup")]
    core_tools = [_backend_tool("approve_old")]
    behaviors = {"approve_old": ToolBehavior(interrupt_on_call=True)}
    first = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="start")],
        ),
    )
    first_wire_id = next(
        event.tool_call_id
        for event in first
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == "lookup"
    )
    first_finished = next(
        event for event in first if event.type == EventType.RUN_FINISHED
    )
    [old_server_interrupt] = first_finished.outcome.interrupts
    old_resume = [
        ResumeEntry(
            interrupt_id=old_server_interrupt.id,
            status="resolved",
            payload={"approved": True},
        )
    ]
    old_result = ToolMessage(
        id="lookup-result",
        tool_call_id=first_wire_id,
        content="exact",
    )
    failure_counter = {"count": 0}
    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "consume",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[old_result],
            resume=old_resume,
        ),
    )
    second_wire_id = next(
        event.tool_call_id
        for event in failed
        if event.type == EventType.TOOL_CALL_START
        and event.tool_call_name == "second_lookup"
    )
    assert EventType.RUN_ERROR in _types(failed)
    assert second_wire_id not in _end_ids(failed)
    assert model.calls == 2

    recovered = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[old_result],
            resume=old_resume,
        ),
    )
    assert EventType.RUN_ERROR not in _types(recovered)
    assert second_wire_id in _end_ids(recovered)
    assert model.calls == 2

    resumed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-4",
            messages=[
                ToolMessage(
                    id="second-result",
                    tool_call_id=second_wire_id,
                    content="second exact",
                )
            ],
        ),
    )
    assert EventType.RUN_ERROR not in _types(resumed)
    assert model.calls == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("replacement_kind", ["visible", "hidden", "mixed"])
async def test_combined_retry_reexposes_normal_superseding_checkpoint(
    tmp_path: Path,
    replacement_kind: str,
):
    thread_id = f"combined-normal-superseding-{replacement_kind}"
    second_names = {
        "visible": ("approve_new",),
        "hidden": ("second_lookup",),
        "mixed": ("second_lookup", "approve_new"),
    }[replacement_kind]
    model = _CombinedThenServerInterruptModel(second_names)
    tools = [_tool("lookup")]
    if replacement_kind != "visible":
        tools.append(_tool("second_lookup"))
    core_tools = [_backend_tool("approve_old"), _backend_tool("approve_new")]
    behaviors = {
        "approve_old": ToolBehavior(interrupt_on_call=True),
        "approve_new": ToolBehavior(interrupt_on_call=True),
    }
    (
        old_wire_id,
        old_server_interrupt,
        old_resume,
        old_result,
    ) = await _start_combined_checkpoint(
        model,
        tools,
        tmp_path,
        thread_id,
        core_tools=core_tools,
        tool_behaviors=behaviors,
    )

    advanced = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[old_result],
            resume=old_resume,
        ),
    )
    assert EventType.RUN_ERROR not in _types(advanced)
    advanced_finished = next(
        event for event in advanced if event.type == EventType.RUN_FINISHED
    )
    new_server_interrupt = None
    if replacement_kind == "hidden":
        assert advanced_finished.outcome.type == "success"
    else:
        assert advanced_finished.outcome.type == "interrupt"
        [new_server_interrupt] = advanced_finished.outcome.interrupts
        assert new_server_interrupt.id != old_server_interrupt.id
    if replacement_kind != "visible":
        second_wire_id = next(
            event.tool_call_id
            for event in advanced
            if event.type == EventType.TOOL_CALL_START
            and event.tool_call_name == "second_lookup"
        )
        assert second_wire_id in _end_ids(advanced)
    assert model.calls == 2
    persisted = _restored_core(model, tmp_path, thread_id)
    persisted_batch = load_frontend_tool_wait(persisted.state)
    assert old_wire_id in persisted_batch.last_completed_wire_ids
    assert bool(persisted_batch.calls) is (replacement_kind != "visible")
    persisted_pending, persisted_fingerprint = _load_persisted_interrupt_bookkeeping(
        persisted
    )
    expected_pending_ids = (
        {new_server_interrupt.id} if new_server_interrupt is not None else set()
    )
    assert set(persisted_pending or {}) == expected_pending_ids
    assert isinstance(persisted_fingerprint, str) and persisted_fingerprint

    replayed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[old_result],
            resume=old_resume,
        ),
    )

    assert EventType.RUN_ERROR not in _types(replayed)
    replayed_finished = next(
        event for event in replayed if event.type == EventType.RUN_FINISHED
    )
    if replacement_kind == "hidden":
        assert replayed_finished.outcome.type == "success"
    else:
        assert replayed_finished.outcome.type == "interrupt"
        assert [interrupt.id for interrupt in replayed_finished.outcome.interrupts] == [
            new_server_interrupt.id
        ]
    assert model.calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("retry_kind", ["exact", "changed", "missing"])
async def test_combined_retry_after_superseding_wait_initial_sync_fails(
    tmp_path: Path,
    retry_kind: str,
):
    thread_id = f"combined-superseding-wait-sync-failure-{retry_kind}"
    model = _CombinedThenServerInterruptModel("second_lookup")
    tools = [_tool("lookup"), _tool("second_lookup")]
    core_tools = [_backend_tool("approve_old")]
    behaviors = {"approve_old": ToolBehavior(interrupt_on_call=True)}
    _, old_server_interrupt, old_resume, old_result = await _start_combined_checkpoint(
        model,
        tools,
        tmp_path,
        thread_id,
        core_tools=core_tools,
        tool_behaviors=behaviors,
    )
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingSupersedingWaitSyncManager,
            manager_kwargs={"failure_counter": failure_counter},
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[old_result],
            resume=old_resume,
        ),
    )
    second_wire_id = next(
        event.tool_call_id
        for event in failed
        if event.type == EventType.TOOL_CALL_START
        and event.tool_call_name == "second_lookup"
    )
    assert failure_counter["count"] == 1
    assert EventType.RUN_ERROR in _types(failed)
    assert second_wire_id not in _end_ids(failed)
    assert model.calls == 2

    retry_resume = {
        "exact": old_resume,
        "changed": [
            ResumeEntry(
                interrupt_id=old_server_interrupt.id,
                status="resolved",
                payload={"approved": False},
            )
        ],
        "missing": None,
    }[retry_kind]
    retried = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            [],
            run_id="run-3",
            messages=[old_result],
            resume=retry_resume,
        ),
    )

    if retry_kind == "exact":
        assert EventType.RUN_ERROR not in _types(retried)
        assert second_wire_id in _end_ids(retried)
    else:
        assert [
            event.code for event in retried if event.type == EventType.RUN_ERROR
        ] == ["INTERRUPT_RESUME_ERROR"]
        assert second_wire_id not in _end_ids(retried)
    assert model.calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("server_first", [True, False])
async def test_out_of_order_combined_resume_replays_completing_request(
    tmp_path: Path,
    server_first: bool,
):
    thread_id = f"out-of-order-combined-resume-{server_first}"
    model = _CombinedThenServerInterruptModel("second_lookup")
    tools = [_tool("lookup"), _tool("second_lookup")]
    core_tools = [_backend_tool("approve_old")]
    behaviors = {"approve_old": ToolBehavior(interrupt_on_call=True)}
    _, _, old_resume, old_result = await _start_combined_checkpoint(
        model,
        tools,
        tmp_path,
        thread_id,
        core_tools=core_tools,
        tool_behaviors=behaviors,
    )
    partial_messages = [] if server_first else [old_result]
    partial_resume = old_resume if server_first else None
    partial = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=partial_messages,
            resume=partial_resume,
        ),
    )
    assert EventType.RUN_ERROR not in _types(partial)
    assert model.calls == 1

    completing_messages = [old_result] if server_first else []
    completing_resume = None if server_first else old_resume
    failure_counter = {"count": 0}
    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingSupersedingWaitSyncManager,
            manager_kwargs={"failure_counter": failure_counter},
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=completing_messages,
            resume=completing_resume,
        ),
    )
    second_wire_id = next(
        event.tool_call_id
        for event in failed
        if event.type == EventType.TOOL_CALL_START
        and event.tool_call_name == "second_lookup"
    )
    assert failure_counter["count"] == 1
    assert EventType.RUN_ERROR in _types(failed)
    assert second_wire_id not in _end_ids(failed)
    assert model.calls == 2
    _, persisted_fingerprint = _load_persisted_interrupt_bookkeeping(
        _restored_core(model, tmp_path, thread_id)
    )
    assert (persisted_fingerprint is None) is server_first

    recovered = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            [],
            run_id="run-4",
            messages=completing_messages,
            resume=completing_resume,
        ),
    )

    assert EventType.RUN_ERROR not in _types(recovered)
    assert second_wire_id in _end_ids(recovered)
    assert model.calls == 2


@pytest.mark.asyncio
async def test_fresh_retry_recovers_consumed_wait_before_new_frontend_wait(
    tmp_path: Path,
):
    thread_id = "consume-sync-new-frontend-wait"
    model = _WaitThenNewWaitModel()
    tools = [_tool("first_lookup"), _tool("second_lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="start")],
        ),
    )
    [first_wire_id] = _wire_ids(first)
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "consume",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id=first_wire_id,
                    content="first exact",
                )
            ],
        ),
    )
    [second_wire_id] = _wire_ids(failed)
    assert EventType.RUN_ERROR in _types(failed)
    assert second_wire_id not in _end_ids(failed)
    assert model.calls == 2

    recovered = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[
                ToolMessage(
                    id="duplicate-first-result",
                    tool_call_id=first_wire_id,
                    content="ignored",
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(recovered)
    assert second_wire_id in _end_ids(recovered)
    assert EventType.RUN_FINISHED in _types(recovered)
    assert model.calls == 2
    replacement = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert replacement.last_completed_wire_ids == (first_wire_id,)
    assert replacement.call_for_wire_id(second_wire_id) is not None

    resumed = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-4",
            messages=[
                UserMessage(id="user-1", content="start"),
                ToolMessage(
                    id="duplicate-first-result",
                    tool_call_id=first_wire_id,
                    content="ignored",
                ),
                ToolMessage(
                    id="second-result",
                    tool_call_id=second_wire_id,
                    content="second exact",
                ),
            ],
        ),
    )
    assert EventType.RUN_ERROR not in _types(resumed)
    assert model.calls == 3
    assert "second exact" in repr(model.seen_messages[-1])


@pytest.mark.asyncio
async def test_fresh_retry_reconstructs_new_wait_after_its_initial_sync_fails(
    tmp_path: Path,
):
    thread_id = "superseding-frontend-wait-sync-failure"
    model = _WaitThenNewWaitModel()
    tools = [_tool("first_lookup"), _tool("second_lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="start")],
        ),
    )
    [first_wire_id] = _wire_ids(first)
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingSupersedingWaitSyncManager,
            manager_kwargs={"failure_counter": failure_counter},
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="first-result",
                    tool_call_id=first_wire_id,
                    content="first exact",
                )
            ],
        ),
    )
    [second_wire_id] = _wire_ids(failed)
    assert failure_counter["count"] == 1
    assert EventType.RUN_ERROR in _types(failed)
    assert second_wire_id not in _end_ids(failed)
    assert model.calls == 2
    stranded = _restored_core(model, tmp_path, thread_id)
    stranded_batch = load_frontend_tool_wait(stranded.state)
    assert stranded_batch.calls == ()
    assert stranded_batch.last_completed_wire_ids == (first_wire_id,)
    assert stranded._interrupt_state.activated is True

    rejected_new_user = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            [],
            run_id="run-3",
            messages=[
                UserMessage(id="user-1", content="start"),
                ToolMessage(
                    id="duplicate-first-result-with-new-user",
                    tool_call_id=first_wire_id,
                    content="ignored",
                ),
                UserMessage(id="user-2", content="do something new"),
            ],
        ),
    )
    assert [
        event.code for event in rejected_new_user if event.type == EventType.RUN_ERROR
    ] == ["INTERRUPT_RESUME_ERROR"]
    assert second_wire_id not in _end_ids(rejected_new_user)
    assert model.calls == 2

    recovered = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            [],
            run_id="run-4",
            messages=[
                UserMessage(id="user-1", content="start"),
                ToolMessage(
                    id="duplicate-first-result",
                    tool_call_id=first_wire_id,
                    content="ignored",
                ),
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(recovered)
    assert second_wire_id in _end_ids(recovered)
    assert model.calls == 2
    replacement = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert replacement.call_for_wire_id(second_wire_id) is not None
    assert replacement.last_completed_wire_ids == (first_wire_id,)

    resumed = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-5",
            messages=[
                ToolMessage(
                    id="second-result",
                    tool_call_id=second_wire_id,
                    content="second exact",
                )
            ],
        ),
    )
    assert EventType.RUN_ERROR not in _types(resumed)
    assert model.calls == 3


@pytest.mark.asyncio
async def test_fresh_retry_reconstructs_initial_multi_wait_after_sync_fails(
    tmp_path: Path,
):
    thread_id = "initial-multi-wait-sync-failure"
    model = _PersistenceModel(("lookup", "details"))
    tools = [_tool("lookup"), _tool("details")]
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "initial",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look up both")],
        ),
    )

    wire_ids = _wire_ids(failed)
    assert len(wire_ids) == 2
    assert failure_counter["count"] == 1
    assert EventType.RUN_ERROR in _types(failed)
    assert _end_ids(failed) == []
    assert model.calls == 1
    stranded = _restored_core(model, tmp_path, thread_id)
    stranded_batch = load_frontend_tool_wait(stranded.state)
    assert stranded_batch.calls == ()
    assert stranded_batch.last_completed_wire_ids == ()
    assert stranded._interrupt_state.activated is True

    recovered = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(thread_id, [], run_id="run-2", messages=[]),
    )

    assert EventType.RUN_ERROR not in _types(recovered)
    assert _end_ids(recovered) == wire_ids
    assert EventType.RUN_FINISHED in _types(recovered)
    assert model.calls == 1
    replacement = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert [call.wire_tool_call_id for call in replacement.calls] == wire_ids
    assert replacement.last_completed_wire_ids == ()


@pytest.mark.asyncio
async def test_fresh_retry_recovers_consumed_combined_checkpoint_idempotently(
    tmp_path: Path,
):
    thread_id = "consume-sync-combined-checkpoint"
    server_name = "approve_server"
    model = _PersistenceModel(("lookup", server_name))
    tools = [_tool("lookup")]
    core_tools = [_backend_tool(server_name)]
    behaviors = {server_name: ToolBehavior(interrupt_on_call=True)}
    first = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    [wire_id] = [
        event.tool_call_id
        for event in first
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == "lookup"
    ]
    finished = next(event for event in first if event.type == EventType.RUN_FINISHED)
    [server_interrupt] = finished.outcome.interrupts
    resume_entries = [
        ResumeEntry(
            interrupt_id=server_interrupt.id,
            status="resolved",
            payload={"approved": True},
        )
    ]
    tool_result = ToolMessage(
        id="result",
        tool_call_id=wire_id,
        content="exact",
    )
    failure_counter = {"count": 0}

    failed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            manager_type=_FailingWaitSyncManager,
            manager_kwargs={
                "fail_when": "consume",
                "failure_limit": 1,
                "failure_counter": failure_counter,
            },
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[tool_result],
            resume=resume_entries,
        ),
    )
    assert EventType.RUN_ERROR in _types(failed)
    assert model.calls == 2

    retried = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[tool_result],
            resume=resume_entries,
        ),
    )

    assert _types(retried) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert retried[-1].outcome.type == "success"
    assert model.calls == 2
    finalized = _restored_core(model, tmp_path, thread_id)
    finalized_batch = load_frontend_tool_wait(finalized.state)
    assert finalized_batch.calls == ()
    assert finalized_batch.last_completed_wire_ids == (wire_id,)
    pending, fingerprint = _load_persisted_interrupt_bookkeeping(finalized)
    assert pending == {}
    assert isinstance(fingerprint, str) and fingerprint


@pytest.mark.asyncio
async def test_completed_combined_replay_rejects_genuine_new_user(
    tmp_path: Path,
):
    thread_id = "completed-combined-replay-with-new-user"
    server_name = "approve_server"
    model = _PersistenceModel(("lookup", server_name))
    tools = [_tool("lookup")]
    core_tools = [_backend_tool(server_name)]
    behaviors = {server_name: ToolBehavior(interrupt_on_call=True)}
    first = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="call both")],
        ),
    )
    [wire_id] = [
        event.tool_call_id
        for event in first
        if event.type == EventType.TOOL_CALL_START and event.tool_call_name == "lookup"
    ]
    first_finished = next(
        event for event in first if event.type == EventType.RUN_FINISHED
    )
    [server_interrupt] = first_finished.outcome.interrupts
    resume_entries = [
        ResumeEntry(
            interrupt_id=server_interrupt.id,
            status="resolved",
            payload={"approved": True},
        )
    ]
    tool_result = ToolMessage(
        id="result",
        tool_call_id=wire_id,
        content="exact",
    )
    completed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[tool_result],
            resume=resume_entries,
        ),
    )
    assert EventType.RUN_ERROR not in _types(completed)
    assert model.calls == 2

    replayed = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-3",
            messages=[tool_result],
            resume=resume_entries,
        ),
    )
    assert _types(replayed) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert replayed[-1].outcome.type == "success"
    assert model.calls == 2

    rejected = await _collect(
        _adapter(
            model,
            tools,
            tmp_path,
            thread_id,
            core_tools=core_tools,
            tool_behaviors=behaviors,
        ),
        _input(
            thread_id,
            tools,
            run_id="run-4",
            messages=[
                tool_result,
                UserMessage(id="user-2", content="do something new"),
            ],
            resume=resume_entries,
        ),
    )

    assert [event.code for event in rejected if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_RESUME_ERROR"
    ]
    assert EventType.RUN_FINISHED not in _types(rejected)
    assert model.calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("malformed_reason", [False, True])
async def test_missing_wait_state_for_restored_tagged_interrupt_uses_provenance(
    tmp_path: Path,
    malformed_reason: bool,
):
    thread_id = "missing-metadata"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    core = _restored_core(model, tmp_path, thread_id)
    core.state.delete(FRONTEND_TOOL_WAIT_STATE_KEY)
    if malformed_reason:
        [native_interrupt] = core._interrupt_state.interrupts.values()
        native_interrupt.reason = {}
    core._session_manager.sync_agent(core)

    events = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(thread_id, tools, run_id="run-2", messages=[]),
    )

    errors = [event for event in events if event.type == EventType.RUN_ERROR]
    if malformed_reason:
        assert [event.code for event in errors] == ["INTERRUPT_RESUME_ERROR"]
        assert EventType.RUN_FINISHED not in _types(events)
    else:
        assert errors == []
        assert EventType.TOOL_CALL_END in _types(events)
        assert EventType.RUN_FINISHED in _types(events)
    assert model.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", ["native-id", "answered", "native-name"])
async def test_active_wait_metadata_is_audited_before_any_request_mutation(
    tmp_path: Path,
    corruption: str,
):
    thread_id = "corrupt-metadata"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    assert _wire_ids(first)
    core = _restored_core(model, tmp_path, thread_id)
    batch = load_frontend_tool_wait(core.state)
    if corruption == "native-id":
        bad_call = FrontendToolWaitCall(
            interrupt_id=batch.calls[0].interrupt_id,
            native_tool_use_id="wrong-native-id",
            wire_tool_call_id=batch.calls[0].wire_tool_call_id,
        )
        core.state.set(
            FRONTEND_TOOL_WAIT_STATE_KEY,
            FrontendToolWaitBatch(
                calls=[bad_call],
                checkpoint_message_ids=batch.checkpoint_message_ids,
            ).to_dict(),
        )
    elif corruption == "answered":
        core._interrupt_state.interrupts[batch.calls[0].interrupt_id].response = {
            "already": "answered"
        }
    else:
        core._interrupt_state.interrupts[
            batch.calls[0].interrupt_id
        ].name = "wrong-native-name"
    core._session_manager.sync_agent(core)

    events = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(thread_id, tools, run_id="run-2", messages=[]),
    )

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_RESUME_ERROR"
    ]
    assert model.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing_state_key",
    [AG_UI_WIRE_MAP_STATE_KEY, AG_UI_TOOL_CALL_MAP_STATE_KEY],
    ids=["wire-map", "tool-call-map"],
)
async def test_fresh_session_rejects_missing_active_wait_provenance_before_staging(
    tmp_path: Path,
    missing_state_key: str,
):
    thread_id = f"missing-active-provenance-{missing_state_key}"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)
    core = _restored_core(model, tmp_path, thread_id)
    core.state.delete(missing_state_key)
    core._session_manager.sync_agent(core)

    events = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                ToolMessage(
                    id="candidate-result",
                    tool_call_id=wire_id,
                    content="must-not-stage",
                )
            ],
        ),
    )

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_RESUME_ERROR"
    ]
    assert model.calls == 1
    persisted = load_frontend_tool_wait(
        _restored_core(model, tmp_path, thread_id).state
    )
    assert persisted.calls[0].has_response is False


@pytest.mark.parametrize(
    "mutate",
    [
        lambda data: data.update(last_completed_wire_ids=[""]),
        lambda data: data.update(last_completed_wire_ids=["done", "done"]),
        lambda data: data["calls"][0].update(content="impossible"),
        lambda data: data["calls"][0].update(is_error=True),
    ],
    ids=[
        "empty-tombstone",
        "duplicate-tombstone",
        "unstaged-content",
        "unstaged-error",
    ],
)
def test_impossible_serialized_wait_shapes_fail_loudly(mutate):
    data = FrontendToolWaitBatch(
        calls=[
            FrontendToolWaitCall(
                interrupt_id="interrupt-1",
                native_tool_use_id="native-1",
                wire_tool_call_id="wire-1",
            )
        ]
    ).to_dict()
    mutate(data)

    with pytest.raises(ValueError):
        FrontendToolWaitBatch.from_dict(data)


@pytest.mark.asyncio
async def test_without_manager_same_wrapper_continues():
    thread_id = "memory-only"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    adapter = _adapter(model, tools, None, thread_id)
    first = await _collect(
        adapter,
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)
    second = await _collect(
        adapter,
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="ok")],
        ),
    )

    assert EventType.RUN_ERROR not in _types(second)
    assert model.calls == 2
    assert adapter.config.session_manager_provider is None


def _assert_unrecoverable_wait_error(events: Sequence[Any]) -> None:
    errors = [event for event in events if event.type == EventType.RUN_ERROR]
    assert [event.code for event in errors] == ["INTERRUPT_RESUME_ERROR"]
    assert "compatible shared SessionManager" in errors[0].message
    assert "stable agent_id" in errors[0].message
    assert EventType.RUN_FINISHED not in _types(events)


@pytest.mark.asyncio
async def test_fresh_wrapper_without_manager_rejects_unrecoverable_wait_result():
    thread_id = "memory-only-recreated"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, None, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    second = await _collect(
        _adapter(model, tools, None, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="ok")],
        ),
    )

    _assert_unrecoverable_wait_error(second)
    assert model.calls == 1


@pytest.mark.asyncio
async def test_fresh_wrapper_opaque_result_without_tools_or_provenance_fails_closed():
    thread_id = "opaque-no-tools"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, None, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)
    recreated = _adapter(model, [], None, thread_id)

    events = await _collect(
        recreated,
        _input(
            thread_id,
            [],
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="ok")],
        ),
    )

    _assert_unrecoverable_wait_error(events)
    assert model.calls == 1
    assert recreated._agents_by_thread[thread_id].messages == []


@pytest.mark.asyncio
async def test_mixed_provenance_tail_rejects_atomically_before_core_mutation():
    thread_id = "mixed-provenance-atomic"
    model = _PersistenceModel()
    tools = [_tool("client")]
    behaviors = {"client": ToolBehavior(continue_after_frontend_call=True)}
    adapter = _adapter(
        model,
        tools,
        None,
        thread_id,
        tool_behaviors=behaviors,
    )
    input_data = _input(
        thread_id,
        tools,
        run_id="run-1",
        messages=[
            AssistantMessage(
                id="assistant-call",
                content="",
                tool_calls=[
                    ToolCall(
                        id="proven-wire",
                        function=FunctionCall(name="client", arguments="{}"),
                    )
                ],
            ),
            ToolMessage(id="proven-result", tool_call_id="proven-wire", content="ok"),
            ToolMessage(id="opaque-result", tool_call_id="opaque-wire", content="no"),
        ],
    )
    original_input = input_data.model_copy(deep=True)

    events = await _collect(adapter, input_data)

    _assert_unrecoverable_wait_error(events)
    assert model.calls == 0
    core = adapter._agents_by_thread[thread_id]
    assert core.messages == []
    assert core.state.get() == {}
    assert core.tool_registry.registry == {}
    assert input_data == original_input


@pytest.mark.asyncio
async def test_wrong_agent_id_rejects_unrestored_wait_result(tmp_path: Path):
    thread_id = "wrong-agent-id"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id, agent_id="right-agent"),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    second = await _collect(
        _adapter(model, tools, tmp_path, thread_id, agent_id="wrong-agent"),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="ok")],
        ),
    )

    _assert_unrecoverable_wait_error(second)
    assert model.calls == 1
    restored = _restored_core(
        model,
        tmp_path,
        thread_id,
        agent_id="right-agent",
    )
    batch = load_frontend_tool_wait(restored.state)
    assert len(batch.calls) == 1
    assert restored._interrupt_state.activated is True


@pytest.mark.asyncio
async def test_restored_false_mode_wire_provenance_without_wait_checkpoint_fails(
    tmp_path: Path,
):
    thread_id = "incomplete-wait-checkpoint"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    core = _restored_core(model, tmp_path, thread_id)
    native_id = core.state.get(AG_UI_WIRE_MAP_STATE_KEY)[wire_id]
    call_meta = core.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)[native_id]
    assert call_meta["is_proxy"] is True
    assert call_meta["continue_after_frontend_call"] is False
    core.state.delete(FRONTEND_TOOL_WAIT_STATE_KEY)
    core._interrupt_state.deactivate()
    core._session_manager.sync_agent(core)

    events = await _collect(
        _adapter(model, tools, tmp_path, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="ok")],
        ),
    )

    _assert_unrecoverable_wait_error(events)
    assert model.calls == 1


@pytest.mark.asyncio
async def test_fresh_wrapper_allows_explicit_continue_true_result():
    thread_id = "continue-true-recreated"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    behaviors = {"lookup": ToolBehavior(continue_after_frontend_call=True)}
    first = await _collect(
        _adapter(model, tools, None, thread_id, tool_behaviors=behaviors),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)
    assert model.calls == 2

    second = await _collect(
        _adapter(model, tools, None, thread_id, tool_behaviors=behaviors),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                AssistantMessage(
                    id="assistant-call",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=wire_id,
                            function=FunctionCall(
                                name="lookup",
                                arguments='{"value":"requested"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(id="result", tool_call_id=wire_id, content="ok"),
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(second)
    assert EventType.RUN_FINISHED in _types(second)
    assert model.calls == 3


@pytest.mark.asyncio
async def test_fresh_wrapper_full_history_rejects_explicit_wait_mode_result():
    thread_id = "wait-mode-full-history"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, None, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    second = await _collect(
        _adapter(model, tools, None, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                AssistantMessage(
                    id="assistant-call",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=wire_id,
                            function=FunctionCall(
                                name="lookup",
                                arguments='{"value":"requested"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(id="result", tool_call_id=wire_id, content="ok"),
            ],
        ),
    )

    _assert_unrecoverable_wait_error(second)
    assert model.calls == 1


@pytest.mark.asyncio
async def test_fresh_wrapper_full_history_without_current_tools_rejects_wait_result():
    thread_id = "wait-mode-full-history-no-tools"
    model = _PersistenceModel()
    tools = [_tool("lookup")]
    first = await _collect(
        _adapter(model, tools, None, thread_id),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="look it up")],
        ),
    )
    [wire_id] = _wire_ids(first)

    second = await _collect(
        _adapter(model, [], None, thread_id),
        _input(
            thread_id,
            [],
            run_id="run-2",
            messages=[
                AssistantMessage(
                    id="assistant-call",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=wire_id,
                            function=FunctionCall(
                                name="lookup",
                                arguments='{"value":"requested"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(id="result", tool_call_id=wire_id, content="ok"),
            ],
        ),
    )

    _assert_unrecoverable_wait_error(second)
    assert model.calls == 1


@pytest.mark.asyncio
async def test_fresh_wrapper_opaque_mixed_modes_is_unrecoverable():
    thread_id = "mixed-modes-opaque"
    model = _PersistenceModel(("continue_tool",))
    tools = [_tool("wait_tool"), _tool("continue_tool")]
    behaviors = {
        "continue_tool": ToolBehavior(continue_after_frontend_call=True),
    }
    first = await _collect(
        _adapter(model, tools, None, thread_id, tool_behaviors=behaviors),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="continue")],
        ),
    )
    [wire_id] = _wire_ids(first)
    assert model.calls == 2

    second = await _collect(
        _adapter(model, tools, None, thread_id, tool_behaviors=behaviors),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[ToolMessage(id="result", tool_call_id=wire_id, content="ok")],
        ),
    )

    _assert_unrecoverable_wait_error(second)
    assert model.calls == 2


@pytest.mark.asyncio
async def test_fresh_wrapper_mixed_modes_uses_assistant_call_provenance_for_true_mode():
    thread_id = "mixed-modes-recreated"
    model = _PersistenceModel(("continue_tool",))
    tools = [_tool("wait_tool"), _tool("continue_tool")]
    behaviors = {
        "continue_tool": ToolBehavior(continue_after_frontend_call=True),
    }
    first = await _collect(
        _adapter(model, tools, None, thread_id, tool_behaviors=behaviors),
        _input(
            thread_id,
            tools,
            run_id="run-1",
            messages=[UserMessage(id="user-1", content="continue")],
        ),
    )
    [wire_id] = _wire_ids(first)
    assert model.calls == 2

    second = await _collect(
        _adapter(model, tools, None, thread_id, tool_behaviors=behaviors),
        _input(
            thread_id,
            tools,
            run_id="run-2",
            messages=[
                AssistantMessage(
                    id="assistant-call",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=wire_id,
                            function=FunctionCall(
                                name="continue_tool",
                                arguments='{"value":"requested"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(id="result", tool_call_id=wire_id, content="ok"),
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _types(second)
    assert EventType.RUN_FINISHED in _types(second)
    assert model.calls == 3


class TestRestorationAuditSkipsOnlyForeignCores:
    """Which cores join the audit is decided by shape, not by provenance.

    The audit reads ``activated`` and ``interrupts`` off the core's native
    checkpoint. A core that cannot answer those two questions is skipped. That
    is a question about the object, not about where it was constructed, and a
    stand-in that answers them faithfully takes part like any other core.
    """

    def test_a_real_core_takes_part(self):
        assert _is_native_interrupt_state(
            Agent(model=_PersistenceModel(), tools=[])._interrupt_state
        )
        # And the audit reached its real work rather than short-circuiting.
        assert _guard_rejects([ToolMessage(id="r", tool_call_id="wire", content="ok")])

    def test_a_faithful_stand_in_takes_part(self):
        assert _is_native_interrupt_state(
            SimpleNamespace(activated=False, interrupts={})
        )

    @pytest.mark.parametrize(
        "interrupt_state",
        [
            None,
            SimpleNamespace(),
            SimpleNamespace(activated=False),
            SimpleNamespace(interrupts={}),
            SimpleNamespace(activated="yes", interrupts={}),
            SimpleNamespace(activated=False, interrupts=[]),
            MagicMock(),
        ],
        ids=[
            "absent",
            "empty",
            "no-interrupts",
            "no-activated",
            "activated-not-a-bool",
            "interrupts-not-a-mapping",
            "answers-everything-with-nothing",
        ],
    )
    def test_a_core_that_cannot_answer_is_skipped(self, interrupt_state: Any):
        assert not _is_native_interrupt_state(interrupt_state)
        assert not _has_unrecoverable_frontend_wait_result(
            _input("skip-thread", (), run_id="skip-run", messages=[]),
            SimpleNamespace(_interrupt_state=interrupt_state),
            FrontendToolWaitBatch(),
            {},
        )


class TestSessionWritesStayOffTheEventLoop:
    """A backend write must not stall every other request in the process.

    ``SessionManager.sync_agent`` is synchronous and writes to a file, a
    database or S3. This path calls it many times per request, so inline it
    holds the loop — and therefore every concurrent stream — for the duration
    of each write.
    """

    class _BlockingSessionManager:
        def __init__(self) -> None:
            self.started = threading.Event()
            self.release = threading.Event()
            self.threads: list[int] = []

        def sync_agent(self, agent: Any) -> None:
            del agent
            self.threads.append(threading.get_ident())
            self.started.set()
            assert self.release.wait(timeout=5.0)

    async def test_the_loop_keeps_running_during_a_write(self):
        session_manager = self._BlockingSessionManager()
        agent = SimpleNamespace(
            session_manager=session_manager, _session_manager=None
        )

        write = asyncio.create_task(_sync_session_state(agent))

        async def wait_for_the_write_to_start() -> None:
            while not session_manager.started.is_set():
                await asyncio.sleep(0.001)

        try:
            # Only reachable if the loop is still scheduling coroutines while
            # the write is in flight. Inline, this deadlocks until the timeout.
            await asyncio.wait_for(wait_for_the_write_to_start(), timeout=5.0)
        finally:
            session_manager.release.set()
            await asyncio.wait_for(write, timeout=5.0)

        assert session_manager.threads == [session_manager.threads[0]]
        assert threading.get_ident() not in session_manager.threads

    async def test_the_write_still_completes_before_the_caller_resumes(self):
        session_manager = self._BlockingSessionManager()
        session_manager.release.set()
        agent = SimpleNamespace(
            session_manager=session_manager, _session_manager=None
        )

        await asyncio.wait_for(_sync_session_state(agent), timeout=5.0)

        assert session_manager.started.is_set()

    async def test_an_unmanaged_agent_writes_nothing(self):
        await _sync_session_state(
            SimpleNamespace(session_manager=None, _session_manager=None)
        )
