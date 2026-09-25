"""Parallel task identities must share a single public step per name."""

import unittest

from .test_agui_transformer import Harness, requires_stream_api


@requires_stream_api
class TestParallelSteps(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.h.process("values", {"namespace": [], "data": {"count": 0}})

    def task(self, task_id, name, *, parent=None, done=False):
        self.h.process("tasks", {
            "namespace": [parent] if parent else [],
            "data": {"id": task_id, "name": name,
                     **({"result": {}} if done else {"input": {"count": 0}})},
        })

    def steps(self, name):
        return [event["type"] for event in self.h.wire_events
                if event.get("stepName") == name]

    def assert_balanced(self):
        active = set()
        for event in self.h.wire_events:
            name = event.get("stepName")
            if event["type"] == "STEP_STARTED":
                self.assertNotIn(name, active)
                active.add(name)
            elif event["type"] == "STEP_FINISHED":
                self.assertIn(name, active)
                active.remove(name)
        self.assertEqual(set(), active)

    def test_parallel_send_siblings_close_only_after_last_completion(self):
        self.task("parent", "outer")
        self.task("a", "worker", parent="outer:parent")
        self.task("b", "worker", parent="outer:parent")
        self.task("a", "worker", parent="outer:parent", done=True)
        self.assertEqual(["STEP_STARTED"], self.steps("worker"))
        self.task("b", "worker", parent="outer:parent", done=True)
        self.assertEqual(["STEP_STARTED", "STEP_FINISHED"], self.steps("worker"))
        self.task("parent", "outer", done=True)
        self.h.transformer.finalize()
        self.assert_balanced()

    def test_workers_in_parallel_subgraphs_share_public_name(self):
        self.task("left", "left_graph")
        self.task("right", "right_graph")
        self.task("a", "worker", parent="left_graph:left")
        self.task("b", "worker", parent="right_graph:right")
        self.task("a", "worker", parent="left_graph:left", done=True)
        self.assertEqual(["STEP_STARTED"], self.steps("worker"))
        self.task("b", "worker", parent="right_graph:right", done=True)
        self.h.transformer.finalize()
        self.assertEqual(["STEP_STARTED", "STEP_FINISHED"], self.steps("worker"))
        self.assert_balanced()

    def test_root_completion_cannot_close_same_named_nested_worker(self):
        self.task("root", "worker")
        self.task("parent", "outer")
        self.task("child", "worker", parent="outer:parent")
        self.task("root", "worker", done=True)
        # Starting another root task flushes the root's pending step finish.
        self.task("next", "other")
        self.assertEqual(["STEP_STARTED"], self.steps("worker"))
        self.task("child", "worker", parent="outer:parent", done=True)
        self.h.transformer.finalize()
        self.assertEqual(["STEP_STARTED", "STEP_FINISHED"], self.steps("worker"))
        self.assert_balanced()

    def test_same_named_parent_and_child_still_have_balanced_boundaries(self):
        self.task("parent", "worker")
        self.task("child", "worker", parent="worker:parent")
        self.task("child", "worker", parent="worker:parent", done=True)
        self.task("parent", "worker", done=True)
        self.h.transformer.finalize()
        self.assert_balanced()

    def test_failure_closes_all_parallel_owners_once(self):
        self.task("parent", "outer")
        self.task("a", "worker", parent="outer:parent")
        self.task("b", "worker", parent="outer:parent")
        self.h.transformer.fail(RuntimeError("failed while workers were active"))
        self.assertEqual(["STEP_STARTED", "STEP_FINISHED"], self.steps("worker"))
        self.assert_balanced()
