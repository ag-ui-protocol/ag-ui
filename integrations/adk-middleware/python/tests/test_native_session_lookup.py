"""Native session continuation requires no model or provider credentials."""

import asyncio
import logging
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from ag_ui.core import RunAgentInput, UserMessage
from google.adk.agents import Agent
from google.adk.events import Event
from google.adk.memory import InMemoryMemoryService
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


def yielding_create(service):
    """Make the real in-memory create suspend, as any networked backend does."""
    real = service.create_session

    async def create(**kwargs):
        await asyncio.sleep(0)
        return await real(**kwargs)

    return create


@pytest.mark.asyncio
@pytest.mark.parametrize("skip_find", [False, True])
async def test_concurrent_first_runs_create_one_session(skip_find):
    service = InMemorySessionService()
    service.create_session = yielding_create(service)
    managers = [SessionManager(session_service=service) for _ in range(2)]
    with (
        patch.object(managers[0], "_start_cleanup_task"),
        patch.object(managers[1], "_start_cleanup_task"),
    ):
        # Two managers on one service still share the per-thread creation lock.
        results = await asyncio.gather(
            *(
                m.get_or_create_session("wire", "app", "user", skip_find=skip_find)
                for m in managers + managers
            )
        )
    sessions = (await service.list_sessions(app_name="app", user_id="user")).sessions
    assert len(sessions) == 1
    assert {sid for _, sid in results} == {sessions[0].id}


@pytest.mark.asyncio
async def test_concurrent_first_runs_through_agent_create_one_session():
    service = InMemorySessionService()
    service.create_session = yielding_create(service)
    # Each agent wraps the shared backend separately; they must still serialize.
    agents = [adapter(service, app_name="app", user_id="user") for _ in range(2)]
    try:
        with (
            patch.object(agents[0]._session_manager, "_start_cleanup_task"),
            patch.object(agents[1]._session_manager, "_start_cleanup_task"),
        ):
            results = await asyncio.gather(
                *(
                    a._ensure_session_exists("app", "user", "wire", {})
                    for a in agents + agents
                )
            )
        sessions = (
            await service.list_sessions(app_name="app", user_id="user")
        ).sessions
        assert len(sessions) == 1
        assert {sid for _, sid in results} == {sessions[0].id}
    finally:
        for agent in agents:
            await agent.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_duplicate_mappings_resolve_to_most_recent_with_warning(direct, caplog):
    service = InMemorySessionService()
    for sid in ["b-newer", "a-older", "c-oldest"]:
        await native(service, sid, state={THREAD_ID_STATE_KEY: "wire"})
    stored = service.sessions["app"]["user"]
    stored["a-older"].last_update_time = 200.0
    stored["b-newer"].last_update_time = 300.0
    stored["c-oldest"].last_update_time = 100.0
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    with (
        patch.object(manager, "_start_cleanup_task"),
        patch.object(service, "create_session", wraps=service.create_session) as create,
        caplog.at_level(logging.WARNING, logger="ag_ui_adk.session_manager"),
    ):
        for _ in range(2):
            session, sid = await manager.get_or_create_session("wire", "app", "user")
            assert sid == session.id == "b-newer"
            assert session.events[0].id == "history"
        create.assert_not_called()
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings
    assert all(s in warnings[0] for s in ["a-older", "b-newer", "c-oldest", "wire"])


@pytest.mark.asyncio
async def test_duplicate_mappings_with_equal_update_times_pick_stable_id():
    service = InMemorySessionService()
    for sid in ["two", "one"]:
        await native(service, sid, state={THREAD_ID_STATE_KEY: "wire"})
    for session in service.sessions["app"]["user"].values():
        session.last_update_time = 100.0
    manager = SessionManager(session_service=service)
    session = await manager.resolve_existing_session("wire", "app", "user")
    assert session.id == "two"


@pytest.mark.asyncio
async def test_duplicate_mappings_let_cold_state_endpoint_read_the_winner():
    service = InMemorySessionService()
    await native(service, "old", state={THREAD_ID_STATE_KEY: "wire", "todo": "old"})
    await native(service, "new", state={THREAD_ID_STATE_KEY: "wire", "todo": "new"})
    service.sessions["app"]["user"]["old"].last_update_time = 1.0
    agent = adapter(service, app_name="app", user_id="user")
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent)
    with TestClient(app) as client:
        response = client.post("/agents/state", json={"threadId": "wire"})
    assert response.status_code == 200
    assert response.json()["threadExists"] is True
    assert response.json()["state"]["todo"] == "new"


