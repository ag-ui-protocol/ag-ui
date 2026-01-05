# tests/test_message_history.py

"""Tests for message history features: adk_events_to_messages, emit_messages_snapshot, and /agents/state endpoint."""

import pytest
import json
import uuid
import threading
import time
import socket
from contextlib import closing
from unittest.mock import MagicMock, AsyncMock, patch
from typing import List, Any

import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport
import httpx

from ag_ui.core import (
    RunAgentInput, UserMessage, AssistantMessage, ToolMessage,
    EventType, MessagesSnapshotEvent, ToolCall, FunctionCall
)

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, adk_events_to_messages
from ag_ui_adk.event_translator import _translate_function_calls_to_tool_calls


# ============================================================================
# Test Fixtures
# ============================================================================

def create_mock_adk_event(
    event_id: str = None,
    author: str = "model",
    text: str = None,
    partial: bool = False,
    function_calls: List[Any] = None,
    function_responses: List[Any] = None,
):
    """Create a mock ADK event for testing."""
    event = MagicMock()
    event.id = event_id or str(uuid.uuid4())
    event.author = author
    event.partial = partial

    # Create content with parts - always create content with parts for events that have any data
    event.content = MagicMock()
    if text:
        part = MagicMock()
        part.text = text
        event.content.parts = [part]
    elif function_calls or function_responses:
        # For function calls/responses, create empty parts but content exists
        part = MagicMock()
        part.text = None
        event.content.parts = [part]
    else:
        event.content = None

    # Mock function call methods
    event.get_function_calls = MagicMock(return_value=function_calls or [])
    event.get_function_responses = MagicMock(return_value=function_responses or [])

    return event


def create_mock_function_call(name: str, args: dict = None, fc_id: str = None):
    """Create a mock function call object."""
    fc = MagicMock()
    fc.id = fc_id or str(uuid.uuid4())
    fc.name = name
    fc.args = args or {}
    return fc


def create_mock_function_response(response: Any, fr_id: str = None):
    """Create a mock function response object."""
    fr = MagicMock()
    fr.id = fr_id or str(uuid.uuid4())
    fr.response = response
    return fr


# ============================================================================
# Unit Tests: adk_events_to_messages()
# ============================================================================

class TestAdkEventsToMessages:
    """Unit tests for the adk_events_to_messages conversion function."""

    def test_empty_events_list(self):
        """Should return empty list for empty input."""
        messages = adk_events_to_messages([])
        assert messages == []

    def test_user_message_conversion(self):
        """Should convert user events to UserMessage."""
        event = create_mock_adk_event(
            event_id="user-1",
            author="user",
            text="Hello, how are you?"
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], UserMessage)
        assert messages[0].id == "user-1"
        assert messages[0].role == "user"
        assert messages[0].content == "Hello, how are you?"

    def test_assistant_message_conversion(self):
        """Should convert model events to AssistantMessage."""
        event = create_mock_adk_event(
            event_id="assistant-1",
            author="model",
            text="I'm doing well, thank you!"
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].id == "assistant-1"
        assert messages[0].role == "assistant"
        assert messages[0].content == "I'm doing well, thank you!"

    def test_assistant_message_with_tool_calls(self):
        """Should convert model events with function calls to AssistantMessage with tool_calls."""
        fc = create_mock_function_call(
            name="get_weather",
            args={"city": "Seattle"},
            fc_id="fc-1"
        )
        event = create_mock_adk_event(
            event_id="assistant-2",
            author="model",
            text="Let me check the weather.",
            function_calls=[fc]
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].tool_calls is not None
        assert len(messages[0].tool_calls) == 1
        assert messages[0].tool_calls[0].id == "fc-1"
        assert messages[0].tool_calls[0].function.name == "get_weather"
        assert json.loads(messages[0].tool_calls[0].function.arguments) == {"city": "Seattle"}

    def test_tool_message_conversion(self):
        """Should convert function responses to ToolMessage."""
        fr = create_mock_function_response(
            response={"temperature": 72, "conditions": "sunny"},
            fr_id="fr-1"
        )
        event = create_mock_adk_event(
            event_id="tool-1",
            author="model",
            function_responses=[fr]
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], ToolMessage)
        assert messages[0].role == "tool"
        assert messages[0].tool_call_id == "fr-1"
        content = json.loads(messages[0].content)
        assert content["temperature"] == 72
        assert content["conditions"] == "sunny"

    def test_partial_events_skipped(self):
        """Should skip partial/streaming events."""
        partial_event = create_mock_adk_event(
            author="model",
            text="Partial...",
            partial=True
        )
        complete_event = create_mock_adk_event(
            author="model",
            text="Complete message",
            partial=False
        )

        messages = adk_events_to_messages([partial_event, complete_event])

        assert len(messages) == 1
        assert messages[0].content == "Complete message"

    def test_events_without_content_skipped(self):
        """Should skip events without content."""
        event_no_content = MagicMock()
        event_no_content.content = None
        event_no_content.partial = False

        event_with_content = create_mock_adk_event(
            author="model",
            text="Has content"
        )

        messages = adk_events_to_messages([event_no_content, event_with_content])

        assert len(messages) == 1
        assert messages[0].content == "Has content"

    def test_conversation_order_preserved(self):
        """Should preserve conversation order."""
        events = [
            create_mock_adk_event(event_id="1", author="user", text="Hi"),
            create_mock_adk_event(event_id="2", author="model", text="Hello!"),
            create_mock_adk_event(event_id="3", author="user", text="How are you?"),
            create_mock_adk_event(event_id="4", author="model", text="I'm great!"),
        ]

        messages = adk_events_to_messages(events)

        assert len(messages) == 4
        assert messages[0].id == "1"
        assert messages[1].id == "2"
        assert messages[2].id == "3"
        assert messages[3].id == "4"

    def test_none_author_treated_as_model(self):
        """Events with None author should be treated as assistant messages."""
        event = create_mock_adk_event(
            event_id="anon-1",
            author=None,
            text="Anonymous response"
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].content == "Anonymous response"

    def test_empty_text_with_function_calls(self):
        """Should create assistant message with just tool calls if no text."""
        fc = create_mock_function_call(name="do_something", args={})
        event = create_mock_adk_event(
            event_id="fc-only",
            author="model",
            text="",
            function_calls=[fc]
        )

        messages = adk_events_to_messages([event])

        assert len(messages) == 1
        assert isinstance(messages[0], AssistantMessage)
        assert messages[0].content is None or messages[0].content == ""
        assert len(messages[0].tool_calls) == 1


