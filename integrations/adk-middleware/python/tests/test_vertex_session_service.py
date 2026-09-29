# tests/test_vertex_session_service.py

"""Tests for ADKAgent behaviour with VertexAiSessionService.

Part 1: Tests against MockVertexAiSessionService, a Vertex-like service that
generates its own numeric session IDs and rejects a caller-provided
session_id, as VertexAiSessionService did before google-adk 1.29. It is not a
VertexAiSessionService instance, so SessionManager takes its generic lookup
path. These run in CI without any cloud credentials.

Vertex lookup tests drive the real VertexAiSessionService over a fake Agent
Engine sessions API, where session IDs are engine-wide. These also run in CI.

Part 2: Optional live tests that run against a real Vertex AI Agent Engine.
Skipped unless VERTEX_REASONING_ENGINE_ID and GOOGLE_CLOUD_PROJECT are set.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
import warnings
from typing import Any, Dict, Optional

import pytest
from unittest.mock import AsyncMock, patch

from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.session_manager import APP_NAME_STATE_KEY, THREAD_ID_STATE_KEY


# ---------------------------------------------------------------------------
# Mock VertexAiSessionService
# ---------------------------------------------------------------------------

class _MockSession:
    """Minimal session object matching the ADK Session contract."""

    def __init__(self, *, app_name: str, user_id: str, id: str, state: dict):
        self.app_name = app_name
        self.user_id = user_id
        self.id = id
        self.state = dict(state) if state else {}
        self.events: list = []
        self.last_update_time = time.time()


class _ListSessionsResponse:
    def __init__(self, sessions: list):
        self.sessions = sessions


class MockVertexAiSessionService:
    """Vertex-like service with pre-1.29 VertexAiSessionService ID rules.

    Key differences from InMemorySessionService:
    - Rejects caller-provided session_id with ValueError
    - Generates its own numeric session IDs (like Vertex AI Agent Engine)

    It is not a VertexAiSessionService, so SessionManager treats it as a
    generic backend. TestVertexNativeIdLookup covers engine-wide IDs.
    """

    def __init__(self):
        self._sessions: Dict[str, _MockSession] = {}  # keyed by "app:user:id"
        self._counter = 1000000

    def _make_key(self, app_name: str, user_id: str, session_id: str) -> str:
        return f"{app_name}:{user_id}:{session_id}"

    def _next_id(self) -> str:
        self._counter += 1
        return str(self._counter)

    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: Optional[dict] = None,
        session_id: Optional[str] = None,
        **kwargs: Any,
    ) -> _MockSession:
        if session_id is not None:
            raise ValueError(
                "User-provided Session id is not supported for"
                " VertexAISessionService."
            )
        sid = self._next_id()
        session = _MockSession(
            app_name=app_name, user_id=user_id, id=sid, state=state or {}
        )
        key = self._make_key(app_name, user_id, sid)
        self._sessions[key] = session
        return session

    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: Any = None,
    ) -> Optional[_MockSession]:
        key = self._make_key(app_name, user_id, session_id)
        return self._sessions.get(key)

    async def list_sessions(
        self, *, app_name: str, user_id: Optional[str] = None
    ) -> _ListSessionsResponse:
        results = []
        for session in self._sessions.values():
            if session.app_name != app_name:
                continue
            if user_id is not None and session.user_id != user_id:
                continue
            results.append(session)
        return _ListSessionsResponse(sessions=results)

    async def delete_session(
        self, *, app_name: str, user_id: str, session_id: str
    ) -> None:
        key = self._make_key(app_name, user_id, session_id)
        self._sessions.pop(key, None)

    async def append_event(self, session: _MockSession, event: Any) -> Any:
        session.events.append(event)
        session.last_update_time = time.time()
        return event


# ===================================================================
# Part 1: Mock-based tests (no cloud credentials needed)
# ===================================================================


class TestVertexSessionServiceMock:
    """Verify ADKAgent works with a backend that generates its own session IDs."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def vertex_session_service(self):
        return MockVertexAiSessionService()

    @pytest.fixture
    def adk_agent(self, vertex_session_service):
        from unittest.mock import Mock
        from google.adk.agents import Agent

        mock_adk = Mock(spec=Agent)
        mock_adk.name = "vertex_test_agent"
        mock_adk.instruction = "Test"
        mock_adk.tools = []

        return ADKAgent(
            adk_agent=mock_adk,
            app_name="vertex_test_app",
            user_id="test_user",
            session_service=vertex_session_service,
            use_in_memory_services=True,
            # Default: use_thread_id_as_session_id=False
        )

    @pytest.mark.asyncio
    async def test_session_created_with_backend_generated_id(
        self, adk_agent, vertex_session_service
    ):
        """Default path: backend generates the session_id (not thread_id)."""
        session, backend_id = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="my-thread-abc",
            initial_state={},
        )
        # Vertex generates numeric IDs — not equal to thread_id
        assert backend_id != "my-thread-abc"
        assert backend_id.isdigit()
        assert session.id == backend_id

    @pytest.mark.asyncio
    async def test_thread_id_stored_in_state(
        self, adk_agent, vertex_session_service
    ):
        """thread_id is stored in session state for recovery via scan."""
        session, _ = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-xyz",
            initial_state={},
        )
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-xyz"

    @pytest.mark.asyncio
    async def test_session_recovered_via_scan_after_cache_miss(
        self, adk_agent, vertex_session_service
    ):
        """After a cache miss, the scan path finds the session by thread_id in state."""
        # Create session
        _, backend_id = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-recover",
            initial_state={},
        )

        # Clear cache to simulate middleware restart
        adk_agent._session_lookup_cache.clear()

        # Second call should find the existing session via list_sessions scan
        session2, backend_id2 = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-recover",
            initial_state={},
        )
        assert backend_id2 == backend_id

    @pytest.mark.asyncio
    async def test_multiple_threads_get_separate_sessions(
        self, adk_agent, vertex_session_service
    ):
        """Different thread_ids create separate sessions."""
        _, id1 = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-1",
            initial_state={},
        )
        _, id2 = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-2",
            initial_state={},
        )
        assert id1 != id2

    @pytest.mark.asyncio
    async def test_same_thread_reuses_session_from_cache(
        self, adk_agent, vertex_session_service
    ):
        """Subsequent calls for the same thread_id reuse the cached session."""
        _, id1 = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-cache",
            initial_state={},
        )
        _, id2 = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-cache",
            initial_state={},
        )
        assert id1 == id2

    @pytest.mark.asyncio
    async def test_same_thread_id_different_users_get_separate_sessions(
        self, adk_agent, vertex_session_service
    ):
        """Same thread_id for two users must not share cache or backend session."""
        shared_thread = "shared-thread-id"
        _, id_user_a = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="user_a",
            thread_id=shared_thread,
            initial_state={},
        )
        _, id_user_b = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="user_b",
            thread_id=shared_thread,
            initial_state={},
        )
        assert id_user_a != id_user_b
        assert adk_agent._session_lookup_cache[(shared_thread, "user_a", "vertex_test_app")][0] == id_user_a
        assert adk_agent._session_lookup_cache[(shared_thread, "user_b", "vertex_test_app")][0] == id_user_b

    @pytest.mark.asyncio
    async def test_initial_state_merged_with_metadata(
        self, adk_agent, vertex_session_service
    ):
        """Client initial_state is merged with AG-UI metadata keys."""
        session, _ = await adk_agent._ensure_session_exists(
            app_name="vertex_test_app",
            user_id="test_user",
            thread_id="thread-state",
            initial_state={"preference": "dark_mode"},
        )
        assert session.state.get("preference") == "dark_mode"
        assert session.state.get(THREAD_ID_STATE_KEY) == "thread-state"