def delete_after_list(service, *sids):
    """Delete sids once list_sessions has returned, before the re-read."""
    real_list = service.list_sessions

    async def list_then_delete(**kwargs):
        response = await real_list(**kwargs)
        for sid in sids:
            await service.delete_session(
                app_name=kwargs["app_name"], user_id=kwargs["user_id"], session_id=sid
            )
        return response

    return patch.object(service, "list_sessions", side_effect=list_then_delete)


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_mapped_session_deleted_during_lookup_is_not_found(direct, caplog):
    service = InMemorySessionService()
    await native(service, "gone", state={THREAD_ID_STATE_KEY: "wire"})
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    with (
        delete_after_list(service, "gone"),
        caplog.at_level(logging.WARNING, logger="ag_ui_adk.session_manager"),
    ):
        assert await manager.resolve_existing_session("wire", "app", "user") is None
    assert any(
        "gone" in r.getMessage() and "wire" in r.getMessage() for r in caplog.records
    )
    with patch.object(manager, "_start_cleanup_task"):
        session, sid = await manager.get_or_create_session("wire", "app", "user")
    assert sid == session.id != "gone"
    assert session.state[THREAD_ID_STATE_KEY] == "wire"


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_duplicate_winner_deleted_during_lookup_falls_back_to_next(direct):
    service = InMemorySessionService()
    for sid in ["newer", "older"]:
        await native(service, sid, state={THREAD_ID_STATE_KEY: "wire"})
    await native(service, "other", state={THREAD_ID_STATE_KEY: "another-thread"})
    stored = service.sessions["app"]["user"]
    stored["newer"].last_update_time = 300.0
    stored["older"].last_update_time = 200.0
    stored["other"].last_update_time = 400.0
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    with (
        delete_after_list(service, "newer"),
        patch.object(manager, "_start_cleanup_task"),
        patch.object(service, "create_session", wraps=service.create_session) as create,
    ):
        session, sid = await manager.get_or_create_session("wire", "app", "user")
        create.assert_not_called()
    assert sid == session.id == "older"
    assert session.events[0].id == "history"


@pytest.mark.asyncio
async def test_mapped_session_reread_error_propagates_without_creating():
    service = InMemorySessionService()
    await native(service, "mapped", state={THREAD_ID_STATE_KEY: "wire"})
    manager = SessionManager(session_service=service)
    with (
        patch.object(
            service, "get_session", side_effect=RuntimeError("backend unavailable")
        ),
        patch.object(service, "create_session", wraps=service.create_session) as create,
    ):
        with pytest.raises(RuntimeError, match="backend unavailable"):
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
async def test_state_endpoint_surfaces_state_read_failure():
    service = InMemorySessionService()
    await native(service)
    agent = adapter(service, app_name="app", user_id="user")
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent)
    real_get = service.get_session
    reads = []

    async def fail_state_read(**kwargs):
        reads.append(kwargs)
        if len(reads) > 1:
            raise RuntimeError("state backend unavailable")
        return await real_get(**kwargs)

    with (
        patch.object(service, "get_session", side_effect=fail_state_read),
        TestClient(app) as client,
    ):
        response = client.post("/agents/state", json={"threadId": "native"})
    assert len(reads) == 2
    assert response.status_code == 500
    assert "state backend unavailable" in response.json()["error"]


@pytest.mark.asyncio
async def test_state_endpoint_missing_session_returns_empty_state():
    agent = adapter(InMemorySessionService(), app_name="app", user_id="user")
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent)
    with TestClient(app) as client:
        response = client.post("/agents/state", json={"threadId": "missing"})
    assert response.status_code == 200
    assert response.json() == {
        "threadId": "missing",
        "threadExists": False,
        "state": {},
        "messages": [],
    }


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
        assert await agent._has_pending_tool_calls("native", "user", app_name="app") is True
        return []

    with patch.object(agent, "_get_unseen_messages", side_effect=check_hydration):
        events = [event async for event in agent.run(input)]
    assert events[-1].type == "RUN_FINISHED"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["list_sessions", "get_session"])
async def test_direct_run_reports_lookup_error_as_run_error(operation):
    service = InMemorySessionService()
    agent = adapter(service, app_name="app", user_id="user")
    input = RunAgentInput(
        thread_id="native",
        run_id="run",
        messages=[UserMessage(id="first", content="Hello")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )
    with (
        patch.object(
            service, operation, side_effect=RuntimeError("backend unavailable")
        ),
        patch.object(service, "create_session", wraps=service.create_session) as create,
    ):
        events = [event async for event in agent.run(input)]
    assert [event.type for event in events] == ["RUN_ERROR"]
    assert events[0].code == "SESSION_LOOKUP_ERROR"
    assert "backend unavailable" in events[0].message
    create.assert_not_called()
    assert ("native", "user", "app") not in agent._session_lookup_cache
    assert ("native", "user", "app") not in agent._cache_checked_keys


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
        ["shared-message"], app_name="app", user_id="one", thread_id="native"
    )

    def run_as(user):
        return RunAgentInput(
            thread_id="native",
            run_id="run",
            messages=[UserMessage(id="shared-message", content="Hello")],
            state={},
            tools=[],
            context=[],
            forwarded_props={"user": user},
        )

    assert await agent._get_unseen_messages(run_as("one")) == []
    assert len(await agent._get_unseen_messages(run_as("two"))) == 1


