"""
Tests to verify that ag-ui-langgraph does not trigger deprecation warnings
from Pydantic V2 or LangGraph V1.
"""

import unittest
import warnings
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import RunAgentInput
from ag_ui_langgraph.agent import LangGraphAgent


class TestPydanticCopyDeprecation(unittest.TestCase):
    """Test that RunAgentInput.copy() deprecation is resolved."""

    def test_run_uses_model_copy_not_copy(self):
        """
        Verify that LangGraphAgent.run() uses model_copy() instead of copy()
        on the RunAgentInput pydantic model, avoiding PydanticDeprecatedSince20.
        """
        input_obj = RunAgentInput(
            thread_id="test-thread",
            run_id="test-run",
            state={},
            messages=[],
            tools=[],
            context=[],
            forwarded_props={"someProp": "value"},
        )

        # Calling .copy(update=...) triggers a DeprecationWarning in Pydantic V2
        # Calling .model_copy(update=...) does not.
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            result = input_obj.model_copy(update={"forwarded_props": {"some_prop": "value"}})
            pydantic_warnings = [
                x for x in w
                if "copy" in str(x.message).lower() and "deprecated" in str(x.message).lower()
            ]
            self.assertEqual(len(pydantic_warnings), 0, "model_copy() should not produce deprecation warnings")

        # Confirm the old .copy() method DOES produce a warning (validates our test approach)
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            _ = input_obj.copy(update={"forwarded_props": {"some_prop": "value"}})
            pydantic_warnings = [
                x for x in w
                if "copy" in str(x.message).lower() and "deprecated" in str(x.message).lower()
            ]
            self.assertGreater(len(pydantic_warnings), 0, "copy() should produce a deprecation warning")


class TestConfigSchemaDeprecation(unittest.TestCase):
    """Test that config_schema().schema() deprecation is resolved."""

    def test_get_schema_keys_uses_get_config_jsonschema(self):
        """
        Verify that get_schema_keys() uses graph.get_config_jsonschema()
        instead of graph.config_schema().schema(), avoiding both
        LangGraphDeprecatedSinceV10 and PydanticDeprecatedSince20.
        """
        mock_graph = MagicMock()
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}, "input_key": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}, "output_key": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }
        # Ensure context_schema is not present (default case)
        mock_graph.context_schema = None

        agent = LangGraphAgent(name="test", graph=mock_graph)

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            schema_keys = agent.get_schema_keys({})
            deprecation_warnings = [
                x for x in w
                if "deprecated" in str(x.message).lower()
            ]
            self.assertEqual(
                len(deprecation_warnings), 0,
                f"get_schema_keys() should not produce deprecation warnings, got: {[str(x.message) for x in deprecation_warnings]}"
            )

        # Verify get_config_jsonschema was called (not config_schema)
        mock_graph.get_config_jsonschema.assert_called_once()
        # config_schema should NOT have been called
        mock_graph.config_schema.assert_not_called()

        # Verify results are correct
        self.assertIn("configurable", schema_keys["config"])

    def test_get_schema_keys_uses_get_context_jsonschema(self):
        """
        Verify that get_schema_keys() uses graph.get_context_jsonschema()
        instead of graph.context_schema().schema() when context_schema exists.
        """
        mock_graph = MagicMock()
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }
        mock_graph.get_context_jsonschema.return_value = {
            "properties": {"user_id": {}, "session": {}}
        }

        agent = LangGraphAgent(name="test", graph=mock_graph)

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            schema_keys = agent.get_schema_keys({})
            deprecation_warnings = [
                x for x in w
                if "deprecated" in str(x.message).lower()
            ]
            self.assertEqual(
                len(deprecation_warnings), 0,
                f"get_schema_keys() should not produce deprecation warnings, got: {[str(x.message) for x in deprecation_warnings]}"
            )

        # Verify get_context_jsonschema was called
        mock_graph.get_context_jsonschema.assert_called_once()

        # Verify context keys were extracted
        self.assertIn("user_id", schema_keys["context"])
        self.assertIn("session", schema_keys["context"])

    def test_get_schema_keys_handles_no_context_schema(self):
        """
        Verify that get_schema_keys() handles the case where
        get_context_jsonschema returns None.
        """
        mock_graph = MagicMock()
        mock_graph.get_input_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_output_jsonschema.return_value = {
            "properties": {"messages": {}}
        }
        mock_graph.get_config_jsonschema.return_value = {
            "properties": {"configurable": {}}
        }
        mock_graph.get_context_jsonschema.return_value = None

        agent = LangGraphAgent(name="test", graph=mock_graph)
        schema_keys = agent.get_schema_keys({})

        self.assertEqual(schema_keys["context"], [])


if __name__ == "__main__":
    unittest.main()
