"""Unit tests for the Swarms AG-UI adapter."""
import json
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from swarms_agui import add_swarms_fastapi_endpoint


def _parse_sse(body: str) -> list[dict]:
    """Parse SSE body into a list of event dicts."""
    events = []
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data = line[len("data:"):].strip()
            if data:
                events.append(json.loads(data))
    return events


def _make_app(agent) -> TestClient:
    app = FastAPI()
    add_swarms_fastapi_endpoint(app, agent, path="/")
    return TestClient(app, raise_server_exceptions=True)


def _run_payload(user_message: str = "Hello") -> dict:
    return {
        "threadId": "thread-1",
        "runId": "run-1",
        "messages": [{"id": "msg-1", "role": "user", "content": user_message}],
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {},
    }


@pytest.fixture()
def mock_agent():
    agent = MagicMock()
    agent.run.return_value = "Hello from Swarms!"
    return agent


class TestEventSequence:
    def test_emits_run_started_and_finished(self, mock_agent):
        client = _make_app(mock_agent)
        resp = client.post("/", json=_run_payload())
        assert resp.status_code == 200
        events = _parse_sse(resp.text)
        types = [e["type"] for e in events]
        assert types[0] == "RUN_STARTED"
        assert types[-1] == "RUN_FINISHED"

    def test_emits_text_message_lifecycle(self, mock_agent):
        client = _make_app(mock_agent)
        events = _parse_sse(client.post("/", json=_run_payload()).text)
        types = [e["type"] for e in events]
        assert "TEXT_MESSAGE_START" in types
        assert "TEXT_MESSAGE_CONTENT" in types
        assert "TEXT_MESSAGE_END" in types

    def test_text_content_matches_agent_response(self, mock_agent):
        mock_agent.run.return_value = "My answer"
        client = _make_app(mock_agent)
        events = _parse_sse(client.post("/", json=_run_payload()).text)
        content_events = [e for e in events if e["type"] == "TEXT_MESSAGE_CONTENT"]
        assert len(content_events) == 1
        assert content_events[0]["delta"] == "My answer"

    def test_messages_snapshot_appends_assistant_message(self, mock_agent):
        mock_agent.run.return_value = "Snapshot answer"
        client = _make_app(mock_agent)
        events = _parse_sse(client.post("/", json=_run_payload()).text)
        snapshots = [e for e in events if e["type"] == "MESSAGES_SNAPSHOT"]
        assert len(snapshots) == 1
        messages = snapshots[0]["messages"]
        assert messages[-1]["role"] == "assistant"
        assert messages[-1]["content"] == "Snapshot answer"

    def test_run_ids_propagated(self, mock_agent):
        client = _make_app(mock_agent)
        events = _parse_sse(client.post("/", json=_run_payload()).text)
        run_started = next(e for e in events if e["type"] == "RUN_STARTED")
        run_finished = next(e for e in events if e["type"] == "RUN_FINISHED")
        assert run_started["runId"] == "run-1"
        assert run_started["threadId"] == "thread-1"
        assert run_finished["runId"] == "run-1"
        assert run_finished["threadId"] == "thread-1"

    def test_agent_receives_last_user_message(self, mock_agent):
        payload = _run_payload()
        payload["messages"].append({"id": "msg-2", "role": "user", "content": "Second message"})
        client = _make_app(mock_agent)
        client.post("/", json=payload)
        mock_agent.run.assert_called_once_with("Second message")

    def test_empty_messages_passes_empty_string(self, mock_agent):
        payload = _run_payload()
        payload["messages"] = []
        client = _make_app(mock_agent)
        client.post("/", json=payload)
        mock_agent.run.assert_called_once_with("")


class TestErrorHandling:
    def test_agent_exception_emits_run_error(self):
        agent = MagicMock()
        agent.run.side_effect = RuntimeError("model failed")
        client = _make_app(agent)
        events = _parse_sse(client.post("/", json=_run_payload()).text)
        error_events = [e for e in events if e["type"] == "RUN_ERROR"]
        assert len(error_events) == 1
        assert "model failed" in error_events[0]["message"]
        assert error_events[0]["code"] == "SWARMS_RUN_ERROR"

    def test_run_error_does_not_emit_run_finished(self):
        agent = MagicMock()
        agent.run.side_effect = RuntimeError("boom")
        client = _make_app(agent)
        events = _parse_sse(client.post("/", json=_run_payload()).text)
        types = [e["type"] for e in events]
        assert "RUN_FINISHED" not in types


class _FakeConversation:
    """Minimal stand-in for a Swarms ``Conversation``."""

    def __init__(self, history=None):
        self.history = list(history or [])

    def clear(self):
        self.history = []

    def batch_add(self, messages):
        self.history.extend(messages)

    def add(self, role, content):
        self.history.append({"role": role, "content": content})

    def to_dict(self):
        return [dict(m) for m in self.history]


class _FakeAgent:
    """Fake Swarms agent that records the memory it sees when ``run`` is called."""

    user_name = "User"
    agent_name = "Assistant"

    def __init__(self):
        self.short_memory = _FakeConversation(
            [{"role": "System", "content": "You are helpful."}]
        )
        self.seen_task = None
        self.seen_history = None

    def run(self, task):
        self.seen_task = task
        # Snapshot what the agent would send to the model for this turn.
        self.seen_history = self.short_memory.to_dict()
        return f"reply to: {task}"


class TestConversationHistory:
    def test_full_history_is_replayed_into_agent(self):
        agent = _FakeAgent()
        app = FastAPI()
        add_swarms_fastapi_endpoint(app, agent, path="/")
        client = TestClient(app)

        payload = _run_payload()
        payload["messages"] = [
            {"id": "m1", "role": "user", "content": "My name is Sam"},
            {"id": "m2", "role": "assistant", "content": "Nice to meet you, Sam"},
            {"id": "m3", "role": "user", "content": "What is my name?"},
        ]
        resp = client.post("/", json=payload)
        assert resp.status_code == 200

        # The latest user message is the task...
        assert agent.seen_task == "What is my name?"
        # ...and the prior turns were replayed as context (system prompt + the
        # two earlier turns), without the latest message being duplicated.
        rendered = agent.seen_history
        roles_contents = [(m["role"], m["content"]) for m in rendered]
        assert ("System", "You are helpful.") in roles_contents
        assert ("User", "My name is Sam") in roles_contents
        assert ("Assistant", "Nice to meet you, Sam") in roles_contents
        assert sum(1 for r, c in roles_contents if c == "What is my name?") == 0

    def test_memory_resets_between_requests(self):
        agent = _FakeAgent()
        app = FastAPI()
        add_swarms_fastapi_endpoint(app, agent, path="/")
        client = TestClient(app)

        first = _run_payload("first turn")
        client.post("/", json=first)

        # A second, unrelated request must not carry the first turn's context.
        second = _run_payload("second turn")
        client.post("/", json=second)

        contents = [m["content"] for m in agent.seen_history]
        assert "first turn" not in contents
        assert agent.seen_task == "second turn"


class TestMultiplePaths:
    def test_custom_path(self, mock_agent):
        app = FastAPI()
        add_swarms_fastapi_endpoint(app, mock_agent, path="/agent")
        client = TestClient(app)
        resp = client.post("/agent", json=_run_payload())
        assert resp.status_code == 200

    def test_content_type_is_sse(self, mock_agent):
        client = _make_app(mock_agent)
        resp = client.post("/", json=_run_payload())
        assert "text/event-stream" in resp.headers["content-type"]
