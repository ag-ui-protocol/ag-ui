"""
Tests for LangGraphAgent get_stream_kwargs method.

Regression test for issue where fork config was incorrectly spread into kwargs
instead of being passed as config=, causing "Checkpointer requires thread_id" errors.
"""

import unittest
from unittest.mock import MagicMock

from ag_ui_langgraph.agent import LangGraphAgent


class TestGetStreamKwargs(unittest.TestCase):
    """Test get_stream_kwargs correctly handles config parameter."""

    def setUp(self):
        """Set up a mock graph for testing."""
        self.mock_graph = MagicMock()
        self.mock_graph.astream_events = MagicMock()
        self.agent = LangGraphAgent(
            name="test-agent",
            graph=self.mock_graph
        )

    def test_config_passed_as_nested_key_not_spread(self):
        """Test that config is passed as 'config' key in kwargs, not spread.

        Regression test for bug where fork=fork caused kwargs.update(fork),
        spreading {'configurable': {...}} at the top level instead of nesting
        it under 'config'.
        """
        # Simulate a forked checkpoint config (what aupdate_state returns)
        fork_config = {
            "configurable": {
                "thread_id": "test-thread-123",
                "checkpoint_id": "checkpoint-abc"
            }
        }

        kwargs = self.agent.get_stream_kwargs(
            input={"messages": []},
            config=fork_config,
            subgraphs=False,
            version="v2",
        )

        # The config should be nested under 'config' key
        self.assertIn("config", kwargs)
        self.assertEqual(kwargs["config"], fork_config)

        # 'configurable' should NOT be at the top level of kwargs
        # This was the bug: kwargs.update(fork) spread configurable to top level
        self.assertNotIn("configurable", kwargs)

    def test_config_preserves_checkpoint_id_for_time_travel(self):
        """Test that checkpoint_id is preserved for time-travel regeneration."""
        fork_config = {
            "configurable": {
                "thread_id": "my-thread",
                "checkpoint_id": "my-checkpoint"
            }
        }

        kwargs = self.agent.get_stream_kwargs(
            input=None,
            config=fork_config,
            subgraphs=False,
            version="v2",
        )

        # Verify the structure that astream_events expects
        self.assertEqual(
            kwargs["config"]["configurable"]["thread_id"],
            "my-thread"
        )
        self.assertEqual(
            kwargs["config"]["configurable"]["checkpoint_id"],
            "my-checkpoint"
        )

    def test_kwargs_without_config(self):
        """Test get_stream_kwargs works without config parameter."""
        kwargs = self.agent.get_stream_kwargs(
            input={"messages": []},
            subgraphs=True,
            version="v2",
        )

        self.assertNotIn("config", kwargs)
        self.assertNotIn("configurable", kwargs)
        self.assertEqual(kwargs["input"], {"messages": []})
        self.assertEqual(kwargs["subgraphs"], True)
        self.assertEqual(kwargs["version"], "v2")


if __name__ == "__main__":
    unittest.main()
