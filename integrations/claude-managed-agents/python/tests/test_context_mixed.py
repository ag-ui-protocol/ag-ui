"""Mixed real results and approvals deliver required context before continuation."""

import copy
import json
from types import SimpleNamespace

import pytest

from ag_ui_claude_managed_agents import (
    InMemorySessionStore,
    SessionBinding,
    SessionRecord,
)
from ag_ui_claude_managed_agents import state
from ag_ui_claude_managed_agents.context import HEADER, attach_context, split_outbound
from .test_agent import SESSION_KEY, IDLE_END_TURN, base_input, collect, new_agent
from .test_context import CONTEXT
from .test_recovery import RecoveryClient, call, idle


@pytest.mark.parametrize("result_first", [False, True])
@pytest.mark.parametrize("decision", ["allow", "deny"])
@pytest.mark.parametrize("is_error", [False, True])
@pytest.mark.parametrize("context_first", [False, True])
def test_mixed_batch_preserves_inputs_and_uses_one_supported_final_system(
    result_first, decision, is_error, context_first
):
    result = {
        "type": "user.custom_tool_result",
        "custom_tool_use_id": "original-custom",
        "is_error": is_error,
        "content": [{"type": "text", "text": "original result"}],
    }
    confirmation = {
        "type": "user.tool_confirmation",
        "tool_use_id": "original-native",
        "result": decision,
    }
    followup = {
        "type": "user.message",
        "content": [{"type": "text", "text": "real followup"}],
    }
    originals = copy.deepcopy([result, confirmation, followup])
    events = ([result, confirmation] if result_first else [confirmation, result]) + [
        followup
    ]
    record = SessionRecord("native")
    context = [SimpleNamespace(**entry) for entry in CONTEXT]
    if context_first:
        delivery = attach_context(events, context, record)
        state_delivery = state.attach(events, {"board": 2}, record)
    else:
        state_delivery = state.attach(events, {"board": 2}, record)
        delivery = attach_context(events, context, record)
    answers, followups = split_outbound(events)
    assert answers[:2] == [originals[1], originals[0]]
    assert [event["type"] for event in answers] == [
        "user.tool_confirmation",
        "user.custom_tool_result",
        "system.message",
    ]
    assert followups == [originals[2]]
    blocks = answers[-1]["content"]
    assert len(blocks) == 2
    assert (
        json.loads(
            next(
                block["text"][len(HEADER) :]
                for block in blocks
                if block["text"].startswith(HEADER)
            )
        )
        == CONTEXT
    )
    assert state.decode(blocks, record)["state"] == {"board": 2}
    assert record.runtime_context is None and record.shared_state is None
    assert delivery.with_results and state_delivery[1]


@pytest.mark.parametrize("result_first", [False, True])
@pytest.mark.parametrize("decision", ["allow", "deny"])
@pytest.mark.parametrize("is_error", [False, True])
async def test_mixed_recovery_sends_context_state_with_original_result_before_followup(
    result_first, decision, is_error
):
    custom = call("original-custom", kind="agent.custom_tool_use")
    native = call("original-native")
    history = ([custom, native] if result_first else [native, custom]) + [
        idle(["original-custom", "original-native"])
    ]
    fake = RecoveryClient([history], streams=[[IDLE_END_TURN]])
    store = InMemorySessionStore()
    agent = new_agent(
        fake,
        store,
        resolve_session=lambda _: SessionBinding("native", last_user_message_id="old"),
    )
    result = {
        "id": "result-message",
        "role": "tool",
        "toolCallId": "original-custom",
        "content": "original result",
    }
    if is_error:
        result["error"] = "original error"
    input = base_input(
        state={"board": 2},
        context=CONTEXT,
        resume=[
            {
                "interruptId": "original-native",
                "status": "resolved",
                "payload": decision,
            }
        ],
        messages=[
            {"id": "old", "role": "user", "content": "old"},
            result,
            {"id": "next", "role": "user", "content": "real followup"},
        ],
    )
    original = input.model_dump()
    events = await collect(agent, input)
    assert events[-1].type == "RUN_FINISHED"
    assert len(fake.sent) == 2
    answers, followups = [entry["events"] for entry in fake.sent]
    assert answers[0] == {
        "type": "user.tool_confirmation",
        "tool_use_id": "original-native",
        "result": decision,
    }
    assert answers[1] == {
        "type": "user.custom_tool_result",
        "custom_tool_use_id": "original-custom",
        "is_error": is_error,
        "content": [
            {
                "type": "text",
                "text": "original result\noriginal error"
                if is_error
                else "original result",
            }
        ],
    }
    assert [event["type"] for event in answers] == [
        "user.tool_confirmation",
        "user.custom_tool_result",
        "system.message",
    ]
    assert len(answers[-1]["content"]) == 2
    assert followups == [
        {"type": "user.message", "content": [{"type": "text", "text": "real followup"}]}
    ]
    record = store.get(SESSION_KEY)
    assert json.loads(record.runtime_context) == CONTEXT
    assert record.shared_state == {"board": 2}
    assert (
        record.pending_confirmations == [] and record.pending_client_tool_use_ids == []
    )
    assert input.model_dump() == original


