#!/usr/bin/env python
"""Tests for `app:`/`user:`-prefixed keys arriving in ``RunAgentInput.state``.

ADK routes `app:` and `user:` prefixed state keys to app-wide and user-wide
scope rather than to the session. Client-supplied state therefore has to be
scoped to the session before it reaches that router, while keys a server
supplies through ``extract_state_from_request`` keep their scope.

See https://github.com/ag-ui-protocol/ag-ui/issues/2835.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from ag_ui.core import BaseEvent, RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.endpoint import add_adk_fastapi_endpoint
from google.adk.agents import LlmAgent
from google.adk.sessions import InMemorySessionService
from tests.constants import LIVE_TEST_MODEL


DEFAULT_MODEL = LIVE_TEST_MODEL


def _app_scope(service: InMemorySessionService, app_name: str) -> Dict[str, Any]:
    """App-wide state ADK persisted for ``app_name``."""
    return service.app_state.get(app_name, {})


def _user_scope(
    service: InMemorySessionService, app_name: str, user_id: str
) -> Dict[str, Any]:
    """User-wide state ADK persisted for ``app_name``/``user_id``."""
    return service.user_state.get(app_name, {}).get(user_id, {})


async def _collect(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    events: List[BaseEvent] = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def _run_input(thread_id: str, run_id: str, state: Dict[str, Any], content: str = "Hello") -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=[UserMessage(id=f"msg_{run_id}", role="user", content=content)],
        context=[],
        state=state,
        tools=[],
        forwarded_props={},
    )


class TestScopedStatePrefixesThroughEndpoint:
    """The FastAPI route scopes client-supplied state to the session."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure the LLMock server is running."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def _make_agent(
        self, app_name: str, user_id: str, service: InMemorySessionService
    ) -> ADKAgent:
        llm_agent = LlmAgent(
            name="scoped_state_agent",
            model=DEFAULT_MODEL,
            instruction="Reply briefly.",
        )
        # ``allow_scoped_state_keys=True`` so these cases exercise the route's
        # scoping rather than the agent-level default.
        return ADKAgent(
            adk_agent=llm_agent,
            app_name=app_name,
            user_id=user_id,
            session_service=service,
            allow_scoped_state_keys=True,
        )

    def test_client_scoped_keys_do_not_reach_app_or_user_scope(self):
        app_name = "scoped_app_a"
        user_id = "scoped_user_a"
        service = InMemorySessionService()
        agent = self._make_agent(app_name, user_id, service)

        app = FastAPI()
        add_adk_fastapi_endpoint(app, agent, "/test")
        client = TestClient(app)

        run_input = _run_input(
            "scoped_thread_a",
            "run_a",
            {
                "app:tenant_tier": "enterprise",
                "user:role": "admin",
                "plain_key": "plain_value",
            },
        )
        response = client.post("/test", json=run_input.model_dump(mode="json"))
        assert response.status_code == 200

        # Assert against the raw service scopes. ``session.state`` re-attaches
        # prefixes on read, so it cannot tell a dropped key from one written to
        # the wrong scope.
        assert _app_scope(service, app_name) == {}
        assert _user_scope(service, app_name, user_id) == {}

    def test_extractor_supplied_scoped_key_is_persisted(self):
        app_name = "scoped_app_b"
        user_id = "scoped_user_b"
        service = InMemorySessionService()
        agent = self._make_agent(app_name, user_id, service)

        async def extract_state(request: Request, input_data: RunAgentInput):
            return {"app:tenant_tier": "gold"}

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, agent, "/test", extract_state_from_request=extract_state
        )
        client = TestClient(app)

        run_input = _run_input("scoped_thread_b", "run_b", {"plain_key": "plain_value"})
        response = client.post("/test", json=run_input.model_dump(mode="json"))
        assert response.status_code == 200

        assert _app_scope(service, app_name).get("tenant_tier") == "gold"

    def test_extractor_value_wins_over_client_value(self):
        app_name = "scoped_app_c"
        user_id = "scoped_user_c"
        service = InMemorySessionService()
        agent = self._make_agent(app_name, user_id, service)

        async def extract_state(request: Request, input_data: RunAgentInput):
            return {"app:tenant_tier": "free"}

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, agent, "/test", extract_state_from_request=extract_state
        )
        client = TestClient(app)

        run_input = _run_input(
            "scoped_thread_c",
            "run_c",
            {"app:tenant_tier": "enterprise", "user:tenant_tier": "enterprise"},
        )
        response = client.post("/test", json=run_input.model_dump(mode="json"))
        assert response.status_code == 200

        # Only the extractor's value is persisted, and the client value does
        # not survive anywhere — not in app scope, not in user scope.
        assert _app_scope(service, app_name) == {"tenant_tier": "free"}
        assert _user_scope(service, app_name, user_id) == {}

    def test_second_turn_on_same_thread_stays_scoped(self):
        """Turn two updates an existing session instead of creating one."""
        app_name = "scoped_app_d"
        user_id = "scoped_user_d"
        service = InMemorySessionService()
        agent = self._make_agent(app_name, user_id, service)

        app = FastAPI()
        add_adk_fastapi_endpoint(app, agent, "/test")
        client = TestClient(app)

        thread_id = "scoped_thread_d"
        first = client.post(
            "/test",
            json=_run_input(
                thread_id, "run_d1", {"plain_key": "plain_value"}
            ).model_dump(mode="json"),
        )
        assert first.status_code == 200

        # The session now exists, so this turn goes through the update path.
        sessions = service.sessions.get(app_name, {}).get(user_id, {})
        assert sessions, "expected the first turn to create a session"

        second_input = RunAgentInput(
            thread_id=thread_id,
            run_id="run_d2",
            messages=[
                UserMessage(id="msg_d1", role="user", content="Hello"),
                UserMessage(id="msg_d2", role="user", content="Hello again"),
            ],
            context=[],
            state={"app:tenant_tier": "enterprise", "user:role": "admin"},
            tools=[],
            forwarded_props={},
        )
        second = client.post("/test", json=second_input.model_dump(mode="json"))
        assert second.status_code == 200

        assert _app_scope(service, app_name) == {}
        assert _user_scope(service, app_name, user_id) == {}


