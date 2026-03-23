# tests/test_vertex_session_service.py

"""Tests for ADKAgent behaviour with VertexAiSessionService.

Part 1: Mock-based tests that faithfully replicate VertexAiSessionService
behaviour (generates its own numeric session IDs, rejects caller-provided
session_id with ValueError, requires a ReasoningEngine resource name as
app_name).  These run in CI without any cloud credentials.

Part 2: Optional live tests that run against a real Vertex AI Agent Engine.
Skipped unless the VERTEX_REASONING_ENGINE_ID environment variable is set
together with GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION and valid ADC.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
import warnings
from typing import Any, Dict, Optional

import pytest
from unittest.mock import AsyncMock

from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.session_manager import THREAD_ID_STATE_KEY


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
    """Mock that replicates VertexAiSessionService behaviour.

    Key differences from InMemorySessionService:
    - Rejects caller-provided session_id with ValueError
    - Generates its own numeric session IDs (like Vertex AI Agent Engine)
    - Requires app_name to look like a resource name or numeric ID
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
    """Verify ADKAgent works correctly with VertexAiSessionService semantics."""

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
        assert adk_agent._session_lookup_cache[(shared_thread, "user_a")][0] == id_user_a
        assert adk_agent._session_lookup_cache[(shared_thread, "user_b")][0] == id_user_b

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

        # The direct lookup via get_session returns None (no existing session),
        # then create_session raises ValueError, and the retry get_session also
        # returns None, so the ValueError propagates.
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
        """Full run() works with VertexAiSessionService (default scan path)."""
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
        cached = agent._session_lookup_cache.get(("vertex-thread-run", "user"))
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
        session_id_1 = agent._session_lookup_cache[("vertex-multi", "user")][0]

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
        session_id_2 = agent._session_lookup_cache[("vertex-multi", "user")][0]

        # Same session reused
        assert session_id_1 == session_id_2


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
        cached = agent._session_lookup_cache.get((thread_id, test_uid))
        assert cached is not None
        backend_id = cached[0]
        assert backend_id != thread_id  # Vertex generates its own ID
