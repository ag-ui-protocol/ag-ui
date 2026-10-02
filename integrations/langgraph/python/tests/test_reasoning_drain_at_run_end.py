"""A reasoning span still open when the run ends must be closed before the terminal event.

The adapter closes a reasoning span only when the NEXT model chunk carries no
reasoning, so a model stream that stops right after a reasoning chunk (a dropped
connection the node tolerates) used to reach RUN_FINISHED with the span still open. The AG-UI client fails the run on exactly
that ("reasoning spans are still active"), so `_drain_reasoning` closes whatever
is left, per subagent lane, ahead of `drain_subagents`.
"""

import unittest
from typing import Any

from ag_ui.core import EventType, RunAgentInput, UserMessage
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from ag_ui_langgraph.agent import LangGraphAgent
from tests._helpers import make_agent, _record_dispatch

_TEXT = {"type": "text", "text": "Because X", "index": 0}


def _types(events):
    return [e.type for e in events]


class TestDrainReasoning(unittest.TestCase):
    def setUp(self):
        self.agent = _record_dispatch(make_agent())
        self.agent.active_run = {}

    def _open_span(self, **extra):
        list(self.agent.handle_reasoning_event({**_TEXT, **extra}))
        self.agent.dispatched.clear()

    def _open_message_id(self):
        return self.agent.active_run["reasoning_processes"]["__root__"]["message_id"]

    def test_open_span_is_closed_message_first_then_span(self):
        self._open_span()
        message_id = self._open_message_id()

        events = list(self.agent._drain_reasoning())

        self.assertEqual(
            _types(events), [EventType.REASONING_MESSAGE_END, EventType.REASONING_END]
        )
        self.assertEqual({e.message_id for e in events}, {message_id})
        self.assertEqual(self.agent.active_run["reasoning_processes"], {})

    def test_accumulated_signature_is_emitted_before_the_close(self):
        self._open_span(signature="sig123")

        events = list(self.agent._drain_reasoning())

        self.assertEqual(
            _types(events),
            [
                EventType.REASONING_ENCRYPTED_VALUE,
                EventType.REASONING_MESSAGE_END,
                EventType.REASONING_END,
            ],
        )
        self.assertEqual(events[0].encrypted_value, "sig123")

    def test_nothing_open_emits_nothing(self):
        self.assertEqual(list(self.agent._drain_reasoning()), [])

    def test_drain_is_idempotent(self):
        self._open_span()
        list(self.agent._drain_reasoning())
        self.assertEqual(list(self.agent._drain_reasoning()), [])

    def test_a_span_closed_by_the_stream_is_not_closed_twice(self):
        self._open_span()
        list(self.agent._close_reasoning_process(self.agent._get_reasoning_process()))
        self.agent.dispatched.clear()

        self.assertEqual(list(self.agent._drain_reasoning()), [])

    def test_stream_plus_drain_leaves_every_open_event_closed(self):
        list(self.agent.handle_reasoning_event(_TEXT))
        list(self.agent.handle_reasoning_event({**_TEXT, "text": " therefore Y"}))
        list(self.agent._drain_reasoning())

        types = _types(self.agent.dispatched)
        for opener, closer in (
            (EventType.REASONING_START, EventType.REASONING_END),
            (EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_END),
        ):
            self.assertEqual(types.count(opener), 1)
            self.assertEqual(types.count(closer), 1)

    def test_no_active_run_is_a_noop(self):
        self.agent.active_run = None
        self.assertEqual(list(self.agent._drain_reasoning()), [])


class TestDrainReasoningPerSubagentLane(unittest.TestCase):
    """Each lane's close is attributed to its own subagent and runs before that
    subagent's own SUBAGENT_FINISHED, which `drain_subagents` emits afterwards."""

    def setUp(self):
        self.agent = make_agent(subagent_visibility="attributed")
        self.agent.active_run = {"emit_subagent_events": True}

    def _open_in_lane(self, lane):
        self.agent.active_run["current_subagent_run_id"] = lane
        list(self.agent.handle_reasoning_event(_TEXT))
        self.agent.active_run["current_subagent_run_id"] = None

    def test_close_is_attributed_to_the_owning_subagent(self):
        self._open_in_lane("sub-1")

        events = list(self.agent._drain_reasoning())

        self.assertEqual(
            _types(events), [EventType.REASONING_MESSAGE_END, EventType.REASONING_END]
        )
        self.assertEqual({e.subagent_run_id for e in events}, {"sub-1"})
        self.assertEqual(self.agent.active_run["reasoning_processes"], {})
        self.assertIsNone(self.agent.active_run["current_subagent_run_id"])

    def test_root_and_subagent_lanes_close_independently(self):
        self._open_in_lane(None)
        self._open_in_lane("sub-1")

        events = list(self.agent._drain_reasoning())

        self.assertEqual(
            _types(events),
            [EventType.REASONING_MESSAGE_END, EventType.REASONING_END] * 2,
        )
        self.assertEqual(
            sorted(str(e.subagent_run_id) for e in events),
            ["None", "None", "sub-1", "sub-1"],
        )
        self.assertEqual(self.agent.active_run["reasoning_processes"], {})


class _DroppedStreamModel(BaseChatModel):
    """Streams one reasoning chunk and then fails, so no chunk after the reasoning
    ever arrives to close the span."""

    @property
    def _llm_type(self) -> str:
        return "dropped-stream"

    def _generate(self, *args: Any, **kwargs: Any) -> ChatResult:
        raise NotImplementedError

    async def _astream(self, *args: Any, **kwargs: Any):
        yield ChatGenerationChunk(
            message=AIMessageChunk(content=[{"type": "thinking", "thinking": "Let me think"}])
        )
        raise TimeoutError("stream dropped")


class TestRunFinishesAfterDroppedReasoningStream(unittest.IsolatedAsyncioTestCase):
    async def test_open_span_is_closed_before_run_finished(self):
        async def think(state, config):
            try:
                await _DroppedStreamModel().ainvoke(state["messages"], config)
            except TimeoutError:
                pass  # a node or middleware that tolerates a failed model call
            return {}

        graph = StateGraph(MessagesState)
        graph.add_node("think", think)
        graph.add_edge(START, "think")
        graph.add_edge("think", END)
        agent = LangGraphAgent(name="t", graph=graph.compile(checkpointer=MemorySaver()))
        run_input = RunAgentInput(
            thread_id="thread-reasoning",
            run_id="run-reasoning",
            state={},
            tools=[],
            context=[],
            forwarded_props={},
            messages=[UserMessage(id="u1", role="user", content="hi")],
        )

        types = [event.type async for event in agent.run(run_input)]

        for opener, closer in (
            (EventType.REASONING_START, EventType.REASONING_END),
            (EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_END),
        ):
            self.assertEqual(types.count(opener), 1)
            self.assertEqual(types.count(closer), 1)
        self.assertEqual(types[-1], EventType.RUN_FINISHED)
        self.assertLess(types.index(EventType.REASONING_END), types.index(EventType.RUN_FINISHED))


if __name__ == "__main__":
    unittest.main()
