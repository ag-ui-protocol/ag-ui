"""
Tests for add_openai_agents_fastapi_endpoint.

Wiring only — the wrapper's behavior is covered in test_agent.py:

- POST on the given path streams the run as SSE frames.
- A GET health check is registered next to it and reports the agent name.
- Custom (non-root) paths get their health check at <path>/health.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from agents import Agent
from agents.result import RunResultStreaming
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
import ag_ui_openai_agents.agent as agent_module

RUN_INPUT_JSON = {
    "thread_id": "t1",
    "run_id": "r1",
    "messages": [{"id": "m1", "role": "user", "content": "hi"}],
    "tools": [],
    "state": {},
    "context": [],
    "forwarded_props": None,
}


async def _empty_stream():
    return
    yield  # pragma: no cover — makes this an async generator


@pytest.fixture
def client(monkeypatch) -> TestClient:
    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    app = FastAPI()
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    add_openai_agents_fastapi_endpoint(app, wrapper, "/")
    return TestClient(app)


def test_post_streams_sse_run(client):
    with client.stream("POST", "/", json=RUN_INPUT_JSON) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        body = "".join(response.iter_text())
    assert '"RUN_STARTED"' in body
    assert '"RUN_FINISHED"' in body
    assert body.count("data: ") >= 2, "each event must be its own SSE frame"


def test_health_reports_agent_name(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "agent": {"name": "assistant"}}


def test_custom_path_places_health_under_it(monkeypatch):
    def fake_run_streamed(agent, *, input, run_config=None, **kwargs):
        result = MagicMock(spec=RunResultStreaming)
        result.stream_events.return_value = _empty_stream()
        return result

    monkeypatch.setattr(agent_module.Runner, "run_streamed", fake_run_streamed)

    app = FastAPI()
    wrapper = OpenAIAgentsAgent(Agent(name="assistant", instructions="hi"))
    add_openai_agents_fastapi_endpoint(app, wrapper, "/my_agent")
    client = TestClient(app)

    assert client.get("/my_agent/health").status_code == 200
    with client.stream("POST", "/my_agent", json=RUN_INPUT_JSON) as response:
        assert response.status_code == 200
