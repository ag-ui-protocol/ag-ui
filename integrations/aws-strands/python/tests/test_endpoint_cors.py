"""Cross-origin behaviour of the app built by `create_strands_app`.

The default is a literal `*` origin with credentials disabled. Those two go
together: `Access-Control-Allow-Origin: *` and
`Access-Control-Allow-Credentials: true` is a combination browsers reject
outright, so credentials are only enabled once the caller names concrete
origins.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from ag_ui_strands.utils import create_strands_app

from tests.endpoint_helpers import FakeAgent, valid_run_input

APP_ORIGIN = "https://app.example.com"
OTHER_ORIGIN = "https://evil.example.com"


def _preflight(client: TestClient, origin: str) -> Any:
    return client.options(
        "/",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )


def _granted_preflight(client: TestClient, origin: str) -> Any:
    """A preflight that the server actually accepted.

    Asserting only the origin header leaves the method and header lists
    unchecked, so narrowing them to something that rejects every real POST
    would not fail any of these tests.
    """
    response = _preflight(client, origin)
    assert response.status_code == 200
    assert "POST" in response.headers["access-control-allow-methods"]
    return response


def _app(**kwargs: Any) -> TestClient:
    return TestClient(create_strands_app(FakeAgent(), path="/", **kwargs))


def test_default_allows_any_origin_as_a_literal_wildcard() -> None:
    """The wildcard is sent verbatim, not reflected back as the caller's origin."""
    response = _granted_preflight(_app(), OTHER_ORIGIN)

    assert response.headers["access-control-allow-origin"] == "*"


def test_default_does_not_allow_credentials() -> None:
    response = _preflight(_app(), OTHER_ORIGIN)

    assert "access-control-allow-credentials" not in response.headers


def test_explicit_origin_is_echoed_and_allows_credentials() -> None:
    response = _granted_preflight(_app(origins=[APP_ORIGIN]), APP_ORIGIN)

    assert response.headers["access-control-allow-origin"] == APP_ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"


def test_an_origin_outside_an_explicit_allow_list_is_not_granted() -> None:
    """No allow-origin header at all, so a leaked `*` fails this too."""
    response = _preflight(_app(origins=[APP_ORIGIN]), OTHER_ORIGIN)

    assert "access-control-allow-origin" not in response.headers
    # Starlette answers a disallowed preflight itself rather than passing it
    # on, so the rejection is visible as a status too.
    assert response.status_code == 400


def test_an_empty_origin_list_falls_back_to_the_wildcard() -> None:
    """`origins or ["*"]` treats an empty list as unset, not as deny-all."""
    response = _granted_preflight(_app(origins=[]), OTHER_ORIGIN)

    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers


def test_a_wildcard_alongside_concrete_origins_still_allows_everything() -> None:
    """One `*` anywhere in the list makes the whole list allow-all."""
    response = _granted_preflight(_app(origins=["*", APP_ORIGIN]), OTHER_ORIGIN)

    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers


def test_an_explicit_wildcard_still_disables_credentials() -> None:
    """`origins=["*"]` is a wildcard however it was spelled."""
    response = _granted_preflight(_app(origins=["*"]), OTHER_ORIGIN)

    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers


def test_a_simple_post_carries_the_allow_origin_header() -> None:
    client = _app()

    response = client.post("/", json=valid_run_input(), headers={"Origin": OTHER_ORIGIN})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"


def test_the_agent_and_ping_routes_are_both_mounted() -> None:
    client = _app(ping_path="/ping")

    assert client.post("/", json=valid_run_input()).status_code == 200
    assert client.get("/ping").json() == {"status": "healthy"}


def test_ping_can_be_disabled() -> None:
    client = _app(ping_path=None)

    assert client.get("/ping").status_code == 404
