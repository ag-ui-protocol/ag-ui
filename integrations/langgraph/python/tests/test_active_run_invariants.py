"""Tests for the ``active_run is None`` invariant on stream-path methods.

Every method that reads ``self.active_run`` requires a live run to be in
flight. Calling these methods outside of an active run is a programmer
error — the refactored adapter raises ``RuntimeError`` explicitly with a
message naming the method, rather than relying on ``assert`` (which is
stripped under ``python -O``) or deferring to an opaque ``AttributeError``
from ``None.get(...)``.

These tests pin the invariant for every entry point that touches
``self.active_run``:

    prepare_stream
    get_state_snapshot
    _handle_single_event
    handle_reasoning_event
    handle_node_change
    end_step
    get_state_and_messages_snapshots

Any new stream-path method that reads ``self.active_run`` should grow a
matching test here.
"""

import unittest
from unittest.mock import MagicMock

from tests._helpers import make_agent


class TestActiveRunInvariantRaises(unittest.IsolatedAsyncioTestCase):
    """Call each method with ``active_run = None`` and assert it raises
    ``RuntimeError``. After the sibling refactor lands the message will
    identify the method by name; these tests only pin the type so they
    are robust to wording changes."""

    def setUp(self):
        self.agent = make_agent()
        self.agent.active_run = None

    async def test_prepare_stream_raises(self):
        with self.assertRaises(RuntimeError):
            await self.agent.prepare_stream(
                MagicMock(),
                MagicMock(values={"messages": []}, tasks=[]),
                {"configurable": {"thread_id": "t1"}},
            )

    def test_get_state_snapshot_raises(self):
        with self.assertRaises(RuntimeError):
            self.agent.get_state_snapshot({"messages": []})

    async def test_handle_single_event_raises(self):
        # _handle_single_event is an async generator; the invariant must
        # fire on first ``asend``/iteration, not be deferred behind the
        # generator protocol.
        with self.assertRaises(RuntimeError):
            async for _ in self.agent._handle_single_event(
                {"event": "on_chat_model_start", "data": {}, "metadata": {}},
                {"messages": []},
            ):
                pass

    def test_handle_reasoning_event_raises(self):
        # sync generator — drain it to trigger the guard.
        with self.assertRaises(RuntimeError):
            for _ in self.agent.handle_reasoning_event(
                {"type": "thinking", "text": "x", "index": 0}
            ):
                pass

    def test_handle_node_change_raises(self):
        # sync generator — drain it to trigger the guard.
        with self.assertRaises(RuntimeError):
            for _ in self.agent.handle_node_change("some_node"):
                pass

    def test_end_step_raises(self):
        with self.assertRaises(RuntimeError):
            self.agent.end_step()

    async def test_get_state_and_messages_snapshots_raises(self):
        # async generator — drain it to trigger the guard.
        with self.assertRaises(RuntimeError):
            async for _ in self.agent.get_state_and_messages_snapshots(
                {"configurable": {"thread_id": "t1"}}
            ):
                pass


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
