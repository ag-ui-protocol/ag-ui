"""Tests for langgraph_default_merge_state orphan-ToolMessage handling (#1412).

The fix preserves in-place content replacements on existing orphan
ToolMessages by excluding the AG-UI duplicate from the new_messages list.
Before the fix, `{"messages": new_messages}` would overwrite state["messages"]
with a copy that still contained the orphan placeholder text.
"""

import unittest
from unittest.mock import MagicMock

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph.state import CompiledStateGraph

from ag_ui_langgraph import LangGraphAgent


def _make_agent():
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    return LangGraphAgent(name="test", graph=graph)


def _orphan_placeholder(tool_name: str, tool_call_id: str) -> str:
    # Must match LangGraphAgent._ORPHAN_TOOL_MSG_RE so the fix path recognises
    # the ToolMessage as an orphan to be repaired in-place.
    return (
        f"Tool call '{tool_name}' with id '{tool_call_id}' "
        f"was interrupted before completion."
    )


def _input(tools=None):
    # RunAgentInput is read only for `.tools` in this code path; a MagicMock
    # with an explicit attribute is sufficient and keeps the test independent
    # of the ag_ui.core schema.
    input_mock = MagicMock()
    input_mock.tools = tools or []
    return input_mock


class TestOrphanToolMessageMerge(unittest.TestCase):
    def test_replaced_orphan_is_not_duplicated_in_new_messages(self):
        """The regression: AG-UI ToolMessage whose content was patched into an
        existing orphan must not also be appended to new_messages."""
        agent = _make_agent()
        tool_call_id = "tc-1"
        orphan = ToolMessage(
            id="orphan-1",
            content=_orphan_placeholder("my_tool", tool_call_id),
            tool_call_id=tool_call_id,
        )
        state = {
            "messages": [
                HumanMessage(id="u-1", content="hi"),
                AIMessage(id="a-1", content="", tool_calls=[
                    {"id": tool_call_id, "name": "my_tool", "args": {}},
                ]),
                orphan,
            ],
        }
        agui_tool_msg = ToolMessage(
            id="agui-tool-1",
            content="the real tool result",
            tool_call_id=tool_call_id,
        )

        result = agent.langgraph_default_merge_state(
            state, [agui_tool_msg], _input(),
        )

        # Orphan content was patched in place on the existing message.
        self.assertEqual(orphan.content, "the real tool result")
        # And the AG-UI ToolMessage was NOT re-added.
        new_messages = result["messages"]
        self.assertEqual(new_messages, [])

    def test_tool_message_without_matching_orphan_is_still_added(self):
        """If no orphan exists for a tool_call_id, the AG-UI ToolMessage must
        still flow into new_messages — the fix's exclusion is narrow."""
        agent = _make_agent()
        state = {
            "messages": [HumanMessage(id="u-1", content="hi")],
        }
        tool_msg = ToolMessage(
            id="agui-tool-2",
            content="fresh tool result",
            tool_call_id="tc-unmatched",
        )

        result = agent.langgraph_default_merge_state(
            state, [tool_msg], _input(),
        )

        self.assertEqual(len(result["messages"]), 1)
        self.assertIs(result["messages"][0], tool_msg)

    def test_non_tool_messages_flow_through_unaffected(self):
        """The new ToolMessage-specific exclusion must not affect AIMessage /
        HumanMessage deduplication, which is still purely id-based."""
        agent = _make_agent()
        state = {"messages": [HumanMessage(id="u-1", content="existing")]}
        ai_new = AIMessage(id="a-new", content="reply")
        human_dup = HumanMessage(id="u-1", content="existing")  # id collision

        result = agent.langgraph_default_merge_state(
            state, [ai_new, human_dup], _input(),
        )

        # ai_new passes; human_dup is dropped by the existing id-dedup check.
        self.assertEqual([m.id for m in result["messages"]], ["a-new"])

    def test_mixed_batch_only_excludes_replaced_tool_message(self):
        """When AG-UI sends both a replaced-orphan ToolMessage and unrelated
        messages, only the replaced one is dropped."""
        agent = _make_agent()
        replaced_id = "tc-replaced"
        orphan = ToolMessage(
            id="orphan-1",
            content=_orphan_placeholder("t", replaced_id),
            tool_call_id=replaced_id,
        )
        state = {
            "messages": [
                HumanMessage(id="u-1", content="hi"),
                AIMessage(id="a-1", content="", tool_calls=[
                    {"id": replaced_id, "name": "t", "args": {}},
                ]),
                orphan,
            ],
        }
        replaced_agui = ToolMessage(
            id="agui-replaced", content="real", tool_call_id=replaced_id,
        )
        fresh_agui = ToolMessage(
            id="agui-fresh", content="other", tool_call_id="tc-other",
        )
        ai_new = AIMessage(id="a-new", content="followup")

        result = agent.langgraph_default_merge_state(
            state, [replaced_agui, fresh_agui, ai_new], _input(),
        )

        # replaced_agui dropped; fresh_agui and ai_new preserved, order kept.
        self.assertEqual(
            [m.id for m in result["messages"]],
            ["agui-fresh", "a-new"],
        )
        self.assertEqual(orphan.content, "real")


if __name__ == "__main__":
    unittest.main()
