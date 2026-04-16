"""
Tests for the regression introduced by PR #1426 (commit 24aa9af, shipped in
ag-ui-langgraph 0.0.30): internal LLM invocations — most notably
`.with_structured_output()` calls made inside a graph node — fire
`on_chat_model_end`, get appended to `active_run['streamed_messages']`, and
then leak into the MESSAGES_SNAPSHOT payload even though they were never
committed to the state reducer's `messages` channel.

Symptom seen by the customer: an empty assistant bubble appears in the UI
after any node that internally uses `.with_structured_output(Schema)` for
routing / classification / extraction.

These tests exercise `LangGraphAgent.get_state_and_messages_snapshots`, which
is the exact site where `streamed_messages` are merged into the snapshot
payload (agent.py lines ~1210-1215 at the time of writing).

Expected status on current main (bug present):
  a) test_structured_output_call_excluded_from_snapshot      -> FAIL
  b) test_router_llm_call_excluded_from_snapshot             -> FAIL
  c) test_subgraph_uncommitted_message_still_appended        -> PASS (protects
     the PR #1426 behavior; duplicates
     test_subgraph_streaming.py::TestGetStateAndMessagesSnapshots::
     test_uncommitted_streamed_message_appended_after_checkpoint)
  d) test_empty_content_structured_output_not_emitted        -> FAIL

After the fix, all four must pass.

Fake models only — no external API calls.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph.state import CompiledStateGraph

from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui.core import EventType


# ---------------------------------------------------------------------------
# Helpers (mirror style from test_subgraph_streaming.py)
# ---------------------------------------------------------------------------

def _make_agent(subgraph_names=None):
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
    types = []
    for ev in events:
        t = getattr(ev, "type", None)
        if t is not None:
            types.append(t.value if hasattr(t, "value") else str(t))
    return types


def _make_configured_agent(checkpoint_messages, streamed_messages=None):
    """Build an agent with a mocked checkpoint and pre-populated streamed_messages."""
    agent = _make_agent(["some_subgraph"])
    agent.active_run = {"id": "run-1", "streamed_messages": streamed_messages or []}
    agent.dispatched = []
    agent._dispatch_event = lambda ev: agent.dispatched.append(ev) or ev
    agent.get_state_snapshot = MagicMock(return_value={})
    state = MagicMock()
    state.values = {"messages": checkpoint_messages}
    agent.graph.aget_state = AsyncMock(return_value=state)
    return agent


def _structured_output_ai_message(
    schema_name="Classification",
    id_="struct-call-1",
    call_id="call_struct_1",
    args=None,
):
    """Build the AIMessage that `.with_structured_output(Schema)` actually
    emits: empty `content`, single tool_call carrying the schema."""
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


def _snapshot_event(dispatched):
    return next(
        e for e in dispatched
        if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT
    )


# ---------------------------------------------------------------------------
# (a) Structured output call must not leak into MESSAGES_SNAPSHOT
# ---------------------------------------------------------------------------

class TestStructuredOutputExcluded(unittest.IsolatedAsyncioTestCase):
    """An LLM call made via `.with_structured_output(Pydantic)` fires
    on_chat_model_end with a BaseMessage output. The current buggy code path
    appends it into streamed_messages, and because its id is not in the
    checkpoint, it leaks into the snapshot as an empty assistant bubble.
    """

    async def test_structured_output_call_excluded_from_snapshot(self):
        user = HumanMessage(content="hi there", id="u1")
        assistant = AIMessage(content="Hello!", id="a1")
        # This is the "bad" message: the internal schema-extraction call.
        structured = _structured_output_ai_message(
            schema_name="RouterSchema",
            id_="routing-internal-1",
            call_id="call_routing_1",
            args={"intent": "greeting", "confidence": 0.99},
        )

        agent = _make_configured_agent(
            checkpoint_messages=[user, assistant],
            streamed_messages=[structured],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = _snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertNotIn(
            "routing-internal-1", ids,
            "Structured-output internal LLM call must not appear in MESSAGES_SNAPSHOT "
            "(it never committed to the state reducer's `messages` channel).",
        )


# ---------------------------------------------------------------------------
# (b) Router / classifier LLM calls must not leak
# ---------------------------------------------------------------------------

class TestRouterLLMCallExcluded(unittest.IsolatedAsyncioTestCase):
    """A node that uses an internal LLM for routing (e.g. a classifier chain,
    an extraction chain, or any LangChain-internal model call not wired to
    the state reducer's `messages` channel) should not surface in the
    snapshot."""

    async def test_router_llm_call_excluded_from_snapshot(self):
        user = HumanMessage(content="what's the weather?", id="u1")
        final = AIMessage(content="It's sunny.", id="a1")
        # Pretend a router node invoked an LLM internally; its output came
        # back on on_chat_model_end but the node returned without writing it
        # to the `messages` channel.
        router_internal = AIMessage(
            id="router-internal-1",
            content="",
            tool_calls=[
                {
                    "name": "RouteSchema",
                    "args": {"route": "weather_agent"},
                    "id": "call_router_1",
                    "type": "tool_call",
                }
            ],
        )

        agent = _make_configured_agent(
            checkpoint_messages=[user, final],
            streamed_messages=[router_internal],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = _snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertNotIn(
            "router-internal-1", ids,
            "Router/classifier internal LLM call must not appear in snapshot; "
            "it was never committed to the reducer's `messages` channel.",
        )


# ---------------------------------------------------------------------------
# (c) Subgraph uncommitted-message behavior (PR #1426) must be preserved
# ---------------------------------------------------------------------------

class TestSubgraphUncommittedMessageStillAppended(unittest.IsolatedAsyncioTestCase):
    """This test protects the legit behavior fixed in PR #1426:
    when a subgraph produces a *real* conversational message before the
    parent checkpoint has committed it, a mid-stream snapshot must still
    include that message so the client sees it in the correct order.

    NOTE: this duplicates the intent of
    tests/test_subgraph_streaming.py::TestGetStateAndMessagesSnapshots::
      test_uncommitted_streamed_message_appended_after_checkpoint
    and is included here so the two behaviors — "include real uncommitted
    msgs" vs. "exclude structured-output msgs" — sit side by side as a
    regression contract around the upcoming filter.
    """

    async def test_subgraph_uncommitted_message_still_appended(self):
        user = HumanMessage(content="AMS to SF", id="u1")
        flights = AIMessage(content="Booked KLM", id="f1")
        # A real assistant message produced inside a subgraph, not yet
        # committed to the parent checkpoint.
        hotels_uncommitted = AIMessage(content="Booked Hotel Zoe", id="h-uncommitted-1")

        agent = _make_configured_agent(
            checkpoint_messages=[user, flights],
            streamed_messages=[hotels_uncommitted],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = _snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn(
            "h-uncommitted-1", ids,
            "Real uncommitted subgraph message MUST remain in the snapshot "
            "— this is the PR #1426 behavior the fix must preserve.",
        )


# ---------------------------------------------------------------------------
# (d) Empty-content structured output — the customer's exact symptom
# ---------------------------------------------------------------------------

class TestEmptyContentStructuredOutputNotEmitted(unittest.IsolatedAsyncioTestCase):
    """The specific symptom reported: `.with_structured_output()` returns an
    AIMessage with `content=""` (pure tool_calls for the Pydantic schema).
    The current code path passes it through to the snapshot, which the
    frontend renders as an empty assistant bubble.

    This test codifies the user-visible contract: no empty-content
    structured-output BaseMessage may reach the MESSAGES_SNAPSHOT.
    """

    async def test_empty_content_structured_output_not_emitted(self):
        user = HumanMessage(content="extract entities from: Paris", id="u1")
        final = AIMessage(content="Found: Paris (city).", id="a1")
        # Multiple structured-output internal calls — all should be excluded.
        extract1 = _structured_output_ai_message(
            schema_name="EntityExtraction",
            id_="extract-internal-1",
            call_id="call_extract_1",
            args={"entities": [{"text": "Paris", "type": "city"}]},
        )
        extract2 = _structured_output_ai_message(
            schema_name="Sentiment",
            id_="extract-internal-2",
            call_id="call_sentiment_1",
            args={"sentiment": "neutral", "score": 0.0},
        )

        agent = _make_configured_agent(
            checkpoint_messages=[user, final],
            streamed_messages=[extract1, extract2],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = _snapshot_event(agent.dispatched)

        # Neither internal structured-output message should appear.
        ids = [m.id for m in snap.messages]
        self.assertNotIn("extract-internal-1", ids)
        self.assertNotIn("extract-internal-2", ids)

        # Stronger: no empty-content assistant message should be emitted at
        # all (this is the user-visible "empty bubble" symptom).
        for m in snap.messages:
            content = getattr(m, "content", None)
            role = getattr(m, "role", None)
            if role == "assistant" and (content == "" or content is None):
                tool_calls = getattr(m, "tool_calls", None) or []
                self.fail(
                    f"Empty-content assistant message leaked into snapshot: "
                    f"id={getattr(m, 'id', None)!r}, tool_calls={tool_calls!r}. "
                    "This is the exact 'empty bubble' symptom reported by the customer."
                )


if __name__ == "__main__":
    unittest.main()
