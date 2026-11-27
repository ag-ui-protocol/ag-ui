"""Exercise the packaged chat factory and FastAPI guidance routes offline."""

import unittest

import ag_ui_langgraph
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from pydantic import Field


class RecordingModel(BaseChatModel):
    prompts: list[list] = Field(default_factory=list)

    @property
    def _llm_type(self):
        return "recording"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.prompts.append(messages)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="OK"))])


def entry(description, value):
    return {"description": description, "value": value}


class TestRunGuidance(unittest.TestCase):
    def setUp(self):
        self.model = RecordingModel()
        self.checkpointer = MemorySaver()

    def client(self, *, agent=None, **endpoint_options):
        self.agent = agent or ag_ui_langgraph.create_langgraph_agent(
            name="test",
            model=self.model,
            system_prompt="Base instruction",
            checkpointer=self.checkpointer,
        )
        app = FastAPI()
        router = APIRouter(prefix="/v1")
        add_langgraph_fastapi_endpoint(router, self.agent, "/agent", **endpoint_options)
        app.include_router(router)
        return TestClient(app)

    def run_agent(self, client, run_id, *, context=(), messages=(), headers=None):
        response = client.post(
            "/v1/agent",
            headers=headers,
            json={
                "threadId": "thread",
                "runId": run_id,
                "state": {},
                "messages": [
                    *messages,
                    {"id": run_id, "role": "user", "content": "Proceed?"},
                ],
                "tools": [],
                "context": context,
                "forwardedProps": {"trustedGuidance": True},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("RUN_ERROR", response.text)
        self.assertIn("RUN_FINISHED", response.text)
        return self.model.prompts[-1]

    def test_host_authorizes_run_and_capability_with_same_callback(self):
        async def authorize(request: Request) -> bool:
            if request.headers.get("Authorization") != "Bearer test-token":
                raise HTTPException(status_code=401)
            return True

        with self.client(authorize_guidance=authorize) as client:
            headers = {"Authorization": "Bearer test-token"}
            path = "/v1/agent"
            self.assertEqual(client.get(path + "/health").status_code, 200)
            self.assertEqual(client.get(path + "/capabilities").status_code, 401)
            self.assertEqual(
                client.post(
                    path,
                    json={
                        "threadId": "thread",
                        "runId": "denied",
                        "state": {},
                        "messages": [],
                        "tools": [],
                        "context": [],
                        "forwardedProps": {},
                    },
                ).status_code,
                401,
            )
            self.assertEqual(self.model.prompts, [])

            capabilities = client.get(path + "/capabilities", headers=headers).json()
            self.assertEqual(capabilities["identity"]["type"], "langgraph")
            self.assertEqual(
                capabilities["custom"], {"openbot.runGuidance": {"version": 1}}
            )

            prompt = self.run_agent(
                client,
                "trusted",
                context=[
                    entry("OpenBot standing role", "STANDING_ROLE"),
                    entry("OpenBot granted tools guidance", "GRANTED_TOOLS"),
                ],
                headers=headers,
            )
            self.assertEqual([message.type for message in prompt], ["system", "human"])
            self.assertIn("Base instruction", prompt[0].content)
            self.assertEqual(prompt[0].content.count("STANDING_ROLE"), 1)
            self.assertEqual(prompt[0].content.count("GRANTED_TOOLS"), 1)

    def test_anonymous_role_has_user_authority_and_clears_on_warm_thread(self):
        with self.client() as client:
            prompt = self.run_agent(
                client,
                "anonymous",
                context=[
                    entry("OpenBot standing role", "STANDING_ROLE"),
                    entry("OpenBot granted tools guidance", "GRANTED_TOOLS"),
                ],
                headers={"X-Forwarded-For": "127.0.0.1"},
            )
            self.assertEqual(
                [
                    message.type
                    for message in prompt
                    if "STANDING_ROLE" in message.content
                ],
                ["human"],
            )
            self.assertFalse(
                any("GRANTED_TOOLS" in message.content for message in prompt)
            )
            next_prompt = self.run_agent(client, "clear")
            self.assertFalse(
                any("STANDING_ROLE" in message.content for message in next_prompt)
            )

    def test_legacy_fallback_and_warm_checkpoint_cleanup(self):
        legacy = [
            {"id": "standing-role:old", "role": "system", "content": "LEGACY_ROLE"},
            {"id": "granted-tools:old", "role": "system", "content": "LEGACY_TOOLS"},
        ]
        with self.client(trusted_ingress=True) as client:
            prompt = self.run_agent(client, "legacy", messages=legacy)
            self.assertEqual([message.type for message in prompt], ["system", "human"])
            self.assertIn("LEGACY_ROLE", prompt[0].content)
            self.assertIn("LEGACY_TOOLS", prompt[0].content)

            self.agent.graph.update_state(
                {"configurable": {"thread_id": "thread"}},
                {
                    "messages": [
                        SystemMessage(
                            id="granted-tools:cached", content="STALE_LEGACY"
                        ),
                        SystemMessage(
                            id="generic-context",
                            content='App Context:\n[{"description":"OpenBot standing role",'
                            '"value":"STALE_ROLE"},{"description":"Ordinary context","value":"KEEP"}]',
                        ),
                    ]
                },
            )
            next_prompt = self.run_agent(
                client,
                "modern",
                context=[entry("OpenBot standing role", "MODERN_ROLE")],
                messages=legacy,
            )
            self.assertIn("MODERN_ROLE", next_prompt[0].content)
            self.assertTrue(any("KEEP" in message.content for message in next_prompt))
            for forbidden in (
                "LEGACY_ROLE",
                "LEGACY_TOOLS",
                "STALE_LEGACY",
                "STALE_ROLE",
            ):
                self.assertFalse(
                    any(forbidden in message.content for message in next_prompt)
                )

            state = self.agent.graph.get_state(
                {"configurable": {"thread_id": "thread"}}
            )
            human = [
                m.content
                for m in state.values["messages"]
                if isinstance(m, HumanMessage)
            ]
            self.assertEqual(human, ["Proceed?", "Proceed?"])

    def test_leading_legacy_row_preserves_the_following_system_instruction(self):
        for context in ([], [entry("OpenBot standing role", "MODERN_ROLE")]):
            with (
                self.subTest(context=context),
                self.client(trusted_ingress=True) as client,
            ):
                prompt = self.run_agent(
                    client,
                    "start",
                    context=context,
                    messages=[
                        {
                            "id": "standing-role:old",
                            "role": "system",
                            "content": "LEGACY_ROLE",
                        },
                        {
                            "id": "granted-tools:old",
                            "role": "system",
                            "content": "LEGACY_TOOLS",
                        },
                        {
                            "id": "ordinary",
                            "role": "system",
                            "content": "ORDINARY_INSTRUCTION",
                        },
                    ],
                )
                self.assertEqual(
                    [message.content for message in prompt if message.id == "ordinary"],
                    ["ORDINARY_INSTRUCTION"],
                )
                state = self.agent.graph.get_state(
                    {"configurable": {"thread_id": "thread"}}
                )
                self.assertEqual(
                    [message.id for message in state.values["messages"][:2]],
                    ["ordinary", "start"],
                )
                self.assertIn(
                    "MODERN_ROLE" if context else "LEGACY_ROLE", prompt[0].content
                )

    def test_checkpoint_context_preserves_non_string_descriptions(self):
        with self.client(trusted_ingress=True) as client:
            self.run_agent(client, "start")
            self.agent.graph.update_state(
                {"configurable": {"thread_id": "thread"}},
                {
                    "messages": [
                        SystemMessage(
                            id="mixed-context",
                            content='App Context:\n[{"description":["ordinary"],"value":"KEEP"},'
                            '{"description":"OpenBot granted tools guidance","value":"STALE"}]',
                        ),
                    ]
                },
            )
            prompt = self.run_agent(client, "next")
            context = next(
                message.content for message in prompt if message.id == "mixed-context"
            )
            self.assertIn("KEEP", context)
            self.assertNotIn("STALE", context)

    def test_chat_factory_uses_a_checkpointer_by_default(self):
        agent = ag_ui_langgraph.create_langgraph_agent(name="test", model=self.model)
        with self.client(agent=agent) as client:
            self.run_agent(client, "start")
            prompt = self.run_agent(client, "next")
            self.assertEqual(
                [message.id for message in prompt if isinstance(message, HumanMessage)],
                ["start", "next"],
            )

    def test_precompiled_graph_retains_existing_capability_behavior(self):
        with self.client():
            app = FastAPI()
            old_agent = LangGraphAgent(name="custom", graph=self.agent.graph)
            add_langgraph_fastapi_endpoint(app, old_agent, "/agent")
            with TestClient(app) as client:
                self.assertEqual(client.get("/agent/capabilities").status_code, 404)
                self.assertEqual(client.get("/agent/health").status_code, 200)
