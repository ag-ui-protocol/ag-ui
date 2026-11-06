import functools
import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import EventType, RunAgentInput, UserMessage
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from ag_ui_langgraph.agent import LangGraphAgent
from tests._helpers import make_agent


class _GraphWithNamedContext:
    nodes = {}

    def astream_events(self, input, subgraphs=False, version="v2", context=None):
        raise NotImplementedError


class _GraphWithKwargs:
    nodes = {}

    def astream_events(self, *args, **kwargs):
        raise NotImplementedError


class _GraphWithoutContext:
    nodes = {}

    def astream_events(self, input, subgraphs=False, version="v2"):
        raise NotImplementedError


class _GraphWithNamedDurability:
    nodes = {}

    def astream_events(self, input, subgraphs=False, version="v2", durability=None):
        raise NotImplementedError


class GetStreamKwargsTest(unittest.TestCase):
    def test_merges_context_for_named_context_parameter(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithNamedContext())

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-1", "tenant": "from-config"}},
            context={"tenant": "from-context", "locale": "en"},
        )

        self.assertEqual(
            kwargs["context"],
            {"thread_id": "t-1", "tenant": "from-context", "locale": "en"},
        )

    def test_merges_context_for_kwargs_signature(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs())

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-2"}},
            context={"locale": "en"},
        )

        self.assertEqual(kwargs["context"], {"thread_id": "t-2", "locale": "en"})

    def test_omits_context_for_older_signature(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithoutContext())

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-3"}},
            context={"locale": "en"},
        )

        self.assertNotIn("context", kwargs)
        self.assertEqual(kwargs["config"], {"configurable": {"thread_id": "t-3"}})


class GetStreamKwargsDurabilityTest(unittest.TestCase):
    def test_omits_durability_by_default(self):
        # Nothing chosen: LangGraph keeps its own default ("async").
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs())

        kwargs = agent.get_stream_kwargs(input={"messages": []})

        self.assertNotIn("durability", kwargs)

    def test_forwards_durability_for_kwargs_signature(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs())

        kwargs = agent.get_stream_kwargs(input={"messages": []}, durability="exit")

        self.assertEqual(kwargs["durability"], "exit")

    def test_forwards_durability_for_named_parameter(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithNamedDurability())

        kwargs = agent.get_stream_kwargs(input={"messages": []}, durability="sync")

        self.assertEqual(kwargs["durability"], "sync")

    def test_constructor_durability_is_the_default(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs(), durability="exit")

        self.assertEqual(agent.get_stream_kwargs(input={})["durability"], "exit")
        self.assertEqual(
            agent.get_stream_kwargs(input={}, durability="sync")["durability"], "sync"
        )

    def test_omits_durability_for_older_signature(self):
        # A graph that cannot take the kwarg would raise TypeError on every
        # run; it is dropped with a warning instead.
        agent = LangGraphAgent(name="test", graph=_GraphWithoutContext(), durability="exit")

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as logs:
            kwargs = agent.get_stream_kwargs(input={"messages": []})

        self.assertNotIn("durability", kwargs)
        self.assertIn("durability", logs.output[0])

    def test_real_compiled_graph_accepts_durability(self):
        graph = StateGraph(MessagesState)
        graph.add_node("noop", lambda state: {})
        graph.add_edge(START, "noop")
        agent = LangGraphAgent(name="test", graph=graph.compile())

        kwargs = agent.get_stream_kwargs(input={}, durability="exit")

        self.assertEqual(kwargs["durability"], "exit")

    def test_invalid_constructor_durability_raises(self):
        with self.assertRaisesRegex(ValueError, "durability must be one of"):
            LangGraphAgent(name="test", graph=_GraphWithKwargs(), durability="never")


class ResolveDurabilityTest(unittest.TestCase):
    def test_forwarded_props_override_constructor(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs(), durability="sync")

        self.assertEqual(agent._resolve_durability({"durability": "exit"}), "exit")

    def test_falls_back_to_constructor(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs(), durability="sync")

        self.assertEqual(agent._resolve_durability({}), "sync")
        self.assertEqual(agent._resolve_durability(None), "sync")
        self.assertEqual(agent._resolve_durability({"durability": None}), "sync")

    def test_invalid_forwarded_durability_raises(self):
        agent = LangGraphAgent(name="test", graph=_GraphWithKwargs())

        with self.assertRaisesRegex(ValueError, "forwardedProps.durability"):
            agent._resolve_durability({"durability": "EXIT"})


def _make_state(messages):
    state = MagicMock()
    state.values = {"messages": messages}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    return state


def _make_input(forwarded_props):
    inp = MagicMock()
    inp.thread_id = "t1"
    inp.messages = [UserMessage(id="h1", role="user", content="hi")]
    inp.state = {}
    inp.tools = []
    inp.context = []
    inp.run_id = "run-1"
    inp.forwarded_props = forwarded_props
    inp.resume = None
    return inp


