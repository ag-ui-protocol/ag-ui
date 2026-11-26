import json
from dataclasses import asdict
from types import SimpleNamespace
import pytest
from ag_ui_claude_managed_agents import (
    InMemorySessionStore,
    SessionRecord,
    SessionBinding,
)
from ag_ui_claude_managed_agents import state
from .test_agent import base_input, collect, new_agent, IDLE_END_TURN, SESSION_KEY
from .fake_client import FakeClient


def call(id, args, **kw):
    return {
        "id": id,
        "type": "agent.custom_tool_use",
        "name": state.NAME,
        "input": args,
        **kw,
    }


def snapshots(events):
    return [e.snapshot for e in events if e.type == "STATE_SNAPSHOT"]


async def test_model_updates_state_merge_deletes_and_restart_clears():
    fake = FakeClient(
        streams=[
            [
                call(
                    "write",
                    {
                        "operation": "merge_patch",
                        "patch": {"board": {"count": 2, "remove": None}, "items": [2]},
                        "expectedRevision": 1,
                    },
                ),
                IDLE_END_TURN,
            ],
            [IDLE_END_TURN],
            [IDLE_END_TURN],
        ]
    )
    store = InMemorySessionStore()
    original = {"board": {"count": 1, "remove": "gone"}, "items": [1]}
    events = await collect(new_agent(fake, store), base_input(state=original))
    assert events[-1].type == "RUN_FINISHED"
    updated = {"board": {"count": 2}, "items": [2]}
    assert snapshots(events) == [original, updated]
    record = store.get(SESSION_KEY)
    assert record.shared_state == updated and record.state_revision == 2
    cold = InMemorySessionStore()
    cold.set(SESSION_KEY, SessionRecord(**json.loads(json.dumps(asdict(record)))))
    next_input = base_input(
        state=None,
        messages=[{"id": "u2", "role": "user", "content": "read retained state"}],
    )
    events = await collect(new_agent(fake, cold), next_input)
    assert snapshots(events) == [updated]
    assert len(fake.sent[-1]["events"]) == 1
    events = await collect(
        new_agent(fake, cold),
        base_input(
            state={}, messages=[{"id": "u3", "role": "user", "content": "clear"}]
        ),
    )
    assert snapshots(events)[-1] == {}
    assert cold.get(SESSION_KEY).state_revision == 3
    assert original["board"]["remove"] == "gone"


@pytest.mark.parametrize("failure", [0, 1])
async def test_failed_native_send_never_commits(failure):
    fake = FakeClient(
        streams=[
            [
                call(
                    "write",
                    {
                        "operation": "replace",
                        "state": {"count": 2},
                        "expectedRevision": 1,
                    },
                ),
                IDLE_END_TURN,
            ]
        ],
        send_failures={failure: RuntimeError("offline")},
    )
    store = InMemorySessionStore()
    events = await collect(new_agent(fake, store), base_input(state={"count": 1}))
    assert events[-1].type == "RUN_ERROR"
    assert store.get(SESSION_KEY).shared_state == (
        None if failure == 0 else {"count": 1}
    )
    assert snapshots(events) == ([] if failure == 0 else [{"count": 1}])


@pytest.mark.parametrize(
    "args",
    [
        {"operation": "replace", "state": {}, "expectedRevision": 99},
        {"operation": "replace", "state": {"__proto__": {}}, "expectedRevision": 1},
        {"operation": "replace", "state": [], "expectedRevision": 1},
    ],
)
async def test_invalid_model_write_is_error_and_keeps_state(args):
    fake = FakeClient(streams=[[call("write", args), IDLE_END_TURN]])
    store = InMemorySessionStore()
    events = await collect(new_agent(fake, store), base_input(state={"count": 1}))
    assert events[-1].type == "RUN_FINISHED"
    assert fake.sent[-1]["events"][0]["is_error"] is True
    assert store.get(SESSION_KEY).state_revision == 1


def native(record, revision, value, **kwargs):
    e = state.envelope(record, value)
    e["revision"] = revision
    return {
        "id": f"e{revision}",
        "type": "system.message",
        "content": [{"type": "text", "text": state.encode(e)}],
        **kwargs,
    }


