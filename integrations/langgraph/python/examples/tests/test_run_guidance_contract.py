import json
import unittest
from typing import Annotated

import httpx
from ag_ui_langgraph import add_langgraph_fastapi_endpoint, create_langgraph_agent
from agents.agentic_chat.fastapi import create_fastapi_agent
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from langchain_core.tools import InjectedToolCallId, tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt


def make_model(captured, tool_name):
    def provider(request):
        body = json.loads(request.content)
        captured.append(body)
        if len(captured) == 1:
            delta = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "index": 0,
                        "type": "function",
                        "id": "approval-call",
                        "function": {"name": tool_name, "arguments": "{}"},
                    }
                ],
            }
            finish = "tool_calls"
        else:
            delta = {"role": "assistant", "content": "Okay."}
            finish = "stop"
        chunk = {
            "id": "model-request",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "gpt-4.1-mini",
            "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        }
        end = {
            **chunk,
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
        }
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            text=f"data: {json.dumps(chunk)}\n\ndata: {json.dumps(end)}\n\ndata: [DONE]\n\n",
        )

    return ChatOpenAI(
        model="gpt-4.1-mini",
        api_key="local-fixture",
        base_url="http://provider.test/v1",
        http_async_client=httpx.AsyncClient(transport=httpx.MockTransport(provider)),
    )


