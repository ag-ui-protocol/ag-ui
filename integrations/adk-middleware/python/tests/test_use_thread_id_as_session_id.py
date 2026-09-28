# tests/test_use_thread_id_as_session_id.py

"""Tests for the use_thread_id_as_session_id feature."""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from types import SimpleNamespace

from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.session_manager import THREAD_ID_STATE_KEY, APP_NAME_STATE_KEY, USER_ID_STATE_KEY
from ag_ui.core import RunAgentInput, UserMessage
from google.adk.agents import Agent
from google.adk.errors.already_exists_error import AlreadyExistsError
from google.adk.sessions import InMemorySessionService


class NoListSessionService(InMemorySessionService):
    """A backend that cannot list sessions."""

    async def list_sessions(self, *, app_name, user_id=None):
        raise NotImplementedError("listing unsupported")


class RaisingGetSessionService(InMemorySessionService):
    """A backend whose get_session raises for an unknown ID."""

    async def get_session(self, *, app_name, user_id, session_id, config=None):
        session = await super().get_session(
            app_name=app_name, user_id=user_id, session_id=session_id, config=config
        )
        if session is None:
            raise KeyError(f"no session {session_id}")
        return session


class TestSessionManagerDirectLookup:
    """Tests for SessionManager with use_thread_id_as_session_id=True."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager before each test."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def session_service(self):
        return InMemorySessionService()

    @pytest.fixture
    def manager(self, session_service):
        return SessionManager(
            session_service=session_service,
            use_thread_id_as_session_id=True,
        )

    @pytest.fixture
    def manager_scan(self, session_service):
        """Manager with the default scan-based lookup (for comparison)."""
        SessionManager.reset_instance()
        return SessionManager(
            session_service=session_service,
            use_thread_id_as_session_id=False,
        )

    @pytest.mark.asyncio
    async def test_create_session_uses_thread_id(self, manager, session_service):
        """Session is created with session_id == thread_id."""
        session, backend_id = await manager.get_or_create_session(
            thread_id="thread-abc",
            app_name="app1",
            user_id="user1",
        )
        assert backend_id == "thread-abc"
        assert session.id == "thread-abc"

    @pytest.mark.asyncio
    async def test_get_existing_session_direct_lookup(self, manager, session_service):
        """Second call returns the same session via direct O(1) lookup."""
        session1, id1 = await manager.get_or_create_session(
            thread_id="thread-abc",
            app_name="app1",
            user_id="user1",
        )
        session2, id2 = await manager.get_or_create_session(
            thread_id="thread-abc",
            app_name="app1",
            user_id="user1",
        )
        assert id1 == id2 == "thread-abc"

    @pytest.mark.asyncio
    async def test_new_thread_scans_once_and_reads_once(self, manager, session_service):
        """A new thread checks for a mapped session, then creates without re-reading."""
        with patch.object(session_service, "list_sessions", wraps=session_service.list_sessions) as lister, \
             patch.object(session_service, "get_session", wraps=session_service.get_session) as getter:
            _, sid = await manager.get_or_create_session(
                thread_id="thread-new",
                app_name="app1",
                user_id="user1",
            )
        assert sid == "thread-new"
        assert lister.call_count == 1
        assert getter.call_count == 1

    @pytest.mark.asyncio
    async def test_cold_hit_is_one_get_without_scan(self, session_service):
        """A session this mode created resolves in a fresh manager with one read."""
        creator = SessionManager(session_service=session_service, use_thread_id_as_session_id=True)
        with patch.object(creator, "_start_cleanup_task"):
            await creator.get_or_create_session("thread-cold", "app1", "user1")
        fresh = SessionManager(session_service=session_service, use_thread_id_as_session_id=True)
        with patch.object(session_service, "list_sessions", wraps=session_service.list_sessions) as lister, \
             patch.object(session_service, "get_session", wraps=session_service.get_session) as getter, \
             patch.object(session_service, "create_session", wraps=session_service.create_session) as creator_spy, \
             patch.object(fresh, "_start_cleanup_task"):
            resolved = await fresh.resolve_existing_session("thread-cold", "app1", "user1")
            assert resolved.id == "thread-cold"
            assert (lister.call_count, getter.call_count) == (0, 1)
            _, sid = await fresh.get_or_create_session("thread-cold", "app1", "user1")
        assert sid == "thread-cold"
        assert (lister.call_count, getter.call_count) == (0, 2)
        creator_spy.assert_not_called()

    @pytest.mark.asyncio
    async def test_direct_hit_wins_over_duplicate_mapping(self, manager, session_service):
        """The thread's own mapped session is authoritative in direct mode."""
        await session_service.create_session(
            app_name="app1", user_id="user1", session_id="thread-dup",
            state={THREAD_ID_STATE_KEY: "thread-dup"},
        )
        await session_service.create_session(
            app_name="app1", user_id="user1", session_id="generated",
            state={THREAD_ID_STATE_KEY: "thread-dup"},
        )
        # A scan would prefer the more recently updated duplicate.
        session_service.sessions["app1"]["user1"]["generated"].last_update_time = 10**12
        with patch.object(manager, "_start_cleanup_task"):
            _, sid = await manager.get_or_create_session("thread-dup", "app1", "user1")
        assert sid == "thread-dup"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "backend_cls, state, raised",
        [
            # The scan finds the mapping and its re-read fails.
            (InMemorySessionService, {THREAD_ID_STATE_KEY: "thread-down"}, RuntimeError),
            # Nothing else finds it: the create at the thread ID is rejected.
            (NoListSessionService, {THREAD_ID_STATE_KEY: "thread-down"}, AlreadyExistsError),
            (InMemorySessionService, {}, AlreadyExistsError),
        ],
        ids=["mapped", "mapped-unlistable", "native-unstamped"],
    )
    async def test_failed_direct_read_never_forks_an_existing_session(self, backend_cls, state, raised):
        """A direct read that fails for an existing session raises and creates nothing."""
        service = backend_cls()
        await InMemorySessionService.create_session(
            service, app_name="app1", user_id="user1", session_id="thread-down", state=state,
        )
        manager = SessionManager(session_service=service, use_thread_id_as_session_id=True)
        with patch.object(service, "get_session", side_effect=RuntimeError("down")), \
             patch.object(manager, "_start_cleanup_task"):
            with pytest.raises(raised):
                await manager.get_or_create_session("thread-down", "app1", "user1")
        listed = await InMemorySessionService.list_sessions(service, app_name="app1", user_id="user1")
        assert [s.id for s in listed.sessions] == ["thread-down"]
        assert manager.get_session_count() == 0

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "backend_cls", [NoListSessionService, RaisingGetSessionService],
        ids=["no-list", "raising-get"],
    )
    async def test_new_thread_and_continuation_on_limited_backends(self, backend_cls):
        """Backends that cannot list, or raise for unknown IDs, open and continue threads."""
        service = backend_cls()
        creator = SessionManager(session_service=service, use_thread_id_as_session_id=True)
        with patch.object(creator, "_start_cleanup_task"):
            session, sid = await creator.get_or_create_session("thread-new", "app1", "user1")
        assert sid == session.id == "thread-new"
        fresh = SessionManager(session_service=service, use_thread_id_as_session_id=True)
        with patch.object(fresh, "_start_cleanup_task"):
            _, again = await fresh.get_or_create_session("thread-new", "app1", "user1")
        assert again == "thread-new"
        listed = await InMemorySessionService.list_sessions(service, app_name="app1", user_id="user1")
        assert [s.id for s in listed.sessions] == ["thread-new"]

    @pytest.mark.asyncio
    async def test_list_errors_other_than_unsupported_still_propagate(self, manager, session_service):
        """Only an unsupported list is treated as unable to list."""
        with patch.object(session_service, "list_sessions", side_effect=RuntimeError("down")), \
             patch.object(session_service, "create_session", wraps=session_service.create_session) as creator_spy:
            with pytest.raises(RuntimeError, match="down"):
                await manager.get_or_create_session("thread-down", "app1", "user1")
        creator_spy.assert_not_called()

    @pytest.mark.asyncio
    async def test_stores_thread_id_in_state(self, manager, session_service):
        """Even with direct lookup, thread_id metadata is stored in state."""
        session, _ = await manager.get_or_create_session(
            thread_id="thread-meta",
            app_name="app1",
            user_id="user1",
        )
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-meta"
        assert session.state.get(APP_NAME_STATE_KEY) == "app1"
        assert session.state.get(USER_ID_STATE_KEY) == "user1"

    @pytest.mark.asyncio
    async def test_initial_state_preserved(self, manager, session_service):
        """Initial state is merged with metadata keys."""
        session, _ = await manager.get_or_create_session(
            thread_id="thread-state",
            app_name="app1",
            user_id="user1",
            initial_state={"user_pref": "dark"},
        )
        assert session.state.get("user_pref") == "dark"
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-state"

    @pytest.mark.asyncio
    async def test_multiple_threads_independent(self, manager, session_service):
        """Different thread_ids create independent sessions."""
        _, id1 = await manager.get_or_create_session(
            thread_id="thread-1",
            app_name="app1",
            user_id="user1",
        )
        _, id2 = await manager.get_or_create_session(
            thread_id="thread-2",
            app_name="app1",
            user_id="user1",
        )
        assert id1 == "thread-1"
        assert id2 == "thread-2"
        assert id1 != id2

    @pytest.mark.asyncio
    async def test_session_tracking(self, manager):
        """Sessions are tracked for cleanup/enumeration."""
        await manager.get_or_create_session(
            thread_id="thread-track",
            app_name="app1",
            user_id="user1",
        )
        assert manager.get_session_count() == 1
        assert manager.get_user_session_count("user1") == 1

    @pytest.mark.asyncio
    async def test_race_condition_retry(self, manager, session_service):
        """If create_session loses a race, the concurrently created session is used."""
        # Another process created the session after this one's lookup, so the
        # skip_find hint is honored and create hits the existing ID.
        await session_service.create_session(
            app_name="app1", user_id="user1", session_id="thread-race",
            state={THREAD_ID_STATE_KEY: "thread-race"},
        )
        with patch.object(session_service, "get_session", wraps=session_service.get_session) as getter, \
             patch.object(session_service, "create_session", wraps=session_service.create_session) as creator:
            session, sid = await manager.get_or_create_session(
                thread_id="thread-race",
                app_name="app1",
                user_id="user1",
                skip_find=True,
            )
        assert sid == session.id == "thread-race"
        assert creator.call_count == 1
        assert getter.call_count == 1

    @pytest.mark.asyncio
    async def test_race_with_another_threads_session_falls_back_to_generated_id(
        self, manager, session_service
    ):
        """A create conflict with another thread's session never adopts it."""
        await session_service.create_session(
            app_name="app1", user_id="user1", session_id="thread-taken",
            state={THREAD_ID_STATE_KEY: "owner"},
        )
        with patch.object(manager, "_start_cleanup_task"):
            session, sid = await manager.get_or_create_session(
                thread_id="thread-taken",
                app_name="app1",
                user_id="user1",
                skip_find=True,
            )
        assert sid != "thread-taken"
        assert session.state[THREAD_ID_STATE_KEY] == "thread-taken"
        owner = await session_service.get_session(
            app_name="app1", user_id="user1", session_id="thread-taken"
        )
        assert owner.state[THREAD_ID_STATE_KEY] == "owner"

    @pytest.mark.asyncio
    async def test_create_failure_without_a_session_propagates(self, manager, session_service):
        """A create error with nothing at the ID is raised, not swallowed."""
        with patch.object(session_service, "create_session", side_effect=RuntimeError("boom")):
            with pytest.raises(RuntimeError, match="boom"):
                await manager.get_or_create_session(
                    thread_id="thread-boom", app_name="app1", user_id="user1", skip_find=True,
                )