class TestVertexSessionServiceRejectsCustomId:
    """Verify that use_thread_id_as_session_id=True fails gracefully
    with VertexAiSessionService (which rejects caller-provided session_id)."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_create_session_raises_on_custom_id(self):
        """VertexAiSessionService raises ValueError for custom session_id."""
        svc = MockVertexAiSessionService()
        with pytest.raises(ValueError, match="not supported"):
            await svc.create_session(
                app_name="app", user_id="user", session_id="custom-id"
            )

    @pytest.mark.asyncio
    async def test_use_thread_id_as_session_id_propagates_error(self):
        """When use_thread_id_as_session_id=True and VertexAiSessionService
        rejects the custom ID, the error propagates to the caller."""
        from unittest.mock import Mock
        from google.adk.agents import Agent

        svc = MockVertexAiSessionService()

        mock_adk = Mock(spec=Agent)
        mock_adk.name = "test"
        mock_adk.tools = []

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name="app",
            user_id="user",
            session_service=svc,
            use_thread_id_as_session_id=True,
        )

        # The direct read and the mapping scan find nothing, create_session
        # raises ValueError, and the retry read returns None, so the
        # ValueError propagates.
        with pytest.raises(ValueError, match="not supported"):
            await agent._ensure_session_exists(
                app_name="app",
                user_id="user",
                thread_id="my-thread",
                initial_state={},
            )


class TestVertexSessionServiceFullRun:
    """End-to-end run() through ADKAgent with a mock Vertex session service."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_full_run_with_vertex_session_service(self):
        """Full run() works with MockVertexAiSessionService (default scan path)."""
        from unittest.mock import Mock, patch
        from google.adk.agents import Agent

        svc = MockVertexAiSessionService()

        mock_adk = Mock(spec=Agent)
        mock_adk.name = "vertex_agent"
        mock_adk.instruction = "Test"
        mock_adk.tools = []

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name="vertex_app",
            user_id="user",
            session_service=svc,
            use_in_memory_services=True,
        )

        input_data = RunAgentInput(
            thread_id="vertex-thread-run",
            run_id="run1",
            messages=[UserMessage(id="msg1", role="user", content="Hello")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        with patch.object(agent, "_create_runner") as mock_runner_factory:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "evt1"
                mock_event.author = "vertex_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Hi")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_runner_factory.return_value = mock_runner

            events = [event async for event in agent.run(input_data)]

        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_FINISHED in event_types

        # Session should exist with a numeric ID (not the thread_id)
        cached = agent._session_lookup_cache.get(("vertex-thread-run", "user", "vertex_app"))
        assert cached is not None
        backend_id = cached[0]
        assert backend_id.isdigit()

    @pytest.mark.asyncio
    async def test_multi_turn_with_vertex_session_service(self):
        """Multiple turns reuse the same Vertex session."""
        from unittest.mock import Mock, patch
        from google.adk.agents import Agent

        svc = MockVertexAiSessionService()

        mock_adk = Mock(spec=Agent)
        mock_adk.name = "vertex_agent"
        mock_adk.instruction = "Test"
        mock_adk.tools = []

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name="vertex_app",
            user_id="user",
            session_service=svc,
            use_in_memory_services=True,
        )

        def make_input(thread_id, messages):
            return RunAgentInput(
                thread_id=thread_id,
                run_id=f"run_{uuid.uuid4().hex[:8]}",
                messages=messages,
                state={},
                tools=[],
                context=[],
                forwarded_props={},
            )

        async def do_run(input_data):
            with patch.object(agent, "_create_runner") as mock_runner_factory:
                mock_runner = AsyncMock()
                mock_runner.close = AsyncMock()

                async def mock_run_async(*args, **kwargs):
                    mock_event = Mock()
                    mock_event.id = f"evt_{uuid.uuid4().hex[:6]}"
                    mock_event.author = "vertex_agent"
                    mock_event.content = Mock()
                    mock_event.content.parts = [Mock(text="Response")]
                    mock_event.partial = False
                    mock_event.actions = None
                    mock_event.get_function_calls = Mock(return_value=[])
                    mock_event.get_function_responses = Mock(return_value=[])
                    yield mock_event

                mock_runner.run_async = mock_run_async
                mock_runner_factory.return_value = mock_runner
                return [event async for event in agent.run(input_data)]

        # Turn 1
        input1 = make_input(
            "vertex-multi",
            [UserMessage(id="msg1", role="user", content="Turn 1")],
        )
        events1 = await do_run(input1)
        assert any(e.type == EventType.RUN_FINISHED for e in events1)
        session_id_1 = agent._session_lookup_cache[("vertex-multi", "user", "vertex_app")][0]

        # Turn 2 — same thread
        input2 = make_input(
            "vertex-multi",
            [
                UserMessage(id="msg1", role="user", content="Turn 1"),
                UserMessage(id="msg2", role="user", content="Turn 2"),
            ],
        )
        events2 = await do_run(input2)
        assert any(e.type == EventType.RUN_FINISHED for e in events2)
        session_id_2 = agent._session_lookup_cache[("vertex-multi", "user", "vertex_app")][0]

        # Same session reused
        assert session_id_1 == session_id_2