class TestTranslateFunctionCallsToToolCalls:
    """Unit tests for _translate_function_calls_to_tool_calls helper."""

    def test_single_function_call(self):
        """Should convert a single function call."""
        fc = create_mock_function_call(
            name="search",
            args={"query": "test"},
            fc_id="fc-123"
        )

        tool_calls = _translate_function_calls_to_tool_calls([fc])

        assert len(tool_calls) == 1
        assert tool_calls[0].id == "fc-123"
        assert tool_calls[0].type == "function"
        assert tool_calls[0].function.name == "search"
        assert json.loads(tool_calls[0].function.arguments) == {"query": "test"}

    def test_multiple_function_calls(self):
        """Should convert multiple function calls."""
        fcs = [
            create_mock_function_call(name="fn1", args={"a": 1}, fc_id="fc-1"),
            create_mock_function_call(name="fn2", args={"b": 2}, fc_id="fc-2"),
        ]

        tool_calls = _translate_function_calls_to_tool_calls(fcs)

        assert len(tool_calls) == 2
        assert tool_calls[0].function.name == "fn1"
        assert tool_calls[1].function.name == "fn2"

    def test_function_call_without_id(self):
        """Should generate UUID if function call has no ID."""
        fc = MagicMock()
        fc.id = None
        fc.name = "test_fn"
        fc.args = {}

        tool_calls = _translate_function_calls_to_tool_calls([fc])

        assert len(tool_calls) == 1
        assert tool_calls[0].id is not None
        # Verify it's a valid UUID format
        uuid.UUID(tool_calls[0].id)

    def test_empty_function_calls(self):
        """Should return empty list for empty input."""
        tool_calls = _translate_function_calls_to_tool_calls([])
        assert tool_calls == []


# ============================================================================
# Unit Tests: emit_messages_snapshot flag
# ============================================================================

class TestEmitMessagesSnapshot:
    """Tests for the emit_messages_snapshot configuration flag."""

    @pytest.fixture
    def mock_adk_agent(self):
        """Create a mock ADK agent."""
        agent = MagicMock()
        agent.name = "test_agent"
        return agent

    def test_default_emit_messages_snapshot_is_false(self, mock_adk_agent):
        """Default value for emit_messages_snapshot should be False."""
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user"
        )

        assert agent._emit_messages_snapshot is False

    def test_emit_messages_snapshot_can_be_enabled(self, mock_adk_agent):
        """emit_messages_snapshot can be set to True."""
        agent = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            emit_messages_snapshot=True
        )

        assert agent._emit_messages_snapshot is True

    def test_emit_messages_snapshot_stored_on_agent(self, mock_adk_agent):
        """Verify emit_messages_snapshot flag is stored correctly on the agent."""
        # Test with False (default)
        agent_false = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            emit_messages_snapshot=False
        )
        assert agent_false._emit_messages_snapshot is False

        # Test with True
        agent_true = ADKAgent(
            adk_agent=mock_adk_agent,
            app_name="test_app",
            user_id="test_user",
            emit_messages_snapshot=True
        )
        assert agent_true._emit_messages_snapshot is True


