import unittest

from ag_ui_langgraph.agent import derive_subagent_context


class TestDeriveSubagentContext(unittest.TestCase):
    def test_none_for_root_or_missing_signals(self):
        # single-segment ns, no lc_agent_name -> not a subagent
        self.assertIsNone(derive_subagent_context("model:root-uuid", None, set()))
        # nested ns but no lc_agent_name (e.g. a declared subgraph) -> not a subagent
        self.assertIsNone(derive_subagent_context("tools:x|model:y", None, set()))
        # empty ns -> not a subagent
        self.assertIsNone(derive_subagent_context("", "researcher", set()))

    def test_nested_ns_with_agent_name_is_subagent(self):
        ns = "tools:e6df-uuid|model:inner-uuid"
        ctx = derive_subagent_context(ns, "researcher", set())
        self.assertIsNotNone(ctx)
        self.assertEqual(ctx.name, "researcher")
        self.assertEqual(ctx.subagent_id, "tools:e6df-uuid")  # leading segment, stable
        self.assertIsNone(ctx.parent_subagent_id)

    def test_stable_id_across_calls(self):
        ns = "tools:e6df-uuid|model:inner-uuid"
        a = derive_subagent_context(ns, "researcher", set())
        b = derive_subagent_context(ns, "researcher", set())
        self.assertEqual(a.subagent_id, b.subagent_id)

    def test_declared_subgraph_excluded(self):
        # if the ns root is a declared subgraph, it's handled by existing subgraph
        # logic, not treated as a deepagents subagent
        ns = "flights:sg-uuid|model:inner"
        self.assertIsNone(derive_subagent_context(ns, "researcher", {"flights"}))
