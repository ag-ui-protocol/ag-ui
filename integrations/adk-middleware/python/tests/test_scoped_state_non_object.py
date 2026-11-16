#!/usr/bin/env python
"""Tests for run state that is not a JSON object.

``RunAgentInput.state`` is typed ``Any``, so a JSON array of ``[key, value]``
pairs passes request validation. The endpoint's ``app:``/``user:`` scope check
only reads object keys, and ``dict()`` in ``ADKAgent.run()`` turns the pairs
back into keys. With ``allow_scoped_state_keys=True`` that let a client write
app-wide and user-wide state (GHSA-4mp8-xf4q-8m7h).

The endpoint now rejects state that is not an object or null with a 422, and
``run()`` ignores such state for direct callers.

The tests run offline: a fake ``BaseLlm`` and ``InMemorySessionService``.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator, Dict, List
from unittest.mock import patch

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types

from ag_ui.core import BaseEvent, EventType, RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.endpoint import (
    _NonObjectStateError,
    _merge_extractor_state,
    add_adk_fastapi_endpoint,
)

APP_NAME = "non_object_app"
USER_ID = "non_object_user"

BACKEND_SECRET = (
    "connect failed: postgresql://svc:hunter2@db.internal:5432/sessions "
    "while reading projects/acme/sessions/other-user-4f2a"
)
SESSION_READ_ERROR_MESSAGE = (
    "Failed to read the session for this thread from the session backend."
)

PAIRS = [
    ["app:tenant_tier", "enterprise"],
    ["user:role", "admin"],
    ["plain", "x"],
]

NON_OBJECT_STATES = {
    "pairs": PAIRS,
    "nested_pair_values": [
        ["app:tenant_tier", ["enterprise"]],
        ["user:role", [["admin"]]],
    ],
    "nested_pairs": [[["app:tenant_tier", "enterprise"]]],
    "empty_list": [],
    "string": "app:tenant_tier",
    "number": 1,
    "bool": True,
}


class FakeLlm(BaseLlm):
    model: str = "fake-offline"

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text="ok")])
        )


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _agent(service: InMemorySessionService, allow: bool = True) -> ADKAgent:
    SessionManager.reset_instance()
    return ADKAgent(
        adk_agent=LlmAgent(
            name="non_object_agent", model=FakeLlm(), instruction="Reply."
        ),
        app_name=APP_NAME,
        user_id=USER_ID,
        session_service=service,
        allow_scoped_state_keys=allow,
    )


def _body(thread_id: str, state: Any) -> Dict[str, Any]:
    return {
        "threadId": thread_id,
        "runId": "r-" + thread_id,
        "state": state,
        "messages": [
            {"id": "m-" + thread_id, "role": "user", "content": "hi"}
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def _app_scope(service: InMemorySessionService) -> Dict[str, Any]:
    return dict(service.app_state.get(APP_NAME, {}))


def _user_scope(service: InMemorySessionService) -> Dict[str, Any]:
    return dict(service.user_state.get(APP_NAME, {}).get(USER_ID, {}))


async def _empty_extractor(request: Request, input_data: RunAgentInput):
    return {}


async def _none_extractor(request: Request, input_data: RunAgentInput):
    return None


async def _trusted_extractor(request: Request, input_data: RunAgentInput):
    return {"trusted": 1}


EXTRACTORS = {
    "no_extractor": None,
    "empty_extractor": _empty_extractor,
    "none_extractor": _none_extractor,
    "trusted_extractor": _trusted_extractor,
}


class TestEndpointRejectsNonObjectState:
    @pytest.mark.parametrize(
        "extractor", EXTRACTORS.values(), ids=EXTRACTORS.keys()
    )
    @pytest.mark.parametrize(
        "state", NON_OBJECT_STATES.values(), ids=NON_OBJECT_STATES.keys()
    )
    def test_non_object_state_is_rejected_and_not_persisted(
        self, state, extractor
    ):
        service = InMemorySessionService()
        agent = _agent(service)
        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, agent, "/", extract_state_from_request=extractor
        )

        with TestClient(app) as client:
            response = client.post("/", json=_body("attacker", state))
            victim = client.post("/", json=_body("victim", {}))

        assert response.status_code == 422
        assert response.json() == {
            "detail": "state must be a JSON object or null."
        }
        assert _app_scope(service) == {}
        assert _user_scope(service) == {}
        sessions = service.sessions.get(APP_NAME, {}).get(USER_ID, {}).values()
        assert all(
            s.state.get("_ag_ui_thread_id") != "attacker" for s in sessions
        )
        assert victim.status_code == 200
        assert "app:tenant_tier" not in victim.text

    def test_rejected_pairs_do_not_reach_agents_state(self):
        service = InMemorySessionService()
        agent = _agent(service)
        app = FastAPI()
        add_adk_fastapi_endpoint(app, agent, "/")

        with TestClient(app) as client:
            assert (
                client.post("/", json=_body("attacker", PAIRS)).status_code
                == 422
            )
            assert (
                client.post("/", json=_body("victim", {})).status_code == 200
            )
            state = client.post("/agents/state", json={"threadId": "victim"})

        assert state.status_code == 200
        assert state.json()["threadExists"] is True
        assert "app:tenant_tier" not in state.json()["state"]
        assert "user:role" not in state.json()["state"]

    @pytest.mark.parametrize(
        "state", [None, {}, {"plain": "x"}], ids=["null", "empty", "object"]
    )
    def test_object_or_null_state_is_accepted(self, state):
        service = InMemorySessionService()
        agent = _agent(service)
        app = FastAPI()
        add_adk_fastapi_endpoint(app, agent, "/")

        with TestClient(app) as client:
            response = client.post("/", json=_body("ok", state))

        assert response.status_code == 200
        assert "RUN_FINISHED" in response.text


class TestMergeExtractorStateRejectsNonObjectState:
    """The check lives in ``_merge_extractor_state``, which also serves
    ``/capabilities`` and ``/agents/state``."""

    @pytest.mark.parametrize(
        "extractor", EXTRACTORS.values(), ids=EXTRACTORS.keys()
    )
    @pytest.mark.parametrize(
        "state", NON_OBJECT_STATES.values(), ids=NON_OBJECT_STATES.keys()
    )
    @pytest.mark.asyncio
    async def test_raises_before_extractor_runs(self, state, extractor):
        calls: List[Any] = []

        async def spy(request, input_data):
            calls.append(input_data.state)
            return await extractor(request, input_data) if extractor else None

        run_input = RunAgentInput(
            thread_id="t",
            run_id="r",
            state=state,
            messages=[],
            tools=[],
            context=[],
            forwarded_props=None,
        )
        with pytest.raises(_NonObjectStateError):
            await _merge_extractor_state(run_input, None, spy)
        assert calls == []

    @pytest.mark.asyncio
    async def test_null_state_is_merged_with_extractor_state(self):
        run_input = RunAgentInput(
            thread_id="t",
            run_id="r",
            state=None,
            messages=[],
            tools=[],
            context=[],
            forwarded_props=None,
        )
        merged = await _merge_extractor_state(
            run_input, None, _trusted_extractor
        )
        assert merged.state == {"trusted": 1}

    def test_capabilities_still_serves_with_extractor(self):
        service = InMemorySessionService()
        agent = _agent(service)
        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, agent, "/run", extract_state_from_request=_trusted_extractor
        )
        with TestClient(app) as client:
            response = client.get("/run/capabilities")
        assert response.status_code == 200


class TestDirectRunIgnoresNonObjectState:
    @pytest.mark.parametrize(
        "state",
        [NON_OBJECT_STATES["pairs"], NON_OBJECT_STATES["nested_pair_values"]],
        ids=["pairs", "nested_pair_values"],
    )
    @pytest.mark.asyncio
    async def test_pairs_do_not_reach_app_or_user_scope(self, state):
        service = InMemorySessionService()
        agent = _agent(service)
        run_input = RunAgentInput(
            thread_id="direct",
            run_id="direct-run",
            state=state,
            messages=[UserMessage(id="m-direct", role="user", content="hi")],
            tools=[],
            context=[],
            forwarded_props={},
        )

        events: List[BaseEvent] = [
            event async for event in agent.run(run_input)
        ]

        assert events[-1].type == EventType.RUN_FINISHED
        assert _app_scope(service) == {}
        assert _user_scope(service) == {}
        snapshots = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
        for snapshot in snapshots:
            assert "app:tenant_tier" not in snapshot.snapshot
            assert "user:role" not in snapshot.snapshot
            assert "plain" not in snapshot.snapshot


def test_state_endpoint_warm_read_error_does_not_leak_backend_details():
    service = InMemorySessionService()
    agent = _agent(service, allow=False)
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent, "/run")
    with TestClient(app) as client:
        assert (
            client.post("/run", json=_body("warm", {"k": "v"})).status_code
            == 200
        )
        assert ("warm", USER_ID, APP_NAME) in agent._session_lookup_cache

        async def fail_read(**kwargs):
            raise RuntimeError(BACKEND_SECRET)

        with patch.object(service, "get_session", side_effect=fail_read):
            response = client.post("/agents/state", json={"threadId": "warm"})

    assert response.status_code == 500
    assert response.json()["error"] == SESSION_READ_ERROR_MESSAGE
    for fragment in ("hunter2", "db.internal", "other-user-4f2a"):
        assert fragment not in response.text
