"""End-to-end test: orphan tool-message replacement through LangGraphAgent.run().

TODO is this the expected pattern with CopilotKit?
This test builds a real LangGraph with checkpointing and runs .run() twice:
  Turn 1: User asks a question -> AI makes a frontend tool call.
  Turn 2: .run() is called with the real tool result in incoming messages.
          The orphan must be replaced and the AI produces a final answer.

It verifies the exact message history in both the final checkpoint and
the MESSAGES_SNAPSHOT event after Turn 2 completes.
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
    """Build a graph whose node behaviour depends on a counter.

    counter=0 (Turn 1): return an AIMessage with a tool_call (frontend tool).
    counter>=1 (Turn 2+): return a plain AIMessage answer.
    """
    class GraphState(TypedDict):
        messages: Annotated[list, add_messages]
        counter: int

    def mock_agent(_state: GraphState):
        turn = _state.get("counter", 0)
        if turn == 0:
            # Turn 1: AI calls a frontend tool + orphan placeholder is created
            return {
                "messages": [
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
                ],
                "counter": turn + 1,
            }
        # Turn 2+: AI answers based on the tool result
        return {
            "messages": [AIMessage(
                content="It's sunny, 22°C.",
                id=f"ai-{turn + 1}",
            )],
            "counter": turn + 1,
        }

    g = StateGraph(GraphState)
    g.add_node("agent", mock_agent)
    g.add_edge(START, "agent")
    g.add_edge("agent", END)
    return g.compile(checkpointer=MemorySaver())


def _make_turn1_messages():
    """Turn 1: user asks a question."""
    return [
        AguiUserMessage(id="msg-1", role="user", content="What is the weather?"),
    ]


def _make_turn2_messages():
    """Turn 2: replay history + orphan replaced with real tool result + new user msg."""
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
        AguiUserMessage(id="msg-2", role="user", content="Thanks, show me the weather"),
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


def _checkpoint_history(graph):
    """Read checkpoint and return messages as (role, id, content) tuples."""
    state = asyncio.get_event_loop().run_until_complete(
        graph.aget_state({"configurable": {"thread_id": THREAD_ID}})
    )
    return [
        (_LANGCHAIN_TYPE_TO_ROLE[type(m).__name__], m.id, m.content)
        for m in state.values.get("messages", [])
    ]


class TestOrphanToolMergeE2E(unittest.TestCase):
    """End-to-end: two .run() turns verifying orphan replacement."""

    def test_orphan_replaced_across_two_runs(self):
        """Run Turn 1 (tool call) then Turn 2 (real result). Verify both
        the checkpoint and the MESSAGES_SNAPSHOT contain the correct history
        with the orphan replaced."""
        graph = _build_graph()
        agent = LangGraphAgent(name="e2e-test", graph=graph)

        # ── Turn 1: user asks, AI makes a frontend tool call ──
        turn1_input = RunAgentInput(
            threadId=THREAD_ID,
            runId="run-1",
            messages=_make_turn1_messages(),
            tools=[],
            state={},
            context=[],
            forwardedProps={},
        )
        asyncio.get_event_loop().run_until_complete(
            _collect_events(agent, turn1_input)
        )

        # After Turn 1: checkpoint has user msg + AI tool call
        turn1_history = _checkpoint_history(graph)
        turn1_history_expected = [
            ("user",      "msg-1", "What is the weather?"),
            ("assistant", "ai-1",  ""),  
            ('tool', 'orphan-1', ORPHAN_CONTENT)
        ]
        self.assertEqual(turn1_history, turn1_history_expected)

        # ── Turn 2: real tool result + new user message ──
        turn2_input = RunAgentInput(
            threadId=THREAD_ID,
            runId="run-2",
            messages=_make_turn2_messages(),
            tools=[],
            state={},
            context=[],
            forwardedProps={},
        )
        turn2_events = asyncio.get_event_loop().run_until_complete(
            _collect_events(agent, turn2_input)
        )

        # ── Verify checkpoint ──
        turn_2_history_expected = [
            ("user",      "msg-1",      "What is the weather?"),
            ("assistant", "ai-1",       ""),                            # tool call
            ("tool",      "orphan-1",   REAL_CONTENT),                  # orphan replaced
            ("user",      "msg-2",      "Thanks, show me the weather"),
            ("assistant", "ai-2",  "It's sunny, 22°C."),          # Turn 2 answer
        ]

        checkpoint_msgs = _checkpoint_history(graph)
        self.assertEqual(checkpoint_msgs, turn_2_history_expected)

        # ── Verify MESSAGES_SNAPSHOT ──
        snapshot_events = [
            e for e in turn2_events
            if hasattr(e, "type") and e.type == EventType.MESSAGES_SNAPSHOT
        ]
        self.assertTrue(snapshot_events)

        snapshot_msgs = [
            (m.role, m.id, m.content)
            for m in snapshot_events[-1].messages
        ]
        self.assertEqual(snapshot_msgs, turn_2_history_expected)


if __name__ == "__main__":
    unittest.main()
