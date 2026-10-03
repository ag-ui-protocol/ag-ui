"""The SSE endpoint must keep JSON nulls that are protocol values.

On ag-ui-protocol 1.0, ``StateDeltaEvent.delta`` is a list of typed JSON Patch
operations, so ``model_dump_json(exclude_none=True)`` recursed into them and
dropped ``"value": null`` from ``{"op": "add", ...}``. The TypeScript client
rejects an add/replace without ``value`` (ZodError at ``delta[0].value``),
which broke the Dojo predictive-state demo: its callback resets
``state["document"] = None``. The 1.0 models already omit unset optional
fields themselves, so the endpoint must not pass ``exclude_none``.
"""

import json
from unittest.mock import MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from ag_ui.core import (
    EventType,
    RunAgentInput,
    RunStartedEvent,
    StateDeltaEvent,
    UserMessage,
)
from ag_ui.encoder import EventEncoder
from ag_ui_adk.adk_agent import ADKAgent
from ag_ui_adk.endpoint import add_adk_fastapi_endpoint


def _post(events):
    agent = MagicMock(spec=ADKAgent)

    async def run(_input):
        for event in events:
            yield event

    agent.run = run
    app = FastAPI()
    add_adk_fastapi_endpoint(app, agent, path="/agent")
    body = RunAgentInput(
        thread_id="t",
        run_id="r",
        messages=[UserMessage(id="u", role="user", content="hi")],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    ).model_dump()
    response = TestClient(app).post("/agent", json=body)
    assert response.status_code == 200
    return [
        line[len("data: "):]
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def test_state_delta_keeps_null_patch_value():
    delta = StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=[
            {"op": "add", "path": "/document", "value": None},
            {"op": "replace", "path": "/nested", "value": {"inner": None}},
        ],
    )

    (frame,) = _post([delta])

    assert json.loads(frame)["delta"] == [
        {"op": "add", "path": "/document", "value": None},
        {"op": "replace", "path": "/nested", "value": {"inner": None}},
    ]


def test_sse_frames_match_the_sdk_encoder():
    """Unset optional fields are still omitted, matching ``EventEncoder``."""
    started = RunStartedEvent(type=EventType.RUN_STARTED, thread_id="t", run_id="r")

    (frame,) = _post([started])

    assert f"data: {frame}\n\n" == EventEncoder().encode(started)
    assert "parentRunId" not in json.loads(frame)