def test_recovery_owner_order_duplicates_and_failed_results():
    record = SessionRecord("sesn_1", primary_thread_id="primary")
    good = native(record, 2, {"valid": True}, session_thread_id="primary")
    history = [
        good,
        good,
        native(record, 1, {"stale": True}),
        native(record, 2, {"conflict": True}, id="conflict"),
        native(record, 3, {"child": True}, session_thread_id="child"),
        {**native(record, 9, {"wrong": True}), "session_id": "other"},
        call("c", {}),
        {
            **native(record, 10, {"failed": True}),
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "c",
            "is_error": True,
        },
    ]
    emitted = []
    state.restore(history, record, emitted.append)
    assert record.shared_state == {"valid": True} and record.state_revision == 2


async def test_import_appends_reserved_tool_preserving_actual_catalog():
    foreign = {
        "type": "custom",
        "name": "imported",
        "description": "original",
        "input_schema": {"type": "object"},
    }
    fake = FakeClient(agent_tools=[foreign], streams=[[IDLE_END_TURN]])
    fake.history = [IDLE_END_TURN]
    store = InMemorySessionStore()
    events = await collect(
        new_agent(
            fake,
            store,
            resolve_session=lambda _: SessionBinding(
                "sesn_1", last_user_message_id="old"
            ),
        ),
        base_input(state={"imported": True}),
    )
    assert events[-1].type == "RUN_FINISHED"
    assert fake.update_calls[0][1]["agent"]["tools"] == [foreign, state.definition()]
    assert store.get(SESSION_KEY).shared_state == {"imported": True}


async def test_primary_native_thread_write_and_child_cannot_overwrite():
    fake = FakeClient(
        streams=[
            [
                call(
                    "primary_call",
                    {
                        "operation": "replace",
                        "state": {"count": 2},
                        "expectedRevision": 1,
                    },
                    session_thread_id="primary",
                ),
                call(
                    "child_call",
                    {
                        "operation": "replace",
                        "state": {"count": 99},
                        "expectedRevision": 2,
                    },
                    session_thread_id="child",
                ),
                IDLE_END_TURN,
            ]
        ]
    )

    async def threads(_):
        return [
            {"id": "primary", "session_id": "sesn_1", "parent_thread_id": None},
            {"id": "child", "session_id": "sesn_1", "parent_thread_id": "primary"},
        ]

    fake.beta.sessions.threads = SimpleNamespace(list=threads)
    store = InMemorySessionStore()
    events = await collect(new_agent(fake, store), base_input(state={"count": 1}))
    assert snapshots(events)[-1] == {"count": 2}
    assert len(fake.sent) == 2


async def test_approval_only_defers_state_without_committing():
    from .test_recovery import RecoveryClient, call as approval_call, idle

    fake = RecoveryClient(
        [[approval_call("approve"), idle(["approve"])]], streams=[[IDLE_END_TURN]]
    )
    store = InMemorySessionStore()
    events = await collect(
        new_agent(fake, store, resolve_session=lambda _: SessionBinding("sesn_1")),
        base_input(
            state={"deferred": True},
            messages=[],
            resume=[
                {"interruptId": "approve", "status": "resolved", "payload": "allow"}
            ],
        ),
    )
    assert events[-1].type == "RUN_FINISHED"
    assert snapshots(events) == []
    assert store.get(SESSION_KEY).shared_state is None
    assert fake.sent[0]["events"] == [
        {"type": "user.tool_confirmation", "tool_use_id": "approve", "result": "allow"}
    ]


async def test_imported_pending_state_write_checks_catalog_and_commits():
    from .test_recovery import RecoveryClient, idle

    pending = call(
        "pending",
        {"operation": "replace", "state": {"recovered": True}, "expectedRevision": 0},
    )
    fake = RecoveryClient(
        [[pending, idle(["pending"])]],
        agent_tools=[state.definition()],
        streams=[[IDLE_END_TURN]],
    )
    store = InMemorySessionStore()
    events = await collect(
        new_agent(fake, store, resolve_session=lambda _: SessionBinding("sesn_1")),
        base_input(state=None, messages=[]),
    )
    assert events[-1].type == "RUN_FINISHED"
    assert store.get(SESSION_KEY).shared_state == {"recovered": True}
    assert fake.update_calls == []
    assert fake.sent[0]["events"][0]["custom_tool_use_id"] == "pending"