class TestRunGuidanceContract(unittest.TestCase):
    def endpoint(self, *, token=None, restricted=False):
        captured = []
        approved = []

        @tool
        def approve_action(call_id: Annotated[str, InjectedToolCallId]):
            """Ask for approval before doing the pending test action."""
            answer = interrupt(
                {"message": "Approve the pending action?", "toolCallId": call_id}
            )
            if answer["approved"]:
                approved.append(call_id)
            return "Action handled."

        model = make_model(captured, "approve_action")
        agent = create_langgraph_agent(
            name="agentic_chat",
            agent_options={"emit_interrupt_outcome": True},
            model=model,
            system_prompt="base instruction",
            tools=[approve_action],
            checkpointer=MemorySaver(),
        )
        app = FastAPI()

        def authorize(request):
            if request.headers.get("authorization") != f"Bearer {token}":
                raise HTTPException(status_code=401)
            return True

        add_langgraph_fastapi_endpoint(
            app,
            agent,
            "/agent",
            authorize_guidance=authorize if token else None,
            trusted_ingress=restricted,
        )
        return TestClient(app, base_url="http://127.0.0.1"), captured, approved

    def run_agent(self, client, *, run_id, context, headers, resume=None):
        request = {
            "threadId": "thread",
            "runId": run_id,
            "state": {},
            "messages": [{"id": "question", "role": "user", "content": "Proceed?"}],
            "tools": [],
            "context": context,
            "forwardedProps": {"trusted": True},
        }
        if resume is not None:
            request["resume"] = resume
        response = client.post("/agent", json=request, headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        events = [
            json.loads(line.removeprefix("data: "))
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]
        self.assertFalse(any(event["type"] == "RUN_ERROR" for event in events), events)
        return next(event for event in events if event["type"] == "RUN_FINISHED")

    def test_role_authority_and_replacement_on_native_resume(self):
        for mode in ("token", "keyless", "anonymous"):
            with self.subTest(mode=mode):
                token = "bot-token" if mode == "token" else None
                client, requests, approved = self.endpoint(
                    token=token, restricted=mode == "keyless"
                )
                headers = (
                    {"Authorization": f"Bearer {token}"}
                    if token
                    else {
                        "X-Forwarded-For": "127.0.0.1",
                        "X-Forwarded-Host": "internal.test",
                    }
                )
                capability = client.get("/agent/capabilities", headers=headers)
                self.assertEqual(
                    capability.json()["custom"]["openbot.runGuidance"]["version"], 1
                )
                if token:
                    self.assertEqual(client.get("/agent/capabilities").status_code, 401)

                first = self.run_agent(
                    client,
                    run_id="first",
                    headers=headers,
                    context=[
                        {
                            "description": "OpenBot standing role",
                            "value": "INITIAL_ROLE",
                        },
                        {
                            "description": "OpenBot granted tools guidance",
                            "value": "INITIAL_TOOLS",
                        },
                    ],
                )
                self.assertEqual(approved, [])
                self.assertEqual(
                    first["outcome"]["interrupts"][0]["toolCallId"], "approval-call"
                )
                self.run_agent(
                    client,
                    run_id="resumed",
                    headers=headers,
                    context=[
                        {"description": "OpenBot standing role", "value": "NEW_ROLE"}
                    ],
                    resume=[
                        {
                            "interruptId": first["outcome"]["interrupts"][0]["id"],
                            "status": "resolved",
                            "payload": {"approved": True},
                        }
                    ],
                )
                self.assertEqual(approved, ["approval-call"])
                self.assertEqual(len(requests), 2)
                role_channel = "user" if mode == "anonymous" else "system"
                prompts = [request["messages"] for request in requests]
                for prompt, role in zip(prompts, ("INITIAL_ROLE", "NEW_ROLE")):
                    matches = [row["role"] for row in prompt if role in json.dumps(row)]
                    self.assertEqual(matches, [role_channel], prompt)
                self.assertEqual(
                    json.dumps(prompts[0]).count("INITIAL_TOOLS"),
                    0 if mode == "anonymous" else 1,
                )
                self.assertNotIn("INITIAL_ROLE", json.dumps(prompts[1]))
                self.assertNotIn("INITIAL_TOOLS", json.dumps(prompts[1]))

    def test_stock_fastapi_chat_preserves_frontend_tool_handback(self):
        requests = []
        app = FastAPI()
        add_langgraph_fastapi_endpoint(
            app,
            create_fastapi_agent(model=make_model(requests, "front_tool")),
            "/agent",
            trusted_ingress=True,
        )
        start = {
            "threadId": "thread",
            "runId": "first",
            "state": {},
            "messages": [{"id": "prompt", "role": "user", "content": "Proceed?"}],
            "tools": [
                {
                    "name": "front_tool",
                    "description": "A frontend tool",
                    "parameters": {"type": "object", "properties": {}},
                }
            ],
            "context": [
                {"description": "OpenBot standing role", "value": "STOCK_ROLE"}
            ],
            "forwardedProps": {},
        }
        with TestClient(app) as client:
            first = client.post("/agent", json=start)
            self.assertEqual(first.status_code, 200)
            self.assertNotIn("RUN_ERROR", first.text)
            events = [
                json.loads(line.removeprefix("data: "))
                for line in first.text.splitlines()
                if line.startswith("data: ")
            ]
            call = next(event for event in events if event["type"] == "TOOL_CALL_START")
            self.assertEqual(call["toolCallId"], "approval-call")
            snapshot = next(
                event for event in events if event["type"] == "MESSAGES_SNAPSHOT"
            )
            payload = {
                **start,
                "runId": "handback",
                "messages": [
                    *snapshot["messages"],
                    {
                        "id": "tool-result",
                        "role": "tool",
                        "toolCallId": "approval-call",
                        "content": "FRONTEND_RESULT",
                    },
                ],
                "context": [],
            }
            second = client.post("/agent", json=payload)
            self.assertEqual(second.status_code, 200)
            self.assertNotIn("RUN_ERROR", second.text)

        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0]["tools"][0]["function"]["name"], "front_tool")
        self.assertIn(
            "You are a helpful assistant.", requests[0]["messages"][0]["content"]
        )
        self.assertEqual(requests[0]["messages"][0]["content"].count("STOCK_ROLE"), 1)
        self.assertNotIn("STOCK_ROLE", json.dumps(requests[1]["messages"]))
        result = next(row for row in requests[1]["messages"] if row["role"] == "tool")
        self.assertEqual(result["tool_call_id"], "approval-call")
        self.assertEqual(result["content"], "FRONTEND_RESULT")
