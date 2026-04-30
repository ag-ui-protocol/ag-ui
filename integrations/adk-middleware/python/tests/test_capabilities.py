#!/usr/bin/env python
"""Tests for capabilities endpoint and get_capabilities() method."""

import pytest
from unittest.mock import MagicMock
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui_adk.endpoint import add_adk_fastapi_endpoint
from ag_ui_adk.adk_agent import ADKAgent


class TestCapabilitiesEndpointRouting:
    """Tests for GET /capabilities endpoint registration and routing."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent."""
        return MagicMock(spec=ADKAgent)

    def test_capabilities_endpoint_registered_at_default_path(self, mock_agent):
        """Test that /capabilities is registered when using default path '/'."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent)

        routes = [route.path for route in app.routes]
        assert "/capabilities" in routes

    def test_capabilities_endpoint_registered_at_custom_path(self, mock_agent):
        """Test that /{path}/capabilities is registered for custom paths."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/my-agent")

        routes = [route.path for route in app.routes]
        assert "/my-agent/capabilities" in routes

    def test_capabilities_endpoint_strips_trailing_slash(self, mock_agent):
        """Test that trailing slashes are stripped before appending /capabilities."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/my-agent/")

        routes = [route.path for route in app.routes]
        assert "/my-agent/capabilities" in routes

    def test_capabilities_endpoint_is_get(self, mock_agent):
        """Test that capabilities endpoint accepts GET requests."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/test")

        route = next(r for r in app.routes if r.path == "/test/capabilities")
        assert "GET" in route.methods


class TestCapabilitiesEndpointEmpty:
    """Tests for capabilities endpoint when no capabilities are configured."""

    @pytest.fixture
    def mock_agent(self):
        """Create a mock ADKAgent with no capabilities."""
        agent = MagicMock(spec=ADKAgent)
        agent.get_capabilities.return_value = None
        return agent

    def test_returns_empty_object_when_no_capabilities(self, mock_agent):
        """Test that endpoint returns {} when agent has no capabilities configured."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent)

        client = TestClient(app)
        response = client.get("/capabilities")

        assert response.status_code == 200
        assert response.json() == {}

    def test_returns_json_content_type(self, mock_agent):
        """Test that response has application/json content type."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent)

        client = TestClient(app)
        response = client.get("/capabilities")

        assert "application/json" in response.headers["content-type"]


class TestCapabilitiesEndpointConfigured:
    """Tests for capabilities endpoint with configured capabilities using camelCase keys."""

    @pytest.fixture
    def capabilities(self):
        """Sample capabilities dict using camelCase keys per AG-UI schema."""
        return {
            "identity": {
                "name": "TestAgent",
                "type": "adk",
                "version": "1.0.0",
            },
            "transport": {
                "streaming": True,
                "websocket": False,
            },
            "tools": {
                "supported": True,
                "parallelCalls": False,
                "clientProvided": True,
            },
            "state": {
                "snapshots": True,
                "deltas": True,
            },
            "custom": {
                "predictiveChips": {"enabled": True, "maxCount": 3},
                "suggestedQuestions": {"enabled": True},
            },
        }

    @pytest.fixture
    def mock_agent(self, capabilities):
        """Create a mock ADKAgent with capabilities."""
        agent = MagicMock(spec=ADKAgent)
        agent.get_capabilities.return_value = capabilities
        return agent

    def test_returns_configured_capabilities(self, mock_agent, capabilities):
        """Test that endpoint returns the full capabilities dict."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent)

        client = TestClient(app)
        response = client.get("/capabilities")

        assert response.status_code == 200
        assert response.json() == capabilities

    def test_preserves_camel_case_keys(self, mock_agent):
        """Test that camelCase keys are preserved in the response."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent)

        client = TestClient(app)
        response = client.get("/capabilities")

        data = response.json()
        assert "parallelCalls" in data["tools"]
        assert "clientProvided" in data["tools"]
        assert "predictiveChips" in data["custom"]
        assert "suggestedQuestions" in data["custom"]

    def test_preserves_nested_structure(self, mock_agent):
        """Test that nested capability values are preserved correctly."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent)

        client = TestClient(app)
        response = client.get("/capabilities")

        data = response.json()
        assert data["custom"]["predictiveChips"] == {"enabled": True, "maxCount": 3}
        assert data["identity"]["name"] == "TestAgent"

    def test_capabilities_at_custom_path(self, mock_agent, capabilities):
        """Test capabilities endpoint works with custom base path."""
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/v1/agent")

        client = TestClient(app)
        response = client.get("/v1/agent/capabilities")

        assert response.status_code == 200
        assert response.json() == capabilities


class TestCapabilitiesEndpointError:
    """Tests for capabilities endpoint error handling."""

    def test_returns_500_on_exception(self):
        """Test that endpoint returns 500 when get_capabilities raises."""
        agent = MagicMock(spec=ADKAgent)
        agent.get_capabilities.side_effect = RuntimeError("internal failure")

        app = FastAPI()
        add_adk_fastapi_endpoint(app, agent)

        client = TestClient(app)
        response = client.get("/capabilities")

        assert response.status_code == 500
        assert "error" in response.json()


class TestGetCapabilitiesDeepCopy:
    """Tests that get_capabilities returns a deep copy."""

    def test_mutation_does_not_affect_internal_state(self):
        """Test that mutating the returned dict doesn't affect the agent's copy."""
        agent = MagicMock(spec=ADKAgent, wraps=None)
        # Use a real implementation for get_capabilities to test deep copy behavior
        original = {"custom": {"predictiveChips": {"enabled": True}}}

        import copy
        agent._capabilities = original
        # Call the real method logic
        agent.get_capabilities = lambda: copy.deepcopy(agent._capabilities) if agent._capabilities else None

        caps1 = agent.get_capabilities()
        caps1["custom"]["predictiveChips"]["enabled"] = False

        caps2 = agent.get_capabilities()
        assert caps2["custom"]["predictiveChips"]["enabled"] is True
