"""Tests for post-run vs mid-stream MESSAGES_SNAPSHOT semantics.

Contract under test:

    ``get_state_and_messages_snapshots`` takes a
    ``merge_streamed_messages: bool = True`` parameter.

    Mid-stream (subgraph-boundary transitions) callers pass the default:
    the emitted MESSAGES_SNAPSHOT is ``checkpoint ++ uncommitted
    streamed_messages`` so in-flight subgraph output surfaces before its
    parent commits. This is PR #1426's subgraph-lag fix.

    The post-run caller passes ``False``: the final MESSAGES_SNAPSHOT is
    the checkpoint alone. This suppresses transient LLM outputs that
    lived in ``streamed_messages`` but never committed — ``.with_structured_output()``
    calls, router/classifier turns, supervisor routing bubbles — which
    otherwise surface as duplicate / empty assistant bubbles in the
    client.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage

from ag_ui.core import EventType

from tests._helpers import make_agent, make_configured_agent, snapshot_event


def _structured_output_ai_message(
    schema_name="Classification",
    id_="struct-call-1",
    call_id="call_struct_1",
    args=None,
):
    """Build the AIMessage that ``.with_structured_output(Schema)``
    emits: empty content and a single tool_call carrying the schema
    name rather than a user-facing tool name."""
    return AIMessage(
        id=id_,
        content="",
        tool_calls=[
            {
                "name": schema_name,
                "args": args or {"category": "greeting", "confidence": 0.9},
                "id": call_id,
                "type": "tool_call",
            }
        ],
    )


class TestPostRunSnapshotUsesCheckpointOnly(unittest.IsolatedAsyncioTestCase):
    """The post-run MESSAGES_SNAPSHOT must come exclusively from the
    checkpoint. Anything still sitting in ``streamed_messages`` at
    end-of-run is, by definition, uncommitted — a transient model
    output that the graph did not fold into its final state. Including
    those here is what Paul's upgrade turned up as duplicate / empty
    assistant bubbles."""

    async def test_post_run_snapshot_uses_checkpoint_only(self):
        user = HumanMessage(content="hi", id="u1")
        committed_assistant = AIMessage(content="Hello!", id="a1")
        uncommitted_streamed = AIMessage(
            content="intermediate streamed bubble that never committed",
            id="streamed-extra-1",
        )

        agent = make_configured_agent(
            checkpoint_messages=[user, committed_assistant],
            streamed_messages=[uncommitted_streamed],
        )

        async for _ in agent.get_state_and_messages_snapshots({}, merge_streamed_messages=False):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("u1", ids)
        self.assertIn("a1", ids)
        self.assertNotIn(
            "streamed-extra-1", ids,
            "Post-run snapshot must not include uncommitted streamed messages.",
        )

    async def test_post_run_snapshot_default_false_from_end_of_run(self):
        """End-to-end: drive ``_handle_stream_events`` through its
        post-run path and assert the streamed AIMessage captured from
        ``on_chat_model_end`` does NOT appear in the final
        MESSAGES_SNAPSHOT. This protects the caller wiring that passes
        ``merge_streamed_messages=False`` at the post-run call site."""
        agent = make_agent(["hotels_agent"])

        # A streamed AIMessage that will be appended to
        # active_run["streamed_messages"] by the on_chat_model_end
        # handler. The checkpoint below does NOT contain it, so the old
        # unconditional merge would leak it into the snapshot.
        streamed_extra = AIMessage(
            content="uncommitted tail bubble",
            id="streamed-tail-1",
        )

        user = HumanMessage(content="hi", id="u1")
        final_assistant = AIMessage(content="done", id="a1")

        final_state = MagicMock()
        final_state.values = {"messages": [user, final_assistant]}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "thread-1"
        run_input.messages = []
        run_input.forwarded_props = {}
        run_input.tools = []

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                yield {
                    "event": "on_chat_model_end",
                    "name": "planner",
                    "data": {"output": streamed_extra},
                    "metadata": {
                        "langgraph_node": "planner",
                        "langgraph_checkpoint_ns": "",
                    },
                    "run_id": "run-1",
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "thread-1"}},
            }

        agent.graph.aget_state = AsyncMock(return_value=final_state)
        agent.prepare_stream = fake_prepare

        collected = []
        async for ev in agent._handle_stream_events(run_input):
            collected.append(ev)

        snapshots = [e for e in collected if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT]
        self.assertGreaterEqual(len(snapshots), 1)
        final_snap = snapshots[-1]
        ids = [m.id for m in final_snap.messages]
        self.assertIn("u1", ids)
        self.assertIn("a1", ids)
        self.assertNotIn(
            "streamed-tail-1", ids,
            "End-of-run snapshot must not leak uncommitted streamed messages.",
        )


class TestPostRunPreservesStreamedAfterMidStreamMerge(unittest.IsolatedAsyncioTestCase):
    """When a mid-stream subgraph-boundary snapshot fired during the
    run, streamed_messages were already delivered to the client through
    that snapshot. The post-run final snapshot must not wipe them: it
    continues to merge streamed_messages so the client's message list
    stays consistent. This is the dojo subgraphs / travel-agent
    scenario where the supervisor's routing AIMessage is only ever in
    ``streamed_messages`` (supervisor returns ``Command(goto=...)``
    without an ``update``) yet must survive to the final snapshot."""

    async def test_post_run_preserves_streamed_when_mid_stream_merge_fired(self):
        agent = make_agent(["flights_agent"])

        supervisor_routing_msg = AIMessage(
            content="",
            id="supervisor-route-1",
            tool_calls=[
                {
                    "name": "SupervisorResponseFormatter",
                    "args": {
                        "answer": "Handing off to flights.",
                        "next_agent": "flights_agent",
                    },
                    "id": "call_sup_1",
                    "type": "tool_call",
                }
            ],
        )

        user = HumanMessage(content="plan my trip", id="u1")
        # The checkpoint never commits the supervisor's routing
        # AIMessage — supervisor returned Command(goto=...) without an
        # update. The final state below reflects that.
        final_state = MagicMock()
        final_state.values = {"messages": [user]}
        final_state.tasks = []
        final_state.next = []
        final_state.metadata = {"writes": {}}

        run_input = MagicMock()
        run_input.run_id = "run-1"
        run_input.thread_id = "thread-1"
        run_input.messages = []
        run_input.forwarded_props = {}
        run_input.tools = []

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                # The supervisor's LLM end-of-stream lands in
                # streamed_messages.
                yield {
                    "event": "on_chat_model_end",
                    "name": "supervisor",
                    "data": {"output": supervisor_routing_msg},
                    "metadata": {
                        "langgraph_node": "supervisor",
                        "langgraph_checkpoint_ns": "",
                    },
                    "run_id": "run-1",
                }
                # Then the flights_agent subgraph starts — ns change
                # triggers the mid-stream boundary snapshot.
                yield {
                    "event": "on_chain_start",
                    "name": "flights_agent",
                    "data": {},
                    "metadata": {
                        "langgraph_node": "flights_agent",
                        "langgraph_checkpoint_ns": "flights_agent:abc",
                    },
                    "run_id": "run-1",
                }

            return {
                "stream": gen(),
                "state": MagicMock(values={"messages": []}),
                "config": {"configurable": {"thread_id": "thread-1"}},
            }

        agent.graph.aget_state = AsyncMock(return_value=final_state)
        agent.prepare_stream = fake_prepare

        collected = []
        async for ev in agent._handle_stream_events(run_input):
            collected.append(ev)

        snapshots = [e for e in collected if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT]
        # At minimum: mid-stream at subgraph boundary + post-run.
        self.assertGreaterEqual(len(snapshots), 2)
        final_snap = snapshots[-1]
        ids = [m.id for m in final_snap.messages]
        self.assertIn("u1", ids)
        self.assertIn(
            "supervisor-route-1", ids,
            "Post-run snapshot must preserve supervisor routing AIMessage "
            "delivered through the mid-stream subgraph-boundary merge.",
        )


class TestMidStreamSubgraphBoundaryMergesStreamed(unittest.IsolatedAsyncioTestCase):
    """The mid-stream call path — invoked on every subgraph →
    root/parent transition — must still merge ``streamed_messages`` on
    top of the checkpoint. This is the exact window PR #1426 closed:
    between the subgraph producing its output and the parent graph
    committing it, the client would otherwise lose the subgraph's
    visible message."""

    async def test_mid_stream_subgraph_boundary_merges_streamed(self):
        user = HumanMessage(content="AMS to SF", id="u1")
        flights = AIMessage(content="Booked KLM", id="f1")
        hotels_uncommitted = AIMessage(content="Booked Hotel Zoe", id="h-uncommitted-1")

        agent = make_configured_agent(
            checkpoint_messages=[user, flights],
            streamed_messages=[hotels_uncommitted],
        )

        # Default merge_streamed_messages=True — mid-stream semantics.
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("u1", ids)
        self.assertIn("f1", ids)
        self.assertIn(
            "h-uncommitted-1", ids,
            "Mid-stream snapshot must include uncommitted subgraph messages.",
        )
        self.assertGreater(ids.index("h-uncommitted-1"), ids.index("f1"))


class TestSupervisorBindToolsMessageSurvivesMidStream(unittest.IsolatedAsyncioTestCase):
    """Regression guard against the dojo subgraphs / travel-agent
    failure. A supervisor AIMessage produced by
    ``model.bind_tools([SupervisorResponseFormatter])`` has empty
    textual content and a tool_call naming a Pydantic schema, not a
    user-registered tool. The content the user sees lives in
    ``tool_call.args["answer"]``; the message itself flows through
    ``streamed_messages`` because the supervisor only commits a new
    AIMessage(content=args["answer"]) when routing to END.

    The earlier registry-based filter mistook this for a
    .with_structured_output() call and dropped it, breaking subgraph
    flow. Under the new semantics the mid-stream merge is
    shape-agnostic: it includes every uncommitted streamed message."""

    async def test_supervisor_bind_tools_message_survives_mid_stream(self):
        user = HumanMessage(content="plan my trip", id="u1")
        supervisor_bind_tools_msg = AIMessage(
            id="supervisor-bind-1",
            content="",
            tool_calls=[
                {
                    "name": "SupervisorResponseFormatter",
                    "args": {
                        "answer": "I'll hand you off to the flights agent.",
                        "next": "flights_agent",
                    },
                    "id": "call_supervisor_1",
                    "type": "tool_call",
                }
            ],
        )

        agent = make_configured_agent(
            checkpoint_messages=[user],
            streamed_messages=[supervisor_bind_tools_msg],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("u1", ids)
        self.assertIn(
            "supervisor-bind-1", ids,
            "Supervisor bind_tools AIMessage must survive the mid-stream "
            "snapshot merge — dropping it breaks subgraph routing.",
        )


class TestStructuredOutputCallExcludedFromPostRunSnapshot(unittest.IsolatedAsyncioTestCase):
    """The Paul regression case: a ``.with_structured_output()`` call
    emits an AIMessage with empty content + a Pydantic-schema tool_call.
    It lands in ``streamed_messages`` via on_chat_model_end but the
    graph never folds it into state. At end-of-run it must NOT appear
    in MESSAGES_SNAPSHOT."""

    async def test_structured_output_call_excluded_from_post_run_snapshot(self):
        user = HumanMessage(content="classify this", id="u1")
        final_assistant = AIMessage(content="it's a greeting", id="a1")
        structured = _structured_output_ai_message(
            schema_name="Classification",
            id_="structured-leak-1",
            call_id="call_structured_1",
            args={"category": "greeting"},
        )

        agent = make_configured_agent(
            checkpoint_messages=[user, final_assistant],
            streamed_messages=[structured],
        )

        # Post-run semantics.
        async for _ in agent.get_state_and_messages_snapshots({}, merge_streamed_messages=False):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("u1", ids)
        self.assertIn("a1", ids)
        self.assertNotIn(
            "structured-leak-1", ids,
            "A .with_structured_output() AIMessage that never committed "
            "must not appear in the post-run snapshot.",
        )


class TestStructuredOutputIncludedAtMidStreamSubgraphBoundary(unittest.IsolatedAsyncioTestCase):
    """Companion to the post-run exclusion test: the new fix is
    load-bearing on WHICH call path is used, not on message shape. A
    schema-named tool_call AIMessage that reaches the mid-stream
    merge — e.g. because the supervisor produced it and the subgraph
    boundary fired before the supervisor committed — must survive.
    This is precisely the shape the dojo subgraph flow depends on."""

    async def test_structured_shaped_message_included_mid_stream(self):
        user = HumanMessage(content="hi", id="u1")
        streamed = _structured_output_ai_message(
            schema_name="SupervisorResponseFormatter",
            id_="shaped-mid-stream-1",
            call_id="call_shaped_1",
            args={"answer": "handing off", "next": "flights"},
        )

        agent = make_configured_agent(
            checkpoint_messages=[user],
            streamed_messages=[streamed],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("shaped-mid-stream-1", ids)


if __name__ == "__main__":
    unittest.main()
