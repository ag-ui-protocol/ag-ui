import json
from dataclasses import asdict
import pytest
import httpx
from anthropic import AsyncAnthropic
from ag_ui_claude_managed_agents import ManagedAgentsAgent, InMemorySessionStore, SessionRecord, SessionBinding
from .test_agent import base_input, IDLE_END_TURN, new_agent, collect, SESSION_KEY
from .fake_client import FakeClient
from .test_recovery import RecoveryClient, call

CONTEXT = [
    {"description": "A2UI catalog", "value": "copilotkit://app-dashboard-catalog — FlightCard"},
    {"description": "A2UI schema", "value": '  {"component":"FlightCard"}\n日本語'},
]

async def test_context_reaches_native_http_request():
    requests = []
    def handle(request):
        if request.url.path.endswith("/events/stream"):
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, text="event: session.status_idle\ndata: " + json.dumps(IDLE_END_TURN) + "\n\n")
        body = json.loads(request.content or "{}")
        if "events" in body:
            requests.append(body)
        return httpx.Response(200, json={"id": "native", "data": []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        async with AsyncAnthropic(api_key="test", max_retries=0, http_client=http) as client:
            agent = ManagedAgentsAgent(managed_agent_id="a", environment_id="e", client=client)
            value = base_input(context=CONTEXT)
            original = value.model_dump()
            events = [event async for event in agent.run(value)]
    assert events[-1].type == "RUN_FINISHED"
    assert len(requests) == 1
    sent = requests[0]["events"]
    assert sent[0] == {"type": "user.message", "content": [{"type": "text", "text": "Hello"}]}
    assert sent[1]["type"] == "system.message"
    assert json.loads(sent[1]["content"][0]["text"].split("\n", 1)[1]) == CONTEXT
    assert value.model_dump() == original

def snapshot(events):
    assert events[-1]["type"] == "system.message"
    return json.loads(events[-1]["content"][0]["text"].split("\n", 1)[1])

async def test_changed_cleared_and_unchanged_context_after_cold_store_restart():
    fake = FakeClient(streams=[[IDLE_END_TURN]] * 5)
    store = InMemorySessionStore()
    await collect(new_agent(fake, store), base_input(context=CONTEXT))
    assert snapshot(fake.sent[0]["events"]) == CONTEXT
    cold_store = InMemorySessionStore()
    cold_store.set(SESSION_KEY, SessionRecord(**json.loads(json.dumps(asdict(store.get(SESSION_KEY))))))
    restored = new_agent(fake, cold_store)
    for id, context in [("u2", CONTEXT), ("u3", [{"description": "updated", "value": "catalog"}]), ("u4", [])]:
        events = await collect(restored, base_input(context=context, messages=[{"id": id, "role": "user", "content": "next"}]))
        assert events[-1].type == "RUN_FINISHED"
    assert len(fake.sent[1]["events"]) == 1
    assert snapshot(fake.sent[2]["events"]) == [{"description": "updated", "value": "catalog"}]
    assert snapshot(fake.sent[3]["events"]) == []
    await collect(restored, base_input(thread_id="other"))
    assert len(fake.sent[4]["events"]) == 1

@pytest.mark.parametrize("partial", [False, True])
async def test_imported_tool_result_carries_context_before_followup(partial):
    pending = [call("c", kind="agent.custom_tool_use")]
    if partial:
        pending.append(call("other", kind="agent.custom_tool_use"))
    fake = RecoveryClient([pending], streams=[[IDLE_END_TURN]])
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding(session_id="native", last_user_message_id="u1"))
    value = base_input(context=CONTEXT, messages=[{"id": "u1", "role": "user", "content": "old"}, {"id": "r", "role": "tool", "toolCallId": "c", "content": "ok"}, {"id": "u2", "role": "user", "content": "next"}])
    events = await collect(agent, value)
    assert events[-1].type == "RUN_FINISHED"
    assert fake.sent[0]["events"][0]["type"] == "user.custom_tool_result"
    assert snapshot(fake.sent[0]["events"]) == CONTEXT
    assert len(fake.sent) == (1 if partial else 2)
    if not partial:
        assert [e["type"] for e in fake.sent[1]["events"]] == ["user.message"]

async def test_failed_context_send_is_retried():
    fake = FakeClient(streams=[[IDLE_END_TURN]] * 2, send_failures={0: RuntimeError("offline")})
    store = InMemorySessionStore()
    agent = new_agent(fake, store)
    assert (await collect(agent, base_input(context=CONTEXT)))[-1].type == "RUN_ERROR"
    assert store.get(SESSION_KEY).runtime_context is None
    assert (await collect(agent, base_input(context=CONTEXT)))[-1].type == "RUN_FINISHED"
    assert snapshot(fake.sent[0]["events"]) == CONTEXT

@pytest.mark.parametrize("child", [False, True])
async def test_unsupported_context_delivery_has_no_native_send(child):
    pending = call("c", kind="agent.custom_tool_use" if child else "agent.tool_use")
    fake = RecoveryClient([[pending]], streams=[[]])
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding(session_id="native", session_thread_id="child" if child else None, last_user_message_id="u1"))
    value = base_input(context=CONTEXT)
    if child:
        value = base_input(context=CONTEXT, messages=[{"id": "r", "role": "tool", "toolCallId": "c", "content": "ok"}])
    else:
        value = base_input(context=CONTEXT, resume=[{"interruptId": "c", "status": "resolved", "payload": "allow"}])
    events = await collect(agent, value)
    assert events[-1].code == "context_delivery_unsupported"
    assert fake.sent == []

@pytest.mark.parametrize("approval", [False, True])
async def test_native_import_restores_latest_context_for_clear_or_unchanged_approval(approval):
    def native(id, entries):
        return {"type": "system.message", "id": id, "content": [{"type": "text", "text": "AG-UI runtime context snapshot. Replace all earlier AG-UI runtime context snapshots with this complete list; an empty list clears them.\n" + json.dumps(entries)}]}
    history = [native("old", [{"description": "obsolete", "value": "old"}]), native("latest", CONTEXT)]
    if approval:
        history.append(call("c"))
    fake = RecoveryClient([history], streams=[[IDLE_END_TURN]])
    agent = new_agent(fake, resolve_session=lambda _: SessionBinding(session_id="native", last_user_message_id="u1"))
    value = base_input(context=CONTEXT, resume=[{"interruptId": "c", "status": "resolved", "payload": "allow"}]) if approval else base_input(context=[], messages=[{"id": "u2", "role": "user", "content": "clear"}])
    events = await collect(agent, value)
    assert events[-1].type == "RUN_FINISHED"
    if approval:
        assert fake.sent[0]["events"] == [{"type": "user.tool_confirmation", "tool_use_id": "c", "result": "allow"}]
    else:
        assert snapshot(fake.sent[0]["events"]) == []
