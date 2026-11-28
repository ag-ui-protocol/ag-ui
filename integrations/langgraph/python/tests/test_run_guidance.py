"""Exercise the packaged chat factory and FastAPI guidance routes offline."""

import json
import unittest

import ag_ui_langgraph
from ag_ui_langgraph import (
    LangGraphAgent,
    RunGuidanceAgentMixin,
    RunGuidanceMiddleware,
    add_langgraph_fastapi_endpoint,
)
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from langchain.agents import AgentState, create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from pydantic import Field


class SnapshotState(AgentState, total=False):
    custom: dict[str, object]


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

    def client(self, *, agent=None, peer=("testclient", 50000), **endpoint_options):
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
        return TestClient(app, client=peer)

    def run_agent(self, client, run_id, *, context=(), messages=(), headers=None):
        self.post_run(
            client, run_id, context=context, messages=messages, headers=headers
        )
        return self.model.prompts[-1]

    def post_run(self, client, run_id, *, context=(), messages=(), headers=None):
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
        return [
            json.loads(line.removeprefix("data: "))
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]

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

    def test_restricted_ingress_trusts_keyless_private_peer(self):
        with self.client(peer=("10.42.0.8", 50000), trusted_ingress=True) as client:
            capability = client.get("/v1/agent/capabilities")
            self.assertEqual(
                capability.json()["custom"]["openbot.runGuidance"], {"version": 1}
            )
            prompt = self.run_agent(
                client,
                "keyless",
                context=[
                    entry("OpenBot standing role", "STANDING_ROLE"),
                    entry("OpenBot granted tools guidance", "GRANTED_TOOLS"),
                ],
            )
            self.assertEqual([message.type for message in prompt], ["system", "human"])
            self.assertEqual(prompt[0].content.count("STANDING_ROLE"), 1)
            self.assertEqual(prompt[0].content.count("GRANTED_TOOLS"), 1)

    def test_public_peer_with_forged_forwarding_stays_anonymous(self):
        with self.client(peer=("8.8.8.8", 50000)) as client:
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

    def test_snapshot_echo_does_not_restore_stale_guidance(self):
        config = {"configurable": {"thread_id": "thread"}}
        agent = ag_ui_langgraph.create_langgraph_agent(
            name="test", model=self.model, state_schema=SnapshotState
        )
        custom = {
            "messages": [
                {
                    "id": "granted-tools:custom",
                    "type": "system",
                    "content": "KEEP_CUSTOM",
                }
            ]
        }
        with self.client(agent=agent, trusted_ingress=True) as client:
            self.run_agent(client, "start")
            self.agent.graph.update_state(
                config,
                {
                    "custom": custom,
                    "messages": [
                        SystemMessage(id="granted-tools:cached", content="STALE_TOOLS"),
                        SystemMessage(
                            id="mixed-context",
                            content='App Context:\n[{"description":"OpenBot standing role",'
                            '"value":"STALE_ROLE"},{"description":"Ordinary context","value":"KEEP"}]',
                        ),
                        SystemMessage(
                            id="reserved-context",
                            content='App Context:\n[{"description":"OpenBot granted tools guidance",'
                            '"value":"STALE_CONTEXT_TOOLS"}]',
                        ),
                        SystemMessage(id="ordinary", content="ORDINARY_INSTRUCTION"),
                    ],
                },
            )
            events = self.post_run(client, "next")
            snapshot = next(
                event["messages"]
                for event in events
                if event["type"] == "MESSAGES_SNAPSHOT"
            )
            prompt = self.run_agent(client, "echo", messages=snapshot)
            for stale in ("STALE_TOOLS", "STALE_ROLE", "STALE_CONTEXT_TOOLS"):
                self.assertFalse(any(stale in message.content for message in prompt))
                self.assertNotIn(stale, json.dumps(snapshot))
            state_snapshots = [
                event["snapshot"]
                for event in events
                if event["type"] == "STATE_SNAPSHOT"
            ]
            self.assertTrue(state_snapshots)
            final_messages = state_snapshots[-1]["messages"]
            self.assertEqual(state_snapshots[-1]["custom"], custom)
            for state in state_snapshots:
                serialized = json.dumps(state.get("messages"))
                for stale in ("STALE_TOOLS", "STALE_ROLE", "STALE_CONTEXT_TOOLS"):
                    self.assertNotIn(stale, serialized)
            for messages in (snapshot, final_messages):
                by_id = {message["id"]: message["content"] for message in messages}
                self.assertEqual(by_id["ordinary"], "ORDINARY_INSTRUCTION")
                self.assertEqual(
                    json.loads(by_id["mixed-context"].removeprefix("App Context:\n")),
                    [{"description": "Ordinary context", "value": "KEEP"}],
                )
                self.assertNotIn("granted-tools:cached", by_id)
                self.assertNotIn("reserved-context", by_id)
            stored = self.agent.graph.get_state(config).values["messages"]
            by_id = {message.id: message.content for message in stored}
            self.assertEqual(by_id["granted-tools:cached"], "STALE_TOOLS")
            self.assertIn("STALE_ROLE", by_id["mixed-context"])
            self.assertIn("STALE_CONTEXT_TOOLS", by_id["reserved-context"])

    def test_packaged_factory_can_opt_out(self):
        agent = ag_ui_langgraph.create_langgraph_agent(
            name="test",
            model=self.model,
            enable_run_guidance=False,
        )

        def authorize(request: Request) -> bool:
            if request.headers.get("Authorization") != "Bearer legacy-token":
                raise HTTPException(status_code=401)
            return False

        with self.client(agent=agent, authorize_guidance=authorize) as client:
            self.assertEqual(client.get("/v1/agent/capabilities").status_code, 404)
            denied = client.post(
                "/v1/agent",
                json={
                    "threadId": "thread",
                    "runId": "denied",
                    "state": {},
                    "messages": [],
                    "tools": [],
                    "context": [],
                    "forwardedProps": {},
                },
            )
            self.assertEqual(denied.status_code, 401)
            self.assertEqual(self.model.prompts, [])

            prompt = self.run_agent(
                client,
                "legacy",
                headers={"Authorization": "Bearer legacy-token"},
                context=[entry("OpenBot standing role", "RESERVED_ROLE")],
                messages=[
                    {"id": "placeholder", "role": "system", "content": "DISCARD"},
                    {
                        "id": "granted-tools:legacy",
                        "role": "system",
                        "content": "LEGACY_TOOLS",
                    },
                ],
            )
            self.assertEqual(
                [(message.type, message.content) for message in prompt],
                [("system", "LEGACY_TOOLS"), ("human", "Proceed?")],
            )

    def test_compiled_chat_graph_can_use_guidance_mixin(self):
        class GuidanceAgent(RunGuidanceAgentMixin, LangGraphAgent):
            pass

        graph = create_agent(
            model=self.model,
            middleware=[RunGuidanceMiddleware()],
            checkpointer=self.checkpointer,
        )
        agent = GuidanceAgent(name="chat", graph=graph)
        with self.client(agent=agent, trusted_ingress=True) as client:
            capability = client.get("/v1/agent/capabilities")
            self.assertEqual(
                capability.json()["custom"]["openbot.runGuidance"], {"version": 1}
            )
            prompt = self.run_agent(
                client,
                "compiled",
                context=[entry("OpenBot standing role", "STANDING_ROLE")],
            )
            self.assertEqual(prompt[0].type, "system")
            self.assertIn("STANDING_ROLE", prompt[0].content)

    def test_precompiled_graph_retains_existing_capability_behavior(self):
        with self.client():
            app = FastAPI()
            old_agent = LangGraphAgent(name="custom", graph=self.agent.graph)
            add_langgraph_fastapi_endpoint(app, old_agent, "/agent")
            with TestClient(app) as client:
                self.assertEqual(client.get("/agent/capabilities").status_code, 404)
                self.assertEqual(client.get("/agent/health").status_code, 200)
