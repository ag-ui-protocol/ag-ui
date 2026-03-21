"""Tests for FastAPI endpoint utilities."""

import unittest
from unittest.mock import MagicMock, AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui_langroid.agent import LangroidAgent
from ag_ui_langroid.endpoint import add_langroid_fastapi_endpoint, create_langroid_app


class TestCreateLangroidApp(unittest.TestCase):
    """Test create_langroid_app factory function."""

    def test_creates_fastapi_app(self):
        mock_agent = MagicMock()
        agent = LangroidAgent(agent=mock_agent, name="test-agent", description="Test")
        app = create_langroid_app(agent)
        self.assertIsInstance(app, FastAPI)

    def test_app_title_includes_agent_name(self):
        mock_agent = MagicMock()
        agent = LangroidAgent(agent=mock_agent, name="my-agent")
        app = create_langroid_app(agent)
        self.assertIn("my-agent", app.title)

    def test_health_endpoint(self):
        mock_agent = MagicMock()
        agent = LangroidAgent(agent=mock_agent, name="test-agent", description="A test")
        app = create_langroid_app(agent, path="/api")
        client = TestClient(app)

        response = client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["agent"]["name"], "test-agent")
        self.assertEqual(data["agent"]["description"], "A test")

    def test_default_path_health(self):
        mock_agent = MagicMock()
        agent = LangroidAgent(agent=mock_agent, name="test", description="")
        app = create_langroid_app(agent, path="/chat")
        client = TestClient(app)

        response = client.get("/chat/health")
        self.assertEqual(response.status_code, 200)


class TestAddLangroidFastapiEndpoint(unittest.TestCase):
    """Test add_langroid_fastapi_endpoint function."""

    def test_adds_post_endpoint(self):
        mock_agent = MagicMock()
        agent = LangroidAgent(agent=mock_agent, name="test")
        app = FastAPI()
        add_langroid_fastapi_endpoint(app, agent, "/chat")

        # Verify routes were added
        routes = [r.path for r in app.routes]
        self.assertIn("/chat", routes)
        self.assertIn("/chat/health", routes)

    def test_adds_health_get_endpoint(self):
        mock_agent = MagicMock()
        agent = LangroidAgent(agent=mock_agent, name="test", description="desc")
        app = FastAPI()
        add_langroid_fastapi_endpoint(app, agent, "/agent")

        client = TestClient(app)
        response = client.get("/agent/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["agent"]["name"], "test")


if __name__ == "__main__":
    unittest.main()