class TestScopedStatePrefixesOnDirectRun:
    """``ADKAgent.run`` called directly, with no FastAPI route in front."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure the LLMock server is running."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def _make_agent(
        self,
        app_name: str,
        user_id: str,
        service: InMemorySessionService,
        **kwargs: Any,
    ) -> ADKAgent:
        llm_agent = LlmAgent(
            name="scoped_state_direct_agent",
            model=DEFAULT_MODEL,
            instruction="Reply briefly.",
        )
        return ADKAgent(
            adk_agent=llm_agent,
            app_name=app_name,
            user_id=user_id,
            session_service=service,
            **kwargs,
        )

    @pytest.mark.asyncio
    async def test_scoped_keys_denied_by_default(self):
        app_name = "scoped_app_e1"
        user_id = "scoped_user_e1"
        service = InMemorySessionService()
        agent = self._make_agent(app_name, user_id, service)

        await _collect(
            agent,
            _run_input(
                "scoped_thread_e1",
                "run_e1",
                {"app:tenant_tier": "enterprise", "user:role": "admin"},
            ),
        )

        assert _app_scope(service, app_name) == {}
        assert _user_scope(service, app_name, user_id) == {}

        await agent.close()

    @pytest.mark.asyncio
    async def test_scoped_keys_allowed_when_opted_in(self):
        app_name = "scoped_app_e2"
        user_id = "scoped_user_e2"
        service = InMemorySessionService()
        agent = self._make_agent(
            app_name, user_id, service, allow_scoped_state_keys=True
        )

        await _collect(
            agent,
            _run_input(
                "scoped_thread_e2",
                "run_e2",
                {"app:tenant_tier": "enterprise", "user:role": "admin"},
            ),
        )

        assert _app_scope(service, app_name).get("tenant_tier") == "enterprise"
        assert _user_scope(service, app_name, user_id).get("role") == "admin"

        await agent.close()
