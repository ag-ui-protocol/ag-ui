import unittest
from types import SimpleNamespace

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


class _RecordingGraph:
    nodes = {}

    def __init__(self):
        self.stream_kwargs = None

    def get_input_jsonschema(self, config):
        return {"properties": {"messages": {}, "tools": {}}}

    def get_output_jsonschema(self, config):
        return {"properties": {"messages": {}}}

    def get_config_jsonschema(self):
        return {"properties": {"configurable": {}}}

    def astream_events(self, input, subgraphs=False, version="v2", config=None, context=None):
        self.stream_kwargs = {
            "input": input,
            "subgraphs": subgraphs,
            "version": version,
            "config": config,
            "context": context,
        }
        return object()


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


class ForwardedPropsRuntimeContextTest(unittest.IsolatedAsyncioTestCase):
    async def test_agent_facing_forwarded_props_reach_langgraph_runtime_context(self):
        graph = _RecordingGraph()
        agent = LangGraphAgent(name="test", graph=graph)
        agent.active_run = {"id": "run-1", "mode": "start"}
        run_input = SimpleNamespace(
            thread_id="thread-1",
            run_id="run-1",
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={
                "deep_thinking": True,
                "model_options": {"reasoning_effort": "high"},
                "command": {},
                "node_name": "adapter-private",
                "stream_subgraphs": False,
            },
            resume=None,
        )
        agent_state = SimpleNamespace(values={"messages": []}, tasks=[])

        await agent.prepare_stream(
            run_input,
            agent_state,
            {"configurable": {"thread_id": "thread-1", "tenant": "tenant-a"}},
        )

        self.assertEqual(
            graph.stream_kwargs["context"],
            {
                "thread_id": "thread-1",
                "tenant": "tenant-a",
                "deep_thinking": True,
                "model_options": {"reasoning_effort": "high"},
            },
        )


if __name__ == "__main__":
    unittest.main()
