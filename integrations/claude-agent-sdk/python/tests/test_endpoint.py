"""Tests for FastAPI endpoint integration."""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from fastapi.testclient import TestClient

from ag_ui_claude.endpoint import add_claude_fastapi_endpoint, create_claude_app
from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage, EventType, RunStartedEvent, RunFinishedEvent


class TestAddClaudeFastAPIEndpoint:
    """Test cases for add_claude_fastapi_endpoint."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ClaudeAgent."""
        agent = AsyncMock(spec=ClaudeAgent)
        
        async def mock_run(input_data):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            )
        
        agent.run = AsyncMock(side_effect=mock_run)
        return agent

    @pytest.fixture
    def app(self, mock_agent):
        """Create a FastAPI app with Claude endpoint."""
        from fastapi import FastAPI
        
        app = FastAPI()
        add_claude_fastapi_endpoint(app, mock_agent, path="/chat")
        return app

    @pytest.fixture
    def client(self, app):
        """Create a test client."""
        return TestClient(app)

    def test_endpoint_exists(self, client):
        """Test that the endpoint exists."""
        # Test with invalid request to check endpoint exists
        response = client.post("/chat", json={})
        # Should not be 404
        assert response.status_code != 404

    def test_endpoint_accepts_run_agent_input(self, client, mock_agent):
        """Test that endpoint accepts RunAgentInput."""
        input_data = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [
                {
                    "id": "msg_1",
                    "role": "user",
                    "content": "Hello!"
                }
            ],
            "state": {},
            "context": [],
            "tools": [],
            "forwarded_props": {}
        }
        
        response = client.post("/chat", json=input_data)
        
        # Should process the request (may return 200 or streaming response)
        assert response.status_code in [200, 200]  # Streaming may return 200
        
        # Verify agent.run was called
        assert mock_agent.run.called

    def test_endpoint_streaming_response(self, client, mock_agent):
        """Test that endpoint returns streaming response."""
        input_data = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [
                {
                    "id": "msg_1",
                    "role": "user",
                    "content": "Hello!"
                }
            ],
            "state": {},
            "context": [],
            "tools": [],
            "forwarded_props": {}
        }
        
        response = client.post(
            "/chat",
            json=input_data,
            headers={"Accept": "text/event-stream"}
        )
        
        # Should return streaming response
        assert response.status_code == 200
        # Content type should be for SSE
        assert "text/event-stream" in response.headers.get("content-type", "").lower() or \
               "application/x-ndjson" in response.headers.get("content-type", "").lower()

    def test_endpoint_error_handling(self, client):
        """Test endpoint error handling."""
        # Create agent that raises error
        error_agent = AsyncMock(spec=ClaudeAgent)
        
        async def error_run(input_data):
            raise Exception("Test error")
        
        error_agent.run = AsyncMock(side_effect=error_run)
        
        from fastapi import FastAPI
        app = FastAPI()
        add_claude_fastapi_endpoint(app, error_agent, path="/chat")
        
        client = TestClient(app)
        
        input_data = {
            "thread_id": "test_thread",
            "run_id": "test_run",
            "messages": [],
            "state": {},
            "context": [],
            "tools": [],
            "forwarded_props": {}
        }
        
        response = client.post("/chat", json=input_data)
        
        # Should handle error gracefully
        assert response.status_code in [200, 500]  # May return error event or 500


class TestCreateClaudeApp:
    """Test cases for create_claude_app."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ClaudeAgent."""
        return AsyncMock(spec=ClaudeAgent)

    def test_create_claude_app(self, mock_agent):
        """Test creating Claude app."""
        app = create_claude_app(mock_agent, path="/claude-chat")
        
        assert app is not None
        # Verify it's a FastAPI app
        assert hasattr(app, "post")

    def test_create_claude_app_default_path(self, mock_agent):
        """Test creating Claude app with default path."""
        app = create_claude_app(mock_agent)
        
        assert app is not None

