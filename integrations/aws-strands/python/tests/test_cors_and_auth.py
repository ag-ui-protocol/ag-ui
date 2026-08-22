"""Tests for the CORS defaults and the authentication hook of the FastAPI app."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import Header, HTTPException
from fastapi.testclient import TestClient

from ag_ui_strands.utils import create_strands_app


@pytest.fixture
def agent():
    return SimpleNamespace(name="test-agent")


# ---------------------------------------------------------------------------
# CORS defaults
# ---------------------------------------------------------------------------


class TestCorsDefaults:
    def test_default_app_does_not_allow_arbitrary_origins(self, agent):
        client = TestClient(create_strands_app(agent))

        resp = client.get("/ping", headers={"Origin": "https://evil.example"})

        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") is None

    def test_default_preflight_is_not_wildcarded(self, agent):
        client = TestClient(create_strands_app(agent))

        resp = client.options(
            "/",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )

        assert resp.headers.get("access-control-allow-origin") != "*"

    def test_explicit_origin_is_allowed(self, agent):
        client = TestClient(create_strands_app(agent, origins=["https://app.example"]))

        resp = client.get("/ping", headers={"Origin": "https://app.example"})

        assert resp.headers.get("access-control-allow-origin") == "https://app.example"

    def test_other_origin_still_rejected_when_allowlist_set(self, agent):
        client = TestClient(create_strands_app(agent, origins=["https://app.example"]))

        resp = client.get("/ping", headers={"Origin": "https://evil.example"})

        assert resp.headers.get("access-control-allow-origin") is None

    def test_wildcard_remains_available_as_explicit_opt_in(self, agent):
        client = TestClient(create_strands_app(agent, origins=["*"]))

        resp = client.get("/ping", headers={"Origin": "https://anything.example"})

        assert resp.headers.get("access-control-allow-origin") == "*"
        # A wildcard origin must never be paired with credentials.
        assert resp.headers.get("access-control-allow-credentials") is None

    def test_default_methods_and_headers_are_not_wildcarded(self, agent):
        client = TestClient(create_strands_app(agent, origins=["https://app.example"]))

        resp = client.options(
            "/",
            headers={
                "Origin": "https://app.example",
                "Access-Control-Request-Method": "DELETE",
                "Access-Control-Request-Headers": "content-type",
            },
        )

        # Only the methods the protocol needs are pre-approved.
        allowed = resp.headers.get("access-control-allow-methods", "")
        assert "DELETE" not in allowed
        assert "POST" in allowed


# ---------------------------------------------------------------------------
# Authentication hook
# ---------------------------------------------------------------------------


def _require_token(authorization: str | None = Header(default=None)) -> None:
    if authorization != "Bearer secret":
        raise HTTPException(status_code=401, detail="Unauthorized")


class TestAuthHook:
    def test_agent_endpoint_rejects_unauthenticated_request(self, agent):
        client = TestClient(create_strands_app(agent, auth=_require_token))

        resp = client.post("/", json={})

        assert resp.status_code == 401

    def test_agent_endpoint_accepts_authenticated_request(self, agent):
        client = TestClient(create_strands_app(agent, auth=_require_token))

        resp = client.post(
            "/", json={}, headers={"Authorization": "Bearer secret"}
        )

        # Not 401: the auth hook passed and the request reached body validation.
        assert resp.status_code != 401

    def test_ping_stays_unauthenticated(self, agent):
        """The health probe must keep working for load balancers / AgentCore."""
        client = TestClient(create_strands_app(agent, auth=_require_token))

        assert client.get("/ping").status_code == 200

    def test_endpoint_helper_accepts_auth_dependency(self, agent):
        from fastapi import FastAPI

        from ag_ui_strands.endpoint import add_strands_fastapi_endpoint

        app = FastAPI()
        add_strands_fastapi_endpoint(app, agent, "/agent", auth=_require_token)
        client = TestClient(app)

        assert client.post("/agent", json={}).status_code == 401

    def test_no_auth_by_default_is_unchanged(self, agent):
        client = TestClient(create_strands_app(agent))

        assert client.post("/", json={}).status_code != 401
