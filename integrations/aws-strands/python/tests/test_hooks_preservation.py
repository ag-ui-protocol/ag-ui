"""Tests for hooks preservation across thread instances in StrandsAgent."""

import asyncio
import unittest
from typing import Any, Dict, List
from unittest.mock import MagicMock, Mock

from strands import Agent as StrandsAgentCore

from ag_ui_strands.agent import StrandsAgent
from ag_ui.core import RunAgentInput


class MockHookProvider:
    """Mock hook provider for testing."""

    def __init__(self):
        self.events_captured = []

    def __call__(self, event: Any) -> None:
        """Capture events for verification."""
        self.events_captured.append(event)


class TestHooksPreservation(unittest.TestCase):
    """Test cases for hooks preservation across threads."""

    def setUp(self):
        """Set up test fixtures."""
        # Create a mock Strands agent
        self.mock_strands_agent = Mock(spec=StrandsAgentCore)
        self.mock_strands_agent.model = "test-model"
        self.mock_strands_agent.system_prompt = "test prompt"
        self.mock_strands_agent.tool_registry = Mock()
        self.mock_strands_agent.tool_registry.registry = {}
        self.mock_strands_agent.record_direct_tool_call = True

    def test_hooks_preserved_across_threads(self):
        """Test that hooks are preserved when creating new thread instances."""
        # Create hook providers
        hook1 = MockHookProvider()
        hook2 = MockHookProvider()
        hooks = [hook1, hook2]

        # Create StrandsAgent with hooks
        agent = StrandsAgent(
            agent=self.mock_strands_agent,
            name="test-agent",
            description="Test agent",
            hooks=hooks,
        )

        # Verify hooks are stored
        self.assertEqual(agent._hooks, hooks)
        self.assertEqual(len(agent._hooks), 2)

    def test_backward_compatibility_without_hooks(self):
        """Test that StrandsAgent works without hooks parameter (backward compatibility)."""
        # Create StrandsAgent without hooks
        agent = StrandsAgent(
            agent=self.mock_strands_agent,
            name="test-agent",
            description="Test agent",
        )

        # Verify hooks default to empty list
        self.assertEqual(agent._hooks, [])

    def test_hooks_passed_to_thread_instances(self):
        """Test that hooks are passed to new per-thread agent instances."""
        # Create hook providers
        hook1 = MockHookProvider()
        hooks = [hook1]

        # Create StrandsAgent with hooks
        agent = StrandsAgent(
            agent=self.mock_strands_agent,
            name="test-agent",
            description="Test agent",
            hooks=hooks,
        )

        # Mock the StrandsAgentCore constructor to capture arguments
        original_strands_agent_core = StrandsAgentCore
        created_agents = []

        def mock_strands_agent_core(*args, **kwargs):
            """Capture created agent arguments."""
            mock_agent = Mock(spec=StrandsAgentCore)
            mock_agent.model = kwargs.get("model")
            mock_agent.system_prompt = kwargs.get("system_prompt")
            mock_agent.tools = kwargs.get("tools", [])
            mock_agent.hooks = kwargs.get("hooks", [])
            mock_agent.stream_async = Mock(return_value=self._mock_async_generator())
            created_agents.append({"args": args, "kwargs": kwargs, "agent": mock_agent})
            return mock_agent

        # Patch StrandsAgentCore temporarily
        import ag_ui_strands.agent as agent_module

        original_core = agent_module.StrandsAgentCore
        agent_module.StrandsAgentCore = mock_strands_agent_core

        try:
            # Create input for first thread
            input1 = RunAgentInput(
                thread_id="thread-1",
                run_id="run-1",
                messages=[],
                state={},
                tools=[],
                context=[],
                forwarded_props={},
            )

            # Run agent for first thread
            async def run_test_thread1():
                result = []
                async for event in agent.run(input1):
                    result.append(event)
                return result

            asyncio.run(run_test_thread1())

            # Verify hooks were passed to the new agent instance
            self.assertEqual(len(created_agents), 1)
            self.assertIn("hooks", created_agents[0]["kwargs"])
            self.assertEqual(created_agents[0]["kwargs"]["hooks"], hooks)

            # Create input for second thread
            input2 = RunAgentInput(
                thread_id="thread-2",
                run_id="run-2",
                messages=[],
                state={},
                tools=[],
                context=[],
                forwarded_props={},
            )

            # Run agent for second thread
            async def run_test_thread2():
                result = []
                async for event in agent.run(input2):
                    result.append(event)
                return result

            asyncio.run(run_test_thread2())

            # Verify hooks were passed to the second agent instance too
            self.assertEqual(len(created_agents), 2)
            self.assertIn("hooks", created_agents[1]["kwargs"])
            self.assertEqual(created_agents[1]["kwargs"]["hooks"], hooks)

        finally:
            # Restore original StrandsAgentCore
            agent_module.StrandsAgentCore = original_core

    async def _mock_async_generator(self):
        """Mock async generator for agent stream."""
        yield {"complete": True}

    def test_empty_hooks_list_passed_correctly(self):
        """Test that explicitly passing empty hooks list works correctly."""
        # Create StrandsAgent with explicit empty hooks
        agent = StrandsAgent(
            agent=self.mock_strands_agent,
            name="test-agent",
            description="Test agent",
            hooks=[],
        )

        # Verify hooks are empty list
        self.assertEqual(agent._hooks, [])


if __name__ == "__main__":
    unittest.main()
