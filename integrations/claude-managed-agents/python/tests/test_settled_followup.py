from types import SimpleNamespace

import httpx
import pytest
from anthropic import AsyncAnthropic

from ag_ui_claude_managed_agents import InMemorySessionStore, SessionRecord
from ag_ui_claude_managed_agents.recovery import verified_end

from .fake_client import FakeClient
from .fake_store import RecordingSessionStore
from .test_agent import IDLE_END_TURN, SESSION_KEY, base_input, collect, new_agent


def followup(id="next"):
    return base_input(messages=[{"role": "user", "id": id, "content": "continue"}])


class HistoryClient(FakeClient):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.reads = []
        self.status = "idle"

    async def _session_retrieve(self, session_id):
        return SimpleNamespace(status=self.status, agent={"tools": self.agent_tools})

    async def _list(self, session_id, **params):
        self.reads.append((params, self.send_attempts))
        if params == {"order": "desc", "limit": 1}:
            async def newest_first():
                yield self.history[-1]
                pytest.fail("fetched another event after the requested newest row")
            return newest_first()
        return list(self.history)


@pytest.mark.parametrize("size", [100, 1000])
async def test_settled_followup_reads_one_row_before_send(size):
    fake = HistoryClient(streams=[[IDLE_END_TURN], [IDLE_END_TURN], [IDLE_END_TURN]])
    fake.history.extend({"id": f"old-{i}", "type": "agent.thinking"} for i in range(size - 2))
    agent = new_agent(fake)
    await collect(agent, base_input())
    assert len(fake.history) == size
    for msg in ("second", "third"):
        assert (await collect(agent, followup(msg)))[-1].type.value == "RUN_FINISHED"
    assert fake.reads == [({"order": "desc", "limit": 1}, 1), ({"order": "desc", "limit": 1}, 2)]


async def test_failed_send_consumes_marker_and_retry_reads_full_history():
    fake = HistoryClient(streams=[[IDLE_END_TURN], [], [IDLE_END_TURN]], send_failures={1: RuntimeError("send failed")})
    store = InMemorySessionStore()
    agent = new_agent(fake, store)
    await collect(agent, base_input())
    assert (await collect(agent, followup()))[-1].type.value == "RUN_ERROR"
    assert store.get(SESSION_KEY).clean_end_event_id is None
    assert (await collect(agent, followup()))[-1].type.value == "RUN_FINISHED"
    assert fake.reads == [({"order": "desc", "limit": 1}, 1), ({}, 2)]


async def test_changed_tail_recovers_offline_permission_before_send():
    fake = HistoryClient(streams=[[IDLE_END_TURN], []])
    agent = new_agent(fake)
    await collect(agent, base_input())
    fake.history.extend([
        {"type": "agent.tool_use", "id": "ask", "name": "read", "input": {}, "evaluated_permission": "ask"},
        {"type": "session.status_idle", "id": "parked", "stop_reason": {"type": "requires_action", "event_ids": ["ask"]}},
    ])
    result = await collect(agent, followup())
    assert result[-1].outcome.interrupts[0].id == "ask"
    assert fake.reads == [({"order": "desc", "limit": 1}, 1), ({}, 1)]
    assert fake.send_attempts == 1


async def test_late_requires_action_only_reads_earlier_answers_after_send():
    old_call = {"id": "old-call", "type": "agent.custom_tool_use", "name": "video", "input": {}}
    delayed = {
        "id": "delayed", "type": "session.status_idle",
        "stop_reason": {"type": "requires_action", "event_ids": ["old-call"]},
    }
    fake = HistoryClient(streams=[[IDLE_END_TURN], [delayed, IDLE_END_TURN]])
    fake.history.append(old_call)
    agent = new_agent(fake)
    await collect(agent, base_input())
    events = await collect(agent, followup())
    assert events[-1].type.value == "RUN_FINISHED"
    assert events[-1].outcome is None
    assert fake.reads == [({"order": "desc", "limit": 1}, 1), ({}, 2)]
    assert len(fake.sent) == 2


@pytest.mark.parametrize("reason", ["old-record", "empty-reconnect", "running", "external-system", "external-result"])
async def test_unverified_followup_uses_full_history(reason):
    external = {
        "external-system": {"id": "system", "type": "system.message", "content": [{"type": "text", "text": "external"}]},
        "external-result": {"id": "res", "type": "user.custom_tool_result", "custom_tool_use_id": "old", "content": []},
    }
    initial = [external[reason], IDLE_END_TURN] if reason in external else [IDLE_END_TURN]
    fake = HistoryClient(streams=[initial, [IDLE_END_TURN]])
    store = InMemorySessionStore()
    agent = new_agent(fake, store)
    await collect(agent, base_input())
    if reason == "old-record":
        record = store.get(SESSION_KEY)
        record.clean_end_event_id = None
        store.set(SESSION_KEY, record)
    if reason == "running":
        fake.status = "running"
    request = base_input(messages=[]) if reason == "empty-reconnect" else followup()
    assert (await collect(agent, request))[-1].type.value == "RUN_FINISHED"
    assert fake.reads == [({}, 1)]


@pytest.mark.parametrize("status", ["idle", "running"])
async def test_native_sdk_queries_only_the_newest_event(status):
    requests = []

    def handle(request):
        requests.append(request.url)
        if request.url.path.endswith("/events"):
            return httpx.Response(200, json={"data": [IDLE_END_TURN], "has_more": True, "next_page": "older"})
        return httpx.Response(200, json={"id": "native", "status": status})

    record = SessionRecord(session_id="native", last_event_id="idle_1")
    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    async with AsyncAnthropic(api_key="test", max_retries=0, http_client=http) as client:
        latest = await verified_end(client.beta.sessions, record, followup(), "idle_1")
    assert requests[0].path == "/v1/sessions/native"
    if status == "running":
        assert latest is None
        assert len(requests) == 1
    else:
        assert latest.id == "idle_1"
        assert len(requests) == 2
        assert requests[1].path == "/v1/sessions/native/events"
        assert requests[1].params["order"] == "desc"
        assert requests[1].params["limit"] == "1"


async def test_restart_keeps_shared_state_and_does_not_resend_context():
    store = RecordingSessionStore()
    fake = HistoryClient(streams=[[IDLE_END_TURN], [IDLE_END_TURN]])
    common = {"state": {"count": 1}, "context": [{"description": "catalog", "value": "one"}]}
    await collect(new_agent(fake, store), base_input(**common))
    request = base_input(messages=[{"role": "user", "id": "second", "content": "continue"}], **common)
    events = await collect(new_agent(fake, store), request)
    assert events[-1].type.value == "RUN_FINISHED"
    assert [e.snapshot for e in events if e.type.value == "STATE_SNAPSHOT"] == [{"count": 1}]
    assert [e["type"] for e in fake.sent[-1]["events"]] == ["user.message"]
    assert fake.reads == [({"order": "desc", "limit": 1}, 1)]
