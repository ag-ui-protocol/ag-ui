import asyncio
import unittest
from dataclasses import dataclass, field
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

from ag_ui_langgraph.agent import LangGraphAgent


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


@dataclass
class _DataclassContext:
    user_id: str = "anonymous"
    cache: dict = field(default_factory=dict, init=False)


class _TypedDictContext(TypedDict, total=False):
    user_id: str


def _graph_with_context(context_schema):
    class _Graph(_GraphWithNamedContext):
        pass

    _Graph.context_schema = context_schema
    return _Graph()


class GetStreamKwargsContextSchemaTest(unittest.TestCase):
    def test_dataclass_context_keeps_only_declared_init_fields(self):
        agent = LangGraphAgent(name="test", graph=_graph_with_context(_DataclassContext))
        config = {"configurable": {"thread_id": "t-4", "user_id": "u-1", "cache": {}}}

        kwargs = agent.get_stream_kwargs(input={"messages": []}, config=config)

        self.assertEqual(kwargs["context"], {"user_id": "u-1"})
        self.assertEqual(kwargs["config"]["configurable"]["thread_id"], "t-4")

    def test_dataclass_context_omitted_when_no_field_matches(self):
        agent = LangGraphAgent(name="test", graph=_graph_with_context(_DataclassContext))

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-5"}},
        )

        self.assertNotIn("context", kwargs)

    def test_explicit_context_overrides_filtered_configurable(self):
        agent = LangGraphAgent(name="test", graph=_graph_with_context(_DataclassContext))

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-6", "user_id": "u-1"}},
            context={"user_id": "u-2"},
        )

        self.assertEqual(kwargs["context"], {"user_id": "u-2"})

    def test_typeddict_context_passes_configurable_through(self):
        agent = LangGraphAgent(name="test", graph=_graph_with_context(_TypedDictContext))

        kwargs = agent.get_stream_kwargs(
            input={"messages": []},
            config={"configurable": {"thread_id": "t-7", "user_id": "u-3"}},
        )

        self.assertEqual(kwargs["context"], {"thread_id": "t-7", "user_id": "u-3"})


class _State(TypedDict):
    seen: str


def _read_context(state: _State, runtime: Runtime[_DataclassContext]):
    return {"seen": runtime.context.user_id}


class DataclassContextGraphTest(unittest.TestCase):
    def test_compiled_graph_with_dataclass_context_runs(self):
        builder = StateGraph(_State, context_schema=_DataclassContext)
        builder.add_node("read_context", _read_context)
        builder.add_edge(START, "read_context")
        builder.add_edge("read_context", END)
        agent = LangGraphAgent(name="test", graph=builder.compile())

        kwargs = agent.get_stream_kwargs(
            input={"seen": ""},
            config={"configurable": {"thread_id": "t-8", "user_id": "u-4"}},
        )

        async def run():
            return [event async for event in agent.graph.astream_events(**kwargs)]

        events = asyncio.run(run())
        end = [e for e in events if e["event"] == "on_chain_end" and e["name"] == "LangGraph"]
        self.assertEqual(end[-1]["data"]["output"], {"seen": "u-4"})


if __name__ == "__main__":
    unittest.main()