async def test_imported_conflicting_reserved_name_does_not_mutate_state():
    from .test_recovery import RecoveryClient, idle

    pending = call(
        "pending",
        {"operation": "replace", "state": {"malicious": True}, "expectedRevision": 0},
    )
    fake = RecoveryClient(
        [[pending, idle(["pending"])]],
        agent_tools=[{**state.definition(), "description": "unrelated tool"}],
        streams=[[IDLE_END_TURN]],
    )
    store = InMemorySessionStore()
    events = await collect(
        new_agent(fake, store, resolve_session=lambda _: SessionBinding("sesn_1")),
        base_input(state=None, messages=[]),
    )
    assert events[-1].type == "RUN_ERROR"
    assert store.get(SESSION_KEY).shared_state is None
    assert fake.sent == []
    assert fake.update_calls == []


async def test_noop_patch_keeps_revision_and_replacement_preserves_null():
    fake = FakeClient(
        streams=[
            [
                call(
                    "noop",
                    {"operation": "merge_patch", "patch": {}, "expectedRevision": 1},
                ),
                call(
                    "replace",
                    {
                        "operation": "replace",
                        "state": {"nullable": None},
                        "expectedRevision": 1,
                    },
                ),
                IDLE_END_TURN,
            ]
        ]
    )
    store = InMemorySessionStore()
    events = await collect(new_agent(fake, store), base_input(state={"before": True}))
    assert snapshots(events) == [{"before": True}, {"nullable": None}]
    assert store.get(SESSION_KEY).state_revision == 2


def test_canonical_tool_contract():
    from pathlib import Path

    assert state.definition() == json.loads(
        (Path(__file__).parents[2] / "contracts/state-tool-v1.json").read_text()
    )


async def test_recovered_state_result_consumes_model_continuation():
    from .test_recovery import RecoveryClient, idle

    pending = call(
        "pending",
        {"operation": "replace", "state": {"recovered": True}, "expectedRevision": 0},
    )
    fake = RecoveryClient(
        [[pending, idle(["pending"])]],
        agent_tools=[state.definition()],
        streams=[
            [
                {
                    "type": "agent.message",
                    "id": "after_commit",
                    "content": [{"type": "text", "text": "State saved."}],
                },
                IDLE_END_TURN,
            ]
        ],
    )
    events = await collect(
        new_agent(fake, resolve_session=lambda _: SessionBinding("sesn_1")),
        base_input(state=None, messages=[]),
    )
    assert any(
        e.type == "TOOL_CALL_RESULT" and e.tool_call_id == "pending" for e in events
    )
    assert any(
        e.type == "TEXT_MESSAGE_CONTENT" and e.delta == "State saved." for e in events
    )
    assert events[-1].type == "RUN_FINISHED"


async def test_empty_patch_absent_state_does_not_invent_snapshot():
    fake = FakeClient(
        streams=[
            [
                call(
                    "noop",
                    {"operation": "merge_patch", "patch": {}, "expectedRevision": 0},
                ),
                IDLE_END_TURN,
            ]
        ]
    )
    store = InMemorySessionStore()
    events = await collect(new_agent(fake, store), base_input(state=None))
    assert snapshots(events) == []
    assert store.get(SESSION_KEY).shared_state is None
    assert store.get(SESSION_KEY).state_revision == 0
    assert fake.sent[-1]["events"][0]["is_error"] is False


async def test_boolean_number_changes_are_real_state_updates():
    fake = FakeClient(
        streams=[
            [
                call(
                    "number",
                    {
                        "operation": "replace",
                        "state": {"nested": [1]},
                        "expectedRevision": 1,
                    },
                ),
                IDLE_END_TURN,
            ],
            [IDLE_END_TURN],
        ]
    )
    store = InMemorySessionStore()
    events = await collect(new_agent(fake, store), base_input(state={"nested": [True]}))
    assert store.get(SESSION_KEY).state_revision == 2
    assert type(snapshots(events)[-1]["nested"][0]) is int
    events = await collect(
        new_agent(fake, store),
        base_input(
            state={"nested": [True]},
            messages=[{"id": "u2", "role": "user", "content": "change to boolean"}],
        ),
    )
    assert store.get(SESSION_KEY).state_revision == 3
    assert type(snapshots(events)[-1]["nested"][0]) is bool


