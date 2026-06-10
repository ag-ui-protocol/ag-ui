"""Tests for langgraph_default_merge_state orphan-ToolMessage handling (#1412).

The fix sends repaired replacement ToolMessages in the message update
without mutating checkpoint message objects in place.
"""

import unittest
from copy import deepcopy
from unittest.mock import MagicMock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph.state import CompiledStateGraph

from ag_ui_langgraph import LangGraphAgent
from ag_ui_langgraph import agent as agent_module


def _make_agent():
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    return LangGraphAgent(name="test", graph=graph)


def _orphan_placeholder(tool_name: str, tool_call_id: str) -> str:
    # Must match LangGraphAgent._ORPHAN_TOOL_MSG_RE so the fix path recognises
    # the ToolMessage as an orphan to be repaired.
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


def _message_signature(messages):
    return [
        (
            type(message).__name__,
            getattr(message, "id", None),
            deepcopy(getattr(message, "content", None)),
            deepcopy(getattr(message, "tool_calls", None)),
            getattr(message, "tool_call_id", None),
        )
        for message in messages
    ]


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

        new_messages = result["messages"]
        self.assertEqual([m.id for m in new_messages], ["orphan-1"])
        self.assertIsNot(new_messages[0], orphan)
        self.assertEqual(new_messages[0].content, "the real tool result")
        self.assertEqual(
            orphan.content,
            _orphan_placeholder("my_tool", tool_call_id),
        )

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

        # replaced_agui dropped; repaired orphan, fresh_agui, and ai_new preserved.
        self.assertEqual(
            [m.id for m in result["messages"]],
            ["orphan-1", "agui-fresh", "a-new"],
        )
        self.assertIsNot(result["messages"][0], orphan)
        self.assertEqual(result["messages"][0].content, "real")
        self.assertEqual(orphan.content, _orphan_placeholder("t", replaced_id))

    def test_replaced_orphan_does_not_mutate_checkpoint_message(self):
        agent = _make_agent()
        tool_call_id = "tc-no-mutate"
        orphan = ToolMessage(
            id="orphan-1",
            content=_orphan_placeholder("t", tool_call_id),
            tool_call_id=tool_call_id,
        )
        checkpoint_messages = [
            HumanMessage(id="u-1", content="hi"),
            AIMessage(id="a-1", content="", tool_calls=[
                {"id": tool_call_id, "name": "t", "args": {}},
            ]),
            orphan,
        ]
        state = {"messages": checkpoint_messages}
        agui_tool_msg = ToolMessage(
            id="agui-replaced", content="real", tool_call_id=tool_call_id,
        )
        before_checkpoint = _message_signature(checkpoint_messages)

        result = agent.langgraph_default_merge_state(
            state, [agui_tool_msg], _input(),
        )

        self.assertEqual(before_checkpoint, _message_signature(checkpoint_messages))
        self.assertEqual([m.id for m in result["messages"]], ["orphan-1"])
        self.assertIsNot(result["messages"][0], orphan)
        self.assertEqual(result["messages"][0].content, "real")

    def test_repaired_ai_message_tool_call_args_are_returned_without_mutating_checkpoint(self):
        agent = _make_agent()
        ai_message = AIMessage(
            id="ai-string-args",
            content="",
            tool_calls=[
                {
                    "id": "tc-string-args",
                    "name": "approval",
                    "args": {},
                }
            ],
        )
        ai_message.tool_calls[0]["args"] = '{"approved": false}'  # type: ignore[typeddict-item]
        checkpoint_messages = [
            HumanMessage(id="u-1", content="hi"),
            ai_message,
        ]
        state = {"messages": checkpoint_messages}
        before_checkpoint = _message_signature(checkpoint_messages)

        result = agent.langgraph_default_merge_state(state, [], _input())

        self.assertEqual(before_checkpoint, _message_signature(checkpoint_messages))
        self.assertIsInstance(checkpoint_messages[1].tool_calls[0]["args"], str)
        self.assertEqual(checkpoint_messages[1].tool_calls[0]["args"], '{"approved": false}')
        self.assertEqual([m.id for m in result["messages"]], ["ai-string-args"])
        repaired = result["messages"][0]
        self.assertIsNot(repaired, ai_message)
        self.assertEqual(repaired.tool_calls[0]["args"], {"approved": False})


class TestAIMessageRepairErrors(unittest.TestCase):
    """Tool-call arg JSON parse failures must surface via logger.error and
    must not append a repaired AIMessage to new_messages when nothing was
    successfully parsed — otherwise the checkpoint message is duplicated
    with empty args."""

    def test_unparseable_tool_call_args_log_error_with_tool_call_id_and_excerpt(self):
        agent = _make_agent()
        bad_args = "not json {{" + ("x" * 300)
        ai_message = AIMessage(
            id="ai-bad-args",
            content="",
            tool_calls=[
                {"id": "tc-bad", "name": "approval", "args": {}},
            ],
        )
        ai_message.tool_calls[0]["args"] = bad_args  # type: ignore[typeddict-item]
        checkpoint_messages = [
            HumanMessage(id="u-1", content="hi"),
            ai_message,
        ]
        state = {"messages": checkpoint_messages}
        before_checkpoint = _message_signature(checkpoint_messages)

        with patch.object(agent_module, "logger") as mock_logger:
            result = agent.langgraph_default_merge_state(state, [], _input())

        # Checkpoint signature unchanged — we did not mutate the originals.
        self.assertEqual(before_checkpoint, _message_signature(checkpoint_messages))

        # The repaired AI message is NOT returned because no tool_call was
        # successfully parsed; otherwise we would duplicate the checkpoint
        # message with empty args.
        self.assertEqual(result["messages"], [])

        # logger.error called with the tool_call_id and a bounded excerpt.
        self.assertTrue(mock_logger.error.called, "expected logger.error to be called")
        call_args = mock_logger.error.call_args
        formatted = call_args[0][0] % call_args[0][1:]
        self.assertIn("tc-bad", formatted)
        # The excerpt must be bounded at 200 chars.
        self.assertIn(bad_args[:200], formatted)
        self.assertNotIn(bad_args, formatted)

    def test_mixed_parseable_and_unparseable_tool_calls_returns_repaired_message(self):
        """When at least one tool_call parses successfully, the repaired
        AIMessage is returned with the parsed value plus {} for the failure."""
        agent = _make_agent()
        ai_message = AIMessage(
            id="ai-mixed",
            content="",
            tool_calls=[
                {"id": "tc-good", "name": "t", "args": {}},
                {"id": "tc-bad", "name": "t", "args": {}},
            ],
        )
        ai_message.tool_calls[0]["args"] = '{"approved": true}'  # type: ignore[typeddict-item]
        ai_message.tool_calls[1]["args"] = "not json"  # type: ignore[typeddict-item]
        checkpoint_messages = [
            HumanMessage(id="u-1", content="hi"),
            ai_message,
        ]
        state = {"messages": checkpoint_messages}
        before_checkpoint = _message_signature(checkpoint_messages)

        with patch.object(agent_module, "logger") as mock_logger:
            result = agent.langgraph_default_merge_state(state, [], _input())

        self.assertEqual(before_checkpoint, _message_signature(checkpoint_messages))
        self.assertEqual([m.id for m in result["messages"]], ["ai-mixed"])
        repaired = result["messages"][0]
        self.assertEqual(repaired.tool_calls[0]["args"], {"approved": True})
        self.assertEqual(repaired.tool_calls[1]["args"], {})
        self.assertTrue(mock_logger.error.called)


if __name__ == "__main__":
    unittest.main()
