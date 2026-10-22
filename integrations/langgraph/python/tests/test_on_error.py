"""The on_error hook chooses the RUN_ERROR for a failed run, or re-raises."""

import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent, UserMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.graph.state import CompiledStateGraph

from ag_ui_langgraph import default_on_error
from ag_ui_langgraph.agent import LangGraphAgent


class ProviderRateLimitError(Exception):
    def __init__(self, retry_after):
        super().__init__("Rate limit exceeded (request id req_abc123)")
        self.retry_after = retry_after


def _failing_graph():
    def call_model(state):
        raise ProviderRateLimitError(retry_after=30.0)

    graph = StateGraph(MessagesState)
    graph.add_node("model", call_model)
    graph.add_edge(START, "model")
    graph.add_edge("model", END)
    return graph.compile(checkpointer=MemorySaver())


def _mock_graph():
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    state = MagicMock()
    state.values = {"messages": []}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=state)
    return graph


def _input():
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hi")],
        tools=[],
        context=[],
        forwarded_props={},
    )


class Recorder:
    """An on_error hook that records each call and delegates to ``respond``."""

    def __init__(self, respond):
        self.calls = []
        self.respond = respond

    def __call__(self, exc):
        self.calls.append(exc)
        return self.respond(exc)


def _rate_limited_event(exc):
    return RunErrorEvent(
        type=EventType.RUN_ERROR, message="The model is busy.", code="rate_limited"
    )


def _reraise(exc):
    raise exc


class TestOnErrorHook(unittest.IsolatedAsyncioTestCase):
    async def test_returned_event_replaces_the_default(self):
        hook = Recorder(_rate_limited_event)
        agent = LangGraphAgent(name="t", graph=_failing_graph(), on_error=hook)

        events = [e async for e in agent.run(_input())]

        self.assertEqual(events[0].type, EventType.RUN_STARTED)
        self.assertEqual(
            [e.type for e in events if e.type in (EventType.RUN_ERROR, EventType.RUN_FINISHED)],
            [EventType.RUN_ERROR],
        )
        self.assertEqual(events[-1].message, "The model is busy.")
        self.assertEqual(events[-1].code, "rate_limited")
        self.assertEqual(len(hook.calls), 1)
        self.assertIsInstance(hook.calls[0], ProviderRateLimitError)
        self.assertEqual(hook.calls[0].retry_after, 30.0)

    async def test_reraising_propagates_the_original_exception(self):
        hook = Recorder(_reraise)
        agent = LangGraphAgent(name="t", graph=_failing_graph(), on_error=hook)

        events = []
        with self.assertRaises(ProviderRateLimitError) as ctx:
            async for event in agent.run(_input()):
                events.append(event)

        self.assertEqual(ctx.exception.retry_after, 30.0)
        self.assertNotIn(EventType.RUN_ERROR, [e.type for e in events])
        self.assertEqual(len(hook.calls), 1)

    async def test_reraising_before_the_run_starts_emits_nothing(self):
        agent = LangGraphAgent(name="t", graph=_failing_graph(), on_error=_reraise)
        agent.prepare_stream = AsyncMock(side_effect=ValueError("bad input"))

        events = []
        with self.assertRaisesRegex(ValueError, "bad input"):
            async for event in agent.run(_input()):
                events.append(event)

        self.assertEqual(events, [])

    async def test_raising_a_different_exception_propagates_it(self):
        def wrap(exc):
            raise RuntimeError("wrapped") from exc

        hook = Recorder(wrap)
        agent = LangGraphAgent(name="t", graph=_failing_graph(), on_error=hook)

        with self.assertRaisesRegex(RuntimeError, "wrapped") as ctx:
            _ = [e async for e in agent.run(_input())]

        self.assertIsInstance(ctx.exception.__cause__, ProviderRateLimitError)
        self.assertEqual(len(hook.calls), 1)

    async def test_hook_can_fall_back_to_the_default(self):
        def classify(exc):
            if isinstance(exc, ProviderRateLimitError):
                return _rate_limited_event(exc)
            return default_on_error(exc)

        agent = LangGraphAgent(name="t", graph=_failing_graph(), on_error=classify)
        agent.prepare_stream = AsyncMock(side_effect=ValueError("bad input"))

        events = [e async for e in agent.run(_input())]

        self.assertEqual([e.type for e in events], [EventType.RUN_STARTED, EventType.RUN_ERROR])
        self.assertEqual(events[-1].message, "bad input")


class Narrow(LangGraphAgent):
    """A subclass that predates on_error, like copilotkit's LangGraphAGUIAgent."""

    def __init__(self, *, name, graph, description=None, config=None):
        super().__init__(name=name, graph=graph, description=description, config=config)


class TestOnErrorClone(unittest.TestCase):
    def test_clone_keeps_the_hook(self):
        agent = LangGraphAgent(name="t", graph=_mock_graph(), on_error=_reraise)
        self.assertIs(agent.clone().on_error, _reraise)

    def test_narrow_subclass_clones_with_the_default_hook(self):
        self.assertIs(Narrow(name="t", graph=_mock_graph()).clone().on_error, default_on_error)

    def test_clone_refuses_to_drop_a_custom_hook(self):
        agent = Narrow(name="t", graph=_mock_graph())
        agent.on_error = _reraise
        with self.assertRaisesRegex(TypeError, "on_error"):
            agent.clone()


if __name__ == "__main__":
    unittest.main()
