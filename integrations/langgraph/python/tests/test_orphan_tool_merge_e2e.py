"""End-to-end test: orphan tool-message replacement through LangGraphAgent.run().

This test builds a real LangGraph with checkpointing, simulates two turns:
  Turn 1: AI makes a tool call -> orphan placeholder is left in checkpoint
  Turn 2: .run() is called with the real tool result in incoming messages

It then verifies the exact message history in both the final checkpoint and
the MESSAGES_SNAPSHOT event after .run() completes.
"""
import asyncio
import unittest
from typing import Annotated
from typing_extensions import TypedDict

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, END, START
from langgraph.graph.message import add_messages

from ag_ui.core import EventType, RunAgentInput
from ag_ui.core.types import (
    UserMessage as AguiUserMessage,
    AssistantMessage as AguiAssistantMessage,
    ToolMessage as AguiToolMessage,
    ToolCall,
    FunctionCall,
)
from ag_ui_langgraph.agent import LangGraphAgent


ORPHAN_CONTENT = "Tool call 'show_result' with id 'tc-1' was interrupted before completion."
REAL_CONTENT = '{"rendered": true, "title": "Weather"}'
THREAD_ID = "test-thread-orphan"


def _build_graph():
    """Build a minimal graph with a mock answer node."""
    class GraphState(TypedDict):
        messages: Annotated[list, add_messages]

    def mock_answer(_state: GraphState):
        return {"messages": [AIMessage(content="It's sunny, 22°C.", id="ai-3")]}

    g = StateGraph(GraphState)
    g.add_node("agent", mock_answer)
    g.add_edge(START, "agent")
    g.add_edge("agent", END)
    return g.compile(checkpointer=MemorySaver())


def _seed_checkpoint_with_orphan(graph):
    """Manually invoke the graph to create a checkpoint containing an orphan.

    Simulates Turn 1: user asks -> AI calls tool -> orphan placeholder is written.
    """
    seed_messages = [
        HumanMessage(content="What is the weather?", id="msg-1"),
        AIMessage(
            content="",
            id="ai-1",
            tool_calls=[{
                "name": "show_result",
                "args": {"title": "Weather"},
                "id": "tc-1",
                "type": "tool_call",
            }],
        ),
        ToolMessage(
            content=ORPHAN_CONTENT,
            tool_call_id="tc-1",
            id="orphan-1",
        ),
        AIMessage(content="", id="ai-2"),
    ]
    asyncio.get_event_loop().run_until_complete(
        graph.ainvoke(
            {"messages": seed_messages},
            config={"configurable": {"thread_id": THREAD_ID}},
        )
    )


def _make_incoming_messages():
    """Simulate Turn 2 incoming AG-UI messages with the real FE tool result."""
    return [
        AguiUserMessage(id="msg-1", role="user", content="What is the weather?"),
        AguiAssistantMessage(
            id="ai-1",
            role="assistant",
            content="",
            tool_calls=[ToolCall(
                id="tc-1",
                type="function",
                function=FunctionCall(name="show_result", arguments='{"title": "Weather"}'),
            )],
        ),
        AguiToolMessage(
            id="orphan-1",
            role="tool",
            content=REAL_CONTENT,
            tool_call_id="tc-1",
        ),
    ]


async def _collect_events(agent, run_input):
    """Run the agent and collect all emitted events."""
    events = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


_LANGCHAIN_TYPE_TO_ROLE = {
    "HumanMessage": "user",
    "AIMessage": "assistant",
    "ToolMessage": "tool",
    "SystemMessage": "system",
}

EXPECTED_HISTORY = [
    ("user",      "msg-1",    "What is the weather?"),
    ("assistant", "ai-1",     ""),
    ("tool",      "orphan-1", REAL_CONTENT),          # orphan replaced
    ("assistant", "ai-2",     ""),
    ("assistant", "ai-3",     "It's sunny, 22°C."),   # mock answer
]


class TestOrphanToolMergeE2E(unittest.TestCase):
    """End-to-end: verify exact message history after .run() with orphan replacement."""

    def test_orphan_replaced_in_checkpoint_and_snapshot(self):
        """After .run(), both the checkpoint and the MESSAGES_SNAPSHOT must
        contain the correct message history with the orphan replaced."""
        graph = _build_graph()
        _seed_checkpoint_with_orphan(graph)
        agent = LangGraphAgent(name="e2e-test", graph=graph)

        run_input = RunAgentInput(
            threadId=THREAD_ID,
            runId="run-2",
            messages=_make_incoming_messages(),
            tools=[],
            state={},
            context=[],
            forwardedProps={},
        )
        events = asyncio.get_event_loop().run_until_complete(
            _collect_events(agent, run_input)
        )

        # -- Checkpoint --
        checkpoint_state = asyncio.get_event_loop().run_until_complete(
            graph.aget_state({"configurable": {"thread_id": THREAD_ID}})
        )
        checkpoint_msgs = [
            (_LANGCHAIN_TYPE_TO_ROLE[type(m).__name__], m.id, m.content)
            for m in checkpoint_state.values.get("messages", [])
        ]
        self.assertEqual(
            checkpoint_msgs, EXPECTED_HISTORY,
            f"\nCheckpoint actual:\n{checkpoint_msgs}\nExpected:\n{EXPECTED_HISTORY}",
        )

        # -- MESSAGES_SNAPSHOT event --
        snapshot_events = [
            e for e in events
            if hasattr(e, "type") and e.type == EventType.MESSAGES_SNAPSHOT
        ]
        self.assertTrue(snapshot_events, "No MESSAGES_SNAPSHOT event emitted")

        snapshot_msgs = [
            (m.role, m.id, m.content)
            for m in snapshot_events[-1].messages
        ]
 
        self.assertEqual(
            snapshot_msgs, EXPECTED_HISTORY,
            f"\nSnapshot actual:\n{snapshot_msgs}\nExpected:\n{EXPECTED_HISTORY}",
        )


if __name__ == "__main__":
    unittest.main()
