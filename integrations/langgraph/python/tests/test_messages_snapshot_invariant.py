"""MESSAGES_SNAPSHOT invariant tests.

The invariant under test:

    ``MESSAGES_SNAPSHOT`` reflects the graph checkpoint's ``messages``
    — nothing else. Streaming-layer events (``TEXT_MESSAGE_*``,
    ``TOOL_CALL_*``) carry in-progress content separately; the
    snapshot never mirrors or merges them.

History: PR #1426 violated this by collecting every ``on_chat_model_end``
output into an ``active_run["streamed_messages"]`` bucket and merging
that bucket into the snapshot. The bucket could not distinguish
committed model outputs from transient internal ones
(``.with_structured_output()``, router/classifier calls), so the
snapshot picked up empty / duplicate assistant bubbles. PR #1543
tried to gate the merge on whether a subgraph-boundary fired;
Function Health kept seeing the leak because the gate didn't cover
the mid-stream emission. The correct fix is the one the customer
arrived at independently: the snapshot must not merge streamed
state at all — it reads straight from the checkpoint.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from ag_ui.core import EventType

from tests._helpers import make_agent, make_configured_agent, snapshot_event


def _structured_output_ai_message(
    schema_name="Classification",
    id_="struct-call-1",
    call_id="call_struct_1",
    args=None,
):
    """Build the AIMessage shape that ``.with_structured_output(Schema)``
    emits: empty content and a single schema-named tool_call. Used to
    represent the transient internal LLM output that must never leak
    into the snapshot."""
    return AIMessage(
        id=id_,
        content="",
        tool_calls=[
            {
                "name": schema_name,
                "args": args or {"category": "greeting"},
                "id": call_id,
                "type": "tool_call",
            }
        ],
    )


async def _drive_stream(agent, chunks, checkpoint_messages):
    """Push ``chunks`` through ``_handle_stream_events`` with a graph
    whose final checkpoint carries ``checkpoint_messages``. Returns the
    list of dispatched events."""
    run_input = MagicMock()
    run_input.run_id = "run-1"
    run_input.thread_id = "thread-1"
    run_input.messages = []
    run_input.forwarded_props = {}
    run_input.tools = []

    final_state = MagicMock()
    final_state.values = {"messages": checkpoint_messages}
    final_state.tasks = []
    final_state.next = []
    final_state.metadata = {"writes": {}}

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

    agent.graph.aget_state = AsyncMock(return_value=final_state)
    agent.prepare_stream = fake_prepare

    collected = []
    async for ev in agent._handle_stream_events(run_input):
        collected.append(ev)
    return collected


class TestSnapshotEqualsCheckpoint(unittest.IsolatedAsyncioTestCase):
    """Core invariant: whatever happens during streaming, the final
    MESSAGES_SNAPSHOT carries exactly the checkpoint's messages.

    Three scenarios cover the surface area:
      1. Streaming produces multiple transient model outputs that the
         graph never commits → snapshot still equals checkpoint.
      2. No streaming activity at all → snapshot still equals checkpoint.
      3. Interleaved tool + model activity → snapshot still equals
         checkpoint, ignoring every non-committed intermediate.
    """

    async def test_streamed_transients_never_leak_into_snapshot(self):
        """A classifier + router + supervisor each do internal LLM
        calls via ``on_chat_model_end``. The graph does not fold any
        of those outputs into state. Snapshot has only committed
        messages."""
        user = HumanMessage(content="help me plan a trip", id="u1")
        final_assistant = AIMessage(content="Here's your trip", id="a1")

        classifier_transient = _structured_output_ai_message(
            schema_name="IntentClassification",
            id_="classifier-leak-1",
            call_id="call_classifier_1",
        )
        router_transient = _structured_output_ai_message(
            schema_name="Router",
            id_="router-leak-1",
            call_id="call_router_1",
        )
        supervisor_transient = _structured_output_ai_message(
            schema_name="SupervisorResponseFormatter",
            id_="supervisor-leak-1",
            call_id="call_sup_1",
        )

        agent = make_agent()
        chunks = [
            {
                "event": "on_chat_model_end",
                "name": name,
                "data": {"output": msg},
                "metadata": {
                    "langgraph_node": name,
                    "langgraph_checkpoint_ns": "",
                },
                "run_id": "run-1",
            }
            for name, msg in [
                ("classifier", classifier_transient),
                ("router", router_transient),
                ("supervisor", supervisor_transient),
            ]
        ]

        collected = await _drive_stream(
            agent, chunks, checkpoint_messages=[user, final_assistant]
        )

        snapshots = [e for e in collected if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT]
        self.assertEqual(
            len(snapshots), 1,
            "Exactly one MESSAGES_SNAPSHOT must fire per run (post-run).",
        )
        ids = [m.id for m in snapshots[0].messages]
        self.assertEqual(
            ids, ["u1", "a1"],
            "Snapshot must be exactly the checkpoint's messages.",
        )

    async def test_snapshot_reflects_checkpoint_when_no_streaming(self):
        """Degenerate case: no ``on_chat_model_end`` events at all.
        Snapshot still equals checkpoint — no silent dependence on
        streaming activity."""
        user = HumanMessage(content="hi", id="u1")
        assistant = AIMessage(content="hello", id="a1")

        agent = make_agent()
        collected = await _drive_stream(
            agent, chunks=[], checkpoint_messages=[user, assistant]
        )

        snapshots = [e for e in collected if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT]
        self.assertEqual(len(snapshots), 1)
        ids = [m.id for m in snapshots[0].messages]
        self.assertEqual(ids, ["u1", "a1"])

    async def test_snapshot_ignores_interleaved_tool_and_model_intermediates(self):
        """A realistic loop: model call → tool call → model call,
        where intermediate model outputs are never committed. Only the
        final committed exchange lands in the snapshot."""
        user = HumanMessage(content="what's the weather?", id="u1")
        final_assistant = AIMessage(content="It's 72F and sunny.", id="a2")

        intermediate_tool_call = AIMessage(
            id="a1-intermediate",
            content="",
            tool_calls=[
                {
                    "name": "get_weather",
                    "args": {"location": "SF"},
                    "id": "call_weather_1",
                    "type": "tool_call",
                }
            ],
        )
        # A transient structured-output classification that runs between
        # the tool result and the final assistant message. The graph
        # consumes its parsed payload and never writes the raw AIMessage
        # back to state.
        transient_router = _structured_output_ai_message(
            schema_name="ResponseTone",
            id_="router-transient-1",
            call_id="call_tone_1",
        )

        agent = make_agent()
        chunks = [
            {
                "event": "on_chat_model_end",
                "name": "model",
                "data": {"output": intermediate_tool_call},
                "metadata": {
                    "langgraph_node": "model",
                    "langgraph_checkpoint_ns": "",
                },
                "run_id": "run-1",
            },
            {
                "event": "on_chat_model_end",
                "name": "tone_router",
                "data": {"output": transient_router},
                "metadata": {
                    "langgraph_node": "tone_router",
                    "langgraph_checkpoint_ns": "",
                },
                "run_id": "run-1",
            },
            {
                "event": "on_chat_model_end",
                "name": "model",
                "data": {"output": final_assistant},
                "metadata": {
                    "langgraph_node": "model",
                    "langgraph_checkpoint_ns": "",
                },
                "run_id": "run-1",
            },
        ]

        # The checkpoint only persists the intermediate tool_call (its
        # ToolMessage result, committed via the tool node) and the final
        # assistant response. The transient router output is gone.
        tool_result = ToolMessage(
            content="72F sunny",
            id="tool-1",
            tool_call_id="call_weather_1",
        )
        checkpoint = [user, intermediate_tool_call, tool_result, final_assistant]

        collected = await _drive_stream(
            agent, chunks, checkpoint_messages=checkpoint
        )

        snapshots = [e for e in collected if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT]
        self.assertEqual(len(snapshots), 1)
        ids = [m.id for m in snapshots[0].messages]
        self.assertEqual(
            ids,
            ["u1", "a1-intermediate", "tool-1", "a2"],
            "Snapshot must be exactly the checkpoint — the transient "
            "router AIMessage must not appear.",
        )


class TestSnapshotIsEmittedOnce(unittest.IsolatedAsyncioTestCase):
    """A single MESSAGES_SNAPSHOT fires per run, at the end. No
    mid-stream emissions: snapshots during streaming would race against
    in-flight messages (chunks already delivered to the client but not
    yet committed to the checkpoint), and the client's edit-merge apply
    logic would drop them."""

    async def test_subgraph_transitions_do_not_fire_snapshots(self):
        user = HumanMessage(content="plan my trip", id="u1")
        subgraph_response = AIMessage(content="Booked flights.", id="a1")

        agent = make_agent()
        chunks = [
            {
                "event": "on_chain_start",
                "name": "flights_agent",
                "data": {},
                "metadata": {
                    "langgraph_node": "flights_agent",
                    "langgraph_checkpoint_ns": "flights_agent:abc",
                },
                "run_id": "run-1",
            },
            {
                "event": "on_chat_model_end",
                "name": "flights_llm",
                "data": {"output": subgraph_response},
                "metadata": {
                    "langgraph_node": "flights_llm",
                    "langgraph_checkpoint_ns": "flights_agent:abc",
                },
                "run_id": "run-1",
            },
            {
                "event": "on_chain_end",
                "name": "flights_agent",
                "data": {"output": {}},
                "metadata": {
                    "langgraph_node": "supervisor",
                    "langgraph_checkpoint_ns": "supervisor:def",
                },
                "run_id": "run-1",
            },
        ]

        collected = await _drive_stream(
            agent, chunks, checkpoint_messages=[user, subgraph_response]
        )

        snapshots = [e for e in collected if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT]
        self.assertEqual(
            len(snapshots), 1,
            "Only the post-run snapshot should fire; subgraph "
            "transitions must not emit MESSAGES_SNAPSHOT.",
        )


class TestGetStateAndMessagesSnapshotsUnit(unittest.IsolatedAsyncioTestCase):
    """Unit-level sanity checks on ``get_state_and_messages_snapshots``
    itself — it must always emit STATE_SNAPSHOT + MESSAGES_SNAPSHOT
    from the current checkpoint, with no knobs."""

    async def test_emits_both_snapshots(self):
        user = HumanMessage(content="hi", id="u1")
        agent = make_configured_agent([user])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        types = [getattr(e, "type", None) for e in agent.dispatched]
        self.assertIn(EventType.STATE_SNAPSHOT, types)
        self.assertIn(EventType.MESSAGES_SNAPSHOT, types)

    async def test_snapshot_matches_checkpoint_messages(self):
        user = HumanMessage(content="hi", id="u1")
        assistant = AIMessage(content="hello", id="a1")
        agent = make_configured_agent([user, assistant])
        async for _ in agent.get_state_and_messages_snapshots({}):
            pass
        snap = snapshot_event(agent.dispatched)
        self.assertEqual([m.id for m in snap.messages], ["u1", "a1"])


class TestFunctionHealthSymptom(unittest.IsolatedAsyncioTestCase):
    """Black-box regression guard that encodes the customer's exact
    report: 'chat history reconstruction intermittently emits
    duplicate/empty assistant messages, which leads to repeated
    feedback UI triggers on a single response.'

    The scenario approximates their graph:
      1. A router node runs a ``.with_structured_output()`` call.
         ``on_chat_model_end`` fires with a schema-only AIMessage;
         the graph consumes the parsed payload only and never
         commits the raw AIMessage to state.
      2. Another router/classifier call fires the same way.
      3. A subgraph boundary is crossed.
      4. The worker subgraph commits the real assistant response.
      5. Run ends.

    Against PR #1426's streamed_messages merge, the mid-stream
    subgraph-boundary snapshot and/or the post-run snapshot leak
    the transient schema AIMessages from steps 1 & 2 — the client
    renders them as empty bubbles *and* (because they share empty
    content) as duplicates that trigger feedback UI repeatedly.

    After the revert the snapshot is the checkpoint alone:
    exactly one assistant message, non-empty, no duplicates.

    Use this as a throwaway acceptance check: RED against current
    ``main`` (pre-revert), GREEN on this branch. Also GREEN against
    the customer's own workaround (checkpoint-only rewrite of the
    MESSAGES_SNAPSHOT event)."""

    async def test_no_empty_or_duplicate_assistant_bubbles(self):
        user = HumanMessage(content="help me plan my trip", id="u1")
        # The ONLY assistant message the graph commits to state.
        real_response = AIMessage(content="Here's your itinerary.", id="a-real")

        router_transient = _structured_output_ai_message(
            schema_name="IntentClassification",
            id_="router-transient-1",
            call_id="call_router_1",
            args={"intent": "travel"},
        )
        second_router_transient = _structured_output_ai_message(
            schema_name="ToneClassification",
            id_="router-transient-2",
            call_id="call_router_2",
            args={"tone": "casual"},
        )

        agent = make_agent()
        chunks = [
            # Step 1 & 2: two transient structured-output calls in a
            # root-level router node. Their raw AIMessages are not
            # committed — only the parsed args leave this node.
            {
                "event": "on_chat_model_end",
                "name": "router",
                "data": {"output": router_transient},
                "metadata": {
                    "langgraph_node": "router",
                    "langgraph_checkpoint_ns": "",
                },
                "run_id": "run-1",
            },
            {
                "event": "on_chat_model_end",
                "name": "router",
                "data": {"output": second_router_transient},
                "metadata": {
                    "langgraph_node": "router",
                    "langgraph_checkpoint_ns": "",
                },
                "run_id": "run-1",
            },
            # Step 3: subgraph boundary. The ``|`` in
            # ``langgraph_checkpoint_ns`` is what the pre-revert
            # detector used to mark "we're inside a subgraph" (see
            # PR #1426). Against PR #1426 / #1543 this triggers a
            # mid-stream MESSAGES_SNAPSHOT that merges the
            # router's two transients on top of the still-empty
            # checkpoint — they land in client state before the
            # worker has said anything.
            {
                "event": "on_chain_start",
                "name": "worker",
                "data": {},
                "metadata": {
                    "langgraph_node": "worker",
                    "langgraph_checkpoint_ns": "worker:abc|worker_inner:def",
                },
                "run_id": "run-1",
            },
            # Step 4: worker commits the real assistant message.
            {
                "event": "on_chat_model_end",
                "name": "worker_llm",
                "data": {"output": real_response},
                "metadata": {
                    "langgraph_node": "worker_llm",
                    "langgraph_checkpoint_ns": "worker:abc|worker_inner:def",
                },
                "run_id": "run-1",
            },
        ]

        # Final checkpoint: user + exactly one committed assistant message.
        collected = await _drive_stream(
            agent, chunks, checkpoint_messages=[user, real_response]
        )

        snapshots = [
            e for e in collected
            if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT
        ]
        self.assertGreaterEqual(
            len(snapshots), 1,
            "At least the post-run snapshot must fire.",
        )

        # The customer's reproduction asserts on the LAST snapshot the
        # client would apply — that's the one driving the final
        # rendered history.
        final_snapshot = snapshots[-1]
        assistant_msgs = [
            m for m in final_snapshot.messages if m.role == "assistant"
        ]

        # Customer's three exact symptoms, asserted in order:

        # 1. No empty assistant bubbles.
        empty = [m for m in assistant_msgs if not (m.content or "").strip()]
        self.assertEqual(
            empty, [],
            f"Found {len(empty)} empty assistant bubble(s) in the "
            f"final snapshot — this is the 'empty messages' half of "
            f"the Function Health symptom.",
        )

        # 2. No duplicate assistant messages (by content).
        contents = [m.content for m in assistant_msgs]
        self.assertEqual(
            len(contents), len(set(contents)),
            f"Assistant messages include duplicates: {contents} — "
            f"this is the 'duplicate messages' half of the Function "
            f"Health symptom (empty bubbles collide under ==).",
        )

        # 3. Exactly one assistant message — the one the graph committed.
        self.assertEqual(
            len(assistant_msgs), 1,
            f"Expected exactly 1 assistant message (the committed "
            f"response); got {len(assistant_msgs)}: "
            f"{[m.id for m in assistant_msgs]}.",
        )
        self.assertEqual(assistant_msgs[0].id, "a-real")


if __name__ == "__main__":
    unittest.main()
