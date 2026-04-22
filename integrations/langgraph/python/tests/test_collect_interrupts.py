"""Tests for collect_interrupts — the parallel-task interrupt helper (#1409).

The regression: historical code read ``tasks[0].interrupts`` and discarded
any interrupt on ``tasks[1]`` or later. collect_interrupts must iterate
every task so parallel-tool-call interrupts are never silently lost.
"""

import unittest
from types import SimpleNamespace

from ag_ui_langgraph.agent import collect_interrupts


def _task(*interrupts):
    """A stand-in for PregelTask — only ``.interrupts`` is read."""
    return SimpleNamespace(interrupts=list(interrupts))


class TestCollectInterrupts(unittest.TestCase):
    def test_returns_empty_list_for_none(self):
        self.assertEqual(collect_interrupts(None), [])

    def test_returns_empty_list_for_empty_tasks(self):
        self.assertEqual(collect_interrupts([]), [])

    def test_returns_empty_when_no_task_has_interrupts(self):
        self.assertEqual(collect_interrupts([_task(), _task()]), [])

    def test_collects_interrupts_from_first_task(self):
        self.assertEqual(
            collect_interrupts([_task("a"), _task()]),
            ["a"],
        )

    def test_collects_interrupts_from_a_later_task(self):
        """The #1409 regression: old code only looked at tasks[0]."""
        self.assertEqual(
            collect_interrupts([_task(), _task("b"), _task()]),
            ["b"],
        )

    def test_collects_interrupts_across_every_task_in_order(self):
        self.assertEqual(
            collect_interrupts([
                _task("a", "b"),
                _task(),
                _task("c"),
            ]),
            ["a", "b", "c"],
        )


if __name__ == "__main__":
    unittest.main()
