"""Public streams surface local provider translation failures without SSE aborts."""

import asyncio
import unittest
from unittest.mock import AsyncMock

from ag_ui.core import EventType, RunAgentInput, UserMessage
from langchain_core.messages import convert_to_openai_messages
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from ag_ui_langgraph.agent import LangGraphAgent
from tests._helpers import DataSource, VideoPart


class TestPublicRunErrors(unittest.IsolatedAsyncioTestCase):
    def make_agent(self):
        def translate(state):
            # Exercise the installed provider translator, without a provider call.
            convert_to_openai_messages(state["messages"])
            return {}

        graph = StateGraph(MessagesState)
        graph.add_node("translate", translate)
        graph.add_edge(START, "translate")
        graph.add_edge("translate", END)
        return LangGraphAgent(
            name="translator", graph=graph.compile(checkpointer=MemorySaver())
        )

    def input(self):
        return RunAgentInput(
            thread_id="thread-error",
            run_id="run-error",
            state={},
            tools=[],
            context=[],
            forwarded_props={},
            messages=[
                UserMessage(
                    id="video",
                    role="user",
                    content=[
                        VideoPart(
                            source=DataSource(
                                type="data", value="AAAA", mime_type="video/mp4"
                            )
                        )
                    ],
                )
            ],
        )

    async def test_real_translator_failure_is_one_terminal_error(self):
        events = [event async for event in self.make_agent().run(self.input())]
        self.assertEqual(events[0].type, EventType.RUN_STARTED)
        self.assertEqual(
            [
                e.type
                for e in events
                if e.type in (EventType.RUN_ERROR, EventType.RUN_FINISHED)
            ],
            [EventType.RUN_ERROR],
        )
        self.assertEqual(events[-1].type, EventType.RUN_ERROR)
        self.assertIn("video", events[-1].message.lower())
        self.assertIsNone(events[-1].raw_event)

    async def test_preparation_failure_starts_and_errors(self):
        agent = self.make_agent()
        agent.prepare_stream = AsyncMock(
            side_effect=ValueError("unsupported provider format")
        )
        events = [event async for event in agent.run(self.input())]
        self.assertEqual(
            [e.type for e in events], [EventType.RUN_STARTED, EventType.RUN_ERROR]
        )
        self.assertEqual(events[-1].message, "unsupported provider format")

    async def test_exception_without_message_uses_exception_name(self):
        agent = self.make_agent()
        agent.prepare_stream = AsyncMock(side_effect=ValueError())
        events = [event async for event in agent.run(self.input())]
        self.assertEqual(
            [e.type for e in events], [EventType.RUN_STARTED, EventType.RUN_ERROR]
        )
        self.assertEqual(events[-1].message, "ValueError")

    async def test_cancellation_propagates(self):
        agent = self.make_agent()
        agent.prepare_stream = AsyncMock(side_effect=asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError):
            _ = [event async for event in agent.run(self.input())]

    async def test_private_stream_keeps_exception_contract(self):
        agent = self.make_agent()
        agent.prepare_stream = AsyncMock(
            side_effect=ValueError("unsupported provider format")
        )
        with self.assertRaisesRegex(ValueError, "unsupported provider format"):
            _ = [event async for event in agent._handle_stream_events(self.input())]
