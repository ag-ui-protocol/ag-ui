"""Tests for LangGraphAgent.get_checkpoint_before_message().

The function walks the graph's state history for a thread to find the
snapshot immediately preceding a given message. Invariants pinned by
these tests: the RunnableConfig handed to ``aget_state_history`` always
carries ``configurable.thread_id``, additional configurable keys
provided by the caller survive the merge, and the caller's ``thread_id``
argument is authoritative over any value in the supplied config.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import HumanMessage

from ag_ui_langgraph.agent import LangGraphAgent

from tests._helpers import make_agent


async def _async_iter(items):
    """Async generator yielding *items* for mocking ``aget_state_history``
    which the adapter iterates via ``async for``. Call directly — the
    returned object is the iterable, no zero-arg invocation required."""
    for item in items:
        yield item


class TestGetCheckpointBeforeMessage(unittest.IsolatedAsyncioTestCase):
    """Verify history_config construction in get_checkpoint_before_message."""

    async def test_missing_thread_id_raises(self):
        """An empty ``thread_id`` fails fast rather than silently skipping."""
        agent = make_agent()
        with self.assertRaisesRegex(ValueError, "thread_id"):
            await agent.get_checkpoint_before_message("msg-1", "")

    async def test_passes_thread_id_in_configurable(self):
        """Without a caller config, ``aget_state_history`` still receives
        a RunnableConfig carrying the ``thread_id`` under ``configurable``."""
        agent = make_agent()
        captured = {}

        def _capture(history_config):
            captured["config"] = history_config
            return _async_iter([])

        agent.graph.aget_state_history = _capture

        with self.assertRaises(ValueError):
            # Empty history => "Message ID not found in history"
            await agent.get_checkpoint_before_message("msg-1", "thread-xyz")

        self.assertIn("configurable", captured["config"])
        self.assertEqual(captured["config"]["configurable"]["thread_id"], "thread-xyz")

    async def test_merges_caller_config_preserving_configurable(self):
        """When the caller provides a RunnableConfig, extra configurable
        keys (checkpoint namespace, subgraph selector, etc.) are preserved
        and ``thread_id`` is authoritative from the argument, not the
        caller's config."""
        agent = make_agent()
        captured = {}

        def _capture(history_config):
            captured["config"] = history_config
            return _async_iter([])

        agent.graph.aget_state_history = _capture

        caller_config = {
            "configurable": {
                "thread_id": "stale-thread-from-caller",
                "checkpoint_ns": "ns-1",
            },
            "tags": ["a-tag"],
        }

        with self.assertRaises(ValueError):
            await agent.get_checkpoint_before_message(
                "msg-1", "thread-xyz", caller_config
            )

        cfg = captured["config"]
        self.assertEqual(cfg["configurable"]["thread_id"], "thread-xyz")
        self.assertEqual(cfg["configurable"]["checkpoint_ns"], "ns-1")
        self.assertEqual(cfg["tags"], ["a-tag"])

    async def test_returns_previous_snapshot(self):
        """When the target message lives in the second snapshot, the
        snapshot returned is the one immediately before it, with the
        next-snapshot values (minus ``messages``) merged in."""
        agent = make_agent()

        prev_snapshot = MagicMock()
        prev_snapshot.values = {"messages": [MagicMock(id="older")], "foo": 1}
        prev_snapshot._replace = MagicMock(return_value="merged-checkpoint")

        target_snapshot = MagicMock()
        target_snapshot.values = {
            "messages": [MagicMock(id="target-msg")],
            "bar": 2,
        }

        # aget_state_history yields newest-first; the adapter reverses
        # internally to walk chronologically.
        agent.graph.aget_state_history = lambda _cfg: _async_iter(
            [target_snapshot, prev_snapshot]
        )

        result = await agent.get_checkpoint_before_message(
            "target-msg", "thread-xyz"
        )

        self.assertEqual(result, "merged-checkpoint")
        prev_snapshot._replace.assert_called_once()
        merged_values = prev_snapshot._replace.call_args.kwargs["values"]
        self.assertEqual(merged_values["foo"], 1)
        self.assertEqual(merged_values["bar"], 2)
        # Messages must come from the PREVIOUS snapshot, not be clobbered by
        # the target's messages during the merge.
        self.assertEqual([m.id for m in merged_values["messages"]], ["older"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
