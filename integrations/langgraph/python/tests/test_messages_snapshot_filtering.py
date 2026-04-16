"""Tests for the MESSAGES_SNAPSHOT filter that drops LLM-internal
structured-output / router / classifier calls while preserving every
message the caller's registered tools or state reducer produced.

Contract under test:
    A streamed AIMessage whose textual content is empty AND whose
    tool_calls all name something OTHER than a tool registered on the
    current run is classified as an internal LLM call and must not
    appear in ``MESSAGES_SNAPSHOT``. Every other message — including
    real agentic tool-call AIMessages whose tool_calls name a
    registered tool — flows through unchanged.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent

from tests._helpers import make_agent, make_configured_agent, snapshot_event


def _structured_output_ai_message(
    schema_name="Classification",
    id_="struct-call-1",
    call_id="call_struct_1",
    args=None,
):
    """Build the AIMessage that ``.with_structured_output(Schema)``
    emits: empty content and a single tool_call carrying the schema
    name rather than a registered tool name."""
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


class TestStructuredOutputExcluded(unittest.IsolatedAsyncioTestCase):
    """Structured-output schema invocations must not leak into the
    snapshot even when their empty-content / tool_calls shape would
    otherwise match a real tool-call turn."""

    async def test_structured_output_call_excluded_from_snapshot(self):
        user = HumanMessage(content="hi there", id="u1")
        assistant = AIMessage(content="Hello!", id="a1")
        structured = _structured_output_ai_message(
            schema_name="RouterSchema",
            id_="routing-internal-1",
            call_id="call_routing_1",
            args={"intent": "greeting", "confidence": 0.99},
        )

        agent = make_configured_agent(
            checkpoint_messages=[user, assistant],
            streamed_messages=[structured],
            registered_tool_names=["search_flights"],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("u1", ids)
        self.assertIn("a1", ids)
        self.assertNotIn(
            "routing-internal-1", ids,
            "Structured-output invocation must not appear in MESSAGES_SNAPSHOT.",
        )


class TestRouterLLMCallExcluded(unittest.IsolatedAsyncioTestCase):
    """Router / classifier LLM calls that emit an AIMessage carrying a
    schema-named tool_call but no registered-tool name must be
    filtered."""

    async def test_router_llm_call_excluded_from_snapshot(self):
        user = HumanMessage(content="what's the weather?", id="u1")
        final = AIMessage(content="It's sunny.", id="a1")
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

        agent = make_configured_agent(
            checkpoint_messages=[user, final],
            streamed_messages=[router_internal],
            registered_tool_names=["get_weather"],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("u1", ids)
        self.assertIn("a1", ids)
        self.assertNotIn(
            "router-internal-1", ids,
            "Router/classifier internal LLM call must not appear in snapshot.",
        )


class TestSubgraphUncommittedMessageStillAppended(unittest.IsolatedAsyncioTestCase):
    """Real conversational subgraph messages produced before the parent
    checkpoint commits them must still surface in the mid-stream
    snapshot — the regression fix from the earlier subgraph streaming
    work must be preserved."""

    async def test_subgraph_uncommitted_message_still_appended(self):
        user = HumanMessage(content="AMS to SF", id="u1")
        flights = AIMessage(content="Booked KLM", id="f1")
        hotels_uncommitted = AIMessage(content="Booked Hotel Zoe", id="h-uncommitted-1")

        agent = make_configured_agent(
            checkpoint_messages=[user, flights],
            streamed_messages=[hotels_uncommitted],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("h-uncommitted-1", ids)


class TestEmptyContentAssistantNeverLeaks(unittest.IsolatedAsyncioTestCase):
    """No empty-content assistant bubble may reach the snapshot via the
    structured-output path. Uses a mixed fixture so the guard does not
    pass by coincidence: a real non-empty assistant message sits
    alongside the structured-output message, and only the structured
    one is filtered."""

    async def test_empty_content_structured_output_not_emitted(self):
        user = HumanMessage(content="extract entities from: Paris", id="u1")
        final = AIMessage(content="Found: Paris (city).", id="a1")
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

        agent = make_configured_agent(
            checkpoint_messages=[user, final],
            streamed_messages=[extract1, extract2],
            registered_tool_names=["lookup_city"],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertNotIn("extract-internal-1", ids)
        self.assertNotIn("extract-internal-2", ids)

        for m in snap.messages:
            content = getattr(m, "content", None)
            role = getattr(m, "role", None)
            if role == "assistant":
                self.assertFalse(
                    content == "" or content is None,
                    f"Empty-content assistant message leaked into snapshot: "
                    f"id={getattr(m, 'id', None)!r}",
                )

    async def test_structured_output_beside_real_assistant(self):
        """A real non-empty assistant message co-existing in the stream
        with a structured-output message must survive — only the
        structured one is dropped."""
        user = HumanMessage(content="what's up?", id="u1")
        real_assistant = AIMessage(
            content="Here's the summary you asked for.",
            id="real-assistant-1",
        )
        structured = _structured_output_ai_message(
            schema_name="SummarySchema",
            id_="structured-1",
            call_id="call_schema_1",
        )

        agent = make_configured_agent(
            checkpoint_messages=[user],
            streamed_messages=[real_assistant, structured],
            registered_tool_names=["summarize"],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("real-assistant-1", ids)
        self.assertNotIn("structured-1", ids)

        for m in snap.messages:
            role = getattr(m, "role", None)
            content = getattr(m, "content", None)
            if role == "assistant":
                self.assertFalse(
                    content == "" or content is None,
                    "No assistant message in the snapshot may have empty content.",
                )


class TestFilterClassifierBoundaryCoverage(unittest.TestCase):
    """Direct coverage of ``_is_structured_output_message`` across the
    boundary conditions that matter in production streams: empty-string
    vs. list content, Anthropic tool_use blocks, mixed text/tool_use
    lists, and non-AIMessage types that must never be classified."""

    def test_empty_string_content_with_registered_tool_not_filtered(self):
        msg = AIMessage(
            id="real-tc-1",
            content="",
            tool_calls=[{
                "name": "search_flights",
                "args": {"origin": "AMS"},
                "id": "call_real_1",
                "type": "tool_call",
            }],
        )
        self.assertFalse(
            LangGraphAgent._is_structured_output_message(msg, {"search_flights"}),
        )

    def test_empty_string_content_with_unregistered_tool_filtered(self):
        msg = AIMessage(
            id="schema-1",
            content="",
            tool_calls=[{
                "name": "ClassificationSchema",
                "args": {},
                "id": "call_schema_1",
                "type": "tool_call",
            }],
        )
        self.assertTrue(
            LangGraphAgent._is_structured_output_message(msg, {"search_flights"}),
        )

    def test_anthropic_tool_use_only_list_content_filtered(self):
        msg = AIMessage(
            id="schema-anth-1",
            content=[{
                "type": "tool_use",
                "id": "call_schema_anth_1",
                "name": "Schema",
                "input": {},
            }],
            tool_calls=[{
                "name": "Schema",
                "args": {},
                "id": "call_schema_anth_1",
                "type": "tool_call",
            }],
        )
        self.assertTrue(
            LangGraphAgent._is_structured_output_message(msg, {"book_flight"}),
        )

    def test_text_block_with_empty_text_filtered_when_tool_unregistered(self):
        msg = AIMessage(
            id="schema-empty-text-1",
            content=[{"type": "text", "text": ""}],
            tool_calls=[{
                "name": "Schema",
                "args": {},
                "id": "call_empty_text_1",
                "type": "tool_call",
            }],
        )
        self.assertTrue(
            LangGraphAgent._is_structured_output_message(msg, {"search_flights"}),
        )

    def test_text_block_with_real_text_never_filtered(self):
        msg = AIMessage(
            id="real-text-1",
            content=[{"type": "text", "text": "here is an answer"}],
            tool_calls=[{
                "name": "AnythingSchema",
                "args": {},
                "id": "call_real_text_1",
                "type": "tool_call",
            }],
        )
        self.assertFalse(
            LangGraphAgent._is_structured_output_message(msg, set()),
        )

    def test_human_message_never_classified(self):
        msg = HumanMessage(id="human-empty-1", content="")
        self.assertFalse(
            LangGraphAgent._is_structured_output_message(msg, {"search_flights"}),
        )

    def test_tool_message_never_classified(self):
        msg = ToolMessage(id="tool-empty-1", content="", tool_call_id="call_x")
        self.assertFalse(
            LangGraphAgent._is_structured_output_message(msg, {"search_flights"}),
        )

    def test_ai_message_no_tool_calls_not_filtered(self):
        msg = AIMessage(id="empty-no-tc-1", content="", tool_calls=[])
        self.assertFalse(
            LangGraphAgent._is_structured_output_message(msg, {"search_flights"}),
        )

    def test_mixed_tool_calls_any_registered_name_preserves_message(self):
        msg = AIMessage(
            id="mixed-tc-1",
            content="",
            tool_calls=[
                {"name": "InternalSchema", "args": {}, "id": "c1", "type": "tool_call"},
                {"name": "search_flights", "args": {}, "id": "c2", "type": "tool_call"},
            ],
        )
        self.assertFalse(
            LangGraphAgent._is_structured_output_message(msg, {"search_flights"}),
        )


class TestMixedStreamedMessages(unittest.IsolatedAsyncioTestCase):
    """One structured-output message and one real uncommitted
    tool-call must each take the correct path through the filter."""

    async def test_structured_filtered_real_tool_call_preserved(self):
        user = HumanMessage(content="book flight", id="u1")
        checkpoint_assistant = AIMessage(content="let me book", id="a1")
        real_tool_call = AIMessage(
            id="real-tc-1",
            content="",
            tool_calls=[{
                "name": "search_flights",
                "args": {"origin": "AMS", "dest": "SFO"},
                "id": "call_real_1",
                "type": "tool_call",
            }],
        )
        structured = _structured_output_ai_message(
            schema_name="RouterSchema",
            id_="structured-1",
            call_id="call_schema_1",
        )

        agent = make_configured_agent(
            checkpoint_messages=[user, checkpoint_assistant],
            streamed_messages=[real_tool_call, structured],
            registered_tool_names=["search_flights"],
        )

        async for _ in agent.get_state_and_messages_snapshots({}):
            pass

        snap = snapshot_event(agent.dispatched)
        ids = [m.id for m in snap.messages]
        self.assertIn("real-tc-1", ids)
        self.assertNotIn("structured-1", ids)


class TestExtractRegisteredToolNames(unittest.TestCase):
    """``_extract_registered_tool_names`` pulls names from both dict
    and object tools, skips entries without a name, and deduplicates."""

    def test_mixed_dict_and_object_tools(self):
        class _ToolObj:
            def __init__(self, name):
                self.name = name

        input = SimpleNamespace(
            tools=[
                {"name": "search_flights"},
                _ToolObj("book_hotel"),
                {"description": "no-name"},
                None,
                {"name": "search_flights"},
            ]
        )
        names = LangGraphAgent._extract_registered_tool_names(input)
        self.assertEqual(names, {"search_flights", "book_hotel"})

    def test_no_tools_returns_empty_set(self):
        input = SimpleNamespace(tools=None)
        self.assertEqual(LangGraphAgent._extract_registered_tool_names(input), set())

    def test_missing_tools_attribute_returns_empty_set(self):
        input = SimpleNamespace()
        self.assertEqual(LangGraphAgent._extract_registered_tool_names(input), set())


class TestHandleStreamEventsFiltering(unittest.IsolatedAsyncioTestCase):
    """End-to-end through ``_handle_stream_events``: feed an
    ``OnChatModelEnd`` carrying a structured-output AIMessage, then
    trigger a final snapshot, and assert the emitted MESSAGES_SNAPSHOT
    excludes the structured message."""

    async def test_structured_output_excluded_from_end_of_run_snapshot(self):
        agent = make_agent(["hotels_agent"])

        structured = _structured_output_ai_message(
            schema_name="RouteSchema",
            id_="structured-integration-1",
            call_id="call_struct_int_1",
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
        run_input.tools = [{"name": "book_flight"}]

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                yield {
                    "event": "on_chat_model_end",
                    "name": "classifier",
                    "data": {"output": structured},
                    "metadata": {
                        "langgraph_node": "classifier",
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
        self.assertNotIn("structured-integration-1", ids)

    async def test_real_tool_call_preserved_in_end_of_run_snapshot(self):
        """Mirror of the above with a REAL tool-call AIMessage whose
        name is registered. It must survive to the final snapshot even
        if the checkpoint has not yet caught up."""
        agent = make_agent(["hotels_agent"])

        real_tool_call = AIMessage(
            id="real-tc-integration-1",
            content="",
            tool_calls=[{
                "name": "book_flight",
                "args": {"origin": "AMS", "dest": "SFO"},
                "id": "call_real_int_1",
                "type": "tool_call",
            }],
        )

        user = HumanMessage(content="book AMS->SFO", id="u1")

        # The checkpoint has not yet committed the tool-call turn.
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
        run_input.tools = [{"name": "book_flight"}]

        async def fake_prepare(*args, **kwargs):
            agent.active_run["schema_keys"] = {
                "input": ["messages"], "output": ["messages"],
                "config": [], "context": [],
            }

            async def gen():
                yield {
                    "event": "on_chat_model_end",
                    "name": "planner",
                    "data": {"output": real_tool_call},
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
        self.assertIn("real-tc-integration-1", ids)


if __name__ == "__main__":
    unittest.main()