def test_processed_ids_scope_cannot_be_omitted():
    """Omitting the user fails loudly instead of writing a bucket no run reads."""
    manager = SessionManager(session_service=InMemorySessionService())
    with pytest.raises(TypeError):
        manager.mark_messages_processed("app", "native", ["m"])
    with pytest.raises(TypeError):
        manager.mark_messages_processed(["m"], app_name="app", thread_id="native")
    with pytest.raises(TypeError):
        manager.get_processed_message_ids("app", "native")
    assert manager._processed_message_ids == {}


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
        # Continued, not created: never tracked, so never evicted or expired.
        assert agent._session_manager.get_session_count() == 0
        assert agent._session_manager.get_user_session_count("user") == 0
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
    manager.mark_messages_processed(
        ["one"], app_name="app", user_id="one", thread_id="native"
    )
    manager.mark_messages_processed(
        ["two"], app_name="app", user_id="two", thread_id="native"
    )
    assert manager.get_processed_message_ids(
        app_name="app", user_id="one", thread_id="native"
    ) == {"one"}
    manager._untrack_session(manager._make_session_key("app", "native", "one"), "one")
    assert (
        manager.get_processed_message_ids(
            app_name="app", user_id="one", thread_id="native"
        )
        == set()
    )
    assert manager.get_processed_message_ids(
        app_name="app", user_id="two", thread_id="native"
    ) == {"two"}


@pytest.mark.asyncio
async def test_tracking_cleanup_and_hitl_are_user_scoped():
    # Both users' created sessions share the backend ID "native".
    service = InMemorySessionService()
    manager = SessionManager(
        session_service=service,
        session_timeout_seconds=-1,
        use_thread_id_as_session_id=True,
    )
    with patch.object(manager, "_start_cleanup_task"):
        for user in ("one", "two"):
            _, sid = await manager.get_or_create_session(
                "native", "app", user,
                initial_state={"pending_tool_calls": ["pending"]},
            )
            assert sid == "native"
            manager.mark_messages_processed(
                [user], app_name="app", user_id=user, thread_id="native"
            )
    assert manager.get_session_count() == 2
    assert manager.get_processed_message_ids(
        app_name="app", user_id="one", thread_id="native"
    ) == {"one"}
    await manager._cleanup_expired_sessions()
    assert len(manager._hitl_preserved_since) == 2
    first = await service.get_session(
        app_name="app", user_id="one", session_id="native"
    )
    await manager._delete_session(first)
    assert manager.get_session_count() == 1
    assert manager.get_user_session_count("two") == 1
    assert len(manager._hitl_preserved_since) == 1
    assert (
        manager.get_processed_message_ids(
            app_name="app", user_id="one", thread_id="native"
        )
        == set()
    )
    assert manager.get_processed_message_ids(
        app_name="app", user_id="two", thread_id="native"
    ) == {"two"}
    assert (
        await service.get_session(app_name="app", user_id="one", session_id="native")
        is None
    )
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
    assert manager.get_session_count() == 0
    assert (await stored(service, "native")).events[0].id == "history"


@pytest.mark.asyncio
async def test_deleting_native_id_shadowed_by_another_mapping_preserves_its_history():
    service = InMemorySessionService()
    first = await native(service, "wire", state={THREAD_ID_STATE_KEY: "legacy"})
    await native(service, "backend", state={THREAD_ID_STATE_KEY: "wire"})
    manager = SessionManager(session_service=service)
    with patch.object(manager, "_start_cleanup_task"):
        await manager.get_or_create_session("legacy", "app", "user")
        await manager.get_or_create_session("wire", "app", "user")
        # Continued sessions are not tracked; track "wire" as if this process
        # had created it for "legacy", so deleting it goes through untracking.
        manager._register_session("legacy", "wire", "app", "user")
    manager.mark_messages_processed(
        ["old"], app_name="app", user_id="user", thread_id="legacy"
    )
    manager.mark_messages_processed(
        ["keep"], app_name="app", user_id="user", thread_id="wire"
    )
    assert manager.get_processed_message_ids(
        app_name="app", user_id="user", thread_id="legacy"
    ) == {"old"}
    await manager._delete_session(first)
    # Only a thread whose ID is the backend ID is cleared, as before native
    # lookup, and "wire" is not on this session.
    assert manager.get_processed_message_ids(
        app_name="app", user_id="user", thread_id="legacy"
    ) == {"old"}
    assert manager.get_processed_message_ids(
        app_name="app", user_id="user", thread_id="wire"
    ) == {"keep"}
    assert manager.get_session_count() == 0
    assert (await stored(service, "backend")).events[0].id == "history"


async def stored(svc, sid, user="user"):
    return await svc.get_session(app_name="app", user_id=user, session_id=sid)


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_expiry_cleanup_never_deletes_adopted_native_session(direct):
    service = InMemorySessionService()
    await native(service)
    manager = SessionManager(
        session_service=service,
        session_timeout_seconds=-1,
        use_thread_id_as_session_id=direct,
    )
    assert manager._delete_session_on_cleanup is True
    with patch.object(manager, "_start_cleanup_task"):
        await manager.get_or_create_session("native", "app", "user")
        _, fresh = await manager.get_or_create_session("fresh", "app", "user")
    assert manager.get_session_count() == 1
    await manager._cleanup_expired_sessions()
    assert manager.get_session_count() == 0
    kept = await stored(service, "native")
    assert kept.events[0].id == "history"
    assert kept.state["todo"] == "keep"
    assert await stored(service, fresh) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_eviction_never_deletes_adopted_native_session(direct):
    service = InMemorySessionService()
    await native(service)
    manager = SessionManager(
        session_service=service,
        max_sessions_per_user=1,
        use_thread_id_as_session_id=direct,
    )
    with patch.object(manager, "_start_cleanup_task"):
        await manager.get_or_create_session("native", "app", "user")
        _, first = await manager.get_or_create_session("first", "app", "user")
        assert manager.get_user_session_count("user") == 1
        assert (await stored(service, "native")).events[0].id == "history"
        await manager.get_or_create_session("second", "app", "user")
    assert manager.get_user_session_count("user") == 1
    assert await stored(service, first) is None
    assert (await stored(service, "native")).events[0].id == "history"


