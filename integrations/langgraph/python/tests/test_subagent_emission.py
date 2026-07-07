import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    SubagentStartedEvent,
)
from ag_ui_langgraph.agent import LangGraphAgent, derive_subagent_context, reconcile_subagents


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


def _run():
    return {"active_subagents": {}, "current_subagent_id": None}


class TestReconcileSubagents(unittest.TestCase):
    def test_enter_emits_started(self):
        ar = _run()
        evs = reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_STARTED])
        self.assertEqual(evs[0].subagent_id, "tools:s1")
        self.assertEqual(evs[0].name, "researcher")
        self.assertEqual(ar["current_subagent_id"], "tools:s1")

    def test_stay_emits_nothing(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        evs = reconcile_subagents(ar, "tools:s1|model:y", "researcher", set())
        self.assertEqual(evs, [])

    def test_exit_to_root_emits_finished(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        evs = reconcile_subagents(ar, "model:root", None, set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_FINISHED])
        self.assertEqual(evs[0].subagent_id, "tools:s1")
        self.assertIsNone(ar["current_subagent_id"])

    def test_switch_subagents_finishes_then_starts(self):
        ar = _run()
        reconcile_subagents(ar, "tools:s1|model:x", "researcher", set())
        evs = reconcile_subagents(ar, "tools:s2|model:y", "writer", set())
        self.assertEqual([e.type for e in evs], [EventType.SUBAGENT_FINISHED, EventType.SUBAGENT_STARTED])

    def test_root_only_emits_nothing(self):
        ar = _run()
        self.assertEqual(reconcile_subagents(ar, "model:root", None, set()), [])


def _make_agent():
    from langgraph.graph.state import CompiledStateGraph
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    initial_state = MagicMock()
    initial_state.values = {"messages": [], "copilotkit": {}}
    initial_state.tasks = []
    initial_state.next = []
    initial_state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=initial_state)
    return LangGraphAgent(name="test", graph=graph)


class TestDispatchStamping(unittest.TestCase):
    def _agent(self, current_subagent_id):
        agent = _make_agent()
        agent.active_run = {"current_subagent_id": current_subagent_id, "active_subagents": {}}
        return agent

    def test_stamps_creation_event_when_in_subagent(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1")
        )
        self.assertEqual(ev.subagent_id, "tools:s1")

    def test_does_not_stamp_when_not_in_subagent(self):
        agent = self._agent(None)
        ev = agent._dispatch_event(
            TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1")
        )
        self.assertIsNone(ev.subagent_id)

    def test_does_not_overwrite_existing_subagent_id(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id="m1", subagent_id="orig"
            )
        )
        self.assertEqual(ev.subagent_id, "orig")

    def test_does_not_stamp_continuation_event(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id="m1", delta="x")
        )
        # continuation events have no subagent_id field / must not be stamped
        self.assertIsNone(getattr(ev, "subagent_id", None))

    def test_does_not_stamp_subagent_lifecycle_event(self):
        agent = self._agent("tools:s1")
        ev = agent._dispatch_event(
            SubagentStartedEvent(type=EventType.SUBAGENT_STARTED, subagent_id="tools:s1", name="r")
        )
        self.assertEqual(ev.subagent_id, "tools:s1")  # its own id, unchanged (not re-stamped by chokepoint logic)
