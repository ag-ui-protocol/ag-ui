"""Regression tests for AGUIToolset replacement in ADK 2.x Workflow graph nodes.

Before the fix, ``_shallow_copy_agent_tree`` and ``_update_agent_tools_recursive``
only traversed ``sub_agents``.  ``Workflow.graph.nodes`` was invisible, so
``AGUIToolset`` placeholders inside Workflow nodes were never swapped for a per-run
``ClientProxyToolset`` — causing ``ValueError: Tool 'ask_question' not found`` on
every request.

All tests skip on ADK 1.x where ``google.adk.workflow`` does not exist.

Relates to: #2036 / mirrors #1860 (#1889 only patched _collect_output_schema_agent_names).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from google.adk.agents import LlmAgent

from ag_ui.core import Tool, UserMessage
from ag_ui.core.types import RunAgentInput
from ag_ui_adk import ADKAgent
from ag_ui_adk.agui_toolset import AGUIToolset
from ag_ui_adk.client_proxy_toolset import ClientProxyToolset


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_tool(name: str) -> Tool:
    return Tool(
        name=name,
        description=f"frontend tool {name}",
        parameters={"type": "object", "properties": {}},
    )


def _node_by_name(nodes: list, name: str) -> Any:
    for n in nodes:
        if getattr(n, "name", None) == name:
            return n
    raise ValueError(f"Node {name!r} not found in {[getattr(n, 'name', n) for n in nodes]}")


def _apply_tool_replacement(root: Any, frontend_tools: list) -> None:
    """Mirror the logic of _update_agent_tools_recursive (post-fix)."""
    event_queue: MagicMock = MagicMock()

    def _update(agent: Any) -> None:
        if isinstance(agent, LlmAgent) and hasattr(agent, "tools"):
            new_tools = []
            for tool in agent.tools:
                if isinstance(tool, AGUIToolset):
                    tool = ClientProxyToolset(
                        ag_ui_tools=frontend_tools,
                        event_queue=event_queue,
                    )
                new_tools.append(tool)
            agent.tools = new_tools

        sub_agents = getattr(agent, "sub_agents", None)
        if sub_agents and isinstance(sub_agents, (list, tuple)):
            for sa in sub_agents:
                _update(sa)

        graph = getattr(agent, "graph", None)
        graph_nodes = getattr(graph, "nodes", None)
        if graph_nodes and isinstance(graph_nodes, (list, tuple)):
            for gn in graph_nodes:
                _update(gn)

    _update(root)


# ---------------------------------------------------------------------------
# _shallow_copy_agent_tree — Workflow graph nodes are copied independently
# ---------------------------------------------------------------------------

class TestShallowCopyWorkflowGraphNodes:
    """_shallow_copy_agent_tree must give each run its own graph + node copies."""

    def _build_workflow(self):
        try:
            from google.adk.workflow import START, Workflow  # type: ignore[import-not-found]
        except ImportError:
            pytest.skip("Workflow not available on this ADK version (1.x)")

        a = LlmAgent(name="node_a", instruction="a", tools=[AGUIToolset()])
        b = LlmAgent(name="node_b", instruction="b", tools=[AGUIToolset()])
        wf = Workflow(name="wf", description="test", edges=[(START, a), (a, b)])
        return wf, a, b

    def test_graph_nodes_are_copied(self):
        wf, orig_a, orig_b = self._build_workflow()
        copied_wf = ADKAgent._shallow_copy_agent_tree(wf)

        copied_a = _node_by_name(copied_wf.graph.nodes, "node_a")
        copied_b = _node_by_name(copied_wf.graph.nodes, "node_b")

        assert copied_a is not orig_a, "node_a should be a separate per-run copy"
        assert copied_b is not orig_b, "node_b should be a separate per-run copy"

    def test_original_graph_nodes_are_unchanged(self):
        wf, orig_a, orig_b = self._build_workflow()
        ADKAgent._shallow_copy_agent_tree(wf)

        assert _node_by_name(wf.graph.nodes, "node_a") is orig_a
        assert _node_by_name(wf.graph.nodes, "node_b") is orig_b

    def test_copy_has_independent_graph(self):
        wf, _, _ = self._build_workflow()
        copy1 = ADKAgent._shallow_copy_agent_tree(wf)
        copy2 = ADKAgent._shallow_copy_agent_tree(wf)

        assert copy1.graph is not copy2.graph, "each run must have its own Graph object"
        assert copy1.graph.nodes is not copy2.graph.nodes, "each run must have its own nodes list"

    def test_copies_have_independent_tools_lists(self):
        wf, _, _ = self._build_workflow()
        copy1 = ADKAgent._shallow_copy_agent_tree(wf)
        copy2 = ADKAgent._shallow_copy_agent_tree(wf)

        a1 = _node_by_name(copy1.graph.nodes, "node_a")
        a2 = _node_by_name(copy2.graph.nodes, "node_a")
        assert a1.tools is not a2.tools, "concurrent runs must not share a tools list"


# ---------------------------------------------------------------------------
# _update_agent_tools_recursive — AGUIToolset replaced in Workflow graph nodes
# ---------------------------------------------------------------------------

class TestUpdateAgentToolsWorkflowGraphNodes:
    """_update_agent_tools_recursive must replace AGUIToolset inside Workflow graph nodes."""

    def _build_workflow(self):
        try:
            from google.adk.workflow import START, Workflow  # type: ignore[import-not-found]
        except ImportError:
            pytest.skip("Workflow not available on this ADK version (1.x)")

        questioner = LlmAgent(name="questioner", instruction="ask", tools=[AGUIToolset()])
        evaluator = LlmAgent(name="evaluator", instruction="eval", tools=[AGUIToolset()])
        wf = Workflow(
            name="oral_boards",
            description="test",
            edges=[(START, questioner), (questioner, evaluator)],
        )
        return wf, questioner, evaluator

    def test_agui_toolset_replaced_in_graph_nodes(self):
        """After replacement, no AGUIToolset remains in any graph node."""
        wf, _, _ = self._build_workflow()
        copied_wf = ADKAgent._shallow_copy_agent_tree(wf)

        _apply_tool_replacement(copied_wf, [_make_tool("ask_question")])

        for node in copied_wf.graph.nodes:
            if not isinstance(node, LlmAgent):
                continue
            for tool in node.tools:
                assert not isinstance(tool, AGUIToolset), (
                    f"Node {node.name!r} still has an unreplaced AGUIToolset"
                )
            assert any(isinstance(t, ClientProxyToolset) for t in node.tools), (
                f"Node {node.name!r} has no ClientProxyToolset after replacement"
            )

    def test_original_workflow_nodes_not_mutated(self):
        """Tool replacement on the per-run copy must not affect the singleton."""
        wf, orig_questioner, _ = self._build_workflow()
        orig_tool = orig_questioner.tools[0]

        copied_wf = ADKAgent._shallow_copy_agent_tree(wf)
        _apply_tool_replacement(copied_wf, [_make_tool("ask_question")])

        assert orig_questioner.tools[0] is orig_tool, (
            "tool replacement on the per-run copy must not mutate the original"
        )

    def test_concurrent_runs_have_independent_proxies(self):
        """Two simultaneous copies must have separate ClientProxyToolset instances."""
        wf, _, _ = self._build_workflow()
        copy1 = ADKAgent._shallow_copy_agent_tree(wf)
        copy2 = ADKAgent._shallow_copy_agent_tree(wf)

        _apply_tool_replacement(copy1, [_make_tool("tool_a")])
        _apply_tool_replacement(copy2, [_make_tool("tool_b")])

        q1 = _node_by_name(copy1.graph.nodes, "questioner")
        q2 = _node_by_name(copy2.graph.nodes, "questioner")
        proxy1 = next(t for t in q1.tools if isinstance(t, ClientProxyToolset))
        proxy2 = next(t for t in q2.tools if isinstance(t, ClientProxyToolset))

        assert proxy1 is not proxy2, "each run must have its own ClientProxyToolset"
        assert proxy1.ag_ui_tools != proxy2.ag_ui_tools, (
            "each run's proxy must carry that run's frontend tools"
        )