class TestSessionManagerScanPath:
    """Verify default scan path still works when flag is False."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def session_service(self):
        return InMemorySessionService()

    @pytest.fixture
    def manager(self, session_service):
        return SessionManager(
            session_service=session_service,
            use_thread_id_as_session_id=False,
        )

    @pytest.mark.asyncio
    async def test_default_lets_backend_generate_id(self, manager, session_service):
        """Default mode lets backend generate session_id (different from thread_id)."""
        session, backend_id = await manager.get_or_create_session(
            thread_id="thread-scan",
            app_name="app1",
            user_id="user1",
        )
        # InMemorySessionService generates its own IDs
        # The session should have thread_id in state, but session.id may differ
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-scan"

    @pytest.mark.asyncio
    async def test_scan_finds_existing_session(self, manager, session_service):
        """Scan path can recover existing sessions via list_sessions."""
        session1, id1 = await manager.get_or_create_session(
            thread_id="thread-find",
            app_name="app1",
            user_id="user1",
        )
        session2, id2 = await manager.get_or_create_session(
            thread_id="thread-find",
            app_name="app1",
            user_id="user1",
        )
        assert id1 == id2


class TestADKAgentWithThreadIdAsSessionId:
    """Tests for ADKAgent with use_thread_id_as_session_id=True."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_agent(self):
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        agent.instruction = "Test instruction"
        agent.tools = []
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
            use_thread_id_as_session_id=True,
        )

    @pytest.fixture
    def sample_input(self):
        return RunAgentInput(
            thread_id="direct-thread-123",
            run_id="run_001",
            messages=[
                UserMessage(id="msg1", role="user", content="Hello")
            ],
            context=[],
            state={},
            tools=[],
            forwarded_props={},
        )

    @pytest.mark.asyncio
    async def test_ensure_session_uses_thread_id_as_session_id(self, adk_agent, sample_input):
        """_ensure_session_exists creates session with thread_id as session_id."""
        session, backend_id = await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="direct-thread-123",
            initial_state={},
        )
        assert backend_id == "direct-thread-123"
        assert session.id == "direct-thread-123"

    @pytest.mark.asyncio
    async def test_cache_populated_after_session_creation(self, adk_agent, sample_input):
        """Session lookup cache should be populated after session creation."""
        await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="cached-thread",
            initial_state={},
        )
        cached = adk_agent._session_lookup_cache.get(("cached-thread", "test_user", "test_app"))
        assert cached is not None
        assert cached[0] == "cached-thread"  # session_id == thread_id

    @pytest.mark.asyncio
    async def test_second_call_uses_cache(self, adk_agent):
        """Second call to _ensure_session_exists should use cache, not re-create."""
        await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="reuse-thread",
            initial_state={},
        )
        # Second call
        session2, id2 = await adk_agent._ensure_session_exists(
            app_name="test_app",
            user_id="test_user",
            thread_id="reuse-thread",
            initial_state={},
        )
        assert id2 == "reuse-thread"

    @pytest.mark.asyncio
    async def test_full_run_with_direct_lookup(self, adk_agent, sample_input):
        """Full run() call works end-to-end with use_thread_id_as_session_id=True."""
        with patch.object(adk_agent, '_create_runner') as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "event1"
                mock_event.author = "test_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Response")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(sample_input)]

        # Should have events (at minimum RUN_STARTED + some content + RUN_FINISHED)
        assert len(events) > 0
        # Verify the session was created with thread_id as session_id
        cached = adk_agent._session_lookup_cache.get(("direct-thread-123", "test_user", "test_app"))
        assert cached is not None
        assert cached[0] == "direct-thread-123"

    @pytest.mark.asyncio
    async def test_parameter_defaults_to_false(self):
        """use_thread_id_as_session_id defaults to False."""
        SessionManager.reset_instance()
        agent = Mock(spec=Agent)
        agent.name = "test"
        adk = ADKAgent(
            adk_agent=agent,
            app_name="app",
            user_id="user",
        )
        assert adk._session_manager._use_thread_id_as_session_id is False


