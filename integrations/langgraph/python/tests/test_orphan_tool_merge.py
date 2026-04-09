"""Regression tests for orphaned-tool-message repair in langgraph_default_merge_state.

Covers the bug reported in ag-ui-protocol/ag-ui#1412:
  Repaired orphan ToolMessages were mutated in-place on the checkpoint copy
  but the function returned only ``new_messages``, so the repair was lost.
"""

import unittest
from typing import Annotated

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict

from ag_ui.core import RunAgentInput
from ag_ui_langgraph.agent import LangGraphAgent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _MinimalState(TypedDict):
    messages: Annotated[list, add_messages]


def _make_agent() -> LangGraphAgent:
    """Build a throwaway LangGraphAgent backed by a trivial graph."""
    g = StateGraph(_MinimalState)
    g.add_node("noop", lambda s: s)
    g.add_edge(START, "noop")
    g.add_edge("noop", END)
    return LangGraphAgent(name="test", graph=g.compile())


def _dummy_input(**overrides) -> RunAgentInput:
    defaults = dict(
        threadId="t1",
        runId="r1",
        messages=[],
        tools=[],
        state={},
        context=[],
        forwardedProps={},
    )
    defaults.update(overrides)
    return RunAgentInput(**defaults)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestOrphanToolMerge(unittest.TestCase):
    """Tests that repaired orphan ToolMessages appear in the merged output."""

    def setUp(self):
        self.agent = _make_agent()

    # -- core bug (issue #1412) ------------------------------------------

    def test_repaired_orphan_is_returned(self):
        """Repaired orphan must be present in merged messages (not discarded)."""
        checkpoint_messages = [
            HumanMessage(content="What is the weather?", id="msg-1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[
                    {"name": "show_result", "args": {"title": "Weather"}, "id": "tc-1", "type": "tool_call"}
                ],
            ),
            ToolMessage(
                content="Tool call 'show_result' with id 'tc-1' was interrupted before completion.",
                tool_call_id="tc-1",
                id="orphan-1",
            ),
            AIMessage(content="", id="ai-2"),
        ]

        incoming = [
            HumanMessage(content="What is the weather?", id="msg-1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[
                    {"name": "show_result", "args": {"title": "Weather"}, "id": "tc-1", "type": "tool_call"}
                ],
            ),
            ToolMessage(
                content='{"rendered": true, "title": "Weather", "body": "Sunny 22°C"}',
                tool_call_id="tc-1",
                id="tool-tc-1",
            ),
        ]

        merged = self.agent.langgraph_default_merge_state(
            {"messages": checkpoint_messages},
            incoming,
            _dummy_input(),
        )

        merged_msgs = merged["messages"]

        # The repaired orphan (with id "orphan-1") should be in the output.
        repaired = [m for m in merged_msgs if getattr(m, "id", None) == "orphan-1"]
        self.assertEqual(len(repaired), 1, "Repaired orphan message must appear in merged output")
        self.assertEqual(
            repaired[0].content,
            '{"rendered": true, "title": "Weather", "body": "Sunny 22°C"}',
        )

    def test_duplicate_tool_message_excluded(self):
        """The incoming ToolMessage that donated its content should NOT also appear."""
        checkpoint_messages = [
            HumanMessage(content="hi", id="h1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[{"name": "t", "args": {}, "id": "tc-1", "type": "tool_call"}],
            ),
            ToolMessage(
                content="Tool call 't' with id 'tc-1' was interrupted before completion.",
                tool_call_id="tc-1",
                id="orphan-1",
            ),
        ]

        incoming = [
            HumanMessage(content="hi", id="h1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[{"name": "t", "args": {}, "id": "tc-1", "type": "tool_call"}],
            ),
            ToolMessage(content="real result", tool_call_id="tc-1", id="real-tool-1"),
        ]

        merged = self.agent.langgraph_default_merge_state(
            {"messages": checkpoint_messages},
            incoming,
            _dummy_input(),
        )

        merged_ids = {getattr(m, "id", None) for m in merged["messages"]}
        self.assertNotIn(
            "real-tool-1",
            merged_ids,
            "Donor ToolMessage should be excluded; its content was already applied to the orphan",
        )

    # -- unaffected paths ------------------------------------------------

    def test_no_orphans_passes_through(self):
        """When there are no orphans, merge behaviour is unchanged."""
        checkpoint = [HumanMessage(content="hi", id="h1")]
        incoming = [
            HumanMessage(content="hi", id="h1"),
            AIMessage(content="hello", id="ai-1"),
        ]

        merged = self.agent.langgraph_default_merge_state(
            {"messages": checkpoint},
            incoming,
            _dummy_input(),
        )

        merged_ids = [getattr(m, "id", None) for m in merged["messages"]]
        self.assertIn("ai-1", merged_ids, "New AI message should appear")
        self.assertNotIn("h1", merged_ids, "Existing message should not be duplicated")

    def test_multiple_orphans_all_repaired(self):
        """Multiple orphans in the same turn must all be repaired and returned."""
        checkpoint_messages = [
            HumanMessage(content="q", id="h1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[
                    {"name": "a", "args": {}, "id": "tc-a", "type": "tool_call"},
                    {"name": "b", "args": {}, "id": "tc-b", "type": "tool_call"},
                ],
            ),
            ToolMessage(
                content="Tool call 'a' with id 'tc-a' was interrupted before completion.",
                tool_call_id="tc-a",
                id="orphan-a",
            ),
            ToolMessage(
                content="Tool call 'b' with id 'tc-b' was interrupted before completion.",
                tool_call_id="tc-b",
                id="orphan-b",
            ),
        ]

        incoming = [
            HumanMessage(content="q", id="h1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[
                    {"name": "a", "args": {}, "id": "tc-a", "type": "tool_call"},
                    {"name": "b", "args": {}, "id": "tc-b", "type": "tool_call"},
                ],
            ),
            ToolMessage(content="result-a", tool_call_id="tc-a", id="real-a"),
            ToolMessage(content="result-b", tool_call_id="tc-b", id="real-b"),
        ]

        merged = self.agent.langgraph_default_merge_state(
            {"messages": checkpoint_messages},
            incoming,
            _dummy_input(),
        )

        merged_msgs = merged["messages"]
        repaired_a = [m for m in merged_msgs if getattr(m, "id", None) == "orphan-a"]
        repaired_b = [m for m in merged_msgs if getattr(m, "id", None) == "orphan-b"]

        self.assertEqual(len(repaired_a), 1)
        self.assertEqual(repaired_a[0].content, "result-a")
        self.assertEqual(len(repaired_b), 1)
        self.assertEqual(repaired_b[0].content, "result-b")

        # Donor messages must not appear
        merged_ids = {getattr(m, "id", None) for m in merged_msgs}
        self.assertNotIn("real-a", merged_ids)
        self.assertNotIn("real-b", merged_ids)

    def test_non_orphan_tool_message_not_affected(self):
        """ToolMessages that are not orphans should pass through normally."""
        checkpoint = [
            HumanMessage(content="hi", id="h1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[{"name": "t", "args": {}, "id": "tc-1", "type": "tool_call"}],
            ),
            ToolMessage(content="normal result", tool_call_id="tc-1", id="tool-1"),
        ]

        incoming = [
            HumanMessage(content="hi", id="h1"),
            AIMessage(
                content="",
                id="ai-1",
                tool_calls=[{"name": "t", "args": {}, "id": "tc-1", "type": "tool_call"}],
            ),
            ToolMessage(content="normal result", tool_call_id="tc-1", id="tool-1"),
            AIMessage(content="done", id="ai-2"),
        ]

        merged = self.agent.langgraph_default_merge_state(
            {"messages": checkpoint},
            incoming,
            _dummy_input(),
        )

        merged_ids = [getattr(m, "id", None) for m in merged["messages"]]
        self.assertIn("ai-2", merged_ids, "New message should be included")
        self.assertNotIn("tool-1", merged_ids, "Existing tool message should not be re-emitted")


if __name__ == "__main__":
    unittest.main()
