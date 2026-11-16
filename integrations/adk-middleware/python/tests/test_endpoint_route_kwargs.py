#!/usr/bin/env python
"""Tests for route metadata passthrough on the FastAPI endpoint helper.

The agent route used to be registered with a bare decorator, so an
application embedding the middleware could not set its ``name``, ``tags``,
``operation_id``, ``dependencies`` or ``include_in_schema``. Extra keyword
arguments now reach ``app.post`` for the agent route. ``dependencies`` also
guards the capabilities and ``/agents/state`` routes, because applications use
it for authentication (GHSA-jhvp-j8pf-5vh5). Those routes otherwise keep their
own identity, because FastAPI requires a unique ``operation_id`` and ``name``
per operation.
"""

import asyncio

import pytest
from unittest.mock import MagicMock
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from ag_ui_adk.endpoint import add_adk_fastapi_endpoint, create_adk_app
from ag_ui_adk.adk_agent import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents import LlmAgent
from google.adk.sessions import InMemorySessionService


@pytest.fixture
def mock_agent():
    return MagicMock(spec=ADKAgent)


APP_NAME = "kwargs_app"
THREAD_ID = "thread-1"
USER_ID = f"thread_user_{THREAD_ID}"


@pytest.fixture
def seeded_agent():
    """A real ADKAgent over an InMemorySessionService holding one thread."""
    SessionManager.reset_instance()
    service = InMemorySessionService()

    async def seed():
        await service.create_session(
            app_name=APP_NAME,
            user_id=USER_ID,
            state={"_ag_ui_thread_id": THREAD_ID, "secret": "s3cr3t"},
        )

    asyncio.run(seed())
    yield ADKAgent(
        adk_agent=LlmAgent(name=APP_NAME, model="gemini-2.0-flash"),
        app_name=APP_NAME,
        session_service=service,
    )
    SessionManager.reset_instance()


class TestEndpointRouteKwargs:
    def test_metadata_lands_on_the_agent_route(self, mock_agent):
        app = FastAPI()
        add_adk_fastapi_endpoint(
            app,
            mock_agent,
            path="/",
            name="adk_agent",
            tags=["ADK"],
            summary="ADK middleware endpoint",
            operation_id="run_agent",
        )

        operation = app.openapi()["paths"]["/"]["post"]
        assert operation["tags"] == ["ADK"]
        assert operation["summary"] == "ADK middleware endpoint"
        assert operation["operationId"] == "run_agent"
        assert app.url_path_for("adk_agent") == "/"

    def test_other_routes_keep_their_own_identity(self, mock_agent):
        """A duplicated ``operation_id`` is what breaks OpenAPI client
        generators, so the helper's other routes stay untouched."""
        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, path="/", tags=["ADK"], operation_id="run_agent"
        )

        paths = app.openapi()["paths"]
        others = [paths[p][m] for p, m in (("/capabilities", "get"), ("/agents/state", "post"))]
        for operation in others:
            assert operation["operationId"] != "run_agent"
            assert "tags" not in operation

    def test_dependencies_guard_every_route(self, mock_agent):
        def deny():
            raise HTTPException(status_code=401, detail="nope")

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, mock_agent, path="/", dependencies=[Depends(deny)]
        )
        client = TestClient(app)

        # The dependency runs before the body is parsed, so the agent is
        # never invoked.
        assert client.post("/", json={}).status_code == 401
        assert client.get("/capabilities").status_code == 401
        assert (
            client.post(
                "/agents/state",
                json={"threadId": "t1", "appName": "app", "userId": "u1"},
            ).status_code
            == 401
        )
        mock_agent.get_capabilities.assert_not_called()

        routes = {r.path: r for r in app.routes if hasattr(r, "dependencies")}
        for route_path in ("/", "/capabilities", "/agents/state"):
            assert len(routes[route_path].dependencies) == 1

    def test_async_dependency_guards_agents_state(self, seeded_agent):
        """An async guard must block ``/agents/state`` too, so thread state
        does not leak to an unauthenticated caller."""

        async def deny():
            raise HTTPException(status_code=401, detail="nope")

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app, seeded_agent, path="/", dependencies=[Depends(deny)]
        )
        client = TestClient(app)

        body = {"threadId": THREAD_ID, "appName": APP_NAME, "userId": USER_ID}
        response = client.post("/agents/state", json=body)
        assert response.status_code == 401
        assert "s3cr3t" not in response.text

    def test_authenticated_requests_reach_every_route(self, seeded_agent):
        """GHSA-jhvp-j8pf-5vh5: an unauthenticated caller must not read
        thread state or capabilities, and an authenticated caller still can."""

        def require_auth(authorization: str | None = Header(default=None)):
            if authorization != "Bearer good":
                raise HTTPException(status_code=401, detail="Login required")

        app = FastAPI()
        add_adk_fastapi_endpoint(
            app,
            seeded_agent,
            path="/chat",
            dependencies=[Depends(require_auth)],
        )
        client = TestClient(app)
        body = {"threadId": THREAD_ID, "appName": APP_NAME, "userId": USER_ID}
        auth = {"Authorization": "Bearer good"}

        denied = client.post("/agents/state", json=body)
        assert denied.status_code == 401
        assert "secret" not in denied.text
        assert client.get("/chat/capabilities").status_code == 401

        caps = client.get("/chat/capabilities", headers=auth)
        assert caps.status_code == 200
        assert caps.json() == {}

        state = client.post("/agents/state", json=body, headers=auth)
        assert state.status_code == 200
        assert state.json()["threadExists"] is True
        assert state.json()["state"]["secret"] == "s3cr3t"

    def test_no_dependencies_leaves_other_routes_unguarded(self, mock_agent):
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/", tags=["ADK"])

        routes = {r.path: r for r in app.routes if hasattr(r, "dependencies")}
        assert routes["/capabilities"].dependencies == []
        assert routes["/agents/state"].dependencies == []

    def test_create_adk_app_forwards_route_kwargs(self, mock_agent):
        app = create_adk_app(mock_agent, path="/", tags=["ADK"], name="adk_agent")

        assert app.openapi()["paths"]["/"]["post"]["tags"] == ["ADK"]
        assert app.url_path_for("adk_agent") == "/"

    def test_default_registration_is_unchanged(self, mock_agent):
        app = FastAPI()
        add_adk_fastapi_endpoint(app, mock_agent, path="/")

        assert "tags" not in app.openapi()["paths"]["/"]["post"]