class PrepareStreamDurabilityTest(unittest.IsolatedAsyncioTestCase):
    def _agent(self, **agent_kwargs):
        agent = make_agent(**agent_kwargs)
        agent.active_run = {"id": "run-1", "mode": "start"}
        return agent

    async def test_forwarded_durability_reaches_astream_events_not_graph_input(self):
        agent = self._agent()

        await agent.prepare_stream(
            _make_input({"durability": "exit", "custom": "kept"}),
            _make_state([]),
            {"configurable": {"thread_id": "t1"}},
        )

        kwargs = agent.graph.astream_events.call_args.kwargs
        self.assertEqual(kwargs["durability"], "exit")
        self.assertNotIn("durability", kwargs["input"])
        # Other forwarded props still reach the graph input as before.
        self.assertEqual(kwargs["input"]["custom"], "kept")

    async def test_no_durability_by_default(self):
        agent = self._agent()

        await agent.prepare_stream(
            _make_input({}), _make_state([]), {"configurable": {"thread_id": "t1"}}
        )

        self.assertNotIn("durability", agent.graph.astream_events.call_args.kwargs)

    async def test_invalid_forwarded_durability_fails_before_any_write(self):
        agent = self._agent()
        agent.active_run["mode"] = "continue"

        with self.assertRaisesRegex(ValueError, "forwardedProps.durability"):
            await agent.prepare_stream(
                _make_input({"durability": "never"}),
                _make_state([]),
                {"configurable": {"thread_id": "t1"}},
            )

        agent.graph.aupdate_state.assert_not_called()
        agent.graph.astream_events.assert_not_called()

    async def test_regenerate_stream_forwards_durability(self):
        agent = self._agent(durability="sync")
        snapshot = MagicMock()
        snapshot.config = {"configurable": {"thread_id": "t1", "checkpoint_id": "cp"}}
        snapshot.values = {"messages": [HumanMessage(id="h1", content="hi")]}
        snapshot.next = ("agent",)
        agent.get_checkpoint_before_message = AsyncMock(return_value=snapshot)
        agent.graph.aupdate_state = AsyncMock(
            return_value={"configurable": {"thread_id": "t1", "checkpoint_id": "fork"}}
        )
        agent.langgraph_default_merge_state = MagicMock(return_value={"messages": []})

        await agent.prepare_regenerate_stream(
            _make_input({"durability": "exit"}),
            HumanMessage(id="h1", content="hi"),
            {"configurable": {"thread_id": "t1"}},
        )

        self.assertEqual(agent.graph.astream_events.call_args.kwargs["durability"], "exit")


class RunDurabilityTest(unittest.IsolatedAsyncioTestCase):
    """End to end against a real graph with a declared subgraph."""

    def _agent(self):
        sub = StateGraph(MessagesState)
        sub.add_node("inner", lambda state: {"messages": [AIMessage(id="a1", content="sub")]})
        sub.add_edge(START, "inner")
        sub.add_edge("inner", END)

        graph = StateGraph(MessagesState)
        graph.add_node("sub", sub.compile())
        graph.add_node("after", lambda state: {"messages": [AIMessage(id="a2", content="done")]})
        graph.add_edge(START, "sub")
        graph.add_edge("sub", "after")
        graph.add_edge("after", END)
        agent = LangGraphAgent(name="test", graph=graph.compile(checkpointer=MemorySaver()))

        # Record what reaches LangGraph; functools.wraps keeps the signature
        # the adapter probes.
        self.stream_kwargs = []
        original = agent.graph.astream_events

        @functools.wraps(original)
        def spy(*args, **kwargs):
            self.stream_kwargs.append(kwargs)
            return original(*args, **kwargs)

        agent.graph.astream_events = spy
        return agent

    def _input(self, forwarded_props):
        return RunAgentInput(
            thread_id="thread-durability",
            run_id="run-durability",
            state={},
            tools=[],
            context=[],
            forwarded_props=forwarded_props,
            messages=[UserMessage(id="u1", role="user", content="hi")],
        )

    async def test_exit_durability_runs_without_stale_mid_run_snapshots(self):
        agent = self._agent()

        events = [e async for e in agent.run(self._input({"durability": "exit"}))]

        self.assertEqual(self.stream_kwargs[0]["durability"], "exit")
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        self.assertGreaterEqual(len(snapshots), 1)
        # Under "exit" a mid-run checkpoint read returns the pre-run state,
        # which would drop this run's own user message from the snapshot.
        for snapshot in snapshots:
            self.assertIn("u1", [m.id for m in snapshot.messages])
        self.assertEqual([m.id for m in snapshots[-1].messages], ["u1", "a1", "a2"])

    async def test_invalid_forwarded_durability_is_a_run_error(self):
        agent = self._agent()

        events = [e async for e in agent.run(self._input({"durability": "never"}))]

        self.assertEqual(
            [e.type for e in events], [EventType.RUN_STARTED, EventType.RUN_ERROR]
        )
        self.assertIn("forwardedProps.durability", events[-1].message)
        self.assertEqual(self.stream_kwargs, [])


if __name__ == "__main__":
    unittest.main()
