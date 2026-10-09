"""Tests for LangGraphAgent.get_schema_keys() exception handling.

The catch in get_schema_keys is intentionally narrow: it falls back to the
constant schema keys for exceptions that legitimately indicate the graph does
not expose schema introspection (AttributeError) or returned an unexpected
shape (TypeError/KeyError). Unexpected exceptions must propagate so programmer
errors and infrastructure failures are not silently swallowed.

It also covers the extra keys an agent can declare in config["schema_keys"],
which are appended to the derived keys on both the happy and fallback paths.
"""

import unittest
from typing import Any, List
from unittest.mock import MagicMock

from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from ag_ui_langgraph import LangGraphAgent


class TestGetSchemaKeysFallback(unittest.TestCase):
    """Verify narrowed exception handling in get_schema_keys."""

    def _make_agent(self, graph):
        return LangGraphAgent(name="test", graph=graph)

    def _config(self):
        return {"configurable": {"thread_id": "t1"}}

    def test_attribute_error_falls_back_and_logs_warning(self):
        """AttributeError (graph lacks introspection) -> fallback + warning."""
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.side_effect = AttributeError("no schema")
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertEqual(result["output"], agent.constant_schema_keys)
        self.assertEqual(result["config"], [])
        self.assertEqual(result["context"], [])
        joined = "\n".join(log_ctx.output)
        self.assertIn("AttributeError", joined)
        self.assertIn("no schema", joined)

    def test_type_error_on_unexpected_shape_falls_back(self):
        """TypeError from unexpected schema shape -> fallback + warning."""
        graph = MagicMock()
        graph.config_specs = []
        # Return something that breaks `"properties" in input_schema`.
        graph.get_input_jsonschema.return_value = 42
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertIn("TypeError", "\n".join(log_ctx.output))

    def test_key_error_falls_back(self):
        """KeyError (missing expected key) -> fallback + warning."""
        graph = MagicMock()
        graph.config_specs = []

        def raise_key_error(_config):
            raise KeyError("properties")

        graph.get_input_jsonschema.side_effect = raise_key_error
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertIn("KeyError", "\n".join(log_ctx.output))

    def test_unexpected_exception_propagates(self):
        """RuntimeError (not a legitimate fallback) must propagate, not be swallowed."""
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.side_effect = RuntimeError("boom")
        agent = self._make_agent(graph)

        with self.assertRaises(RuntimeError):
            agent.get_schema_keys(self._config())

    def test_value_error_falls_back(self):
        """ValueError (Pydantic v2 raises it via PydanticUserError /
        PydanticSchemaGenerationError when a schema model can't be
        built for runtime-only types) must fall back to defaults, not
        propagate.
        """
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.side_effect = ValueError("bad value")
        agent = self._make_agent(graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            result = agent.get_schema_keys(self._config())

        self.assertEqual(result["input"], agent.constant_schema_keys)
        self.assertIn("ValueError", "\n".join(log_ctx.output))

    def test_happy_path_no_warning(self):
        """Well-formed schemas return extracted keys and emit no warning."""
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.return_value = {"properties": {"foo": {}, "bar": {}}}
        graph.get_output_jsonschema.return_value = {"properties": {"baz": {}}}
        # Production now prefers the non-deprecated get_config_jsonschema().
        graph.get_config_jsonschema.return_value = {"properties": {"cfg": {}}}
        # context_schema is optional; set it to None so the hasattr branch short-circuits.
        graph.context_schema = None
        agent = self._make_agent(graph)

        with self.assertNoLogs("ag_ui_langgraph.agent", level="WARNING"):
            result = agent.get_schema_keys(self._config())

        self.assertEqual(
            result["input"],
            ["foo", "bar", *agent.constant_schema_keys],
        )
        self.assertEqual(
            result["output"],
            ["baz", *agent.constant_schema_keys],
        )
        self.assertEqual(result["config"], ["cfg"])
        self.assertEqual(result["context"], [])


def _introspectable_graph():
    """A mock graph declaring `question` on input and `answer` on output."""
    graph = MagicMock()
    graph.config_specs = []
    graph.get_input_jsonschema.return_value = {"properties": {"question": {}}}
    graph.get_output_jsonschema.return_value = {"properties": {"answer": {}}}
    graph.get_config_jsonschema.return_value = {"properties": {"thread_id": {}}}
    graph.context_schema = None
    return graph


class TestConfiguredSchemaKeys(unittest.TestCase):
    """get_schema_keys merges keys declared in config["schema_keys"]."""

    def _make_agent(self, config=None, graph=None):
        return LangGraphAgent(name="test", graph=graph or _introspectable_graph(), config=config)

    def test_configured_output_key_is_appended(self):
        """A key only declared in config joins the derived output keys, after them."""
        agent = self._make_agent({"schema_keys": {"output": ["steps"]}})

        result = agent.get_schema_keys({})

        self.assertEqual(result["output"], ["answer", "messages", "tools", "steps"])

    def test_unmentioned_buckets_keep_derived_keys(self):
        """Declaring output keys must not disturb input, config or context."""
        agent = self._make_agent({"schema_keys": {"output": ["steps"]}})

        result = agent.get_schema_keys({})

        self.assertEqual(result["input"], ["question", "messages", "tools"])
        self.assertEqual(result["config"], ["thread_id"])
        self.assertEqual(result["context"], [])

    def test_all_buckets_can_be_configured(self):
        """input, output, config and context are each mergeable."""
        agent = self._make_agent(
            {"schema_keys": {"input": ["a"], "output": ["b"], "config": ["c"], "context": ["d"]}}
        )

        result = agent.get_schema_keys({})

        self.assertEqual(
            result,
            {
                "input": ["question", "messages", "tools", "a"],
                "output": ["answer", "messages", "tools", "b"],
                "config": ["thread_id", "c"],
                "context": ["d"],
            },
        )

    def test_configured_keys_are_not_duplicated(self):
        """A key the graph already exposes, or one listed twice, appears once."""
        agent = self._make_agent({"schema_keys": {"output": ["answer", "tools", "steps", "steps"]}})

        result = agent.get_schema_keys({})

        self.assertEqual(result["output"], ["answer", "messages", "tools", "steps"])

    def test_configured_keys_survive_introspection_fallback(self):
        """The fallback path honours configured keys without mutating the constants."""
        graph = MagicMock()
        graph.config_specs = []
        graph.get_input_jsonschema.side_effect = AttributeError("no schema")
        agent = self._make_agent({"schema_keys": {"output": ["steps"], "config": ["c"]}}, graph=graph)

        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING"):
            result = agent.get_schema_keys({})

        self.assertEqual(result["input"], ["messages", "tools"])
        self.assertEqual(result["output"], ["messages", "tools", "steps"])
        self.assertEqual(result["config"], ["c"])
        # The fallback hands out constant_schema_keys itself; the merge must
        # not have appended to it.
        self.assertEqual(agent.constant_schema_keys, ["messages", "tools"])

    def test_no_config_leaves_derived_keys_untouched(self):
        """Without config["schema_keys"] the result and logs are as before."""
        with self.assertNoLogs("ag_ui_langgraph.agent", level="WARNING"):
            agent = self._make_agent()
            result = agent.get_schema_keys({})

        self.assertEqual(
            result,
            {
                "input": ["question", "messages", "tools"],
                "output": ["answer", "messages", "tools"],
                "config": ["thread_id"],
                "context": [],
            },
        )

    def test_unknown_bucket_is_ignored_with_a_warning(self):
        """A bucket get_schema_keys does not return is reported, not invented."""
        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
            agent = self._make_agent({"schema_keys": {"outputs": ["steps"]}})

        result = agent.get_schema_keys({})

        self.assertNotIn("outputs", result)
        self.assertEqual(result["output"], ["answer", "messages", "tools"])
        self.assertIn("unknown config['schema_keys'] buckets ['outputs']", "\n".join(log_ctx.output))

    def test_malformed_schema_keys_warn_and_fall_back(self):
        """Malformed config is reported at construction and never stops the agent.

        Before this option existed a stray `schema_keys` was silently ignored,
        so raising here would stop an upgraded app from booting.
        """
        cases = {
            "not-a-dict": (["steps"], "expected a dict"),
            "bucket-is-a-string": ({"output": "steps"}, "expected a list of strings"),
            "bucket-is-not-a-list": ({"output": 1}, "expected a list of strings"),
            "bucket-holds-a-non-string": ({"output": ["steps", 2]}, "expected a list of strings"),
        }
        derived = self._make_agent().get_schema_keys({})
        for case, (schema_keys, message) in cases.items():
            with self.subTest(case=case):
                with self.assertLogs("ag_ui_langgraph.agent", level="WARNING") as log_ctx:
                    agent = self._make_agent({"schema_keys": schema_keys})

                self.assertEqual(agent.get_schema_keys({}), derived)
                self.assertIn(message, "\n".join(log_ctx.output))

    def test_malformed_bucket_does_not_discard_valid_ones(self):
        """One bad bucket is skipped; the other configured buckets still apply."""
        with self.assertLogs("ag_ui_langgraph.agent", level="WARNING"):
            agent = self._make_agent({"schema_keys": {"input": "a", "output": ["steps"]}})

        result = agent.get_schema_keys({})

        self.assertEqual(result["input"], ["question", "messages", "tools"])
        self.assertEqual(result["output"], ["answer", "messages", "tools", "steps"])

    def test_configured_keys_survive_clone(self):
        """The FastAPI endpoint clones the agent per request; the keys must travel."""
        agent = self._make_agent({"schema_keys": {"output": ["steps"]}})

        result = agent.clone().get_schema_keys({})

        self.assertEqual(result["output"], ["answer", "messages", "tools", "steps"])


class TestConfiguredSchemaKeysStateSnapshot(unittest.TestCase):
    """A configured output key survives the STATE_SNAPSHOT filter on a real graph."""

    @staticmethod
    def _narrow_output_graph():
        """A graph whose state has `steps` but whose output schema does not."""

        class State(TypedDict):
            messages: List[Any]
            steps: List[str]

        class Output(TypedDict):
            messages: List[Any]

        builder = StateGraph(State, output_schema=Output)
        builder.add_node("node", lambda state: {"steps": ["research", "write"]})
        builder.add_edge(START, "node")
        builder.add_edge("node", END)
        return builder.compile()

    def _snapshot(self, state, config=None):
        agent = LangGraphAgent(name="demo", graph=self._narrow_output_graph(), config=config)
        agent.active_run = {"schema_keys": agent.get_schema_keys({})}
        return agent.get_state_snapshot(state)

    def test_configured_key_outside_output_schema_reaches_snapshot(self):
        """`steps` is absent from the output schema but declared in config."""
        snapshot = self._snapshot(
            {"messages": [], "steps": ["research", "write"]},
            config={"schema_keys": {"output": ["steps"]}},
        )

        self.assertEqual(snapshot, {"messages": [], "steps": ["research", "write"]})

    def test_key_outside_output_schema_is_filtered_without_config(self):
        """Without config, the pre-existing filtering behaviour is unchanged."""
        snapshot = self._snapshot({"messages": [], "steps": ["research", "write"]})

        self.assertEqual(snapshot, {"messages": []})

    def test_keys_outside_schema_and_config_stay_filtered(self):
        """Declaring `steps` must not turn the filter into a passthrough."""
        snapshot = self._snapshot(
            {"messages": [], "steps": [], "internal_scratchpad": "secret"},
            config={"schema_keys": {"output": ["steps"]}},
        )

        self.assertEqual(snapshot, {"messages": [], "steps": []})


if __name__ == "__main__":
    unittest.main()
