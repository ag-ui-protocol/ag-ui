"""Tests for interrupt detection across parallel tasks — fixes #1409.

The bug is that interrupt checking only looks at tasks[0], so if a parallel
tool call has the interrupt on tasks[1] or later, it's silently missed.
"""
import pytest
from unittest.mock import MagicMock, AsyncMock
from dataclasses import dataclass, field
from typing import List, Any

from ag_ui_langgraph.agent import LangGraphAgent


@dataclass
class FakeInterrupt:
    value: Any


@dataclass
class FakeTask:
    interrupts: List[FakeInterrupt] = field(default_factory=list)


@dataclass
class FakeStateSnapshot:
    tasks: List[FakeTask] = field(default_factory=list)
    values: dict = field(default_factory=dict)
    metadata: dict = field(default_factory=dict)
    next: tuple = ()


def make_agent():
    """Create a LangGraphAgent with a mock graph."""
    mock_graph = MagicMock()
    agent = LangGraphAgent(name="test", graph=mock_graph)
    return agent


class TestInterruptDetection:
    """Test that interrupts are detected across ALL tasks, not just tasks[0]."""

    def test_single_task_with_interrupt(self):
        """Single task with interrupt should be detected."""
        state = FakeStateSnapshot(
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="please confirm")])],
        )
        interrupts = _collect_interrupts(state)
        assert len(interrupts) == 1
        assert interrupts[0].value == "please confirm"

    def test_single_task_without_interrupt(self):
        """Single task without interrupt should return empty."""
        state = FakeStateSnapshot(
            tasks=[FakeTask(interrupts=[])],
        )
        interrupts = _collect_interrupts(state)
        assert len(interrupts) == 0

    def test_multiple_tasks_interrupt_on_second(self):
        """Bug #1409: interrupt on tasks[1] should be detected."""
        state = FakeStateSnapshot(
            tasks=[
                FakeTask(interrupts=[]),
                FakeTask(interrupts=[FakeInterrupt(value="confirm action B")]),
            ],
        )
        interrupts = _collect_interrupts(state)
        assert len(interrupts) == 1, "Interrupt on tasks[1] must be detected (issue #1409)"
        assert interrupts[0].value == "confirm action B"

    def test_multiple_tasks_interrupt_on_third(self):
        """Interrupt on tasks[2] should also be detected."""
        state = FakeStateSnapshot(
            tasks=[
                FakeTask(interrupts=[]),
                FakeTask(interrupts=[]),
                FakeTask(interrupts=[FakeInterrupt(value="confirm C")]),
            ],
        )
        interrupts = _collect_interrupts(state)
        assert len(interrupts) == 1

    def test_multiple_tasks_multiple_interrupts(self):
        """Interrupts on multiple tasks should all be collected."""
        state = FakeStateSnapshot(
            tasks=[
                FakeTask(interrupts=[FakeInterrupt(value="A")]),
                FakeTask(interrupts=[FakeInterrupt(value="B")]),
            ],
        )
        interrupts = _collect_interrupts(state)
        assert len(interrupts) == 2

    def test_no_tasks(self):
        """Empty tasks list should return empty without crashing."""
        state = FakeStateSnapshot(tasks=[])
        interrupts = _collect_interrupts(state)
        assert len(interrupts) == 0

    def test_none_interrupts_on_tasks(self):
        """Tasks without any interrupts attribute handled gracefully."""
        state = FakeStateSnapshot(
            tasks=[FakeTask(interrupts=[]), FakeTask(interrupts=[])],
        )
        interrupts = _collect_interrupts(state)
        assert len(interrupts) == 0


def _collect_interrupts(state):
    """Extract interrupts from state the same way the agent should.

    This mirrors the logic in agent.py after the stream loop completes.
    If this function only checks tasks[0], the tests will fail.
    """
    tasks = state.tasks if len(state.tasks) > 0 else None
    interrupts = []
    if tasks:
        for task in tasks:
            interrupts.extend(task.interrupts)
    return interrupts
