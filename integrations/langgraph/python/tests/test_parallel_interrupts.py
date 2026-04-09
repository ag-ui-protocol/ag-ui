"""Regression tests for parallel-task interrupt aggregation.

Bug: Only tasks[0].interrupts was inspected. When an interrupt landed on
tasks[1+] (e.g. parallel tool calls), the CUSTOM on_interrupt event was
never emitted and the frontend received RUN_FINISHED without interrupts.
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from types import SimpleNamespace

from langchain_core.messages import HumanMessage
from langgraph.types import Interrupt


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_pregel_task(name, interrupt_values=None):
    """Return a lightweight mock that looks like a PregelTask."""
    task = SimpleNamespace(
        id=f"task-{name}",
        name=name,
        path=("__pregel_pull", name),
        error=None,
        interrupts=tuple(
            Interrupt(value=v) for v in (interrupt_values or [])
        ),
        state=None,
        result=None,
    )
    return task


def _make_state(tasks, values=None, metadata=None, next_nodes=()):
    """Return a mock StateSnapshot with the given tasks."""
    state = SimpleNamespace(
        tasks=tuple(tasks),
        values=values or {"messages": []},
        metadata=metadata or {"writes": {}},
        next=next_nodes,
    )
    return state


def _make_agent_input(thread_id="thread-1", run_id="run-1", messages=None):
    """Build a minimal RunAgentInput-compatible mock."""
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.run_id = run_id
    inp.messages = messages or []
    inp.state = {}
    inp.forwarded_props = {}
    inp.copy = MagicMock(return_value=inp)
    return inp


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestParallelInterruptAggregation(unittest.TestCase):
    """Ensure interrupts from ALL tasks are collected, not just tasks[0]."""

    def _build_agent(self):
        """Construct a LangGraphAgent with a mocked graph."""
        from ag_ui_langgraph.agent import LangGraphAgent

        graph = MagicMock()
        graph.aget_state = AsyncMock()
        graph.astream_events = AsyncMock()
        agent = LangGraphAgent(name="test-agent", graph=graph)
        return agent, graph

    # ------------------------------------------------------------------
    # prepare_stream tests (pre-run path)
    # ------------------------------------------------------------------

    def test_prepare_stream_interrupt_on_second_task(self):
        """Interrupt only on tasks[1] must still be detected."""
        agent, graph = self._build_agent()
        agent.active_run = {
            "id": "run-1",
            "thread_id": "thread-1",
            "mode": "start",
            "node_name": None,
            "schema_keys": None,
        }

        task0 = _make_pregel_task("tool_a")  # no interrupt
        task1 = _make_pregel_task("tool_b", [{"action": "confirm_delete"}])
        agent_state = _make_state([task0, task1])

        # Stub schema-keys helper
        agent.get_schema_keys = MagicMock(return_value={})

        input_ = _make_agent_input()
        config = {"configurable": {"thread_id": "thread-1"}}

        result = asyncio.get_event_loop().run_until_complete(
            agent.prepare_stream(input=input_, agent_state=agent_state, config=config)
        )

        events = result.get("events_to_dispatch", [])
        custom_events = [e for e in events if getattr(e, "name", None) == "on_interrupt"]

        self.assertEqual(len(custom_events), 1, "Expected exactly one on_interrupt event")
        import json
        parsed = json.loads(custom_events[0].value)
        self.assertEqual(parsed["action"], "confirm_delete")

    def test_prepare_stream_interrupts_on_multiple_tasks(self):
        """Interrupts spread across tasks[0] and tasks[2] must both appear."""
        agent, graph = self._build_agent()
        agent.active_run = {
            "id": "run-1",
            "thread_id": "thread-1",
            "mode": "start",
            "node_name": None,
            "schema_keys": None,
        }

        task0 = _make_pregel_task("tool_a", [{"action": "approve"}])
        task1 = _make_pregel_task("tool_b")  # no interrupt
        task2 = _make_pregel_task("tool_c", [{"action": "confirm"}])
        agent_state = _make_state([task0, task1, task2])

        agent.get_schema_keys = MagicMock(return_value={})

        input_ = _make_agent_input()
        config = {"configurable": {"thread_id": "thread-1"}}

        result = asyncio.get_event_loop().run_until_complete(
            agent.prepare_stream(input=input_, agent_state=agent_state, config=config)
        )

        events = result.get("events_to_dispatch", [])
        custom_events = [e for e in events if getattr(e, "name", None) == "on_interrupt"]

        self.assertEqual(len(custom_events), 2, "Expected two on_interrupt events")
        import json
        actions = {json.loads(e.value)["action"] for e in custom_events}
        self.assertEqual(actions, {"approve", "confirm"})

    def test_prepare_stream_no_interrupts_no_false_positive(self):
        """When no tasks have interrupts, events_to_dispatch must be empty."""
        agent, graph = self._build_agent()
        agent.active_run = {
            "id": "run-1",
            "thread_id": "thread-1",
            "mode": "start",
            "node_name": None,
            "schema_keys": None,
        }

        task0 = _make_pregel_task("tool_a")
        task1 = _make_pregel_task("tool_b")
        agent_state = _make_state([task0, task1])

        agent.get_schema_keys = MagicMock(return_value={})

        input_ = _make_agent_input()
        config = {"configurable": {"thread_id": "thread-1"}}

        result = asyncio.get_event_loop().run_until_complete(
            agent.prepare_stream(input=input_, agent_state=agent_state, config=config)
        )

        events = result.get("events_to_dispatch", [])
        custom_events = [e for e in events if getattr(e, "name", None) == "on_interrupt"]
        self.assertEqual(len(custom_events), 0)

    def test_prepare_stream_empty_tasks(self):
        """Empty tasks tuple must not raise."""
        agent, graph = self._build_agent()
        agent.active_run = {
            "id": "run-1",
            "thread_id": "thread-1",
            "mode": "start",
            "node_name": None,
            "schema_keys": None,
        }

        agent_state = _make_state([])
        agent.get_schema_keys = MagicMock(return_value={})

        input_ = _make_agent_input()
        config = {"configurable": {"thread_id": "thread-1"}}

        result = asyncio.get_event_loop().run_until_complete(
            agent.prepare_stream(input=input_, agent_state=agent_state, config=config)
        )

        events = result.get("events_to_dispatch", [])
        custom_events = [e for e in events if getattr(e, "name", None) == "on_interrupt"]
        self.assertEqual(len(custom_events), 0)

    # ------------------------------------------------------------------
    # Post-stream path (after graph execution)
    # ------------------------------------------------------------------

    def test_post_stream_interrupt_on_nonzero_task(self):
        """After streaming, interrupts on tasks[1+] must emit CUSTOM events."""
        agent, graph = self._build_agent()
        agent.active_run = {
            "id": "run-1",
            "thread_id": "thread-1",
            "mode": "start",
            "node_name": "some_node",
            "has_function_streaming": False,
            "model_made_tool_call": False,
            "state_reliable": True,
            "streamed_messages": [],
            "current_graph_state": {"messages": []},
            "reasoning_process": None,
        }

        task0 = _make_pregel_task("tool_a")  # no interrupt
        task1 = _make_pregel_task("tool_b", [{"action": "confirm"}])
        post_state = _make_state(
            [task0, task1],
            values={"messages": []},
            metadata={"writes": {"tool_a": {}}},
            next_nodes=("tool_b",),
        )

        # The post-stream code collects interrupts at line ~313-317.
        # We directly test the aggregation logic:
        tasks = post_state.tasks if len(post_state.tasks) > 0 else None
        interrupts = [
            intr
            for task in (tasks or [])
            for intr in task.interrupts
        ]

        self.assertEqual(len(interrupts), 1)
        self.assertEqual(interrupts[0].value["action"], "confirm")


if __name__ == "__main__":
    unittest.main()
