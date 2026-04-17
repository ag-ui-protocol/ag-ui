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


class TestGetCheckpointBeforeMessageEmptyHistoryBranch(unittest.IsolatedAsyncioTestCase):
    """When the target message lives in the oldest snapshot (idx == 0
    after the chronological reverse) there is no predecessor to hand
    back. The adapter returns a synthetic "empty-before" snapshot with
    ``messages=[]`` rather than raising, so callers can still fork from
    the start. The snapshot returned must not share mutable state with
    the original checkpoint — stomping on the checkpoint's ``messages``
    list would leak across the rest of the run."""

    async def test_idx_zero_returns_snapshot_with_empty_messages(self):
        original_messages = [MagicMock(id="target-msg"), MagicMock(id="trailing")]
        snapshot = MagicMock()
        snapshot.values = {"messages": original_messages, "other": 1}

        agent = make_agent()
        agent.graph.aget_state_history = lambda _cfg: _async_iter([snapshot])

        result = await agent.get_checkpoint_before_message("target-msg", "thread-xyz")

        self.assertIs(result, snapshot)
        self.assertEqual(result.values["messages"], [])

    async def test_idx_zero_does_not_mutate_original_snapshot_values(self):
        """Defensive: the synthetic empty-before must not be carved out of
        the live snapshot by overwriting its ``values["messages"]``. If the
        helper mutates the original snapshot's values dict, downstream
        consumers holding a reference (e.g. the adapter's own state-merge
        path on a subsequent iteration) see an emptied checkpoint. This
        ties directly to the H5 no-mutation invariant added in the
        sibling branch."""
        original_messages = [MagicMock(id="target-msg"), MagicMock(id="trailing")]
        original_values = {"messages": original_messages, "other": 1}

        snapshot = MagicMock()
        snapshot.values = original_values

        agent = make_agent()
        agent.graph.aget_state_history = lambda _cfg: _async_iter([snapshot])

        await agent.get_checkpoint_before_message("target-msg", "thread-xyz")

        # After the call, inspect the ORIGINAL values dict: its messages
        # key must still point at the full list (or the helper must have
        # swapped in a fresh dict on the returned snapshot, leaving this
        # one untouched).
        self.assertEqual(
            [getattr(m, "id", None) for m in original_values["messages"]],
            ["target-msg", "trailing"],
        )


class TestPrepareRegenerateStreamValidation(unittest.IsolatedAsyncioTestCase):
    """``prepare_regenerate_stream`` narrows two Optional fields into the
    stricter types its downstream call chain demands: ``HumanMessage.id``
    and ``RunAgentInput.thread_id``. Both are validated up-front so
    callers see a targeted ValueError rather than an obscure failure in
    ``get_checkpoint_before_message`` or ``aupdate_state``."""

    async def test_raises_when_message_checkpoint_has_no_id(self):
        agent = make_agent()
        run_input = MagicMock()
        run_input.tools = []
        run_input.thread_id = "thread-xyz"
        run_input.forwarded_props = {}
        # HumanMessage with id=None triggers the narrow-guard.
        msg = HumanMessage(content="redo this", id=None)

        with self.assertRaisesRegex(ValueError, "message_checkpoint"):
            await agent.prepare_regenerate_stream(
                input=run_input,
                message_checkpoint=msg,
                config={"configurable": {"thread_id": "thread-xyz"}},
            )

    async def test_raises_when_thread_id_missing(self):
        agent = make_agent()
        run_input = MagicMock()
        run_input.tools = []
        run_input.thread_id = None
        run_input.forwarded_props = {}
        msg = HumanMessage(content="redo this", id="msg-1")

        with self.assertRaisesRegex(ValueError, "thread_id"):
            await agent.prepare_regenerate_stream(
                input=run_input,
                message_checkpoint=msg,
                config={"configurable": {}},
            )


class TestGetStateSnapshotSchemaKeysSafety(unittest.TestCase):
    """``get_state_snapshot`` runs against ``active_run["schema_keys"]``
    via ``.get("schema_keys")``. The fallback path in ``get_schema_keys``
    can race with a caller that reads the snapshot before schema
    introspection has populated it, and legitimate callers (tests,
    custom wrappers) may never set it at all. In both cases the helper
    must not blow up; it returns the state unfiltered."""

    def _make_agent_with_active_run(self, active_run):
        agent = make_agent()
        agent.active_run = active_run
        return agent

    def test_schema_keys_missing_returns_state_unfiltered(self):
        """active_run has no ``schema_keys`` entry at all."""
        agent = self._make_agent_with_active_run({"id": "run-1"})
        state = {"messages": ["m"], "custom_key": "keep"}
        result = agent.get_state_snapshot(state)
        self.assertEqual(result, state)

    def test_schema_keys_none_returns_state_unfiltered(self):
        """active_run explicitly sets ``schema_keys`` to ``None``."""
        agent = self._make_agent_with_active_run({"id": "run-1", "schema_keys": None})
        state = {"messages": ["m"], "custom_key": "keep"}
        result = agent.get_state_snapshot(state)
        self.assertEqual(result, state)

    def test_schema_keys_present_but_output_none_returns_state_unfiltered(self):
        """``schema_keys`` dict is present but ``output`` is None."""
        agent = self._make_agent_with_active_run(
            {"id": "run-1", "schema_keys": {"output": None}}
        )
        state = {"messages": ["m"], "custom_key": "keep"}
        result = agent.get_state_snapshot(state)
        self.assertEqual(result, state)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
