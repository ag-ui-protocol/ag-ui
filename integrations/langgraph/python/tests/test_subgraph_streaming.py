"""Tests for subgraph streaming detection, ordering, and snapshot dispatch.

When a subgraph (e.g. hotels_agent) commits a message mid-stream, the
supervisor must see that commit reflected before it emits further text —
otherwise the late-arriving subgraph message gets appended after
supervisor text and the client renders them out of order.

The adapter handles this by calling
``get_state_and_messages_snapshots`` on every subgraph transition,
fetching the fresh checkpoint and dispatching STATE_SNAPSHOT +
MESSAGES_SNAPSHOT before the next TEXT_MESSAGE events arrive. These
tests pin that ordering and the underlying namespace-detection logic.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage

from ag_ui_langgraph.agent import ROOT_SUBGRAPH_NAME
from ag_ui.core import EventType

from tests._helpers import make_agent as _make_agent, make_configured_agent, snapshot_event


def _event_types(events):
    """Extract EventType string values from a list of dispatched event objects."""
    types = []
    for ev in events:
        t = getattr(ev, "type", None)
        if t is not None:
            types.append(t.value if hasattr(t, "value") else str(t))
    return types


def _ns_root(ns):
    """Mirror the ns_root extraction logic from agent.py.

    WARNING: this duplicates the extraction rule used by the adapter —
    if ``agent.py`` changes how it derives the root subgraph name from a
    langgraph_checkpoint_ns string, this helper MUST be kept in sync or
    the tests below will silently diverge from production semantics."""
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

    async def test_dispatches_state_snapshot(self):
        agent = make_configured_agent([HumanMessage(content="hi", id="u1")])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        self.assertIn("STATE_SNAPSHOT", _event_types(agent.dispatched))

    async def test_dispatches_messages_snapshot(self):
        agent = make_configured_agent([HumanMessage(content="hi", id="u1")])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        self.assertIn("MESSAGES_SNAPSHOT", _event_types(agent.dispatched))

    async def test_hotels_message_in_checkpoint_at_correct_position(self):
        """Hotels msg in checkpoint must appear before experiences msg."""
        user = HumanMessage(content="AMS to SF", id="u1")
        flights = AIMessage(content="Booked KLM", id="f1")
        hotels = AIMessage(content="Booked Hotel Zoe", id="h1")
        agent = make_configured_agent([user, flights, hotels])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("h1", ids)
        self.assertLess(ids.index("f1"), ids.index("h1"))



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
    """``get_state_and_messages_snapshots`` is invoked on every subgraph
    transition. An exception raised inside it must propagate out of the
    stream, not be silently swallowed."""

    async def test_get_state_and_messages_snapshots_error_propagates(self):
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
        agent.graph.aget_state = AsyncMock(return_value=initial_state)

        # Stub the target function directly so we are independent of how
        # many intermediate ``aget_state`` calls the adapter makes during
        # a run. Any other wiring change (extra pre-stream peeks, etc.)
        # is irrelevant — what we assert is simply that a failure
        # originating in this helper is not swallowed on the way out.
        async def raising_snapshots(*_args, **_kwargs):
            raise RuntimeError("checkpoint unavailable")
            yield  # pragma: no cover — keeps the function an async generator

        agent.get_state_and_messages_snapshots = raising_snapshots

        with self.assertRaisesRegex(RuntimeError, "checkpoint unavailable"):
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
        """With stream_subgraphs=False the legacy 'events' chunk must not
        set is_subgraph_stream=True, so no mid-stream snapshot fires —
        the run ends with exactly the one end-of-run MESSAGES_SNAPSHOT."""
        agent = _make_agent(["hotels_agent"])
        events = await self._drive(
            agent, [self._legacy_subgraph_chunk()], stream_subgraphs=False
        )
        # Exactly-1 asserted rather than >=1: the gating guarantee is
        # "no EXTRA snapshot fires", which a loose >=1 would not catch.
        self.assertEqual(_event_types(events).count("MESSAGES_SNAPSHOT"), 1)

    async def test_legacy_events_do_trigger_snapshot_when_enabled(self):
        """With stream_subgraphs=True the legacy 'events' chunk sets
        is_subgraph_stream=True, firing a mid-stream snapshot in addition
        to the end-of-run one — at least 2 total (additional snapshots
        are acceptable as the adapter adds instrumentation)."""
        agent = _make_agent(["hotels_agent"])
        events = await self._drive(
            agent, [self._legacy_subgraph_chunk()], stream_subgraphs=True
        )
        self.assertGreaterEqual(_event_types(events).count("MESSAGES_SNAPSHOT"), 2)


if __name__ == "__main__":
    unittest.main()
