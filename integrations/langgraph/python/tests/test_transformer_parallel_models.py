"""Model identities, rather than shared block indices, own streaming state."""

import asyncio
import unittest

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import StateGraph, MessagesState, START, END
from pydantic import PrivateAttr

from ag_ui_langgraph.transformer import agui_transformer

from tests.test_agui_transformer import Harness, requires_stream_api


class InterleavedProtocolModel(BaseChatModel):
    """An in-process protocol producer; no provider or network is mocked."""

    label: str
    _ready: asyncio.Event = PrivateAttr()
    _peer_ready: asyncio.Event = PrivateAttr()

    @property
    def _llm_type(self):
        return "parallel-protocol-test"

    def _generate(self, messages, **kwargs):
        raise AssertionError("The graph must consume native streaming events")

    async def _astream_chat_model_events(self, messages, **kwargs):
        yield {"event": "message-start", "id": self.label, "role": "assistant"}
        yield {"event": "content-block-start", "index": 0, "content": {"type": "text"}}
        yield {"event": "content-block-delta", "index": 0,
               "delta": {"type": "text-delta", "text": self.label + "0"}}
        self._ready.set()
        await asyncio.wait_for(self._peer_ready.wait(), timeout=5)
        yield {"event": "content-block-delta", "index": 0,
               "delta": {"type": "text-delta", "text": self.label + "1"}}
        yield {"event": "content-block-finish", "index": 0,
               "content": {"type": "text", "text": self.label + "0" + self.label + "1"}}
        yield {"event": "message-finish"}


