"""Native session continuation requires no model or provider credentials."""

from unittest.mock import patch

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from ag_ui.core import RunAgentInput, UserMessage
from google.adk.agents import Agent
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from google.genai import types

from ag_ui_adk import ADKAgent, SessionManager, add_adk_fastapi_endpoint
from ag_ui_adk.session_manager import THREAD_ID_STATE_KEY


async def native(service, sid="native", app="app", user="user", state=None):
    session = await service.create_session(
        app_name=app, user_id=user, session_id=sid, state=state or {"todo": "keep"}
    )
    await service.append_event(
        session,
        Event(
            id="history",
            invocation_id="old",
            author="assistant",
            content=types.Content(
                role="model", parts=[types.Part(text="Native history")]
            ),
        ),
    )
    return session


def adapter(service, **kwargs):
    return ADKAgent(
        adk_agent=Agent(name="app", model="unused"),
        session_service=service,
        delete_session_on_cleanup=False,
        **kwargs,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_native_without_metadata_reuses_session_and_full_history(direct):
    service = InMemorySessionService()
    await native(service)
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    session = await manager.resolve_existing_session("native", "app", "user")
    assert session.id == "native"
    assert session.events[0].id == "history"
    with patch.object(manager, "_start_cleanup_task"):
        selected, sid = await manager.get_or_create_session("native", "app", "user")
    assert sid == selected.id == "native"
    assert THREAD_ID_STATE_KEY not in selected.state
    assert (
        len((await service.list_sessions(app_name="app", user_id="user")).sessions) == 1
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_mapping_precedes_native_collision_and_fetches_events(direct):
    service = InMemorySessionService()
    await native(service, "wire")
    await native(service, "backend", state={THREAD_ID_STATE_KEY: "wire"})
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    with patch.object(manager, "_start_cleanup_task"):
        selected, sid = await manager.get_or_create_session("wire", "app", "user")
    assert sid == "backend"
    assert selected.events[0].id == "history"


@pytest.mark.asyncio
async def test_duplicate_mapping_is_rejected_without_creation():
    service = InMemorySessionService()
    for sid in ["one", "two"]:
        await native(service, sid, state={THREAD_ID_STATE_KEY: "wire"})
    manager = SessionManager(session_service=service)
    with patch.object(
        service, "create_session", wraps=service.create_session
    ) as create:
        with pytest.raises(ValueError, match="multiple|ambiguous"):
            await manager.get_or_create_session("wire", "app", "user")
        create.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["list_sessions", "get_session"])
async def test_lookup_error_does_not_create(operation):
    service = InMemorySessionService()
    manager = SessionManager(session_service=service)
    with (
        patch.object(
            service, operation, side_effect=RuntimeError("backend unavailable")
        ),
        patch.object(service, "create_session", wraps=service.create_session) as create,
    ):
        with pytest.raises(RuntimeError, match="backend unavailable"):
            await manager.get_or_create_session("native", "app", "user")
        create.assert_not_called()


@pytest.mark.asyncio
async def test_cold_state_endpoint_hydrates_native_history_without_creating():
    service = InMemorySessionService()
    await native(service)
    agent = adapter(service, app_name="app", user_id="user")
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent)
    with TestClient(app) as client:
        response = client.post("/agents/state", json={"threadId": "native"})
    assert response.status_code == 200
    data = response.json()
    assert data["threadExists"] is True
    assert data["state"]["todo"] == "keep"
    assert data["messages"][0]["content"] == "Native history"


