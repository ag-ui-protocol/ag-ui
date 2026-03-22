import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import UserMessage
from ag_ui_langgraph.agent import LangGraphAgent
from langchain_core.messages import AIMessage, HumanMessage


class _Snapshot:
    def __init__(self, values, config=None, next_nodes=None):
        self.values = values
        self.config = config or {"configurable": {"thread_id": "thread-1"}}
        self.next = next_nodes or ["assistant"]

    def _replace(self, **kwargs):
        return _Snapshot(
            kwargs.get("values", self.values),
            kwargs.get("config", self.config),
            kwargs.get("next", self.next),
        )


class TestLangGraphAgentRecovery(unittest.TestCase):
    def test_get_checkpoint_before_message_uses_supplied_config(self):
        history_config = {
            "configurable": {
                "thread_id": "thread-1",
                "checkpoint_ns": "fork-1",
            }
        }
        previous = _Snapshot(
            values={
                "messages": [HumanMessage(content="before", id="before-user-id")],
                "step": "before",
            },
            config=history_config,
        )
        current = _Snapshot(
            values={
                "messages": [HumanMessage(content="retry", id="target-user-id")],
                "step": "current",
            },
            config=history_config,
        )

        captured = {}

        async def history(config):
            captured["config"] = config
            for snapshot in [current, previous]:
                yield snapshot

        graph = MagicMock()
        graph.aget_state_history = history
        agent = LangGraphAgent(name="test", graph=graph)

        result = asyncio.run(
            agent.get_checkpoint_before_message(
                "target-user-id",
                "thread-1",
                history_config,
            )
        )

        self.assertEqual(
            captured["config"]["configurable"],
            history_config["configurable"],
        )
        self.assertEqual(result.values["step"], "current")
        self.assertEqual(
            [message.id for message in result.values["messages"]],
            ["before-user-id"],
        )

    def test_get_checkpoint_before_message_returns_none_when_message_missing(self):
        async def history(_config):
            yield _Snapshot(
                values={"messages": [HumanMessage(content="before", id="before-user-id")]},
            )

        graph = MagicMock()
        graph.aget_state_history = history
        agent = LangGraphAgent(name="test", graph=graph)

        result = asyncio.run(
            agent.get_checkpoint_before_message(
                "missing-user-id",
                "thread-1",
                {"configurable": {"thread_id": "thread-1"}},
            )
        )

        self.assertIsNone(result)

    def test_get_checkpoint_before_message_does_not_mutate_first_snapshot(self):
        current = _Snapshot(
            values={
                "messages": [HumanMessage(content="retry", id="target-user-id")],
                "step": "current",
            },
        )

        async def history(_config):
            yield current

        graph = MagicMock()
        graph.aget_state_history = history
        agent = LangGraphAgent(name="test", graph=graph)

        result = asyncio.run(
            agent.get_checkpoint_before_message(
                "target-user-id",
                "thread-1",
                {"configurable": {"thread_id": "thread-1"}},
            )
        )

        self.assertEqual(
            [message.id for message in result.values["messages"]],
            [],
        )
        self.assertEqual(
            [message.id for message in current.values["messages"]],
            ["target-user-id"],
        )

    def test_prepare_stream_falls_back_when_recovery_returns_none(self):
        graph = MagicMock()
        graph.astream_events = MagicMock(return_value="normal-stream")

        agent = LangGraphAgent(name="test", graph=graph)
        agent.active_run = {
            "id": "run-1",
            "mode": "start",
            "schema_keys": [],
            "node_name": None,
        }
        agent.langgraph_default_merge_state = MagicMock(return_value={})
        agent.get_stream_kwargs = MagicMock(
            return_value={
                "input": {"ok": True},
                "config": {"configurable": {"thread_id": "thread-1"}},
                "subgraphs": False,
                "version": "v2",
            }
        )
        agent.prepare_regenerate_stream = AsyncMock(return_value=None)

        input_obj = SimpleNamespace(
            state={},
            messages=[UserMessage(id="unused", role="user", content="retry")],
            forwarded_props={},
            context=[],
            thread_id="thread-1",
            run_id="run-1",
            tools=None,
        )
        agent_state = SimpleNamespace(
            values={
                "messages": [
                    HumanMessage(content="stored", id="same-user-id"),
                    AIMessage(content="assistant", id="stored-ai-id"),
                    AIMessage(content="extra assistant", id="extra-ai-id"),
                ]
            },
            tasks=[],
            metadata={},
            next=[],
        )
        config = {"configurable": {"thread_id": "thread-1"}}

        with patch(
            "ag_ui_langgraph.agent.agui_messages_to_langchain",
            return_value=[
                AIMessage(content="frontend echo", id="fresh-ai-id"),
                HumanMessage(content="retry", id="same-user-id"),
            ],
        ):
            result = asyncio.run(
                agent.prepare_stream(
                    input=input_obj,
                    agent_state=agent_state,
                    config=config,
                )
            )

        self.assertEqual(agent.prepare_regenerate_stream.await_count, 1)
        self.assertIsNotNone(result)
        self.assertEqual(result["stream"], "normal-stream")
        self.assertEqual(result["config"], config)
