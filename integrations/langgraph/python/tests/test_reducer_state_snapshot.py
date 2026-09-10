"""Streamed STATE_SNAPSHOT must honor LangGraph channel reducers (#2628).

``dict.update`` on ``on_chain_end`` output keeps only the last write to an
``Annotated[list, operator.add]`` channel. Mid-stream snapshots should copy
those keys from ``graph.aget_state``, which applies checkpoint writes through
the declared reducers.
"""

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


class TestReducerAwareStateSnapshot(unittest.IsolatedAsyncioTestCase):
    async def test_fan_out_list_channel_keeps_all_writes(self):
        agent = make_agent(emit_raw_events=False)

        checkpoints = [
            {"plan_results": []},
            {"plan_results": [{"id": 1}]},
            {"plan_results": [{"id": 1}, {"id": 2}]},
            {"plan_results": [{"id": 1}, {"id": 2}]},
        ]
        call = {"n": 0}

        async def aget_state(_config=None):
            i = min(call["n"], len(checkpoints) - 1)
            call["n"] += 1
            snap = MagicMock()
            snap.values = checkpoints[i]
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
             patch.object(agent.graph, "aget_state", side_effect=aget_state), \
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
        merged = None
        for snap in snapshots:
            results = snap.get("plan_results") if isinstance(snap, dict) else None
            if results and {item.get("id") for item in results} == {1, 2}:
                merged = results
                break
        self.assertIsNotNone(
            merged,
            f"fan-out writes should appear together in a snapshot, got {snapshots!r}",
        )