async def test_imported_frontend_reserved_override_rejected_before_dispatch():
    fake = FakeClient(
        streams=[
            [
                call("c", {"operation": "replace", "state": {}, "expectedRevision": 0}),
                IDLE_END_TURN,
            ]
        ]
    )
    events = await collect(
        new_agent(fake, resolve_session=lambda _: SessionBinding("sesn_1")),
        base_input(
            state=None,
            messages=[],
            tools=[{"name": state.NAME, "description": "frontend", "parameters": {}}],
        ),
    )
    assert events[-1].type == "RUN_ERROR"
    assert fake.sent == [] and fake.stream_calls == []


@pytest.mark.parametrize(
    "catalog",
    [
        [state.definition(), state.definition()],
        [{**state.definition(), "description": "conflicting base tool"}],
    ],
)
async def test_reserved_base_catalog_conflicts_rejected(catalog):
    fake = FakeClient(agent_tools=catalog)
    events = await collect(new_agent(fake), base_input())
    assert events[-1].type == "RUN_ERROR"
    assert fake.create_calls == []


@pytest.mark.parametrize("known", [False, True])
async def test_cold_pending_state_result_has_call_before_result_without_duplicates(
    known,
):
    from .test_recovery import RecoveryClient, idle

    args = {"operation": "replace", "state": {"recovered": True}, "expectedRevision": 0}
    pending = call("pending", args)
    fake = RecoveryClient(
        [[pending, idle(["pending"])]],
        agent_tools=[state.definition()],
        streams=[[IDLE_END_TURN]],
    )
    messages = (
        [
            {
                "id": "assistant",
                "role": "assistant",
                "toolCalls": [
                    {
                        "id": "pending",
                        "type": "function",
                        "function": {"name": state.NAME, "arguments": json.dumps(args)},
                    }
                ],
            }
        ]
        if known
        else []
    )
    events = await collect(
        new_agent(fake, resolve_session=lambda _: SessionBinding("sesn_1")),
        base_input(state=None, messages=messages),
    )
    tool_events = [
        e.type.value for e in events if getattr(e, "tool_call_id", None) == "pending"
    ]
    assert tool_events == (
        ["TOOL_CALL_RESULT"]
        if known
        else ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]
    )
    assert events[-1].type == "RUN_FINISHED"


@pytest.mark.parametrize("context_first", [False, True])
async def test_context_state_share_final_message_and_restore_independently(
    context_first,
):
    from ag_ui_claude_managed_agents.context import (
        attach_context,
        restore_context,
        split_outbound,
    )

    record = SessionRecord("sesn_1")
    events = [
        {
            "type": "user.custom_tool_result",
            "custom_tool_use_id": "pending",
            "content": [],
        },
        {
            "type": "user.tool_confirmation",
            "tool_use_id": "approval",
            "result": "allow",
        },
        {"type": "user.message", "content": [{"type": "text", "text": "next"}]},
    ]
    context = [SimpleNamespace(description="catalog", value="CounterCard")]
    if context_first:
        attach_context(events, context, record)
        state.attach(events, {"count": 1}, record)
    else:
        state.attach(events, {"count": 1}, record)
        attach_context(events, context, record)
    results, followups = split_outbound(events)
    assert [e["type"] for e in results] == [
        "user.tool_confirmation",
        "user.custom_tool_result",
        "system.message",
    ]
    assert [e["type"] for e in followups] == ["user.message"]
    blocks = results[-1]["content"]
    assert len(blocks) == 2
    assert state.decode(blocks, record)["state"] == {"count": 1}
    restore_context(blocks, record)
    assert json.loads(record.runtime_context) == [
        {"description": "catalog", "value": "CounterCard"}
    ]
    assert state.decode(blocks + blocks, record) is None
    record.runtime_context = None
    restore_context(blocks + blocks, record)
    assert record.runtime_context is None
