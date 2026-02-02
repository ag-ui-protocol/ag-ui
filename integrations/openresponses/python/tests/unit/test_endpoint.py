"""Unit tests for endpoint factory functions."""

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui_openresponses import (
    OpenResponsesAgent,
    OpenResponsesAgentConfig,
)
from ag_ui_openresponses.endpoint import (
    create_openresponses_endpoint,
    create_openresponses_proxy,
)


def _make_request_body(**overrides):
    """Build a minimal RunAgentInput request body."""
    body = {
        "thread_id": "t1",
        "run_id": "r1",
        "messages": [{"id": "m1", "role": "user", "content": "hello"}],
        "tools": [],
        "context": [],
        "state": {},
        "forwarded_props": {},
    }
    body.update(overrides)
    return body


class TestSystemPrompt:
    """Tests for system_prompt parameter on endpoint factories."""

    def _capture_agent_run_input(self, app, path="/"):
        """Helper: intercept agent.run() calls and return captured input_data."""
        captured = {}

        async def fake_run(input_data):
            captured["input_data"] = input_data
            # Yield minimal events
            from ag_ui.core import EventType, RunStartedEvent, RunFinishedEvent

            yield RunStartedEvent(
                type=EventType.RUN_STARTED, thread_id=input_data.thread_id, run_id=input_data.run_id
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED, thread_id=input_data.thread_id, run_id=input_data.run_id
            )

        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(base_url="https://api.openai.com/v1", api_key="test")
        )
        agent.run = fake_run

        create_openresponses_endpoint(app, agent, path=path, system_prompt="Be helpful.")
        return captured

    def test_system_prompt_prepends_system_message(self):
        app = FastAPI()
        captured = self._capture_agent_run_input(app)

        client = TestClient(app)
        resp = client.post("/", json=_make_request_body())
        assert resp.status_code == 200

        input_data = captured["input_data"]
        assert input_data.messages[0].role == "system"
        assert input_data.messages[0].content == "Be helpful."
        assert input_data.messages[1].role == "user"

    def test_no_system_prompt_leaves_messages_unchanged(self):
        app = FastAPI()
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(base_url="https://api.openai.com/v1", api_key="test")
        )

        captured = {}

        async def fake_run(input_data):
            captured["input_data"] = input_data
            from ag_ui.core import EventType, RunStartedEvent, RunFinishedEvent

            yield RunStartedEvent(
                type=EventType.RUN_STARTED, thread_id=input_data.thread_id, run_id=input_data.run_id
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED, thread_id=input_data.thread_id, run_id=input_data.run_id
            )

        agent.run = fake_run
        create_openresponses_endpoint(app, agent, path="/")

        client = TestClient(app)
        resp = client.post("/", json=_make_request_body())
        assert resp.status_code == 200

        input_data = captured["input_data"]
        assert len(input_data.messages) == 1
        assert input_data.messages[0].role == "user"

    def test_proxy_system_prompt(self, tmp_path):
        """system_prompt on create_openresponses_proxy reaches the agent."""
        # Create a config file
        config_file = tmp_path / "test.json"
        config_file.write_text(json.dumps({
            "base_url": "https://api.openai.com/v1",
            "api_key": "test-key",
            "default_model": "gpt-4o",
        }))

        app = FastAPI()

        captured = {}
        original_run = OpenResponsesAgent.run

        async def intercept_run(self, input_data):
            captured["input_data"] = input_data
            from ag_ui.core import EventType, RunStartedEvent, RunFinishedEvent

            yield RunStartedEvent(
                type=EventType.RUN_STARTED, thread_id=input_data.thread_id, run_id=input_data.run_id
            )
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED, thread_id=input_data.thread_id, run_id=input_data.run_id
            )

        with patch.object(OpenResponsesAgent, "run", intercept_run):
            create_openresponses_proxy(
                app,
                path="/",
                config_dir=str(tmp_path),
                system_prompt="Plan carefully.",
            )

            client = TestClient(app)

            # Test generic endpoint
            resp = client.post("/", json=_make_request_body())
            assert resp.status_code == 200
            input_data = captured["input_data"]
            assert input_data.messages[0].role == "system"
            assert input_data.messages[0].content == "Plan carefully."

            # Test named config endpoint
            captured.clear()
            resp = client.post("/configs/test", json=_make_request_body())
            assert resp.status_code == 200
            input_data = captured["input_data"]
            assert input_data.messages[0].role == "system"
            assert input_data.messages[0].content == "Plan carefully."
