"""
Tests for subgraph streaming: detection, ordering fix, and snapshot dispatch.

The bug: when a subgraph (e.g. hotels_agent) commits a message mid-stream,
the client only sees it in the final MESSAGES_SNAPSHOT — by which point
supervisor/experiences TEXT_MESSAGE events have already arrived, so hotels_msg
gets appended *after* them (wrong order).

The fix: every time current_subgraph changes, get_state_and_messages_snapshots
is called, fetching the fresh checkpoint and dispatching STATE_SNAPSHOT +
MESSAGES_SNAPSHOT before any subsequent TEXT_MESSAGE events arrive.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph.state import CompiledStateGraph

from ag_ui_langgraph.agent import LangGraphAgent, ROOT_SUBGRAPH_NAME
from ag_ui.core import EventType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_agent(subgraph_names=None):
    """Return a LangGraphAgent with mocked CompiledStateGraph subgraph nodes."""
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    nodes = {}
    for name in (subgraph_names or []):
        node = MagicMock()
        node.bound = MagicMock(spec=CompiledStateGraph)
        nodes[name] = node
    graph.nodes = nodes
    return LangGraphAgent(name="test", graph=graph)


def _event_types(events):
    """Extract EventType string values from a list of dispatched event objects."""
    types = []
    for ev in events:
        t = getattr(ev, "type", None)
        if t is not None:
            types.append(t.value if hasattr(t, "value") else str(t))
    return types


def _ns_root(ns):
    """Mirror the ns_root extraction logic from agent.py."""
    return ns.split("|")[0].split(":")[0] if ns else ""


# ---------------------------------------------------------------------------
# NS parsing
# ---------------------------------------------------------------------------

class TestNsRootExtraction(unittest.TestCase):
    def test_empty_ns(self):
        self.assertEqual(_ns_root(""), "")

    def test_root_level_supervisor(self):
        self.assertEqual(_ns_root("supervisor:cf4865ae"), "supervisor")

    def test_subgraph_boundary(self):
        self.assertEqual(_ns_root("flights_agent:17b1922c"), "flights_agent")

    def test_inside_subgraph(self):
        self.assertEqual(
            _ns_root("flights_agent:17b1922c|flights_agent_chat_node:0a492c87"),
            "flights_agent",
        )

    def test_deeply_nested(self):
        self.assertEqual(_ns_root("outer:aaa|inner:bbb|deepest:ccc"), "outer")


# ---------------------------------------------------------------------------
# Subgraph detection
# ---------------------------------------------------------------------------

class TestSubgraphDetection(unittest.TestCase):
    def setUp(self):
        self.agent = _make_agent(["flights_agent", "hotels_agent"])

    def _resolve(self, ns):
        root = _ns_root(ns)
        return root if root in self.agent.subgraphs else ROOT_SUBGRAPH_NAME

    def test_supervisor_is_root(self):
        self.assertEqual(self._resolve("supervisor:abc"), ROOT_SUBGRAPH_NAME)

    def test_flights_boundary_is_subgraph(self):
        self.assertEqual(self._resolve("flights_agent:abc"), "flights_agent")

    def test_inside_flights_is_subgraph(self):
        self.assertEqual(self._resolve("flights_agent:abc|node:xyz"), "flights_agent")

    def test_empty_ns_is_root(self):
        self.assertEqual(self._resolve(""), ROOT_SUBGRAPH_NAME)

    def test_unknown_node_is_root(self):
        # experiences_agent not registered in subgraphs → root
        self.assertEqual(self._resolve("experiences_agent:abc"), ROOT_SUBGRAPH_NAME)


# ---------------------------------------------------------------------------
# get_state_and_messages_snapshots
# ---------------------------------------------------------------------------

class TestGetStateAndMessagesSnapshots(unittest.IsolatedAsyncioTestCase):

    def _make_agent(self, checkpoint_messages, streamed_messages=None):
        agent = _make_agent(["hotels_agent"])
        agent.active_run = {"id": "run-1", "streamed_messages": streamed_messages or []}
        agent.dispatched = []
        agent._dispatch_event = lambda ev: agent.dispatched.append(ev) or ev
        agent.get_state_snapshot = MagicMock(return_value={})
        state = MagicMock()
        state.values = {"messages": checkpoint_messages}
        agent.graph.aget_state = AsyncMock(return_value=state)
        return agent

    async def test_dispatches_state_snapshot(self):
        agent = self._make_agent([HumanMessage(content="hi", id="u1")])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        self.assertIn("STATE_SNAPSHOT", _event_types(agent.dispatched))

    async def test_dispatches_messages_snapshot(self):
        agent = self._make_agent([HumanMessage(content="hi", id="u1")])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        self.assertIn("MESSAGES_SNAPSHOT", _event_types(agent.dispatched))

    async def test_hotels_message_in_checkpoint_at_correct_position(self):
        """Hotels msg in checkpoint must appear before experiences msg."""
        user = HumanMessage(content="AMS to SF", id="u1")
        flights = AIMessage(content="Booked KLM", id="f1")
        hotels = AIMessage(content="Booked Hotel Zoe", id="h1")
        agent = self._make_agent([user, flights, hotels])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        snap = next(e for e in agent.dispatched if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT)
        ids = [m.id for m in snap.messages]
        self.assertIn("h1", ids)
        self.assertLess(ids.index("f1"), ids.index("h1"))

    async def test_uncommitted_streamed_message_appended_after_checkpoint(self):
        """Uncommitted streamed messages (e.g. supervisor routing) go after checkpoint."""
        user = HumanMessage(content="hi", id="u1")
        flights = AIMessage(content="Booked KLM", id="f1")
        supervisor_routing = AIMessage(content="routing", id="sup1")
        agent = self._make_agent([user, flights], streamed_messages=[supervisor_routing])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        snap = next(e for e in agent.dispatched if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT)
        ids = [m.id for m in snap.messages]
        self.assertIn("sup1", ids)
        self.assertGreater(ids.index("sup1"), ids.index("f1"))

    async def test_streamed_message_already_in_checkpoint_not_duplicated(self):
        """A streamed message whose ID is already in the checkpoint appears only once."""
        user = HumanMessage(content="hi", id="u1")
        exp = AIMessage(content="activities", id="exp1")
        agent = self._make_agent([user, exp], streamed_messages=[exp])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        snap = next(e for e in agent.dispatched if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT)
        self.assertEqual([m.id for m in snap.messages].count("exp1"), 1)


# ---------------------------------------------------------------------------
# Subgraph change triggers mid-stream snapshot
# ---------------------------------------------------------------------------

class TestSubgraphChangeTrigger(unittest.IsolatedAsyncioTestCase):

    async def _drive(self, agent, stream_chunks):
        """Drive _handle_stream_events with synthetic chunks; return dispatched events."""
        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "thread-1"
        run_input.messages = []
        run_input.forwarded_props = {}

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }
            async def gen():
                for c in stream_chunks:
                    yield c
            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "thread-1"}},
            }

        user = HumanMessage(content="AMS to SF", id="u1")
        flights = AIMessage(content="Booked KLM", id="f1")
        hotels = AIMessage(content="Booked Hotel Zoe", id="h1")
        final_state = MagicMock()
        final_state.values = {"messages": [user, flights, hotels]}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=final_state)
        agent.prepare_stream = fake_prepare

        collected = []
        async for ev in agent._handle_stream_events(run_input):
            collected.append(ev)
        return collected

    def _hotels_to_root_chunks(self):
        return [
            {
                "event": "on_chain_start",
                "name": "hotels_agent",
                "data": {},
                "metadata": {"langgraph_node": "hotels_agent",
                              "langgraph_checkpoint_ns": "hotels_agent:abc"},
                "run_id": "run-1",
            },
            {
                "event": "on_chain_end",
                "name": "hotels_agent",
                "data": {"output": {}},
                "metadata": {"langgraph_node": "supervisor",
                              "langgraph_checkpoint_ns": "supervisor:def"},
                "run_id": "run-1",
            },
        ]

    async def test_messages_snapshot_fires_on_subgraph_to_root_transition(self):
        """hotels_agent → root transition must fire at least one MESSAGES_SNAPSHOT."""
        agent = _make_agent(["hotels_agent"])
        events = await self._drive(agent, self._hotels_to_root_chunks())
        self.assertGreaterEqual(_event_types(events).count("MESSAGES_SNAPSHOT"), 1)

    async def test_hotels_message_in_mid_stream_snapshot_before_experiences(self):
        """
        Core regression: the mid-stream snapshot fired on subgraph→root must contain
        hotels_msg at its checkpoint position (before any experiences messages).
        """
        agent = _make_agent(["hotels_agent"])
        events = await self._drive(agent, self._hotels_to_root_chunks())
        snapshots = [e for e in events if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT]
        self.assertGreaterEqual(len(snapshots), 1)
        first = snapshots[0]
        ids = [m.id for m in first.messages]
        self.assertIn("h1", ids)
        if "f1" in ids:
            self.assertLess(ids.index("f1"), ids.index("h1"))


# ---------------------------------------------------------------------------
# aget_state throwing mid-stream
# ---------------------------------------------------------------------------

class TestAgetStateMidStreamError(unittest.IsolatedAsyncioTestCase):
    """aget_state is now called on every subgraph transition (hot path).
    An exception there must propagate out — not be silently swallowed."""

    async def test_aget_state_error_propagates(self):
        agent = _make_agent(["hotels_agent"])

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "thread-1"
        run_input.messages = []
        run_input.forwarded_props = {}

        initial_state = MagicMock()
        initial_state.values = {"messages": []}
        initial_state.tasks = []

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                # This chunk puts us inside hotels_agent (ns_root in subgraphs),
                # triggering the subgraph-change branch and get_state_and_messages_snapshots.
                yield {
                    "event": "on_chain_start",
                    "name": "hotels_agent",
                    "data": {},
                    "metadata": {
                        "langgraph_node": "hotels_agent",
                        "langgraph_checkpoint_ns": "hotels_agent:abc",
                    },
                    "run_id": "run-1",
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "thread-1"}},
            }

        agent.prepare_stream = fake_prepare
        # Call 1 (before stream, line ~180) succeeds.
        # Call 2 (mid-stream, inside get_state_and_messages_snapshots) raises.
        agent.graph.aget_state = AsyncMock(side_effect=[
            initial_state,
            RuntimeError("checkpoint unavailable"),
        ])

        with self.assertRaises(RuntimeError):
            async for _ in agent._handle_stream_events(run_input):
                pass


# ---------------------------------------------------------------------------
# stream_subgraphs: False gating
# ---------------------------------------------------------------------------

class TestStreamSubgraphsGating(unittest.IsolatedAsyncioTestCase):
    """stream_subgraphs: False must gate legacy 'events*'/'values*' events from
    triggering is_subgraph_stream=True and hence the mid-stream snapshot."""

    async def _drive(self, agent, chunks, stream_subgraphs):
        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "thread-1"
        run_input.messages = []
        run_input.forwarded_props = {"stream_subgraphs": stream_subgraphs}

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                for c in chunks:
                    yield c

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "thread-1"}},
            }

        final_state = MagicMock()
        final_state.values = {"messages": []}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=final_state)
        agent.prepare_stream = fake_prepare

        collected = []
        async for ev in agent._handle_stream_events(run_input):
            collected.append(ev)
        return collected

    def _legacy_subgraph_chunk(self):
        """LangGraph < 0.6 style: event type starts with 'events' (not 'on_*')."""
        return {
            "event": "events",
            "name": "hotels_agent",
            "data": {"event": {"event": "on_chain_stream", "data": {}}},
            "metadata": {"langgraph_node": "hotels_agent", "langgraph_checkpoint_ns": ""},
            "run_id": "run-1",
        }

    async def test_legacy_events_do_not_trigger_snapshot_when_disabled(self):
        """With stream_subgraphs=False the legacy 'events' chunk must not set
        is_subgraph_stream=True, so no mid-stream snapshot fires.  Only the
        single end-of-run MESSAGES_SNAPSHOT should be present."""
        agent = _make_agent(["hotels_agent"])
        events = await self._drive(agent, [self._legacy_subgraph_chunk()], stream_subgraphs=False)
        self.assertEqual(_event_types(events).count("MESSAGES_SNAPSHOT"), 1)

    async def test_legacy_events_do_trigger_snapshot_when_enabled(self):
        """With stream_subgraphs=True the legacy 'events' chunk sets
        is_subgraph_stream=True, firing a mid-stream snapshot in addition to
        the end-of-run one — at least 2 total."""
        agent = _make_agent(["hotels_agent"])
        events = await self._drive(agent, [self._legacy_subgraph_chunk()], stream_subgraphs=True)
        self.assertGreaterEqual(_event_types(events).count("MESSAGES_SNAPSHOT"), 2)


if __name__ == "__main__":
    unittest.main()
