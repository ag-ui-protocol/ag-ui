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


def _chain_end(node: str, output: dict, *, name=None, tags=None):
    return {
        "event": "on_chain_end",
        "name": node if name is None else name,
        "data": {"output": output},
        "metadata": {"langgraph_node": node, "langgraph_checkpoint_ns": f"{node}:abc"},
        "tags": ["graph:step:1"] if tags is None else tags,
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

        async def final_aget_state(_config=None):
            # After the stream, the checkpoint is complete. Mid-stream
            # on_chain_end must not read this, or worker A would jump to
            # [1, 2] and skip the [1] snapshot.
            snap = MagicMock()
            snap.values = {"plan_results": [{"id": 1}, {"id": 2}]}
            snap.tasks = []
            snap.next = []
            snap.metadata = {"writes": {}}
            return snap

        with patch.object(agent, "prepare_stream", AsyncMock(side_effect=fake_prepare)), \
             patch.object(agent.graph, "aget_state", side_effect=final_aget_state), \
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
            snapshots = []
            async for ev in agent._handle_stream_events(input_data):
                if ev is not None and getattr(ev, "type", None) == EventType.STATE_SNAPSHOT:
                    snapshots.append(
                        ev.model_copy(deep=True).snapshot
                        if hasattr(ev, "model_copy")
                        else dict(ev.snapshot)
                    )

        self.assertEqual(
            [snap.get("plan_results") for snap in snapshots],
            [
                [{"id": 1}],
                [{"id": 1}, {"id": 2}],
                [{"id": 1}, {"id": 2}],
            ],
        )

    async def test_nested_chain_end_does_not_double_count_reducer_write(self):
        agent = make_agent(emit_raw_events=False)
        agent.graph.channels = {
            "plan_results": MagicMock(operator=operator.add),
        }

        stream_events = [
            _chain_start("worker_a"),
            _chain_end(
                "worker_a",
                {"plan_results": [{"id": 1}]},
                name="RunnableLambda",
                tags=["seq:step:1"],
            ),
            _chain_end("worker_a", {"plan_results": [{"id": 1}]}),
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

        async def final_aget_state(_config=None):
            snap = MagicMock()
            snap.values = {"plan_results": [{"id": 1}]}
            snap.tasks = []
            snap.next = []
            snap.metadata = {"writes": {}}
            return snap

        with patch.object(agent, "prepare_stream", AsyncMock(side_effect=fake_prepare)), \
             patch.object(agent.graph, "aget_state", side_effect=final_aget_state), \
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
            snapshots = []
            async for ev in agent._handle_stream_events(input_data):
                if ev is not None and getattr(ev, "type", None) == EventType.STATE_SNAPSHOT:
                    snapshots.append(
                        ev.model_copy(deep=True).snapshot
                        if hasattr(ev, "model_copy")
                        else dict(ev.snapshot)
                    )

        self.assertEqual(
            [snap.get("plan_results") for snap in snapshots],
            [
                [{"id": 1}],
                [{"id": 1}],
            ],
        )


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
        # Exclude the already-correct final checkpoint snapshot.
        id_seqs = [seq for seq in (_ids(snap) for snap in snapshots[:-1]) if seq]
        self.assertTrue(
            any(sorted(seq) == [1, 2] for seq in id_seqs),
            f"merged fan-out must appear in worker snapshots, got {id_seqs!r}",
        )
        self.assertTrue(
            any(seq in ([1], [2]) for seq in id_seqs),
            f"a single-worker snapshot must appear before the merge, got {id_seqs!r}",
        )

    async def test_nested_runnable_does_not_duplicate_reducer_write(self):
        try:
            from typing import Annotated, TypedDict

            from ag_ui.core import UserMessage
            from langchain_core.runnables import RunnableLambda
            from langgraph.checkpoint.memory import InMemorySaver
            from langgraph.graph import END, START, StateGraph

            from ag_ui_langgraph.agent import LangGraphAgent
        except ImportError as exc:
            self.skipTest(f"langgraph nested helpers unavailable: {exc}")

        class State(TypedDict):
            plan_results: Annotated[list, operator.add]

        async def worker(state: State):
            leaf = RunnableLambda(lambda _s: {"plan_results": [{"id": 1}]})
            return await leaf.ainvoke(state)

        builder = StateGraph(State)
        builder.add_node("worker", worker)
        builder.add_edge(START, "worker")
        builder.add_edge("worker", END)
        graph = builder.compile(checkpointer=InMemorySaver())

        agent = LangGraphAgent(name="nested", graph=graph, emit_raw_events=False)
        input_data = RunAgentInput(
            thread_id="thread-nested",
            run_id="run-nested",
            messages=[UserMessage(id="m1", role="user", content="go")],
            state={"plan_results": []},
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
        self.assertTrue(id_seqs, f"expected reducer snapshots, got {snapshots!r}")
        self.assertNotIn(
            [1, 1],
            id_seqs,
            f"nested on_chain_end must not double-count the node write, got {id_seqs!r}",
        )
        self.assertEqual(id_seqs[-1], [1])

    async def test_scalar_state_streams_before_completion(self):
        try:
            from typing import TypedDict

            from ag_ui.core import UserMessage
            from langgraph.checkpoint.memory import InMemorySaver
            from langgraph.graph import END, START, StateGraph

            from ag_ui_langgraph.agent import LangGraphAgent
        except ImportError as exc:
            self.skipTest(f"langgraph scalar helpers unavailable: {exc}")

        class State(TypedDict):
            status: str

        def set_new(_state: State):
            return {"status": "new"}

        builder = StateGraph(State)
        builder.add_node("set_new", set_new)
        builder.add_edge(START, "set_new")
        builder.add_edge("set_new", END)
        graph = builder.compile(checkpointer=InMemorySaver())

        agent = LangGraphAgent(name="scalar", graph=graph, emit_raw_events=False)
        input_data = RunAgentInput(
            thread_id="thread-scalar",
            run_id="run-scalar",
            messages=[UserMessage(id="m1", role="user", content="go")],
            state={"status": "old"},
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
        statuses = [
            snap.get("status")
            for snap in snapshots
            if isinstance(snap, dict) and snap.get("status")
        ]
        self.assertIn("new", statuses)
        self.assertIn(
            "new",
            statuses[:-1] if len(statuses) > 1 else statuses,
            f"status=new must stream at node exit, not only at the final checkpoint, got {statuses!r}",
        )

    async def test_delayed_checkpoint_write_still_streams_node_output(self):
        try:
            from typing import TypedDict

            from ag_ui.core import UserMessage
            from langgraph.checkpoint.memory import InMemorySaver
            from langgraph.graph import END, START, StateGraph

            from ag_ui_langgraph.agent import LangGraphAgent
        except ImportError as exc:
            self.skipTest(f"langgraph delayed-checkpoint helpers unavailable: {exc}")

        class State(TypedDict):
            status: str

        def set_new(_state: State):
            return {"status": "new"}

        class LaggingSaver(InMemorySaver):
            """Keep old state readable while withholding newer checkpoint writes."""

            def put(self, config, checkpoint, metadata, new_versions):
                if checkpoint["channel_values"].get("status") != "new":
                    return super().put(config, checkpoint, metadata, new_versions)
                return {
                    "configurable": {
                        **config["configurable"],
                        "checkpoint_id": checkpoint["id"],
                    }
                }

            def put_writes(self, config, writes, task_id, task_path=""):
                # aget_state can also reconstruct new state from pending writes.
                if any(key == "status" and value == "new" for key, value in writes):
                    return
                return super().put_writes(config, writes, task_id, task_path)

        builder = StateGraph(State)
        builder.add_node("set_new", set_new)
        builder.add_edge(START, "set_new")
        builder.add_edge("set_new", END)
        graph = builder.compile(checkpointer=LaggingSaver())

        agent = LangGraphAgent(name="lag", graph=graph, emit_raw_events=False)
        input_data = RunAgentInput(
            thread_id="thread-lag",
            run_id="run-lag",
            messages=[UserMessage(id="m1", role="user", content="go")],
            state={"status": "old"},
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
        statuses = [
            snap.get("status")
            for snap in snapshots
            if isinstance(snap, dict) and "status" in snap
        ]
        self.assertIn(
            "new",
            statuses,
            f"node output must stream even when the checkpoint lags, got {statuses!r} from {snapshots!r}",
        )

    async def test_compiled_subgraph_chain_end_counts_parent_once(self):
        agent = make_agent(emit_raw_events=False)
        agent.graph.channels = {
            "plan_results": MagicMock(operator=operator.add),
        }

        inner = {
            "event": "on_chain_end",
            "name": "child_worker",
            "data": {"output": {"plan_results": [{"id": 1}]}},
            "metadata": {
                "langgraph_node": "child_worker",
                "langgraph_checkpoint_ns": "child:abc",
            },
            "tags": ["graph:step:1"],
            "run_id": "run-1",
        }
        parent = {
            "event": "on_chain_end",
            "name": "child",
            "data": {"output": {"plan_results": [{"id": 1}]}},
            "metadata": {
                "langgraph_node": "child",
                "langgraph_checkpoint_ns": "",
            },
            "tags": ["graph:step:2"],
            "run_id": "run-1",
        }

        stream_events = [
            _chain_start("child_worker"),
            inner,
            _chain_start("child"),
            parent,
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

        async def final_aget_state(_config=None):
            snap = MagicMock()
            snap.values = {"plan_results": [{"id": 1}]}
            snap.tasks = []
            snap.next = []
            snap.metadata = {"writes": {}}
            return snap

        with patch.object(agent, "prepare_stream", AsyncMock(side_effect=fake_prepare)), \
             patch.object(agent.graph, "aget_state", side_effect=final_aget_state), \
             patch.object(agent, "get_state_snapshot", side_effect=fake_get_state_snapshot):
            input_data = RunAgentInput(
                thread_id="thread-1",
                run_id="run-1",
                messages=[],
                state={"plan_results": []},
                tools=[],
                context=[],
                forwarded_props={},
            )
            snapshots = []
            async for ev in agent._handle_stream_events(input_data):
                if ev is not None and getattr(ev, "type", None) == EventType.STATE_SNAPSHOT:
                    snapshots.append(
                        ev.model_copy(deep=True).snapshot
                        if hasattr(ev, "model_copy")
                        else dict(ev.snapshot)
                    )

        seqs = [snap.get("plan_results") for snap in snapshots if isinstance(snap, dict)]
        self.assertNotIn(
            [{"id": 1}, {"id": 1}],
            seqs,
            f"inner subgraph write must not be reduced again at the parent, got {seqs!r}",
        )

    async def test_compiled_subgraph_does_not_double_count_reducer_write(self):
        try:
            from typing import Annotated, TypedDict

            from ag_ui.core import UserMessage
            from langgraph.checkpoint.memory import InMemorySaver
            from langgraph.graph import END, START, StateGraph

            from ag_ui_langgraph.agent import LangGraphAgent
        except ImportError as exc:
            self.skipTest(f"langgraph compiled-subgraph helpers unavailable: {exc}")

        class State(TypedDict):
            plan_results: Annotated[list, operator.add]
            status: str

        def child_worker(_state: State):
            return {"plan_results": [1]}

        def set_status(_state: State):
            return {"status": "done"}

        child = StateGraph(State)
        child.add_node("child_worker", child_worker)
        child.add_edge(START, "child_worker")
        child.add_edge("child_worker", END)

        parent = StateGraph(State)
        parent.add_node("child", child.compile())
        parent.add_node("set_status", set_status)
        parent.add_edge(START, "child")
        parent.add_edge("child", "set_status")
        parent.add_edge("set_status", END)
        graph = parent.compile(checkpointer=InMemorySaver())

        agent = LangGraphAgent(name="subgraph", graph=graph, emit_raw_events=False)
        input_data = RunAgentInput(
            thread_id="thread-subgraph",
            run_id="run-subgraph",
            messages=[UserMessage(id="m1", role="user", content="go")],
            state={"plan_results": [], "status": "old"},
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
        seqs = [
            snap.get("plan_results")
            for snap in snapshots
            if isinstance(snap, dict) and snap.get("plan_results")
        ]
        self.assertTrue(seqs, f"expected subgraph snapshots, got {snapshots!r}")
        self.assertNotIn(
            [1, 1],
            seqs,
            f"compiled subgraph must not double-count the worker write, got {seqs!r}",
        )
        self.assertEqual(seqs[-1], [1])
        mid = seqs[:-1]
        self.assertTrue(
            any(seq == [1] for seq in mid) or seqs == [[1]],
            f"intermediate snapshots must include [1] without duplicating it, got {seqs!r}",
        )