@pytest.mark.asyncio
async def test_cold_run_resolves_native_before_pending_and_history_checks():
    service = InMemorySessionService()
    await native(service, state={"pending_tool_calls": ["original-call"]})
    agent = adapter(service, app_name="app", user_id="user")
    input = RunAgentInput(
        thread_id="native",
        run_id="run",
        messages=[],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    async def check_hydration(_input):
        assert await agent._has_pending_tool_calls("native", "user") is True
        return []

    with patch.object(agent, "_get_unseen_messages", side_effect=check_hydration):
        events = [event async for event in agent.run(input)]
    assert events[-1].type == "RUN_FINISHED"


@pytest.mark.asyncio
async def test_ensure_session_cache_is_scoped_to_app_and_user():
    service = InMemorySessionService()
    for app, user in [("first", "one"), ("second", "one"), ("first", "two")]:
        await native(service, "native", app, user, {"owner": f"{app}/{user}"})
    agent = adapter(service)
    with patch.object(agent._session_manager, "_start_cleanup_task"):
        for app, user in [("first", "one"), ("second", "one"), ("first", "two")]:
            session, sid = await agent._ensure_session_exists(app, user, "native", {})
            assert sid == "native"
            assert session.state["owner"] == f"{app}/{user}"


@pytest.mark.asyncio
async def test_processed_history_is_isolated_between_users():
    service = InMemorySessionService()
    agent = adapter(
        service, app_name="app", user_id_extractor=lambda i: i.forwarded_props["user"]
    )
    agent._session_manager.mark_messages_processed(
        "app", "native", ["shared-message"], user_id="one"
    )
    input = RunAgentInput(
        thread_id="native",
        run_id="run",
        messages=[UserMessage(id="shared-message", content="Hello")],
        state={},
        tools=[],
        context=[],
        forwarded_props={"user": "two"},
    )
    assert len(await agent._get_unseen_messages(input)) == 1


@pytest.mark.asyncio
async def test_native_run_updates_original_session_without_a_model():
    from google.adk.agents import BaseAgent
    from google.adk.events import EventActions

    seen = []

    class RecordingAgent(BaseAgent):
        async def _run_async_impl(self, ctx):
            seen.append(
                (
                    ctx.session.id,
                    dict(ctx.session.state),
                    [e.id for e in ctx.session.events],
                )
            )
            yield Event(
                invocation_id=ctx.invocation_id,
                author=self.name,
                content=types.Content(
                    role="model", parts=[types.Part(text="Updated locally")]
                ),
                actions=EventActions(state_delta={"todo": "updated"}),
            )

    service = InMemorySessionService()
    session = await service.create_session(
        app_name="app", user_id="user", session_id="native", state={"todo": "keep"}
    )
    await service.append_event(
        session,
        Event(
            id="history",
            invocation_id="old",
            author="app",
            content=types.Content(
                role="model", parts=[types.Part(text="Native history")]
            ),
        ),
    )
    agent = ADKAgent(
        adk_agent=RecordingAgent(name="app"),
        app_name="app",
        user_id="user",
        session_service=service,
        delete_session_on_cleanup=False,
    )
    input = RunAgentInput(
        thread_id="native",
        run_id="run",
        messages=[UserMessage(id="followup", content="Update")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )
    try:
        events = [e async for e in agent.run(input)]
        assert not any(e.type == "RUN_ERROR" for e in events)
        assert events[-1].type == "RUN_FINISHED"
        assert seen[0][0] == "native"
        assert seen[0][1]["todo"] == "keep"
        assert "history" in seen[0][2]
        after = await service.get_session(
            app_name="app", user_id="user", session_id="native"
        )
        assert after.state["todo"] == "updated"
        assert agent._session_manager.get_session_count() == 1
        assert agent._session_manager.get_user_session_count("user") == 1
        assert after.events[0].id == "history"
        assert any(
            e.content and any(p.text == "Updated locally" for p in e.content.parts)
            for e in after.events
        )
        assert (
            len((await service.list_sessions(app_name="app", user_id="user")).sessions)
            == 1
        )
    finally:
        await agent.close()
        if agent._session_manager._cleanup_task:
            agent._session_manager._cleanup_task.cancel()


def test_untrack_clears_only_scoped_processed_ids():
    manager = SessionManager(session_service=InMemorySessionService())
    with patch.object(manager, "_start_cleanup_task"):
        manager._register_session("native", "native", "app", "one")
        manager._register_session("native", "native", "app", "two")
    manager.mark_messages_processed("app", "native", ["one"], user_id="one")
    manager.mark_messages_processed("app", "native", ["two"], user_id="two")
    manager._untrack_session(manager._make_session_key("app", "native", "one"), "one")
    assert manager.get_processed_message_ids("app", "native", user_id="one") == set()
    assert manager.get_processed_message_ids("app", "native", user_id="two") == {"two"}


@pytest.mark.asyncio
async def test_tracking_cleanup_and_hitl_are_user_scoped():
    service = InMemorySessionService()
    for user in ("one", "two"):
        await native(
            service, "native", user=user, state={"pending_tool_calls": ["pending"]}
        )
    manager = SessionManager(session_service=service, session_timeout_seconds=-1)
    with patch.object(manager, "_start_cleanup_task"):
        for user in ("one", "two"):
            await manager.get_or_create_session("native", "app", user)
            manager.mark_messages_processed("app", "native", [user], user_id=user)
    assert manager.get_session_count() == 2
    await manager._cleanup_expired_sessions()
    assert len(manager._hitl_preserved_since) == 2
    first = await service.get_session(
        app_name="app", user_id="one", session_id="native"
    )
    await manager._delete_session(first)
    assert manager.get_session_count() == 1
    assert manager.get_user_session_count("two") == 1
    assert len(manager._hitl_preserved_since) == 1
    assert manager.get_processed_message_ids("app", "native", user_id="one") == set()
    assert manager.get_processed_message_ids("app", "native", user_id="two") == {"two"}
    assert (
        await service.get_session(app_name="app", user_id="two", session_id="native")
        is not None
    )


@pytest.mark.asyncio
async def test_continuing_existing_session_at_user_limit_does_not_evict():
    service = InMemorySessionService()
    await native(service)
    manager = SessionManager(session_service=service, max_sessions_per_user=1)
    with patch.object(manager, "_start_cleanup_task"):
        await manager.get_or_create_session("native", "app", "user")
        session, sid = await manager.get_or_create_session("native", "app", "user")
    assert sid == "native"
    assert session.events[0].id == "history"
    assert session.state["todo"] == "keep"
    assert manager.get_session_count() == 1


@pytest.mark.asyncio
async def test_deleting_native_id_shadowed_by_another_mapping_preserves_its_history():
    service = InMemorySessionService()
    first = await native(service, "wire", state={THREAD_ID_STATE_KEY: "legacy"})
    await native(service, "backend", state={THREAD_ID_STATE_KEY: "wire"})
    manager = SessionManager(session_service=service)
    with patch.object(manager, "_start_cleanup_task"):
        await manager.get_or_create_session("legacy", "app", "user")
        await manager.get_or_create_session("wire", "app", "user")
    manager.mark_messages_processed("app", "legacy", ["old"], user_id="user")
    manager.mark_messages_processed("app", "wire", ["keep"], user_id="user")
    await manager._delete_session(first)
    assert manager.get_processed_message_ids("app", "legacy", user_id="user") == set()
    assert manager.get_processed_message_ids("app", "wire", user_id="user") == {"keep"}
    assert manager.get_session_count() == 1
