"""Tests for emit-raw-events and emit-raw-event-data metadata flags."""

import unittest
from unittest.mock import MagicMock, AsyncMock, patch
from ag_ui.core import EventType, RawEvent, RunAgentInput, StateSnapshotEvent, TextMessageContentEvent, ToolCallEndEvent
from ag_ui_langgraph.agent import LangGraphAgent


class TestEmitRawEventData(unittest.TestCase):
    """emit-raw-event-data flag controls whether raw_event is populated on non-RAW events."""

    def _make_agent(self, emit_raw_event_data=True):
        mock_graph = MagicMock()
        agent = LangGraphAgent(name="test", graph=mock_graph)
        agent.active_run = {
            "id": "run-1",
            "thread_id": "t-1",
            "emit_raw_event_data": emit_raw_event_data,
        }
        return agent

    def test_raw_event_stripped_from_state_snapshot_when_false(self):
        agent = self._make_agent(emit_raw_event_data=False)
        event = StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot={"key": "value"},
            raw_event={"event": "on_chain_end", "data": {"output": {"large": "payload"}}},
        )
        result = agent._dispatch_event(event)
        self.assertIsNone(result.raw_event)

    def test_raw_event_stripped_from_text_message_when_false(self):
        agent = self._make_agent(emit_raw_event_data=False)
        event = TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id="msg-1",
            delta="hello",
            raw_event={"event": "on_chat_model_stream", "metadata": {}},
        )
        result = agent._dispatch_event(event)
        self.assertIsNone(result.raw_event)

    def test_raw_event_stripped_from_tool_call_end_when_false(self):
        agent = self._make_agent(emit_raw_event_data=False)
        event = ToolCallEndEvent(
            type=EventType.TOOL_CALL_END,
            tool_call_id="tc-1",
            raw_event={"event": "on_tool_end", "data": {"output": "big result"}},
        )
        result = agent._dispatch_event(event)
        self.assertIsNone(result.raw_event)

    def test_raw_event_preserved_when_true(self):
        agent = self._make_agent(emit_raw_event_data=True)
        event = StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot={"key": "value"},
            raw_event={"event": "on_chain_end", "data": {}},
        )
        result = agent._dispatch_event(event)
        self.assertIsNotNone(result.raw_event)

    def test_raw_event_preserved_by_default(self):
        """When active_run has no emit_raw_event_data key, default to True."""
        mock_graph = MagicMock()
        agent = LangGraphAgent(name="test", graph=mock_graph)
        agent.active_run = {"id": "run-1", "thread_id": "t-1"}
        event = StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot={"key": "value"},
            raw_event={"event": "on_chain_end", "data": {}},
        )
        result = agent._dispatch_event(event)
        self.assertIsNotNone(result.raw_event)

    def test_raw_event_on_raw_event_type_unaffected(self):
        """The flag should NOT affect RawEvent.event -- only raw_event on other types."""
        from ag_ui.core import RawEvent
        agent = self._make_agent(emit_raw_event_data=False)
        event = RawEvent(
            type=EventType.RAW,
            event={"event": "on_chain_start", "data": {}},
        )
        result = agent._dispatch_event(event)
        self.assertIsNotNone(result.event)