@pytest.mark.parametrize("decision", ["allow", "deny"])
async def test_confirmation_plus_user_followup_cannot_deliver_required_context_late(
    decision,
):
    fake = RecoveryClient(
        [[call("original-native"), idle(["original-native"])]],
        streams=[[IDLE_END_TURN]],
    )
    store = InMemorySessionStore()
    agent = new_agent(
        fake,
        store,
        resolve_session=lambda _: SessionBinding("native", last_user_message_id="old"),
    )
    events = await collect(
        agent,
        base_input(
            state={"board": 2},
            context=CONTEXT,
            resume=[
                {
                    "interruptId": "original-native",
                    "status": "resolved",
                    "payload": decision,
                }
            ],
            messages=[
                {"id": "old", "role": "user", "content": "old"},
                {"id": "next", "role": "user", "content": "real followup"},
            ],
        ),
    )
    assert events[-1].type == "RUN_ERROR"
    assert events[-1].code == "context_delivery_unsupported"
    assert fake.sent == []
    record = store.get(SESSION_KEY)
    assert [entry["id"] for entry in record.pending_confirmations] == [
        "original-native"
    ]
    assert record.runtime_context is None and record.shared_state is None


@pytest.mark.parametrize("sibling", [False, True, "allow", "deny"])
async def test_pending_internal_state_delivers_required_context_with_its_real_result(
    sibling,
):
    args = {"operation": "merge_patch", "patch": {"count": 2}, "expectedRevision": 1}
    initial_record = SessionRecord("native")
    initial = {
        "id": "initial-state",
        "type": "system.message",
        "content": [
            {
                "type": "text",
                "text": state.encode(state.envelope(initial_record, {"count": 1})),
            }
        ],
    }
    pending = call(
        "original-state", kind="agent.custom_tool_use", name=state.NAME, input=args
    )
    history = [initial, pending]
    if sibling:
        history.append(call("sibling-approval"))
    history.append(idle(["original-state"] + (["sibling-approval"] if sibling else [])))
    fake = RecoveryClient(
        [history],
        agent_tools=[state.definition()],
        streams=[
            [
                {
                    "id": "continued",
                    "type": "agent.message",
                    "content": [{"type": "text", "text": "read the new catalog"}],
                },
                IDLE_END_TURN,
            ]
        ],
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(
        agent,
        base_input(
            context=CONTEXT,
            state={"stale-input": True},
            messages=[],
            resume=[
                {
                    "interruptId": "sibling-approval",
                    "status": "resolved",
                    "payload": sibling,
                }
            ]
            if isinstance(sibling, str)
            else [],
        ),
    )
    assert events[-1].type == "RUN_FINISHED"
    assert len(fake.sent) == (2 if isinstance(sibling, str) else 1)
    batch = fake.sent[0]["events"]
    assert [e["type"] for e in batch] == ["user.custom_tool_result", "system.message"]
    assert (
        batch[0]["custom_tool_use_id"] == "original-state"
        and batch[0]["is_error"] is False
    )
    committed = state.decode(batch[0]["content"], initial_record)
    assert committed["revision"] == 2 and committed["state"] == {"count": 2}
    assert json.loads(batch[1]["content"][0]["text"][len(HEADER) :]) == CONTEXT
    record = store.get(SESSION_KEY)
    assert record.shared_state == {"count": 2} and record.state_revision == 2
    assert json.loads(record.runtime_context) == CONTEXT
    assert [e["id"] for e in record.pending_confirmations] == (
        ["sibling-approval"] if sibling is True else []
    )
    if sibling is not True:
        assert any(
            e.type == "TEXT_MESSAGE_CONTENT" and e.delta == "read the new catalog"
            for e in events
        )


async def test_pending_internal_state_failed_context_batch_retries_without_early_commit():
    pending = call(
        "original-state",
        kind="agent.custom_tool_use",
        name=state.NAME,
        input={"operation": "replace", "state": {"saved": True}, "expectedRevision": 0},
    )
    fake = RecoveryClient(
        [[pending, idle(["original-state"])]],
        agent_tools=[state.definition()],
        streams=[[IDLE_END_TURN], [IDLE_END_TURN]],
        send_failures={0: RuntimeError("delivery failed")},
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store, resolve_session=lambda _: SessionBinding("native"))
    input = base_input(context=CONTEXT, messages=[], state=None)
    first = await collect(agent, input)
    assert first[-1].type == "RUN_ERROR"
    record = store.get(SESSION_KEY)
    assert record.shared_state is None and record.state_revision == 0
    assert record.runtime_context is None and fake.sent == []
    second = await collect(agent, input)
    assert second[-1].type == "RUN_FINISHED"
    assert len(fake.sent) == 1
    batch = fake.sent[0]["events"]
    assert [e["type"] for e in batch] == ["user.custom_tool_result", "system.message"]
    assert batch[0]["custom_tool_use_id"] == "original-state"
    record = store.get(SESSION_KEY)
    assert state.decode(batch[0]["content"], record)["revision"] == 1
    assert record.shared_state == {"saved": True} and record.state_revision == 1
    assert json.loads(record.runtime_context) == CONTEXT


async def test_child_pending_state_and_approval_reject_changed_context_without_send():
    pending = call(
        "child-state",
        kind="agent.custom_tool_use",
        name=state.NAME,
        input={"operation": "replace", "state": {"saved": True}, "expectedRevision": 0},
    )
    fake = RecoveryClient(
        [[pending, call("child-approval"), idle(["child-state", "child-approval"])]],
        agent_tools=[state.definition()],
        streams=[[]],
    )
    store = InMemorySessionStore()
    agent = new_agent(
        fake,
        store,
        resolve_session=lambda _: SessionBinding("native", session_thread_id="child"),
    )
    events = await collect(
        agent,
        base_input(
            context=CONTEXT,
            state=None,
            messages=[],
            resume=[
                {
                    "interruptId": "child-approval",
                    "status": "resolved",
                    "payload": "allow",
                }
            ],
        ),
    )
    assert (
        events[-1].type == "RUN_ERROR"
        and events[-1].code == "context_delivery_unsupported"
    )
    assert fake.sent == []
    record = store.get(SESSION_KEY)
    assert record.shared_state is None and record.runtime_context is None
    assert record.pending_client_tool_use_ids == ["child-state"]
    assert [e["id"] for e in record.pending_confirmations] == ["child-approval"]


@pytest.mark.parametrize(
    "resumes",
    [
        [{"interruptId": "sibling-approval", "status": "invalid", "payload": "allow"}],
        [{"interruptId": "unknown", "status": "resolved", "payload": "allow"}],
        [
            {
                "interruptId": "sibling-approval",
                "status": "resolved",
                "payload": "invalid",
            }
        ],
        [
            {
                "interruptId": "sibling-approval",
                "status": "resolved",
                "payload": "allow",
            },
            {
                "interruptId": "sibling-approval",
                "status": "resolved",
                "payload": "deny",
            },
        ],
        [{"interruptId": "original-state", "status": "resolved", "payload": "allow"}],
    ],
)
async def test_invalid_resume_preflight_precedes_recovered_state_and_context_effects(
    resumes,
):
    pending = call(
        "original-state",
        kind="agent.custom_tool_use",
        name=state.NAME,
        input={"operation": "replace", "state": {"saved": True}, "expectedRevision": 0},
    )
    fake = RecoveryClient(
        [
            [
                pending,
                call("sibling-approval"),
                idle(["original-state", "sibling-approval"]),
            ]
        ],
        agent_tools=[state.definition()],
        streams=[[]],
    )
    store = InMemorySessionStore()
    agent = new_agent(fake, store, resolve_session=lambda _: SessionBinding("native"))
    events = await collect(
        agent,
        base_input(context=CONTEXT, state=None, messages=[]).model_copy(
            update={"resume": resumes}
        ),
    )
    assert events[-1].type == "RUN_ERROR" and events[-1].code == "invalid_resume"
    assert fake.sent == []
    record = store.get(SESSION_KEY)
    assert (
        record.shared_state is None
        and record.state_revision == 0
        and record.runtime_context is None
    )
    assert record.pending_client_tool_use_ids == ["original-state"]
    assert [entry["id"] for entry in record.pending_confirmations] == [
        "sibling-approval"
    ]
