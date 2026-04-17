"""Shared test helpers for ag-ui-langgraph integration tests.

These helpers build lightweight ``LangGraphAgent`` fixtures backed by
``MagicMock``/``AsyncMock`` stand-ins so tests can exercise agent logic in
isolation, without spinning up a real graph or hitting any network.
"""

from typing import Any, Iterable, List, Optional
from unittest.mock import AsyncMock, MagicMock

from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent


def make_agent(subgraph_names: Optional[Iterable[str]] = None) -> LangGraphAgent:
    """Return a ``LangGraphAgent`` whose graph is a mock with the given
    subgraph nodes. Every listed name becomes a node whose ``bound``
    attribute is itself a ``CompiledStateGraph`` mock, which is how the
    agent detects subgraphs at construction time."""
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    nodes = {}
    for name in (subgraph_names or []):
        node = MagicMock()
        node.bound = MagicMock(spec=CompiledStateGraph)
        nodes[name] = node
    graph.nodes = nodes
    return LangGraphAgent(name="test", graph=graph)


def _record_dispatch(agent: LangGraphAgent):
    """Replace ``agent._dispatch_event`` with a recording function.

    The installed function appends every dispatched event to
    ``agent.dispatched`` and returns the event unchanged so the rest of
    the agent's control flow (which expects the return value) still
    works. Using a named function instead of a lambda keeps tracebacks
    readable and makes the side effect explicit."""
    agent.dispatched = []

    def _dispatch(event):
        agent.dispatched.append(event)
        return event

    agent._dispatch_event = _dispatch
    return agent


def make_configured_agent(
    checkpoint_messages: List[Any],
    streamed_messages: Optional[List[Any]] = None,
    subgraph_names: Optional[Iterable[str]] = None,
    registered_tool_names: Optional[Iterable[str]] = None,
) -> LangGraphAgent:
    """Build an agent with a mocked checkpoint and a recording dispatcher.

    The mocked ``graph.aget_state`` returns a state whose ``.values``
    carries ``checkpoint_messages`` under the ``messages`` key.
    ``streamed_messages`` is placed on ``active_run`` so the merge path in
    ``get_state_and_messages_snapshots`` can observe it. When
    ``registered_tool_names`` is provided, it becomes the set used by the
    structured-output filter to distinguish user-facing tool calls from
    internal schema invocations."""
    agent = make_agent(list(subgraph_names) if subgraph_names else ["hotels_agent"])
    agent.active_run = {
        "id": "run-1",
        "streamed_messages": list(streamed_messages or []),
        "registered_tool_names": set(registered_tool_names or []),
    }
    _record_dispatch(agent)
    agent.get_state_snapshot = MagicMock(return_value={})
    state = MagicMock()
    state.values = {"messages": checkpoint_messages}
    agent.graph.aget_state = AsyncMock(return_value=state)
    return agent


def snapshot_event(dispatched: List[Any]):
    """Return the first ``MESSAGES_SNAPSHOT`` event in a dispatched list.

    Raises ``StopIteration`` if no snapshot was dispatched — callers use
    this as an assertion that the snapshot was emitted."""
    return next(
        e for e in dispatched
        if getattr(e, "type", None) == EventType.MESSAGES_SNAPSHOT
    )