@pytest.mark.asyncio
async def test_scope_keyed_helpers_require_the_extracted_app_name():
    # The extractor puts the session under "tenant", not the agent name "app".
    service = InMemorySessionService()
    agent = adapter(
        service,
        app_name_extractor=lambda i: i.forwarded_props["tenant"],
        user_id="user",
    )
    input = RunAgentInput(
        thread_id="wire",
        run_id="run",
        messages=[],
        state={},
        tools=[],
        context=[],
        forwarded_props={"tenant": "tenant"},
    )
    app_name = agent._get_app_name(input)
    assert app_name == "tenant" != agent._adk_agent.name
    await agent._ensure_session_exists(app_name, "user", "wire", {})
    await agent._add_pending_tool_call_with_context("wire", "call", app_name, "user")

    metadata = agent._get_session_metadata("wire", "user", app_name=app_name)
    assert metadata is not None and metadata[1] == "tenant"
    assert agent._get_backend_session_id("wire", "user", app_name=app_name) == metadata[0]
    assert await agent._get_pending_tool_call_ids("wire", "user", app_name=app_name) == ["call"]
    assert await agent._has_pending_tool_calls("wire", "user", app_name=app_name) is True

    # The agent-name scope a default would pick holds nothing for this thread.
    assert agent._get_session_metadata("wire", "user", app_name="app") is None
    assert await agent._has_pending_tool_calls("wire", "user", app_name="app") is False

    # Omitting app_name, or passing it positionally, fails instead of guessing.
    for call in (
        lambda: agent._get_session_metadata("wire", "user"),
        lambda: agent._get_backend_session_id("wire", "user"),
        lambda: agent._get_session_metadata("wire", "user", app_name),
    ):
        with pytest.raises(TypeError):
            call()
    for coro_fn in (
        lambda: agent._get_pending_tool_call_ids("wire", "user"),
        lambda: agent._has_pending_tool_calls("wire", "user"),
        lambda: agent._remove_pending_tool_call("wire", "call", "user"),
    ):
        with pytest.raises(TypeError):
            await coro_fn()

    await agent._remove_pending_tool_call("wire", "call", "user", app_name=app_name)
    assert await agent._has_pending_tool_calls("wire", "user", app_name=app_name) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_native_id_mapped_to_another_thread_is_not_adopted(direct, caplog):
    service = InMemorySessionService()
    await native(service, "wire", state={THREAD_ID_STATE_KEY: "owner", "todo": "a"})
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    with caplog.at_level(logging.WARNING, logger="ag_ui_adk.session_manager"):
        assert await manager.resolve_existing_session("wire", "app", "user") is None
    assert "belongs to AG-UI thread owner" in caplog.text
    with patch.object(manager, "_start_cleanup_task"):
        created, sid = await manager.get_or_create_session("wire", "app", "user")
        assert sid != "wire"
        assert created.state[THREAD_ID_STATE_KEY] == "wire"
        assert created.events == []
        again, again_sid = await manager.get_or_create_session("wire", "app", "user")
        owner, owner_sid = await manager.get_or_create_session("owner", "app", "user")
    assert again_sid == sid
    assert owner_sid == "wire"
    assert owner.state == {THREAD_ID_STATE_KEY: "owner", "todo": "a"}
    assert owner.events[0].id == "history"
    assert ("app", "user", "wire") not in manager._session_keys
    assert manager._session_thread_ids == {("app", "user", sid): {"wire"}}
    assert (
        len((await service.list_sessions(app_name="app", user_id="user")).sessions) == 2
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_native_id_mapped_to_the_same_thread_is_adopted(direct):
    service = InMemorySessionService()
    await native(service, "wire", state={THREAD_ID_STATE_KEY: "wire", "todo": "a"})
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    with patch.object(manager, "_start_cleanup_task"):
        selected, sid = await manager.get_or_create_session("wire", "app", "user")
    assert sid == selected.id == "wire"
    assert selected.events[0].id == "history"
    assert (
        len((await service.list_sessions(app_name="app", user_id="user")).sessions) == 1
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_direct_lookup_without_list_sessions_never_adopts_other_thread(direct):
    service = InMemorySessionService()
    await native(service, "wire", state={THREAD_ID_STATE_KEY: "owner"})
    manager = SessionManager(
        session_service=service, use_thread_id_as_session_id=direct
    )
    with patch.object(manager, "_list_user_sessions", return_value=None):
        assert await manager.resolve_existing_session("wire", "app", "user") is None
        with patch.object(manager, "_start_cleanup_task"):
            _, sid = await manager.get_or_create_session("wire", "app", "user")
    assert sid != "wire"


@pytest.mark.asyncio
async def test_cold_state_endpoint_does_not_read_another_threads_session():
    service = InMemorySessionService()
    await native(service, "wire", state={THREAD_ID_STATE_KEY: "owner"})
    agent = adapter(service, app_name="app", user_id="user")
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent)
    with TestClient(app) as client:
        response = client.post("/agents/state", json={"threadId": "wire"})
    assert response.status_code == 200
    assert response.json()["threadExists"] is False
    assert response.json()["messages"] == []


@pytest.mark.asyncio
async def test_cold_run_does_not_inherit_another_threads_pending_calls():
    service = InMemorySessionService()
    await native(
        service,
        "wire",
        state={THREAD_ID_STATE_KEY: "owner", "pending_tool_calls": ["owner-call"]},
    )
    agent = adapter(service, app_name="app", user_id="user")
    input = RunAgentInput(
        thread_id="wire",
        run_id="run",
        messages=[],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    async def check_hydration(_input):
        assert await agent._has_pending_tool_calls("wire", "user", app_name="app") is False
        return []

    with patch.object(agent, "_get_unseen_messages", side_effect=check_hydration):
        events = [event async for event in agent.run(input)]
    assert events[-1].type == "RUN_FINISHED"
    owner = await stored(service, "wire")
    assert owner.state["pending_tool_calls"] == ["owner-call"]


def tracked(manager, app, user="user"):
    return sum(1 for key in manager._session_keys if key[:2] == (app, user))


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_continuing_sessions_never_leaves_user_above_limit(direct):
    service = InMemorySessionService()
    for sid in ("n1", "n2"):
        await native(service, sid)
    manager = SessionManager(
        session_service=service,
        max_sessions_per_user=1,
        use_thread_id_as_session_id=direct,
    )
    with patch.object(manager, "_start_cleanup_task"):
        _, created = await manager.get_or_create_session("fresh", "app", "user")
        for step in ("n1", "n2"):
            _, sid = await manager.get_or_create_session(step, "app", "user")
            assert sid == step
            assert manager._session_keys == {("app", "user", created)}
        _, later = await manager.get_or_create_session("later", "app", "user")
        assert manager._session_keys == {("app", "user", later)}
    assert await stored(service, created) is None
    for sid in ("n1", "n2"):
        assert (await stored(service, sid)).events[0].id == "history"


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_user_limit_counts_each_app_independently(direct):
    service = InMemorySessionService()
    manager = SessionManager(
        session_service=service,
        max_sessions_per_user=1,
        use_thread_id_as_session_id=direct,
    )
    with patch.object(manager, "_start_cleanup_task"):
        _, one = await manager.get_or_create_session("t", "one", "user")
        _, two = await manager.get_or_create_session("t", "two", "user")
    assert tracked(manager, "one") == 1
    assert tracked(manager, "two") == 1
    assert manager.get_user_session_count("user") == 2
    for app, sid in (("one", one), ("two", two)):
        assert await service.get_session(
            app_name=app, user_id="user", session_id=sid
        ) is not None


@pytest.mark.asyncio
async def test_user_limit_untracks_sessions_gone_from_backend_before_evicting():
    service = InMemorySessionService()
    manager = SessionManager(session_service=service, max_sessions_per_user=2)
    with patch.object(manager, "_start_cleanup_task"):
        _, gone = await manager.get_or_create_session("gone", "app", "user")
        _, kept = await manager.get_or_create_session("kept", "app", "user")
        await service.delete_session(app_name="app", user_id="user", session_id=gone)
        _, new = await manager.get_or_create_session("new", "app", "user")
    assert manager._app_user_sessions("app", "user") == {
        ("app", "user", kept), ("app", "user", new)
    }
    assert await stored(service, kept) is not None


# Two runs that share a thread id but differ in app (same user) or in user
# (same app). Each pair must resolve, cache, run, and record under its own scope.
SCOPE_PAIRS = [
    pytest.param(("first", "one"), ("second", "one"), id="cross-app"),
    pytest.param(("app", "one"), ("app", "two"), id="cross-user"),
]


def scoped_recording_agent(service, seen, **kwargs):
    """An adapter whose app and user come from the request, running a model-free
    agent that records the session it was handed and writes the run's scope."""
    from google.adk.agents import BaseAgent
    from google.adk.events import EventActions

    class RecordingAgent(BaseAgent):
        async def _run_async_impl(self, ctx):
            seen.append(
                {
                    "id": ctx.session.id,
                    "app": ctx.session.app_name,
                    "user": ctx.session.user_id,
                    "state": dict(ctx.session.state),
                    "texts": [
                        p.text
                        for e in ctx.session.events
                        if e.content
                        for p in e.content.parts or []
                        if p.text
                    ],
                }
            )
            owner = f"{ctx.session.app_name}/{ctx.session.user_id}"
            yield Event(
                invocation_id=ctx.invocation_id,
                author=self.name,
                content=types.Content(
                    role="model", parts=[types.Part(text=f"reply for {owner}")]
                ),
                actions=EventActions(state_delta={"owner": owner}),
            )

    return ADKAgent(
        adk_agent=RecordingAgent(name="recorder"),
        app_name_extractor=lambda i: i.forwarded_props["app"],
        user_id_extractor=lambda i: i.forwarded_props["user"],
        session_service=service,
        delete_session_on_cleanup=False,
        **kwargs,
    )


def scoped_run(app, user, run_id="run", message_id="shared-message"):
    return RunAgentInput(
        thread_id="wire",
        run_id=run_id,
        messages=[UserMessage(id=message_id, content=f"Hello from {app}/{user}")],
        state={},
        tools=[],
        context=[],
        forwarded_props={"app": app, "user": user},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
@pytest.mark.parametrize("first_scope,second_scope", SCOPE_PAIRS)
async def test_same_thread_in_another_scope_runs_in_its_own_session(
    first_scope, second_scope, direct
):
    service = InMemorySessionService()
    seen = []
    agent = scoped_recording_agent(
        service, seen, use_thread_id_as_session_id=direct
    )
    try:
        for app, user in (first_scope, second_scope):
            events = [e async for e in agent.run(scoped_run(app, user))]
            assert [e.type for e in events][-1] == "RUN_FINISHED", events

        assert len(seen) == 2, "the second scope's message was filtered as seen"
        first, second = seen
        for record, (app, user) in zip(seen, (first_scope, second_scope)):
            assert (record["app"], record["user"]) == (app, user)
            assert "owner" not in record["state"]
            assert record["texts"] == [f"Hello from {app}/{user}"]

        for app, user in (first_scope, second_scope):
            sessions = (
                await service.list_sessions(app_name=app, user_id=user)
            ).sessions
            assert len(sessions) == 1
            stored_session = await service.get_session(
                app_name=app, user_id=user, session_id=sessions[0].id
            )
            assert stored_session.state["owner"] == f"{app}/{user}"
            assert agent._session_lookup_cache[("wire", user, app)] == (
                sessions[0].id, app, user
            )
            assert agent._session_manager.get_processed_message_ids(
                app_name=app, user_id=user, thread_id="wire"
            ) == {"shared-message"}
        assert len(agent._session_lookup_cache) == 2
        assert agent._active_executions == {}
    finally:
        await agent.close()
        if agent._session_manager._cleanup_task:
            agent._session_manager._cleanup_task.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize("first_scope,second_scope", SCOPE_PAIRS)
async def test_warm_cache_never_serves_another_scopes_session(
    first_scope, second_scope
):
    """The first scope's thread maps to a backend session; the second owns a
    native session of the thread's id. A warm cache must serve each its own."""
    service = InMemorySessionService()
    first_app, first_user = first_scope
    await native(
        service,
        "mapped",
        first_app,
        first_user,
        {THREAD_ID_STATE_KEY: "wire", "todo": f"{first_app}/{first_user}"},
    )
    await native(service, "wire", *second_scope, {"todo": "/".join(second_scope)})
    seen = []
    agent = scoped_recording_agent(service, seen)
    try:
        for run_id, (app, user) in enumerate((first_scope, second_scope)):
            events = [
                e async for e in agent.run(scoped_run(app, user, run_id=str(run_id)))
            ]
            assert [e.type for e in events][-1] == "RUN_FINISHED", events
        assert [(r["id"], r["app"], r["user"], r["state"]["todo"]) for r in seen] == [
            ("mapped", *first_scope, "/".join(first_scope)),
            ("wire", *second_scope, "/".join(second_scope)),
        ]
        assert "Native history" in seen[1]["texts"]
        for sid, (app, user) in (("mapped", first_scope), ("wire", second_scope)):
            after = await service.get_session(
                app_name=app, user_id=user, session_id=sid
            )
            assert after.state["owner"] == f"{app}/{user}"
            assert agent._session_lookup_cache[("wire", user, app)] == (sid, app, user)
    finally:
        await agent.close()
        if agent._session_manager._cleanup_task:
            agent._session_manager._cleanup_task.cancel()


@pytest.mark.parametrize("first_scope,second_scope", SCOPE_PAIRS)
def test_state_endpoint_cache_hit_is_read_under_the_requesting_scope(
    first_scope, second_scope
):
    """The endpoint's cache fast path must key on the resolved app and user.

    The first scope warms the cache; the second, which has no session for the
    thread, must see an empty thread rather than the first scope's state."""
    service = InMemorySessionService()
    asyncio.run(native(service, "wire", *first_scope, {"todo": "first-secret"}))
    agent = adapter(service)

    async def identity(request, _input):
        return {
            "app_name": request.headers["x-app"],
            "user_id": request.headers["x-user"],
        }

    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent, extract_state_from_request=identity)

    def read_state(scope):
        return client.post(
            "/agents/state",
            headers={"x-app": scope[0], "x-user": scope[1]},
            json={"threadId": "wire"},
        )

    with TestClient(app) as client:
        first = read_state(first_scope)
        assert first.status_code == 200
        assert first.json()["state"]["todo"] == "first-secret"
        with patch.object(
            agent, "_get_session_metadata", wraps=agent._get_session_metadata
        ) as lookup:
            second = read_state(second_scope)
        assert second.status_code == 200
        assert second.json() == {
            "threadId": "wire",
            "threadExists": False,
            "state": {},
            "messages": [],
        }
        lookup.assert_called_once_with(
            "wire", second_scope[1], app_name=second_scope[0]
        )
        first_key = ("wire", first_scope[1], first_scope[0])
        assert agent._session_lookup_cache == {
            first_key: ("wire", first_scope[0], first_scope[1])
        }

        # The first scope's warm fast path still reads its own session.
        again = read_state(first_scope)
        assert again.json()["state"]["todo"] == "first-secret"


async def _thread_moved_to_newer_session(stale_path):
    """Thread "t" runs on A, then moves to B; A leaves tracking via stale_path."""
    service = InMemorySessionService()
    manager = SessionManager(session_service=service, max_sessions_per_user=2)
    with patch.object(manager, "_start_cleanup_task"):
        first, first_id = await manager.get_or_create_session("t", "app", "user")
        manager.mark_messages_processed(
            ["m1"], app_name="app", user_id="user", thread_id="t"
        )
        if stale_path == "delete":
            # A newer session mapped to the same thread wins resolution.
            newer = await native(service, "newer", state={THREAD_ID_STATE_KEY: "t"})
        else:
            await service.delete_session(
                app_name="app", user_id="user", session_id=first_id
            )
        _, second_id = await manager.get_or_create_session("t", "app", "user")
        assert second_id != first_id
        if stale_path == "delete":
            assert second_id == newer.id
        manager.mark_messages_processed(
            ["m2"], app_name="app", user_id="user", thread_id="t"
        )
        if stale_path == "expiry":
            await manager._cleanup_expired_sessions()
        elif stale_path == "eviction":
            await manager.get_or_create_session("other", "app", "user")
        else:
            await manager._delete_session(first)
    assert manager._make_session_key("app", first_id, "user") not in (
        manager._session_keys
    )
    return service, manager, second_id


@pytest.mark.asyncio
@pytest.mark.parametrize("stale_path", ["expiry", "eviction", "delete"])
async def test_untracking_stale_session_keeps_active_threads_processed_ids(
    stale_path,
):
    _, manager, _ = await _thread_moved_to_newer_session(stale_path)
    assert manager.get_processed_message_ids(
        app_name="app", user_id="user", thread_id="t"
    ) == {"m1", "m2"}


@pytest.mark.asyncio
@pytest.mark.parametrize("stale_path", ["expiry", "eviction", "delete"])
async def test_deleting_active_session_drops_its_tracking(stale_path):
    service, manager, second_id = await _thread_moved_to_newer_session(stale_path)
    await manager._delete_session(await stored(service, second_id))
    # A generated backend ID never names the thread, so its processed IDs
    # stay, as before native lookup.
    assert manager.get_processed_message_ids(
        app_name="app", user_id="user", thread_id="t"
    ) == {"m1", "m2"}
    assert ("app", "user", second_id) not in manager._session_keys
    assert not any("t" in aliases for aliases in manager._session_thread_ids.values())
    assert ("app", "user", "t") not in manager._created_threads()


# Only sessions this process created are tracked. A continued session, whether
# native or created by an earlier process, is never counted toward
# max_sessions_per_user, evicted, expired, deleted, or saved to memory here.


class RecordingMemory(InMemoryMemoryService):
    def __init__(self):
        super().__init__()
        self.saved = []

    async def add_session_to_memory(self, session):
        self.saved.append(session.id)


async def continued_sessions(service):
    """A native session and one an earlier process created for thread "old"."""
    await native(service, "n1")
    await native(service, "s1", state={THREAD_ID_STATE_KEY: "old", "todo": "keep"})
    return {"n1": "n1", "old": "s1"}


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_new_thread_at_limit_leaves_continued_sessions_alone(direct):
    service = InMemorySessionService()
    threads = await continued_sessions(service)
    memory = RecordingMemory()
    manager = SessionManager(
        session_service=service,
        memory_service=memory,
        max_sessions_per_user=1,
        session_timeout_seconds=-1,
        use_thread_id_as_session_id=direct,
    )
    with patch.object(manager, "_start_cleanup_task"):
        for thread_id, sid in threads.items():
            _, resolved = await manager.get_or_create_session(thread_id, "app", "user")
            assert resolved == sid
        _, new = await manager.get_or_create_session("new", "app", "user")
        assert manager._session_keys == {("app", "user", new)}
        await manager._cleanup_expired_sessions()
    assert memory.saved == [new]
    assert await stored(service, new) is None
    for sid in threads.values():
        assert (await stored(service, sid)).events[0].id == "history"


def model_free_agent(service, **kwargs):
    from google.adk.agents import BaseAgent

    class ReplyAgent(BaseAgent):
        async def _run_async_impl(self, ctx):
            yield Event(
                invocation_id=ctx.invocation_id,
                author=self.name,
                content=types.Content(role="model", parts=[types.Part(text="ok")]),
            )

    return ADKAgent(
        adk_agent=ReplyAgent(name="app"),
        app_name="app",
        user_id="user",
        session_service=service,
        **kwargs,
    )


def run_input(thread_id, message_id):
    return RunAgentInput(
        thread_id=thread_id,
        run_id=f"run-{message_id}",
        messages=[UserMessage(id=message_id, content="hi")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_runs_on_continued_sessions_are_not_evicted_by_a_new_thread(direct):
    # Warm runs take the lookup-cache path, which must not track either.
    service = InMemorySessionService()
    threads = await continued_sessions(service)
    memory = RecordingMemory()
    agent = model_free_agent(
        service,
        memory_service=memory,
        max_sessions_per_user=1,
        use_thread_id_as_session_id=direct,
    )
    try:
        for turn in ("a", "b"):
            for thread_id in threads:
                run = agent.run(run_input(thread_id, f"{thread_id}-{turn}"))
                events = [e async for e in run]
                assert events[-1].type == "RUN_FINISHED"
        manager = agent._session_manager
        assert manager.get_user_session_count("user") == 0
        events = [e async for e in agent.run(run_input("new", "new-a"))]
        assert events[-1].type == "RUN_FINISHED"
        assert manager.get_user_session_count("user") == 1
        assert memory.saved == []
        for sid in threads.values():
            assert (await stored(service, sid)).events[0].id == "history"
    finally:
        await agent.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_continued_sessions_processed_ids_survive_new_thread_eviction(direct):
    service = InMemorySessionService()
    threads = await continued_sessions(service)
    manager = SessionManager(
        session_service=service,
        max_sessions_per_user=1,
        delete_session_on_cleanup=False,
        use_thread_id_as_session_id=direct,
    )
    with patch.object(manager, "_start_cleanup_task"):
        for thread_id in threads:
            await manager.get_or_create_session(thread_id, "app", "user")
            manager.mark_messages_processed(
                [f"{thread_id}-seen"],
                app_name="app",
                user_id="user",
                thread_id=thread_id,
            )
        for new in ("new1", "new2"):
            await manager.get_or_create_session(new, "app", "user")
    for thread_id in threads:
        assert manager.get_processed_message_ids(
            app_name="app", user_id="user", thread_id=thread_id
        ) == {f"{thread_id}-seen"}


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_created_sessions_obey_the_user_limit(direct):
    service = InMemorySessionService()
    memory = RecordingMemory()
    manager = SessionManager(
        session_service=service,
        memory_service=memory,
        max_sessions_per_user=2,
        use_thread_id_as_session_id=direct,
    )
    with patch.object(manager, "_start_cleanup_task"):
        ids = [
            (await manager.get_or_create_session(t, "app", "user"))[1]
            for t in ("t1", "t2")
        ]
        # Continuing a created session neither re-counts nor evicts.
        assert (await manager.get_or_create_session("t1", "app", "user"))[1] == ids[0]
        assert manager.get_user_session_count("user") == 2
        assert memory.saved == []
        # A third creation evicts the least recently updated created session.
        _, third = await manager.get_or_create_session("t3", "app", "user")
    assert manager._session_keys == {("app", "user", ids[1]), ("app", "user", third)}
    assert memory.saved == [ids[0]]
    assert await stored(service, ids[0]) is None
    assert await stored(service, ids[1]) is not None


@pytest.mark.asyncio
async def test_managers_sharing_a_backend_recheck_each_others_creations():
    service = InMemorySessionService()
    first = SessionManager(session_service=service)
    second = SessionManager(session_service=service)
    with patch.object(first, "_start_cleanup_task"), patch.object(
        second, "_start_cleanup_task"
    ):
        _, created = await first.get_or_create_session("t", "app", "user")
        # second's caller scanned before first created; the hint is stale.
        _, again = await second.get_or_create_session(
            "t", "app", "user", skip_find=True
        )
    assert again == created
    listed = await service.list_sessions(app_name="app", user_id="user")
    assert len(listed.sessions) == 1


@pytest.mark.asyncio
async def test_creation_registry_is_released_with_its_backend():
    import gc
    import weakref

    service = InMemorySessionService()
    manager = SessionManager(session_service=service)
    with patch.object(manager, "_start_cleanup_task"):
        await manager.get_or_create_session("released", "app", "user")
    assert ("app", "user", "released") in manager._created_threads()
    backend = weakref.ref(service)
    del manager, service
    gc.collect()
    assert backend() is None
    assert not any(
        ("app", "user", "released") in created
        for created in SessionManager._created_by_backend.values()
    )


@pytest.mark.asyncio
async def test_unhashable_backend_still_rechecks_its_own_creations():
    class UnhashableService(InMemorySessionService):
        __hash__ = None

    service = UnhashableService()
    manager = SessionManager(session_service=service)
    with patch.object(manager, "_start_cleanup_task"):
        _, created = await manager.get_or_create_session("t", "app", "user")
        _, again = await manager.get_or_create_session(
            "t", "app", "user", skip_find=True
        )
    assert again == created
    listed = await service.list_sessions(app_name="app", user_id="user")
    assert len(listed.sessions) == 1