class _FakeAgentEngineSessions:
    """Agent Engine sessions API behind the real VertexAiSessionService.

    Session ids are engine-wide, as on Vertex: reading one returns it whatever
    the caller's user, and the service itself enforces ownership afterwards.
    """

    def __init__(self):
        self.records: Dict[str, Any] = {}
        self._counter = 9000
        self.read_names: list = []
        self.get_error: Optional[Exception] = None
        self.list_error: Optional[Exception] = None
        self.events = self

    def add(self, sid: str, user_id: str, state: Optional[dict] = None):
        from datetime import datetime, timezone
        from types import SimpleNamespace

        self.records[sid] = SimpleNamespace(
            name=f"reasoningEngines/{_ENGINE}/sessions/{sid}",
            user_id=user_id,
            session_state=state or {},
            update_time=datetime.now(timezone.utc),
        )

    @staticmethod
    async def _iterate(items):
        for item in items:
            yield item

    async def get(self, *, name: str):
        from google.genai.errors import ClientError

        self.read_names.append(name)
        if self.get_error is not None:
            raise self.get_error
        sid = name.split("/sessions/", 1)[1]
        if sid not in self.records:
            raise ClientError(404, {"error": {"code": 404, "status": "NOT_FOUND"}})
        return self.records[sid]

    async def create(self, *, name: str, user_id: str, config: dict):
        from types import SimpleNamespace
        from google.genai.errors import ClientError

        sid = config.get("session_id")
        if sid is None:
            # Generated ids never collide, as on Vertex.
            while str(self._counter) in self.records:
                self._counter += 1
            sid = str(self._counter)
        if sid in self.records:
            raise ClientError(409, {"error": {"code": 409, "status": "ALREADY_EXISTS"}})
        self.add(sid, user_id=user_id, state=config.get("session_state"))
        return SimpleNamespace(response=self.records[sid])

    async def list(self, *, name: str, config: Optional[dict] = None):
        if "/sessions/" in name:  # events.list
            return self._iterate([])
        if self.list_error is not None:
            raise self.list_error
        wanted = (config or {}).get("filter", "").partition("=")[2].strip('"')
        return self._iterate(
            [r for r in self.records.values() if not wanted or r.user_id == wanted]
        )