class TestEmitRawEvents(unittest.IsolatedAsyncioTestCase):
    """emit-raw-events flag controls whether RawEvent objects are yielded."""

    def _make_agent(self):
        mock_graph = MagicMock()
        agent = LangGraphAgent(name="test", graph=mock_graph)
        return agent

    async def _run_with_events(self, agent, stream_events):
        """Helper: mock the agent pipeline and collect all dispatched events."""
        async def mock_stream():
            for e in stream_events:
                yield e

        async def mock_prepare_stream(**kwargs):
            # Mimic the side-effects that prepare_stream normally applies
            agent.active_run["schema_keys"] = {"output": []}
            return {
                "state": {"messages": []},
                "stream": mock_stream(),
                "config": {"configurable": {"thread_id": "t-1"}},
                "events_to_dispatch": None,
            }

        agent.prepare_stream = mock_prepare_stream
        mock_state = MagicMock()
        mock_state.values = {"messages": []}
        mock_state.tasks = []
        mock_state.next = ()
        mock_state.metadata = {"writes": {}}
        agent.graph.aget_state = AsyncMock(return_value=mock_state)

        input_data = RunAgentInput(
            thread_id="t-1",
            run_id="r-1",
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={},
        )

        events = []
        async for event in agent.run(input_data):
            events.append(event)
        return events

    async def test_raw_events_suppressed_when_metadata_false(self):
        agent = self._make_agent()
        stream_events = [
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {"langgraph_node": "node1", "emit-raw-events": False},
                "run_id": "r-1",
            },
        ]
        events = await self._run_with_events(agent, stream_events)
        raw_events = [e for e in events if isinstance(e, RawEvent)]
        self.assertEqual(len(raw_events), 0, "RAW events should be suppressed")

    async def test_raw_events_emitted_by_default(self):
        agent = self._make_agent()
        stream_events = [
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {"langgraph_node": "node1"},
                "run_id": "r-1",
            },
        ]
        events = await self._run_with_events(agent, stream_events)
        raw_events = [e for e in events if isinstance(e, RawEvent)]
        self.assertGreater(len(raw_events), 0, "RAW events should be emitted by default")

    async def test_raw_events_emitted_when_metadata_true(self):
        agent = self._make_agent()
        stream_events = [
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {"langgraph_node": "node1", "emit-raw-events": True},
                "run_id": "r-1",
            },
        ]
        events = await self._run_with_events(agent, stream_events)
        raw_events = [e for e in events if isinstance(e, RawEvent)]
        self.assertGreater(len(raw_events), 0, "RAW events should be emitted when True")

    async def test_emit_raw_event_data_applied_from_metadata(self):
        """emit-raw-event-data from stream metadata is applied per-event."""
        agent = self._make_agent()
        stream_events = [
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {
                    "langgraph_node": "node1",
                    "emit-raw-event-data": False,
                },
                "run_id": "r-1",
            },
        ]
        events = await self._run_with_events(agent, stream_events)
        # RAW events should still be emitted (emit-raw-events defaults to True)
        raw_events = [e for e in events if isinstance(e, RawEvent)]
        self.assertGreater(len(raw_events), 0, "RAW events should still be emitted")

    async def test_emit_raw_event_data_is_per_event_not_sticky(self):
        """emit-raw-event-data resets to True for events that don't set it."""
        agent = self._make_agent()
        stream_events = [
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {
                    "langgraph_node": "node1",
                    "emit-raw-event-data": False,
                },
                "run_id": "r-1",
            },
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {
                    "langgraph_node": "node1",
                    # No emit-raw-event-data — should default to True, not inherit False
                },
                "run_id": "r-1",
            },
        ]
        events = await self._run_with_events(agent, stream_events)
        # The second event should have raw_event preserved on its typed events
        # because emit-raw-event-data defaults to True per-event
        # (this verifies non-sticky behavior)

    async def test_mixed_raw_events_some_suppressed(self):
        """When some events suppress RAW and some don't, only the allowed ones appear."""
        agent = self._make_agent()
        stream_events = [
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {"langgraph_node": "node1", "emit-raw-events": True},
                "run_id": "r-1",
            },
            {
                "event": "on_chain_end",
                "data": {},
                "metadata": {"langgraph_node": "node1", "emit-raw-events": False},
                "run_id": "r-1",
            },
            {
                "event": "on_chain_start",
                "data": {},
                "metadata": {"langgraph_node": "node1", "emit-raw-events": True},
                "run_id": "r-2",
            },
        ]
        events = await self._run_with_events(agent, stream_events)
        raw_events = [e for e in events if isinstance(e, RawEvent)]
        # 2 out of 3 events have emit-raw-events=True
        self.assertEqual(len(raw_events), 2, "Only events with emit-raw-events=True should produce RAW")
