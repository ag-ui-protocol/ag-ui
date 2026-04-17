"""Shared test helpers for ag-ui-langgraph integration tests.

These helpers build lightweight ``LangGraphAgent`` fixtures backed by
``MagicMock``/``AsyncMock`` stand-ins so tests can exercise agent logic in
isolation, without spinning up a real graph or hitting any network.
"""

from typing import Any, List
from unittest.mock import AsyncMock, MagicMock

from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent


def make_agent() -> LangGraphAgent:
    """Return a ``LangGraphAgent`` backed by a mock ``CompiledStateGraph``.

    The mock graph has no nodes; tests drive ``_handle_stream_events``
    by feeding synthetic event chunks rather than compiling a real
    graph, so node wiring is irrelevant."""
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
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
) -> LangGraphAgent:
    """Build an agent with a mocked checkpoint and a recording dispatcher.

    The mocked ``graph.aget_state`` returns a state whose ``.values``
    carries ``checkpoint_messages`` under the ``messages`` key. That
    checkpoint is the sole source the agent draws MESSAGES_SNAPSHOT
    from — no streaming-layer side channel is plumbed through."""
    agent = make_agent()
    agent.active_run = {"id": "run-1"}
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
