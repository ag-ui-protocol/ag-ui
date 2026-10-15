"""Exercise real LangChain callbacks through real LangGraph V3 streams."""

import asyncio
import unittest
from typing import TypedDict

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.callbacks.manager import (
    adispatch_custom_event,
    dispatch_custom_event,
)
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from ag_ui_langgraph import AGUICustomEventBridge, agui_transformer


class State(TypedDict):
    count: int


class Observer(BaseCallbackHandler):
    run_inline = True

    def __init__(self):
        self.events = []

    def on_custom_event(self, name, data, **kwargs):
        self.events.append((name, data))


def graph_for(node, observer):
    builder = StateGraph(State)
    builder.add_node("work", node)
    builder.add_edge(START, "work")
    builder.add_edge("work", END)
    return (
        builder.compile(transformers=[agui_transformer])
        .with_config(callbacks=[observer])
        .with_config(callbacks=[AGUICustomEventBridge()])
    )


def custom_payloads(events):
    return [e["params"]["data"] for e in events if e["method"] == "custom"]


class CustomEventBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_callbacks_preserve_order_and_existing_observers(self):
        observer = Observer()

        async def node(state):
            for count in range(4):
                await adispatch_custom_event("manually_emit_state", {"count": count})
            await adispatch_custom_event("application_event", {"nullable": None})
            get_stream_writer()({"name": "writer_probe", "payload": {"count": 4}})
            return {"count": 5}

        graph = graph_for(node, observer)
        run = await graph.astream_events({"count": 0}, version="v3")
        events = [event async for event in run]
        expected = [("manually_emit_state", {"count": n}) for n in range(4)]
        expected.append(("application_event", {"nullable": None}))
        self.assertEqual(observer.events, expected)
        self.assertEqual(
            custom_payloads(events),
            [
                *[{"name": name, "payload": data} for name, data in expected],
                {"name": "writer_probe", "payload": {"count": 4}},
            ],
        )
        # Prove the real AG-UI transformer sees the bridge, not merely protocol output.
        snapshots = [
            event["params"]["data"]["snapshot"]
            for event in events
            if event["method"] == "custom:agui"
            and event["params"]["data"].get("type") == "STATE_SNAPSHOT"
        ]
        for count in range(4):
            self.assertIn({"count": count}, snapshots)

    async def test_reused_mutable_custom_payload_is_snapshotted_at_dispatch(self):
        async def node(state):
            payload = {"steps": [{"status": "pending"}]}
            await adispatch_custom_event("progress", payload)
            payload["steps"][0]["status"] = "running"
            await adispatch_custom_event("progress", payload)
            payload["steps"][0]["status"] = "done"
            await adispatch_custom_event("progress", payload)
            payload["steps"].clear()
            return {"count": 3}

        graph = graph_for(node, Observer())
        run = await graph.astream_events({"count": 0}, version="v3")
        events = [event async for event in run]
        self.assertEqual(
            custom_payloads(events),
            [
                {"name": "progress", "payload": {"steps": [{"status": status}]}}
                for status in ["pending", "running", "done"]
            ],
        )

    async def test_concurrent_runs_do_not_mix_callback_payloads(self):
        async def node(state):
            await asyncio.sleep(0)
            await adispatch_custom_event("probe", {"count": state["count"]})
            return state

        graph = graph_for(node, Observer())

        async def capture(count):
            run = await graph.astream_events({"count": count}, version="v3")
            return custom_payloads([event async for event in run])

        self.assertEqual(
            await asyncio.gather(capture(1), capture(2)),
            [
                [{"name": "probe", "payload": {"count": 1}}],
                [{"name": "probe", "payload": {"count": 2}}],
            ],
        )

    def test_sync_callbacks_use_the_same_bridge(self):
        observer = Observer()

        def node(state):
            dispatch_custom_event("probe", {"count": 2})
            return {"count": 3}

        graph = graph_for(node, observer)
        events = list(graph.stream_events({"count": 0}, version="v3"))
        self.assertEqual(
            custom_payloads(events), [{"name": "probe", "payload": {"count": 2}}]
        )
        self.assertEqual(observer.events, [("probe", {"count": 2})])

    async def test_subgraph_inherits_one_bridge_and_retains_namespace(self):
        async def child_node(state):
            await adispatch_custom_event("child_probe", {"count": 2})
            return {"count": 2}

        child = StateGraph(State)
        child.add_node("child_work", child_node)
        child.add_edge(START, "child_work")
        child.add_edge("child_work", END)
        observer = Observer()
        graph = graph_for(child.compile(), observer)
        run = await graph.astream_events({"count": 0}, version="v3")
        events = [event async for event in run]
        custom = [event for event in events if event["method"] == "custom"]
        self.assertEqual(len(custom), 1)
        self.assertEqual(
            custom[0]["params"]["data"],
            {"name": "child_probe", "payload": {"count": 2}},
        )
        self.assertTrue(custom[0]["params"]["namespace"])
        self.assertEqual(observer.events, [("child_probe", {"count": 2})])

    def test_missing_graph_context_fails_loudly(self):
        with self.assertRaises(RuntimeError):
            AGUICustomEventBridge().on_custom_event("probe", {})
