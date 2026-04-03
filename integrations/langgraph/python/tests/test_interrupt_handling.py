"""Tests for interrupt detection across parallel tasks — fixes #1409.

The bug is that interrupt checking only looks at tasks[0], so if a parallel
tool call has the interrupt on tasks[1] or later, it's silently missed.

These tests call the actual LangGraphAgent._collect_interrupts() method
so that reverting the fix in agent.py will cause test failures.
"""
import pytest
from unittest.mock import MagicMock
from dataclasses import dataclass, field
from typing import List, Any

from ag_ui_langgraph.agent import LangGraphAgent


@dataclass
class FakeInterrupt:
    value: Any


@dataclass
class FakeTask:
    interrupts: List[FakeInterrupt] = field(default_factory=list)


def make_agent():
    """Create a LangGraphAgent with a mock graph."""
    mock_graph = MagicMock()
    return LangGraphAgent(name="test", graph=mock_graph)


class TestCollectInterrupts:
    """Test LangGraphAgent._collect_interrupts() across all tasks."""

    def test_single_task_with_interrupt(self):
        agent = make_agent()
        tasks = [FakeTask(interrupts=[FakeInterrupt(value="please confirm")])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1
        assert interrupts[0].value == "please confirm"

    def test_single_task_without_interrupt(self):
        agent = make_agent()
        tasks = [FakeTask(interrupts=[])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 0

    def test_multiple_tasks_interrupt_on_second(self):
        """Bug #1409: interrupt on tasks[1] must be detected."""
        agent = make_agent()
        tasks = [
            FakeTask(interrupts=[]),
            FakeTask(interrupts=[FakeInterrupt(value="confirm action B")]),
        ]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1, "Interrupt on tasks[1] must be detected (issue #1409)"
        assert interrupts[0].value == "confirm action B"

    def test_multiple_tasks_interrupt_on_third(self):
        agent = make_agent()
        tasks = [
            FakeTask(interrupts=[]),
            FakeTask(interrupts=[]),
            FakeTask(interrupts=[FakeInterrupt(value="confirm C")]),
        ]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1

    def test_multiple_tasks_multiple_interrupts(self):
        """Interrupts on multiple tasks should all be collected."""
        agent = make_agent()
        tasks = [
            FakeTask(interrupts=[FakeInterrupt(value="A")]),
            FakeTask(interrupts=[FakeInterrupt(value="B")]),
        ]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 2
        values = [i.value for i in interrupts]
        assert "A" in values
        assert "B" in values

    def test_empty_tasks(self):
        """Empty tasks list should return empty without crashing."""
        agent = make_agent()
        interrupts = agent._collect_interrupts([])
        assert len(interrupts) == 0

    def test_none_tasks(self):
        """None tasks should return empty without crashing."""
        agent = make_agent()
        interrupts = agent._collect_interrupts(None)
        assert len(interrupts) == 0

    def test_all_tasks_without_interrupts(self):
        agent = make_agent()
        tasks = [FakeTask(interrupts=[]), FakeTask(interrupts=[])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 0
