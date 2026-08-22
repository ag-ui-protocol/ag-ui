"""Request validation at the Strands FastAPI endpoint boundary.

A request that does not carry a well-formed `RunAgentInput` must be
rejected before the agent is reached, so a malformed request fails as an
HTTP error rather than halfway through a stream that has already returned
200.

FastAPI validates the body against the `RunAgentInput` model, so rejections
surface as 422 with a pydantic `detail` list. The TypeScript adapter, which
validates by hand, answers 415 for a non-JSON content type and 400 for a
schema failure. Both refuse the request without running the agent; the
status codes differ because each side uses its framework's idiom.

A `+json` subtype diverges further: pydantic parses it, so Python runs the
agent, while Express's `json()` middleware parses only `application/json`
and leaves the body empty, which the TypeScript adapter deliberately
answers with 400 rather than 415. Both are documented in their own suites.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui_strands.endpoint import add_strands_fastapi_endpoint

from tests.endpoint_helpers import FakeAgent, valid_run_input

UNPROCESSABLE = 422


@pytest.fixture
def agent() -> FakeAgent:
    return FakeAgent()


@pytest.fixture
def client(agent: FakeAgent) -> TestClient:
    app = FastAPI()
    add_strands_fastapi_endpoint(app, agent, "/")
    return TestClient(app)


def _without(field: str) -> dict:
    return {k: v for k, v in valid_run_input().items() if k != field}


@pytest.mark.parametrize("missing", ["threadId", "runId"])
def test_missing_required_field_is_rejected_without_running_the_agent(
    client: TestClient, agent: FakeAgent, missing: str
) -> None:
    response = client.post("/", json=_without(missing))

    assert response.status_code == UNPROCESSABLE
    assert agent.received == []
    locations = [tuple(d["loc"]) for d in response.json()["detail"]]
    assert ("body", missing) in locations


def test_malformed_json_is_rejected_without_running_the_agent(
    client: TestClient, agent: FakeAgent
) -> None:
    response = client.post(
        "/", content="{not json", headers={"Content-Type": "application/json"}
    )

    assert response.status_code == UNPROCESSABLE
    assert agent.received == []


def test_plain_text_under_a_json_content_type_is_rejected(
    client: TestClient, agent: FakeAgent
) -> None:
    response = client.post(
        "/", content="hello", headers={"Content-Type": "application/json"}
    )

    assert response.status_code == UNPROCESSABLE
    assert agent.received == []


def test_body_with_no_content_type_is_rejected(
    client: TestClient, agent: FakeAgent
) -> None:
    response = client.post("/", content="hello")

    assert response.status_code == UNPROCESSABLE
    assert agent.received == []


def test_form_encoded_body_is_rejected(client: TestClient, agent: FakeAgent) -> None:
    response = client.post("/", data={"threadId": "t", "runId": "r"})

    assert response.status_code == UNPROCESSABLE
    assert agent.received == []


def test_wrongly_typed_field_is_rejected(client: TestClient, agent: FakeAgent) -> None:
    response = client.post("/", json={**valid_run_input(), "messages": "not-a-list"})

    assert response.status_code == UNPROCESSABLE
    assert agent.received == []


def test_snake_case_body_is_accepted_and_reaches_the_agent(
    client: TestClient, agent: FakeAgent
) -> None:
    """Cross-SDK clients send snake_case; the model accepts it by alias."""
    response = client.post(
        "/",
        json={
            "thread_id": "snake-thread",
            "run_id": "snake-run",
            "messages": [],
            "tools": [],
            "context": [],
            "state": {},
            "forwarded_props": {},
        },
    )

    assert response.status_code == 200
    assert [(i.thread_id, i.run_id) for i in agent.received] == [
        ("snake-thread", "snake-run")
    ]


def test_camel_case_body_reaches_the_agent_with_its_values_intact(
    client: TestClient, agent: FakeAgent
) -> None:
    response = client.post("/", json=valid_run_input())

    assert response.status_code == 200
    assert [(i.thread_id, i.run_id) for i in agent.received] == [
        ("test-thread", "test-run")
    ]


@pytest.mark.parametrize(
    "content_type",
    ["application/json; charset=utf-8", "application/vnd.custom+json"],
)
def test_json_content_type_variants_are_accepted(
    client: TestClient, agent: FakeAgent, content_type: str
) -> None:
    response = client.post(
        "/", content=json.dumps(valid_run_input()), headers={"Content-Type": content_type}
    )

    assert response.status_code == 200
    assert len(agent.received) == 1


def test_unknown_top_level_keys_do_not_prevent_the_run(
    client: TestClient, agent: FakeAgent
) -> None:
    response = client.post("/", json={**valid_run_input(), "somethingExtra": {"a": 1}})

    assert response.status_code == 200
    assert len(agent.received) == 1