_ENGINE = "1234567890"


def _vertex_service(api: _FakeAgentEngineSessions, **kwargs: Any):
    """A real VertexAiSessionService whose Agent Engine client is ``api``."""
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from google.adk.sessions import VertexAiSessionService

    service = VertexAiSessionService(project="p", location="us-central1", **kwargs)
    client = SimpleNamespace(agent_engines=SimpleNamespace(sessions=api))

    @asynccontextmanager
    async def _client():
        yield client

    service._get_api_client = _client
    return service


async def _skip_unless_caller_session_ids_accepted() -> None:
    """Skip direct mode where the installed service rejects caller session ids.

    VertexAiSessionService raised ValueError for any caller-supplied
    session_id until google-adk 1.29.0, so use_thread_id_as_session_id cannot
    create a session there. Probe the installed service rather than its version.
    """
    probe = _vertex_service(_FakeAgentEngineSessions())
    try:
        await probe.create_session(
            app_name=_ENGINE, user_id="probe", session_id="probe"
        )
    except ValueError as rejected:
        pytest.skip(f"installed VertexAiSessionService rejects session_id: {rejected}")


class TestVertexNativeIdLookup:
    """Cold-run native id probes against the real VertexAiSessionService."""

    @pytest.fixture
    def api(self):
        return _FakeAgentEngineSessions()

    @pytest.fixture
    def vertex(self, api):
        return _vertex_service(api)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("direct", [False, True])
    async def test_other_users_native_id_is_not_found(
        self, vertex, api, direct, caplog
    ):
        api.add("4242", user_id="alice")
        manager = SessionManager(
            session_service=vertex, use_thread_id_as_session_id=direct
        )
        with caplog.at_level(logging.DEBUG):
            assert await manager.resolve_existing_session("4242", _ENGINE, "bob") is None
        # Never probed, so no error or log can reveal that alice's session exists.
        assert api.read_names == []
        assert "alice" not in caplog.text
        assert "belong" not in caplog.text

    @pytest.mark.asyncio
    async def test_new_thread_colliding_with_other_users_id_gets_own_session(
        self, vertex, api
    ):
        api.add("4242", user_id="alice", state={"secret": "a"})
        manager = SessionManager(session_service=vertex)
        with patch.object(manager, "_start_cleanup_task"):
            session, sid = await manager.get_or_create_session("4242", _ENGINE, "bob")
        assert sid != "4242"
        assert session.user_id == "bob"
        assert session.state[THREAD_ID_STATE_KEY] == "4242"
        assert "secret" not in session.state
        assert api.records["4242"].user_id == "alice"
        assert f"reasoningEngines/{_ENGINE}/sessions/4242" not in api.read_names

    @pytest.mark.asyncio
    async def test_direct_mode_new_thread_colliding_with_other_users_id_errors(
        self, vertex, api, caplog
    ):
        """Direct mode surfaces the create conflict instead of a generated id.

        The id is not listed for bob, so the manager never reads alice's
        session, and the run creates nothing.
        """
        from unittest.mock import Mock
        from google.adk.agents import Agent
        from google.genai.errors import ClientError

        await _skip_unless_caller_session_ids_accepted()
        api.add("4242", user_id="alice", state={"secret": "classified"})
        mock_adk = Mock(spec=Agent)
        mock_adk.name = "vertex_agent"
        mock_adk.instruction = "Test"
        mock_adk.tools = []
        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name=_ENGINE,
            user_id="bob",
            session_service=vertex,
            use_in_memory_services=True,
            use_thread_id_as_session_id=True,
        )
        run_input = RunAgentInput(
            thread_id="4242",
            run_id="run-1",
            messages=[UserMessage(id="m1", role="user", content="hi")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )
        with patch.object(agent, "_create_runner"):
            events = [event async for event in agent.run(run_input)]

        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert len(errors) == 1
        assert errors[0].code == "BACKGROUND_EXECUTION_ERROR"
        # The create conflict, not another failure, ended the run.
        logged = [r.exc_info[1] for r in caplog.records if r.exc_info]
        assert any(isinstance(e, ClientError) and e.code == 409 for e in logged)
        assert not any(e.type == EventType.RUN_FINISHED for e in events)
        assert list(api.records) == ["4242"]
        assert api.records["4242"].user_id == "alice"
        assert api.records["4242"].session_state == {"secret": "classified"}
        assert f"reasoningEngines/{_ENGINE}/sessions/4242" not in api.read_names

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "thread_id",
        ["my-thread/../4242", "a b", f"reasoningEngines/{_ENGINE}/sessions/4242"],
    )
    async def test_malformed_native_id_is_not_found(self, vertex, api, thread_id):
        api.add("4242", user_id="bob")
        manager = SessionManager(session_service=vertex)
        assert await manager.resolve_existing_session(thread_id, _ENGINE, "bob") is None
        assert api.read_names == []

    @pytest.mark.asyncio
    async def test_own_native_id_is_adopted(self, vertex, api):
        api.add("4242", user_id="bob")
        manager = SessionManager(session_service=vertex)
        session = await manager.resolve_existing_session("4242", _ENGINE, "bob")
        assert session.id == "4242"
        assert session.user_id == "bob"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("where", ["get", "list"])
    @pytest.mark.parametrize("code", [401, 403, 503])
    async def test_backend_failure_propagates(self, vertex, api, where, code):
        from google.genai.errors import ClientError, ServerError

        api.add("4242", user_id="bob")
        # The classes google-genai raises, so 4xx passes ADK's 404 filter.
        error_cls = ClientError if code < 500 else ServerError
        error = error_cls(code, {"error": {"code": code, "status": "FAILED"}})
        setattr(api, f"{where}_error", error)
        manager = SessionManager(session_service=vertex)
        with pytest.raises(error_cls) as raised:
            await manager.resolve_existing_session("4242", _ENGINE, "bob")
        assert raised.value is error