class TestAgentsStateEndpointWithDirectLookup:
    """Tests for /agents/state endpoint with use_thread_id_as_session_id=True."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def mock_agent(self):
        agent = Mock(spec=Agent)
        agent.name = "test_agent"
        agent.instruction = "Test instruction"
        agent.tools = []
        return agent

    @pytest.fixture
    def adk_agent(self, mock_agent):
        return ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
            use_in_memory_services=True,
            use_thread_id_as_session_id=True,
        )

    @pytest.fixture
    def app(self, adk_agent):
        from fastapi import FastAPI
        from ag_ui_adk import add_adk_fastapi_endpoint
        app = FastAPI()
        add_adk_fastapi_endpoint(app, adk_agent)
        return app

    @pytest.fixture
    def client(self, app):
        from starlette.testclient import TestClient
        return TestClient(app)

    @pytest.mark.asyncio
    async def test_agents_state_uses_direct_lookup(self, adk_agent, client):
        """State hydration checks mappings before falling back to the native ID."""
        # Create a session first via the session manager
        session, sid = await adk_agent._session_manager.get_or_create_session(
            thread_id="state-thread-123",
            app_name="test_app",
            user_id="test_user",
        )
        assert sid == "state-thread-123"

        # Ensure the cache is clear so endpoint must look up from backend
        adk_agent._session_lookup_cache.clear()

        # Verify state hydration honors mapping precedence
        with patch.object(
            adk_agent._session_manager._session_service,
            "list_sessions",
            wraps=adk_agent._session_manager._session_service.list_sessions,
        ) as spy:
            response = client.post(
                "/agents/state",
                json={"threadId": "state-thread-123"},
            )
            assert response.status_code == 200
            data = response.json()
            assert data["threadExists"] is True
            assert data["threadId"] == "state-thread-123"
            # A session this mode created needs no scan.
            assert spy.call_count == 0

    @pytest.mark.asyncio
    async def test_agents_state_nonexistent_thread(self, adk_agent, client):
        """/agents/state returns threadExists=False for unknown thread."""
        response = client.post(
            "/agents/state",
            json={"threadId": "nonexistent-thread"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["threadExists"] is False


@pytest.mark.asyncio
async def test_cold_run_resolves_direct_session_without_scanning():
    """A restarted adapter continues a direct-mode thread with no list_sessions call."""
    from google.adk.agents import BaseAgent
    from google.adk.events import Event
    from google.genai import types

    class Reply(BaseAgent):
        async def _run_async_impl(self, ctx):
            yield Event(
                invocation_id=ctx.invocation_id,
                author=self.name,
                content=types.Content(role="model", parts=[types.Part(text="ok")]),
            )

    service = InMemorySessionService()
    await service.create_session(
        app_name="app", user_id="user", session_id="thread-run",
        state={THREAD_ID_STATE_KEY: "thread-run"},
    )
    agent = ADKAgent(
        adk_agent=Reply(name="app"),
        app_name="app",
        user_id="user",
        session_service=service,
        delete_session_on_cleanup=False,
        use_thread_id_as_session_id=True,
    )
    run = RunAgentInput(
        thread_id="thread-run",
        run_id="run-1",
        messages=[UserMessage(id="m1", content="hi")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )
    manager = agent._session_manager
    try:
        with patch.object(service, "list_sessions", wraps=service.list_sessions) as lister, \
             patch.object(service, "create_session", wraps=service.create_session) as creator, \
             patch.object(
                 manager, "resolve_existing_session", wraps=manager.resolve_existing_session
             ) as resolver:
            events = [e async for e in agent.run(run)]
        assert events[-1].type == "RUN_FINISHED"
        assert resolver.call_count == 1
        lister.assert_not_called()
        creator.assert_not_called()
        assert agent._session_lookup_cache[("thread-run", "user", "app")][0] == "thread-run"
    finally:
        await agent.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "backend_cls", [NoListSessionService, RaisingGetSessionService],
    ids=["no-list", "raising-get"],
)
async def test_run_opens_new_thread_on_limited_backends(backend_cls):
    """A direct-mode run on a new thread finishes on backends that cannot list or raise on unknown IDs."""
    from google.adk.agents import BaseAgent
    from google.adk.events import Event
    from google.genai import types

    class Reply(BaseAgent):
        async def _run_async_impl(self, ctx):
            yield Event(
                invocation_id=ctx.invocation_id,
                author=self.name,
                content=types.Content(role="model", parts=[types.Part(text="ok")]),
            )

    service = backend_cls()
    agent = ADKAgent(
        adk_agent=Reply(name="app"),
        app_name="app",
        user_id="user",
        session_service=service,
        delete_session_on_cleanup=False,
        use_thread_id_as_session_id=True,
    )
    run = RunAgentInput(
        thread_id="thread-fresh",
        run_id="run-1",
        messages=[UserMessage(id="m1", content="hi")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )
    try:
        events = [e async for e in agent.run(run)]
        assert events[-1].type == "RUN_FINISHED"
        listed = await InMemorySessionService.list_sessions(service, app_name="app", user_id="user")
        assert [s.id for s in listed.sessions] == ["thread-fresh"]
    finally:
        await agent.close()
