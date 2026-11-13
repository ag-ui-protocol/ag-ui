#!/usr/bin/env python
"""Regression test for ag-ui-protocol/ag-ui#3262.

When a sub-agent with ``disallow_transfer_to_parent=True`` raises a tool
confirmation (``adk_request_confirmation``), approving it through the ADK
middleware must resume that sub-agent — not the root agent. On ADK versions
whose ``Runner._find_agent_to_run`` runs before ``new_message`` is appended
(reproduced on google-adk 2.2.0), the last session event the router saw was
a middleware ``state_update_*`` event left over from persisting
``pending_tool_calls`` / run state. That event carries no FunctionResponse,
so the router fell back to its event scan, which skips a sub-agent that
cannot transfer to its parent and landed on the root agent — which then
re-executed the confirmed call against its own tools and failed with
"Tool 'apply_change' not found".

This test is offline: a scripted model plays coordinator (transfer to the
specialist) and specialist (call the confirmed tool, then finish).
"""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.adk.agents import Agent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools import FunctionTool
from google.genai import types

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from ag_ui_adk.session_manager import SessionManager


class _Script(BaseLlm):
    model: str = "script"

    async def generate_content_async(self, llm_request, stream=False):
        tools = list(llm_request.tools_dict)
        last = llm_request.contents[-1].parts[-1]
        if "apply_change" in tools and not last.function_response:
            part = types.Part.from_function_call(
                name="apply_change", args={"change_id": "c1"}
            )
        elif "transfer_to_agent" in tools and not last.function_response:
            part = types.Part.from_function_call(
                name="transfer_to_agent", args={"agent_name": "specialist"}
            )
        else:
            part = types.Part.from_text(text="done")
        yield LlmResponse(
            content=types.Content(role="model", parts=[part])
        )


@pytest.fixture(autouse=True)
def reset_session_manager():
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


def _post(client, messages, run_id):
    response = client.post(
        "/",
        json={
            "threadId": "t1",
            "runId": run_id,
            "state": {},
            "messages": messages,
            "tools": [],
            "context": [],
            "forwardedProps": {},
        },
    )
    assert response.status_code == 200
    return [
        json.loads(line.removeprefix("data:"))
        for line in response.text.splitlines()
        if line.startswith("data:")
    ]


def test_confirmation_resume_returns_to_disallow_transfer_subagent():
    applied = []

    def apply_change(change_id: str) -> dict:
        applied.append(change_id)
        return {"applied": change_id}

    specialist = Agent(
        name="specialist",
        model=_Script(),
        description="Applies changes.",
        tools=[FunctionTool(apply_change, require_confirmation=True)],
        disallow_transfer_to_parent=True,
    )
    root = Agent(name="coordinator", model=_Script(), sub_agents=[specialist])
    app = App(
        name="demo",
        root_agent=root,
        resumability_config=ResumabilityConfig(is_resumable=True),
    )
    api = FastAPI()
    add_adk_fastapi_endpoint(
        api,
        ADKAgent.from_app(app, user_id="u", use_in_memory_services=True),
        path="/",
    )
    client = TestClient(api)

    asked = {"id": "m1", "role": "user", "content": "apply c1"}
    first_run = _post(client, [asked], "r1")
    [call_id] = [
        event["toolCallId"]
        for event in first_run
        if event["type"] == "TOOL_CALL_START"
        and event["toolCallName"] == "adk_request_confirmation"
    ]
    _post(
        client,
        [
            asked,
            {
                "id": "a1",
                "role": "assistant",
                "toolCalls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": "adk_request_confirmation",
                            "arguments": "{}",
                        },
                    }
                ],
            },
            {
                "id": "t1",
                "role": "tool",
                "toolCallId": call_id,
                "content": json.dumps({"confirmed": True}),
            },
        ],
        "r2",
    )
    assert applied == ["c1"]
