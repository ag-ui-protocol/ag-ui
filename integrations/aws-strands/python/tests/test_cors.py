"""Regression tests for CORS configuration on the AWS Strands FastAPI app.

Covers #1939: the adapter must not combine a wildcard origin with credentials.
With Starlette, allow_origins=["*"] + allow_credentials=True reflects the
request Origin back per-request (credentialed any-origin). The app must instead
emit a literal "*" and must not allow credentials, matching the TypeScript
adapter (#1931).
"""

from unittest.mock import patch

from fastapi.testclient import TestClient

from ag_ui_strands.utils import create_strands_app


class _FakeAgent:
    name = "fake"


def _build_client() -> TestClient:
    # Isolate the CORS layer: stub out the endpoint/ping wiring so the app can
    # be built without a real StrandsAgent or model.
    with patch("ag_ui_strands.endpoint.add_strands_fastapi_endpoint"), patch(
        "ag_ui_strands.endpoint.add_ping"
    ):
        app = create_strands_app(_FakeAgent())
    return TestClient(app)


def test_preflight_returns_literal_wildcard_not_reflected_origin():
    client = _build_client()
    res = client.options(
        "/",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    allow_origin = res.headers.get("access-control-allow-origin")
    # Literal wildcard, NOT the reflected request Origin.
    assert allow_origin == "*"
    assert allow_origin != "https://evil.example.com"


def test_credentials_not_allowed_with_wildcard_origin():
    client = _build_client()
    res = client.options(
        "/",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    # A credentialed wildcard is exactly the posture #1939 forbids.
    assert res.headers.get("access-control-allow-credentials") != "true"
