"""Streamed STATE_SNAPSHOT must honor LangGraph channel reducers (#2628).

``dict.update`` on ``on_chain_end`` output keeps only the last write to an
``Annotated[list, operator.add]`` channel. Merge through the compiled graph's
channel operators. Do not refresh from ``aget_state``: the checkpoint can
still hold the previous value when ``on_chain_end`` fires, which would undo
the node's write.
"""

import operator
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import EventType, RunAgentInput

from tests._helpers import make_agent


def _chain_end(node: str, output: dict):
    return {
        "event": "on_chain_end",
        "name": node,
        "data": {"output": output},
        "metadata": {"langgraph_node": node, "langgraph_checkpoint_ns": f"{node}:abc"},
        "run_id": "run-1",
    }


def _chain_start(node: str):
    return {
        "event": "on_chain_start",
        "name": node,
        "data": {},
        "metadata": {"langgraph_node": node, "langgraph_checkpoint_ns": f"{node}:abc"},
        "run_id": "run-1",
    }


def _ids(snap):
    results = snap.get("plan_results") if isinstance(snap, dict) else None
    if not results:
        return None
    return [item.get("id") for item in results]


class TestReducerAwareStateSnapshot(unittest.IsolatedAsyncioTestCase):
    async def test_fan_out_list_channel_keeps_all_writes(self):
        agent = make_agent(emit_raw_events=False)
        agent.graph.channels = {
            "plan_results": MagicMock(operator=operator.add),
        }

        async def stale_aget_state(_config=None):
            snap = MagicMock()
            snap.values = {"plan_results": []}
            snap.tasks = []
            snap.next = []
            snap.metadata = {"writes": {}}
            return snap

        stream_events = [
            _chain_start("worker_a"),
            _chain_end("worker_a", {"plan_results": [{"id": 1}]}),
            _chain_start("worker_b"),
            _chain_end("worker_b", {"plan_results": [{"id": 2}]}),
        ]

        async def fake_stream():
            for ev in stream_events:
                yield ev

        async def fake_prepare(*_args, **_kwargs):
            return {
                "stream": fake_stream(),
                "state": {"plan_results": []},
                "config": {"configurable": {"thread_id": "thread-1"}},
            }

        def fake_get_state_snapshot(state):
            if isinstance(state, dict):
                return state
            return getattr(state, "values", {}) or {}

        with patch.object(agent, "prepare_stream", AsyncMock(side_effect=fake_prepare)), \
             patch.object(agent.graph, "aget_state", side_effect=stale_aget_state), \
             patch.object(agent, "get_state_snapshot", side_effect=fake_get_state_snapshot):
            input_data = RunAgentInput(
                thread_id="thread-1",
                run_id="run-1",
                messages=[],
                state={},
                tools=[],
                context=[],
                forwarded_props={},
            )
            emitted = [ev async for ev in agent._handle_stream_events(input_data)]

        snapshots = [
            ev.snapshot
            for ev in emitted
            if ev is not None and getattr(ev, "type", None) == EventType.STATE_SNAPSHOT
        ]
        self.assertTrue(snapshots, "expected at least one STATE_SNAPSHOT")
        id_seqs = [seq for seq in (_ids(snap) for snap in snapshots) if seq]
        self.assertIn(
            [1],
            id_seqs,
            f"after worker A the snapshot must be [1], got {snapshots!r}",
        )
        self.assertIn(
            [1, 2],
            id_seqs,
            f"after worker B the snapshot must be [1, 2], got {snapshots!r}",
        )
        first_one = next(i for i, seq in enumerate(id_seqs) if seq == [1])
        first_both = next(i for i, seq in enumerate(id_seqs) if seq == [1, 2])
        self.assertLess(first_one, first_both)


class TestRealGraphReducerSnapshots(unittest.IsolatedAsyncioTestCase):
    async def test_send_fanout_snapshots_accumulate(self):
        try:
            from typing import Annotated, TypedDict

            from ag_ui.core import UserMessage
            from langgraph.checkpoint.memory import InMemorySaver
            from langgraph.graph import END, START, StateGraph
            from langgraph.types import Send

            from ag_ui_langgraph.agent import LangGraphAgent
        except ImportError as exc:
            self.skipTest(f"langgraph fan-out helpers unavailable: {exc}")

        class State(TypedDict):
            items: list
            plan_results: Annotated[list, operator.add]

        def continue_workers(state: State):
            return [Send("worker", {"items": [item]}) for item in state["items"]]

        def worker(state: State):
            return {"plan_results": [{"id": state["items"][0]}]}

        builder = StateGraph(State)
        builder.add_node("worker", worker)
        builder.add_conditional_edges(START, continue_workers, ["worker"])
        builder.add_edge("worker", END)
        graph = builder.compile(checkpointer=InMemorySaver())

        agent = LangGraphAgent(name="fanout", graph=graph, emit_raw_events=False)
        input_data = RunAgentInput(
            thread_id="thread-fanout",
            run_id="run-fanout",
            messages=[UserMessage(id="m1", role="user", content="go")],
            state={"items": [1, 2]},
            tools=[],
            context=[],
            forwarded_props={},
        )
        emitted = [ev async for ev in agent.run(input_data)]
        snapshots = [
            ev.snapshot
            for ev in emitted
            if ev is not None and getattr(ev, "type", None) == EventType.STATE_SNAPSHOT
        ]
        id_seqs = [seq for seq in (_ids(snap) for snap in snapshots) if seq]
        self.assertIn(
            [1],
            id_seqs,
            f"worker snapshots must include [1] before the merge, got {snapshots!r}",
        )
        self.assertIn(
            [1, 2],
            id_seqs,
            f"worker snapshots must include [1, 2], got {snapshots!r}",
        )
        self.assertLess(
            next(i for i, seq in enumerate(id_seqs) if seq == [1]),
            next(i for i, seq in enumerate(id_seqs) if seq == [1, 2]),
        )