# ============================================================================
# Integration Tests: /agents/state endpoint
# ============================================================================

class TestAgentsStateEndpoint:
    """Integration tests for the /agents/state endpoint."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent with necessary attributes."""
        mock_adk = MagicMock()
        mock_adk.name = "test_agent"

        agent = MagicMock(spec=ADKAgent)
        agent._static_app_name = "test_app"
        agent._static_user_id = "test_user"
        agent._adk_agent = mock_adk

        # Mock session manager
        mock_session_manager = MagicMock()
        agent._session_manager = mock_session_manager

        return agent

    @pytest.fixture
    def app_with_endpoint(self, mock_agent):
        """Create a FastAPI app with the ADK endpoint."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")
        return app

    def test_agents_state_endpoint_exists(self, app_with_endpoint):
        """The /agents/state endpoint should be registered."""
        routes = [r.path for r in app_with_endpoint.routes]
        assert "/agents/state" in routes

    def test_agents_state_returns_thread_info(self, mock_agent):
        """Should return thread info for existing session."""
        # Setup mock session with events
        mock_session = MagicMock()
        mock_session.events = [
            create_mock_adk_event(author="user", text="Hello"),
            create_mock_adk_event(author="model", text="Hi!"),
        ]

        # Mock _get_session_metadata to return session metadata tuple
        # Format: (session_id, app_name, user_id)
        mock_agent._get_session_metadata = MagicMock(return_value=(
            "backend-session-id",
            "test_app",
            "test_user"
        ))

        # Mock _session_service.get_session to return the session
        mock_session_service = MagicMock()
        mock_session_service.get_session = AsyncMock(return_value=mock_session)
        mock_agent._session_manager._session_service = mock_session_service
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={"key": "value"})

        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(app) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "test-thread-123"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == "test-thread-123"
            assert data["threadExists"] is True

            # State and messages should be JSON strings
            state = json.loads(data["state"])
            assert state == {"key": "value"}

            messages = json.loads(data["messages"])
            assert len(messages) == 2

    def test_agents_state_handles_missing_session(self, mock_agent):
        """Should return threadExists=false for missing session."""
        # Mock _get_session_metadata to return None (session doesn't exist)
        mock_agent._get_session_metadata = MagicMock(return_value=None)
        # Mock _find_session_by_thread_id to return None (no session in backend either)
        mock_agent._session_manager._find_session_by_thread_id = AsyncMock(return_value=None)

        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(app) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "nonexistent-thread"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["threadExists"] is False
            assert data["threadId"] == "nonexistent-thread"

    def test_agents_state_handles_empty_events(self, mock_agent):
        """Should return empty messages list for session with no events."""
        mock_session = MagicMock()
        mock_session.events = []

        # Mock _get_session_metadata to return session metadata tuple
        # Format: (session_id, app_name, user_id)
        mock_agent._get_session_metadata = MagicMock(return_value=(
            "backend-session-id",
            "test_app",
            "test_user"
        ))

        # Mock _session_service.get_session to return the session
        mock_session_service = MagicMock()
        mock_session_service.get_session = AsyncMock(return_value=mock_session)
        mock_agent._session_manager._session_service = mock_session_service
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={})

        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(app) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "empty-thread"}
            )

            assert response.status_code == 200
            data = response.json()
            messages = json.loads(data["messages"])
            assert messages == []

    def test_agents_state_handles_error(self, mock_agent):
        """Should return 500 error on exception."""
        mock_agent._session_manager.get_or_create_session = AsyncMock(
            side_effect=Exception("Database error")
        )

        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(app) as client:
            response = client.post(
                "/agents/state",
                json={"threadId": "error-thread"}
            )

            assert response.status_code == 500
            data = response.json()
            assert "error" in data
            assert data["threadExists"] is False

    def test_agents_state_optional_fields(self, mock_agent):
        """Should accept optional name and properties fields."""
        mock_session = MagicMock()
        mock_session.events = []

        # Mock _get_session_metadata to return session metadata tuple
        # Format: (session_id, app_name, user_id)
        mock_agent._get_session_metadata = MagicMock(return_value=(
            "backend-session-id",
            "test_app",
            "test_user"
        ))

        # Mock _session_service.get_session to return the session
        mock_session_service = MagicMock()
        mock_session_service.get_session = AsyncMock(return_value=mock_session)
        mock_agent._session_manager._session_service = mock_session_service
        mock_agent._session_manager.get_session_state = AsyncMock(return_value={})

        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        with TestClient(app) as client:
            response = client.post(
                "/agents/state",
                json={
                    "threadId": "test-thread",
                    "name": "my_agent",
                    "properties": {"custom": "prop"}
                }
            )

            assert response.status_code == 200


# ============================================================================
# Integration Tests: Full Flow with Live Endpoint
# ============================================================================

class TestMessageHistoryIntegration:
    """Integration tests for message history features with a live endpoint."""

    @pytest.fixture
    def real_agent(self):
        """Create a real ADKAgent for integration testing."""
        mock_adk = MagicMock()
        mock_adk.name = "integration_test_agent"

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name="integration_test",
            user_id="test_user"
        )
        return agent

    @pytest.mark.asyncio
    async def test_agents_state_with_real_session_manager(self, real_agent):
        """Test /agents/state with a real session manager."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, real_agent, path="/")

        # First, create a session via session manager
        await real_agent._session_manager.get_or_create_session(
            thread_id="integration-test-thread",
            app_name="integration_test",
            user_id="test_user"
        )

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test"
        ) as client:
            # Now /agents/state should find the existing session
            response = await client.post(
                "/agents/state",
                json={"threadId": "integration-test-thread"}
            )

            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == "integration-test-thread"
            assert data["threadExists"] is True

    @pytest.mark.asyncio
    async def test_agents_state_returns_json_stringified_response(self, real_agent):
        """Verify state and messages are JSON-stringified as expected."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, real_agent, path="/")

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test"
        ) as client:
            response = await client.post(
                "/agents/state",
                json={"threadId": "json-test-thread"}
            )

            assert response.status_code == 200
            data = response.json()

            # Verify these are strings (JSON-stringified)
            assert isinstance(data["state"], str)
            assert isinstance(data["messages"], str)

            # Verify they can be parsed as JSON
            parsed_state = json.loads(data["state"])
            parsed_messages = json.loads(data["messages"])

            assert isinstance(parsed_state, dict)
            assert isinstance(parsed_messages, list)


# ============================================================================
# Live Server Integration Tests
# ============================================================================

def find_free_port():
    """Find a free port on localhost."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(('', 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