@requires_stream_api
class TestParallelModels(unittest.TestCase):
    def setUp(self):
        self.h = Harness()

    def frame(self, run, event, *, namespace=(), metadata=None, **data):
        self.h.process("messages", {"namespace": list(namespace), "data": (
            {"event": event, **data}, {"run_id": run, **(metadata or {})})})

    def start(self, run, message, **kwargs):
        self.frame(run, "message-start", id=message, **kwargs)

    def delta(self, run, text, **kwargs):
        self.frame(run, "content-block-delta", index=0,
                   delta={"type": "text-delta", "text": text}, **kwargs)

    def content(self, kind="TEXT_MESSAGE_CONTENT", key="messageId"):
        result = {}
        for event in self.h.wire_events:
            if event["type"] == kind:
                result[event[key]] = result.get(event[key], "") + event["delta"]
        return result

    def assert_balanced(self):
        for prefix, key in (("TEXT_MESSAGE", "messageId"), ("TOOL_CALL", "toolCallId"),
                            ("REASONING", "messageId"), ("REASONING_MESSAGE", "messageId")):
            active, seen = set(), set()
            for event in self.h.wire_events:
                if event["type"] == prefix + "_START":
                    self.assertNotIn(event[key], seen)
                    seen.add(event[key])
                    active.add(event[key])
                elif event["type"] in (prefix + "_CONTENT", prefix + "_ARGS"):
                    self.assertIn(event[key], active)
                elif event["type"] == prefix + "_END":
                    self.assertIn(event[key], active)
                    active.remove(event[key])
            self.assertFalse(active)

    def test_parallel_model_runs_keep_index_zero_and_finish_independent(self):
        self.start("left", "L")
        self.delta("left", "L0")
        self.start("right", "R")
        self.delta("right", "R0")
        self.delta("left", "L1")
        self.frame("left", "message-finish")
        self.delta("right", "R1")
        self.frame("right", "message-finish")
        self.assertEqual({"L": "L0L1", "R": "R0R1"}, self.content())
        self.assert_balanced()

    def test_namespace_disambiguates_reused_model_run_ids(self):
        for namespace, message in ((('left:task',), "L"), (('right:task',), "R")):
            self.start("shared", message, namespace=namespace)
            self.delta("shared", message + "0", namespace=namespace)
        self.delta("shared", "L1", namespace=('left:task',))
        self.delta("shared", "R1", namespace=('right:task',))
        self.h.transformer.finalize()
        self.assertEqual({"L": "L0L1", "R": "R0R1"}, self.content())
        self.assert_balanced()

    def test_reasoning_tool_and_prediction_metadata_are_model_local(self):
        prediction = [{"tool": "write", "state_key": "value", "tool_argument": "value"}]
        self.start("left", "L", metadata={"predict_state": prediction})
        self.frame("left", "content-block-start", index=0,
                   content={"type": "reasoning", "id": "rs-left"})
        self.start("right", "R")
        self.frame("right", "content-block-start", index=0,
                   content={"type": "tool_call", "id": "right-tool", "name": "write", "args": '{"value":'})
        self.frame("left", "content-block-delta", index=0,
                   delta={"type": "reasoning-delta", "reasoning": "left thought"})
        self.frame("left", "content-block-start", index=1,
                   content={"type": "tool_call", "id": "left-tool", "name": "write", "args": '{"value":'})
        self.frame("right", "content-block-delta", index=0,
                   delta={"type": "block-delta", "fields": {"args": '{"value":2}'}})
        self.frame("left", "content-block-delta", index=1,
                   delta={"type": "block-delta", "fields": {"args": '{"value":1}'}})
        self.frame("left", "message-error")
        self.frame("right", "message-finish")
        self.assertEqual({"rs-left": "left thought"}, self.content("REASONING_MESSAGE_CONTENT"))
        self.assertEqual({"left-tool": '{"value":1}', "right-tool": '{"value":2}'},
                         self.content("TOOL_CALL_ARGS", "toolCallId"))
        starts = [event for event in self.h.wire_events if event["type"] == "TOOL_CALL_START"]
        self.assertEqual({"left-tool": "L", "right-tool": "R"},
                         {event["toolCallId"]: event["parentMessageId"] for event in starts})
        self.assertEqual([prediction], [event["value"] for event in self.h.wire_events
                                      if event.get("name") == "PredictState"])
        self.assert_balanced()

    def test_real_parallel_graph_routes_metadata_run_ids(self):
        async def collect():
            left_ready, right_ready = asyncio.Event(), asyncio.Event()
            left = InterleavedProtocolModel(label="L")
            left._ready, left._peer_ready = left_ready, right_ready
            right = InterleavedProtocolModel(label="R")
            right._ready, right._peer_ready = right_ready, left_ready

            async def left_node(state):
                return {"messages": [await left.ainvoke(state["messages"])]}

            async def right_node(state):
                return {"messages": [await right.ainvoke(state["messages"])]}

            builder = StateGraph(MessagesState)
            builder.add_node("left", left_node)
            builder.add_node("right", right_node)
            for node in ("left", "right"):
                builder.add_edge(START, node)
                builder.add_edge(node, END)
            graph = builder.compile(transformers=[agui_transformer])
            run = await graph.astream_events({"messages": [HumanMessage(content="Hi")]}, version="v3")
            return [event["params"]["data"] async for event in run
                    if event.get("method") == "custom:agui"]

        self.h.wire_events = asyncio.run(collect())
        self.assertEqual({"L": "L0L1", "R": "R0R1"}, self.content())
        self.assert_balanced()

    def test_idless_frames_only_route_to_an_unambiguous_model(self):
        self.start(None, "legacy")
        self.delta(None, "first")
        self.start(None, "other")
        self.delta(None, "ambiguous")
        self.frame(None, "message-finish", message_id="legacy")
        self.delta(None, "second")
        self.h.transformer.finalize()
        self.assertEqual({"legacy": "first", "other": "second"}, self.content())
        self.assert_balanced()

    def test_unknown_run_cannot_mutate_an_identified_model(self):
        self.start("known", "message")
        self.delta("known", "before")
        self.delta("unknown", "wrong")
        self.frame("unknown", "message-finish")
        self.delta("known", "after")
        self.h.transformer.fail(RuntimeError("terminal"))
        self.assertEqual({"message": "beforeafter"}, self.content())
        self.assert_balanced()

    def test_missing_tool_ids_are_unique_across_models(self):
        for run in ("left", "right"):
            self.start(run, run)
            self.frame(run, "content-block-start", index=0,
                       content={"type": "tool_call", "name": "work", "args": "{}"})
        self.h.transformer.finalize()
        calls = self.content("TOOL_CALL_ARGS", "toolCallId")
        self.assertEqual(2, len(calls))
        self.assertEqual(["{}", "{}"], list(calls.values()))
        self.assert_balanced()

    def test_unrelated_tool_result_cannot_clear_pending_prediction(self):
        self.start("left", "L", metadata={"predict_state": [{"tool": "plan"}]})
        self.frame("left", "content-block-start", index=0,
                   content={"type": "tool_call", "id": "plan-call", "name": "plan", "args": "{}"})
        self.h.process("tools", {"data": {"event": "tool-finished", "tool_call_id": "other-call", "output": "ok"}})
        self.h.process("tasks", {"namespace": [], "data": {
            "id": "next", "name": "next", "input": {"value": "partial"}}})
        self.assertFalse(any(event["type"] == "STATE_SNAPSHOT" for event in self.h.wire_events))
        self.h.transformer.finalize()
        self.assert_balanced()

    def test_direct_protocol_frames_use_their_model_run_id(self):
        for model in ("left", "right"):
            self.h.process("messages", {"data": {"event": "message-start", "id": model, "run_id": model}})
        for model in ("left", "right"):
            self.h.process("messages", {"data": {"event": "content-block-delta", "run_id": model,
                            "index": 0, "delta": {"type": "text-delta", "text": model}}})
        self.h.transformer.finalize()
        self.assertEqual({"left": "left", "right": "right"}, self.content())
        self.assert_balanced()

    def test_streaming_reasoning_does_not_hide_sibling_snapshot_reasoning(self):
        self.start("left", "L")
        self.frame("left", "content-block-start", index=0,
                   content={"type": "reasoning", "id": "rs-left", "reasoning": "streamed"})
        self.frame("left", "message-finish")
        messages = [AIMessage(id=message, content="answer", additional_kwargs={"reasoning": {
            "id": reasoning, "summary": [{"text": text}]}})
            for message, reasoning, text in (("L", "rs-left", "streamed"), ("R", "rs-right", "snapshot"))]
        self.h.process("values", {"data": {"messages": messages}})
        self.h.transformer.finalize()
        self.assertEqual({"rs-left": "streamed", "rs-right": "snapshot"},
                         self.content("REASONING_MESSAGE_CONTENT"))
        self.assert_balanced()

    def test_completed_node_text_closes_before_next_model_without_closing_live_sibling(self):
        self.start("live", "live-message")
        self.delta("live", "before")
        self.h.process("messages", {"data": (AIMessage(id="node-final", content="Flights Agent: Booked."), {})})
        self.start("supervisor", "supervisor-message")
        self.frame("supervisor", "content-block-start", index=0,
                   content={"type": "tool_call", "id": "route", "name": "supervisor_response", "args": "{}"})
        events = self.h.wire_events
        tool_start = next(i for i, event in enumerate(events) if event["type"] == "TOOL_CALL_START")
        self.assertEqual(["node-final"], [event["messageId"] for event in events[:tool_start]
                                         if event["type"] == "TEXT_MESSAGE_END"])
        self.delta("live", "after")
        self.frame("supervisor", "message-finish")
        self.frame("live", "message-finish")
        self.h.transformer.finalize()
        self.assertEqual({"live-message": "beforeafter", "node-final": "Flights Agent: Booked."}, self.content())
        self.assert_balanced()
