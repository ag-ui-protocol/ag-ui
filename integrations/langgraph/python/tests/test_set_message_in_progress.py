"""Regression test for GitHub issue #702.

When ``messages_in_process[run_id]`` is explicitly set to ``None``
(which happens in several places during the stream lifecycle), a
subsequent call to ``set_message_in_progress`` must NOT crash with
``TypeError: argument of type 'NoneType' is not iterable``.

The fix is the ``or {}`` guard in ``set_message_in_progress``.
"""

import unittest

from tests._helpers import make_agent


class TestSetMessageInProgressNoneGuard(unittest.TestCase):
    """Issue #702 — set_message_in_progress tolerates None entries."""

    def test_none_value_does_not_crash(self):
        """When messages_in_process[run_id] is None, calling
        set_message_in_progress must succeed and store the new data."""
        agent = make_agent()
        run_id = "run-abc"

        # Simulate the state that causes the crash: the stream lifecycle
        # sets messages_in_process[run_id] = None in multiple places
        # (e.g. after OnChatModelEnd, after OnToolEnd, etc.).
        agent.messages_in_process[run_id] = None

        # This must NOT raise TypeError
        agent.set_message_in_progress(run_id, {"content": "hello"})

        result = agent.get_message_in_progress(run_id)
        self.assertEqual(result, {"content": "hello"})

    def test_missing_key_works(self):
        """A run_id never seen before should also work (returns {})."""
        agent = make_agent()
        agent.set_message_in_progress("new-run", {"role": "assistant"})
        self.assertEqual(
            agent.get_message_in_progress("new-run"),
            {"role": "assistant"},
        )

    def test_existing_value_is_merged(self):
        """Normal case: existing dict is merged with new data."""
        agent = make_agent()
        run_id = "run-merge"
        agent.messages_in_process[run_id] = {"content": "hi"}

        agent.set_message_in_progress(run_id, {"role": "assistant"})

        self.assertEqual(
            agent.get_message_in_progress(run_id),
            {"content": "hi", "role": "assistant"},
        )
