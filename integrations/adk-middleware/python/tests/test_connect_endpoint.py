# tests/test_connect_endpoint.py

"""Tests for the POST {path}/connect history-replay route."""

import json
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import Depends, FastAPI, HTTPException
from google.adk.events import Event
from google.genai import types
from httpx import ASGITransport, AsyncClient

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint


def _agent() -> ADKAgent:
    adk = MagicMock()
    adk.name = "connect_test_agent"
    return ADKAgent(adk_agent=adk, app_name="connect_test", user_id="u1")


def _input(thread_id: str) -> dict:
    return {
        "threadId": thread_id,
        "runId": "replay-run",
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def _events(body: str) -> list[dict]:
    return [
        json.loads(line[len("data: "):])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


async def _post(app: FastAPI, url: str, payload: dict):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(url, json=payload)


@pytest.mark.asyncio
async def test_connect_replays_saved_history_as_one_run():
    agent = _agent()
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent, path="/chat")

    thread_id = f"t-{uuid.uuid4()}"
    session, _ = await agent._session_manager.get_or_create_session(
        thread_id=thread_id, app_name="connect_test", user_id="u1"
    )
    service = agent._session_manager._session_service
    for author, role, text in (("user", "user", "Hello"), ("connect_test_agent", "model", "Hi there")):
        await service.append_event(
            session,
            Event(author=author, content=types.Content(role=role, parts=[types.Part(text=text)])),
        )

    response = await _post(app, "/chat/connect", _input(thread_id))

    assert response.status_code == 200
    events = _events(response.text)
    assert [e["type"] for e in events] == [
        "RUN_STARTED",
        "MESSAGES_SNAPSHOT",
        "STATE_SNAPSHOT",
        "RUN_FINISHED",
    ]
    assert [(m["role"], m["content"]) for m in events[1]["messages"]] == [
        ("user", "Hello"),
        ("assistant", "Hi there"),
    ]
    assert events[0]["threadId"] == thread_id


@pytest.mark.asyncio
async def test_connect_unknown_thread_is_an_empty_run():
    app = FastAPI()
    add_adk_fastapi_endpoint(app, _agent(), path="/")

    response = await _post(app, "/connect", _input(f"missing-{uuid.uuid4()}"))

    assert response.status_code == 200
    assert [e["type"] for e in _events(response.text)] == ["RUN_STARTED", "RUN_FINISHED"]


@pytest.mark.asyncio
async def test_connect_never_runs_the_agent():
    agent = _agent()
    agent.run = MagicMock(side_effect=AssertionError("connect must not run the agent"))
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent, path="/")

    response = await _post(app, "/connect", _input(f"t-{uuid.uuid4()}"))

    assert response.status_code == 200
    agent.run.assert_not_called()


@pytest.mark.asyncio
async def test_connect_uses_the_run_route_dependencies():
    def deny():
        raise HTTPException(status_code=401, detail="nope")

    app = FastAPI()
    add_adk_fastapi_endpoint(app, _agent(), path="/", dependencies=[Depends(deny)])

    response = await _post(app, "/connect", _input("t1"))

    assert response.status_code == 401