class _DelegatingSessionService:
    """A user wrapper, such as caching or tracing, around another service.

    It exposes the wrapped service under no attribute the middleware knows.
    """

    def __init__(self, wrapped):
        self._wrapped_service = wrapped

    async def create_session(self, **kwargs):
        return await self._wrapped_service.create_session(**kwargs)

    async def get_session(self, **kwargs):
        return await self._wrapped_service.get_session(**kwargs)

    async def list_sessions(self, **kwargs):
        return await self._wrapped_service.list_sessions(**kwargs)

    async def delete_session(self, **kwargs):
        return await self._wrapped_service.delete_session(**kwargs)

    async def append_event(self, **kwargs):
        return await self._wrapped_service.append_event(**kwargs)


class TestWrappedVertexNativeIdLookup:
    """Default mode reads only listed native ids, whatever wraps Vertex."""

    @pytest.fixture
    def api(self):
        return _FakeAgentEngineSessions()

    @pytest.fixture
    def manager(self, api):
        return SessionManager(
            session_service=_DelegatingSessionService(_vertex_service(api))
        )

    @pytest.mark.asyncio
    async def test_other_users_native_id_is_not_read(self, manager, api):
        api.add("4242", user_id="alice")
        assert await manager.resolve_existing_session("4242", _ENGINE, "bob") is None
        assert api.read_names == []

    @pytest.mark.asyncio
    async def test_new_thread_colliding_with_other_users_id_gets_own_session(
        self, manager, api
    ):
        api.add("4242", user_id="alice", state={"secret": "a"})
        with patch.object(manager, "_start_cleanup_task"):
            session, sid = await manager.get_or_create_session("4242", _ENGINE, "bob")
        assert sid != "4242"
        assert session.user_id == "bob"
        assert "secret" not in session.state
        assert f"reasoningEngines/{_ENGINE}/sessions/4242" not in api.read_names

    @pytest.mark.asyncio
    async def test_malformed_native_id_is_not_read(self, manager, api):
        assert await manager.resolve_existing_session("a b", _ENGINE, "bob") is None
        assert api.read_names == []

    @pytest.mark.asyncio
    async def test_own_native_id_is_adopted(self, manager, api):
        api.add("4242", user_id="bob")
        session = await manager.resolve_existing_session("4242", _ENGINE, "bob")
        assert session.id == "4242"
        assert session.user_id == "bob"