class UvicornServer:
    """Context manager for running uvicorn server in a background thread."""

    def __init__(self, app: FastAPI, host: str = "127.0.0.1", port: int = None):
        self.app = app
        self.host = host
        self.port = port or find_free_port()
        self.server = None
        self.thread = None

    def __enter__(self):
        config = uvicorn.Config(
            app=self.app,
            host=self.host,
            port=self.port,
            log_level="error",  # Suppress logs during tests
        )
        self.server = uvicorn.Server(config)

        # Run server in background thread
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()

        # Wait for server to start
        max_retries = 50
        for _ in range(max_retries):
            try:
                with socket.create_connection((self.host, self.port), timeout=0.1):
                    break
            except (socket.error, ConnectionRefusedError):
                time.sleep(0.1)
        else:
            raise RuntimeError(f"Server failed to start on {self.host}:{self.port}")

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.server:
            self.server.should_exit = True
        if self.thread:
            self.thread.join(timeout=5)

    @property
    def base_url(self):
        return f"http://{self.host}:{self.port}"


class TestLiveServerIntegration:
    """Integration tests against a live uvicorn server.

    These tests spin up an actual uvicorn server and make real HTTP requests.
    They use mocked ADK agents, so no external API keys are required.
    """

    @pytest.fixture
    def live_agent(self):
        """Create a real ADKAgent for live server testing."""
        mock_adk = MagicMock()
        mock_adk.name = "live_test_agent"

        agent = ADKAgent(
            adk_agent=mock_adk,
            app_name="live_test_app",
            user_id="live_test_user"
        )
        return agent

    @pytest.fixture
    def live_server(self, live_agent):
        """Start a live uvicorn server with the agent endpoint."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, live_agent, path="/")

        with UvicornServer(app) as server:
            yield server

    def test_live_server_agents_state_endpoint(self, live_server, live_agent):
        """Test /agents/state endpoint on a live server."""
        import asyncio

        # First create a session
        async def create_session():
            await live_agent._session_manager.get_or_create_session(
                thread_id="live-test-thread-1",
                app_name="live_test_app",
                user_id="live_test_user"
            )
        asyncio.get_event_loop().run_until_complete(create_session())

        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": "live-test-thread-1"},
            timeout=10.0
        )

        assert response.status_code == 200
        data = response.json()
        assert data["threadId"] == "live-test-thread-1"
        assert data["threadExists"] is True
        assert "state" in data
        assert "messages" in data

    def test_live_server_agents_state_json_format(self, live_server):
        """Verify JSON-stringified format on live server."""
        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": "live-json-test-thread"},
            timeout=10.0
        )

        assert response.status_code == 200
        data = response.json()

        # Verify state and messages are JSON strings
        assert isinstance(data["state"], str)
        assert isinstance(data["messages"], str)

        # Verify they can be parsed
        state = json.loads(data["state"])
        messages = json.loads(data["messages"])

        assert isinstance(state, dict)
        assert isinstance(messages, list)

    def test_live_server_agents_state_with_optional_fields(self, live_server):
        """Test /agents/state with optional name and properties fields."""
        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={
                "threadId": "live-optional-fields-thread",
                "name": "custom_agent",
                "properties": {"key": "value"}
            },
            timeout=10.0
        )

        assert response.status_code == 200
        data = response.json()
        assert data["threadId"] == "live-optional-fields-thread"

    def test_live_server_session_persistence(self, live_server, live_agent):
        """Test that session state persists across requests."""
        import asyncio
        thread_id = f"live-persist-test-{uuid.uuid4()}"

        # First create a session
        async def create_session():
            await live_agent._session_manager.get_or_create_session(
                thread_id=thread_id,
                app_name="live_test_app",
                user_id="live_test_user"
            )
        asyncio.get_event_loop().run_until_complete(create_session())

        # First request - session should exist
        response1 = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": thread_id},
            timeout=10.0
        )
        assert response1.status_code == 200
        data1 = response1.json()
        assert data1["threadExists"] is True

        # Second request - same thread should still exist
        response2 = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={"threadId": thread_id},
            timeout=10.0
        )
        assert response2.status_code == 200
        data2 = response2.json()
        assert data2["threadExists"] is True
        assert data2["threadId"] == thread_id

    def test_live_server_multiple_threads(self, live_server, live_agent):
        """Test handling multiple different thread IDs."""
        import asyncio
        threads = [f"live-multi-thread-{i}-{uuid.uuid4()}" for i in range(3)]

        # First create all sessions
        async def create_sessions():
            for thread_id in threads:
                await live_agent._session_manager.get_or_create_session(
                    thread_id=thread_id,
                    app_name="live_test_app",
                    user_id="live_test_user"
                )
        asyncio.get_event_loop().run_until_complete(create_sessions())

        responses = []
        for thread_id in threads:
            response = httpx.post(
                f"{live_server.base_url}/agents/state",
                json={"threadId": thread_id},
                timeout=10.0
            )
            responses.append(response)

        # All requests should succeed
        for i, response in enumerate(responses):
            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == threads[i]
            assert data["threadExists"] is True

    @pytest.mark.asyncio
    async def test_live_server_concurrent_requests(self, live_server):
        """Test concurrent requests to the live server."""
        thread_ids = [f"live-concurrent-{i}-{uuid.uuid4()}" for i in range(5)]

        async with httpx.AsyncClient(timeout=10.0) as client:
            # Send concurrent requests
            tasks = [
                client.post(
                    f"{live_server.base_url}/agents/state",
                    json={"threadId": tid}
                )
                for tid in thread_ids
            ]
            import asyncio
            responses = await asyncio.gather(*tasks)

        # All requests should succeed
        for i, response in enumerate(responses):
            assert response.status_code == 200
            data = response.json()
            assert data["threadId"] == thread_ids[i]

    def test_live_server_invalid_request(self, live_server):
        """Test error handling for invalid requests."""
        # Missing required threadId field
        response = httpx.post(
            f"{live_server.base_url}/agents/state",
            json={},
            timeout=10.0
        )

        # Should return 422 Unprocessable Entity for validation error
        assert response.status_code == 422

    def test_live_server_main_endpoint_exists(self, live_server):
        """Test that the main POST endpoint exists (even if it requires proper input)."""
        # Send a minimal valid request to verify endpoint exists
        # This will likely fail due to missing proper input, but should not 404
        response = httpx.post(
            f"{live_server.base_url}/",
            json={
                "thread_id": "test",
                "run_id": "test-run",
                "messages": [],
                "context": [],
                "state": {},
                "tools": [],
                "forwarded_props": {}
            },
            headers={"accept": "text/event-stream"},
            timeout=10.0
        )

        # Should not be 404 (endpoint exists)
        assert response.status_code != 404