class TestVertexSharedAgentEngine:
    """Apps sharing one agent engine, as with agent_engine_id.

    The engine, not the app name, scopes Vertex sessions then, and the service
    stamps the caller's app name on every session it returns.
    """

    @pytest.fixture
    def api(self):
        return _FakeAgentEngineSessions()

    @pytest.fixture
    def vertex(self, api):
        return _vertex_service(api, agent_engine_id=_ENGINE)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("direct", [False, True])
    async def test_apps_never_resolve_each_others_threads(self, vertex, api, direct):
        if direct:
            await _skip_unless_caller_session_ids_accepted()
        manager = SessionManager(
            session_service=vertex, use_thread_id_as_session_id=direct
        )
        with patch.object(manager, "_start_cleanup_task"):
            _, a_id = await manager.get_or_create_session(
                "t1", "app-a", "bob", initial_state={"secret": "a"}
            )
            assert await manager.resolve_existing_session("t1", "app-b", "bob") is None
            b, b_id = await manager.get_or_create_session("t1", "app-b", "bob")

            assert b_id != a_id
            assert b.state[APP_NAME_STATE_KEY] == "app-b"
            assert "secret" not in b.state
            again_a = await manager.resolve_existing_session("t1", "app-a", "bob")
            again_b = await manager.resolve_existing_session("t1", "app-b", "bob")
        assert again_a.id == a_id
        assert again_a.state["secret"] == "a"
        assert again_b.id == b_id

    @pytest.mark.asyncio
    async def test_other_apps_session_is_not_adopted_by_native_id(self, vertex, api):
        api.add("4242", user_id="bob", state={APP_NAME_STATE_KEY: "app-a"})
        manager = SessionManager(session_service=vertex)
        assert await manager.resolve_existing_session("4242", "app-b", "bob") is None

    @pytest.mark.asyncio
    async def test_unmarked_mapped_session_is_still_found(self, vertex, api):
        api.add("4242", user_id="bob", state={THREAD_ID_STATE_KEY: "t1"})
        manager = SessionManager(session_service=vertex)
        session = await manager.resolve_existing_session("t1", "app-b", "bob")
        assert session.id == "4242"


# ===================================================================
# Part 2: Live tests against a real Vertex AI Agent Engine
# ===================================================================


def _has_vertex_session_auth():
    """Check if live Vertex AI session tests can run."""
    engine_id = os.environ.get("VERTEX_REASONING_ENGINE_ID")
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not engine_id or not project:
        return False
    # Must not have GOOGLE_API_KEY set (conflicts with project/location auth)
    return True


class TestVertexSessionServiceLive:
    """Live integration tests against a real Vertex AI Agent Engine.

    Requires:
    - VERTEX_REASONING_ENGINE_ID: numeric ID or full resource name
    - GOOGLE_CLOUD_PROJECT: GCP project ID
    - GOOGLE_CLOUD_LOCATION: GCP region (defaults to us-central1)
    - Valid Application Default Credentials (ADC)
    - GOOGLE_API_KEY must NOT be set (conflicts with project/location auth)
    """

    pytestmark = pytest.mark.skipif(
        not _has_vertex_session_auth(),
        reason=(
            "Live Vertex session tests require VERTEX_REASONING_ENGINE_ID "
            "and GOOGLE_CLOUD_PROJECT environment variables"
        ),
    )

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture(autouse=True)
    def _clean_env_for_vertex(self, monkeypatch):
        """Adjust environment for VertexAiSessionService.

        - Remove GOOGLE_API_KEY: the genai client raises ValueError when both
          project/location and an API key are present.
        - Override GOOGLE_CLOUD_LOCATION to us-central1: the .env may set it to
          ``global`` (valid for Gemini model calls but not for the Agent Engine
          sessions endpoint which requires a real region).
        """
        monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
        monkeypatch.setenv(
            "GOOGLE_CLOUD_LOCATION",
            os.environ.get("VERTEX_SESSION_LOCATION", "us-central1"),
        )

    @pytest.fixture
    def vertex_service(self):
        from google.adk.sessions import VertexAiSessionService

        project = os.environ["GOOGLE_CLOUD_PROJECT"]
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        engine_id = os.environ["VERTEX_REASONING_ENGINE_ID"]

        return VertexAiSessionService(
            project=project,
            location=location,
            agent_engine_id=engine_id,
        )

    @pytest.fixture
    def app_name(self):
        """Return the app_name (resource name or numeric ID) for the engine."""
        return os.environ["VERTEX_REASONING_ENGINE_ID"]

    @pytest.mark.asyncio
    async def test_create_and_get_session(self, vertex_service, app_name):
        """Create a session and retrieve it via get_session."""
        user_id = f"test_{uuid.uuid4().hex[:8]}"

        session = await vertex_service.create_session(
            app_name=app_name,
            user_id=user_id,
            state={"test_key": "test_value"},
        )

        assert session is not None
        assert session.id  # Vertex generates the ID
        assert session.user_id == user_id

        # Retrieve
        retrieved = await vertex_service.get_session(
            app_name=app_name,
            user_id=user_id,
            session_id=session.id,
        )
        assert retrieved is not None
        assert retrieved.id == session.id

        # Cleanup
        await vertex_service.delete_session(
            app_name=app_name,
            user_id=user_id,
            session_id=session.id,
        )

    @pytest.mark.asyncio
    async def test_list_sessions_finds_created_session(
        self, vertex_service, app_name
    ):
        """list_sessions returns a session that was just created."""
        user_id = f"test_{uuid.uuid4().hex[:8]}"

        session = await vertex_service.create_session(
            app_name=app_name,
            user_id=user_id,
            state={THREAD_ID_STATE_KEY: "vertex-list-test"},
        )

        try:
            listing = await vertex_service.list_sessions(
                app_name=app_name, user_id=user_id
            )
            ids = [s.id for s in listing.sessions]
            assert session.id in ids
        finally:
            await vertex_service.delete_session(
                app_name=app_name,
                user_id=user_id,
                session_id=session.id,
            )

    @pytest.mark.asyncio
    async def test_custom_session_id_raises_value_error(self, vertex_service, app_name):
        """Vertex AI rejects caller-provided session_id."""
        with pytest.raises(ValueError, match="not supported"):
            await vertex_service.create_session(
                app_name=app_name,
                user_id="user",
                session_id="my-custom-id",
            )

    @pytest.mark.asyncio
    async def test_adk_agent_default_path_works(self, vertex_service, app_name):
        """ADKAgent with default settings works against real Vertex sessions."""
        from unittest.mock import Mock, patch
        from google.adk.agents import Agent

        mock_adk = Mock(spec=Agent)
        mock_adk.name = "vertex_live_agent"
        mock_adk.instruction = "Test"
        mock_adk.tools = []

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name=app_name,
            user_id=f"test_{uuid.uuid4().hex[:8]}",
            session_service=vertex_service,
            use_in_memory_services=True,
        )

        thread_id = f"vertex-live-{uuid.uuid4().hex[:8]}"
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", role="user", content="Hello")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        with patch.object(agent, "_create_runner") as mock_runner_factory:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()

            async def mock_run_async(*args, **kwargs):
                mock_event = Mock()
                mock_event.id = "evt1"
                mock_event.author = "vertex_live_agent"
                mock_event.content = Mock()
                mock_event.content.parts = [Mock(text="Hi")]
                mock_event.partial = False
                mock_event.actions = None
                mock_event.get_function_calls = Mock(return_value=[])
                mock_event.get_function_responses = Mock(return_value=[])
                yield mock_event

            mock_runner.run_async = mock_run_async
            mock_runner_factory.return_value = mock_runner

            events = [event async for event in agent.run(input_data)]

        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_FINISHED in event_types

        # Verify session exists and has a Vertex-generated ID
        test_uid = agent._static_user_id
        cached = agent._get_session_metadata(thread_id, test_uid, app_name=app_name)
        assert cached is not None
        backend_id = cached[0]
        assert backend_id != thread_id  # Vertex generates its own ID
