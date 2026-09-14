"""Shared test helpers for ag-ui-langgraph integration tests.

These helpers build lightweight ``LangGraphAgent`` fixtures backed by
``MagicMock``/``AsyncMock`` stand-ins so tests can exercise agent logic in
isolation, without spinning up a real graph or hitting any network.

It also binds the multimodal content-part classes under 1.0's names whichever
name the installed SDK actually exports — see THE CONTENT-PART NAMES below.
"""

from typing import Any, Iterable, List, Optional
from unittest.mock import AsyncMock, MagicMock

from langgraph.graph.state import CompiledStateGraph

import ag_ui.core
from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent


# ── THE CONTENT-PART NAMES ────────────────────────────────────────────────
#
# AG-UI 1.0 renamed the multimodal content parts — ``TextInputContent`` became
# ``TextPart``, ``ImageInputContent`` became ``ImagePart``, and so on, with
# ``InputContentDataSource``/``InputContentUrlSource`` becoming
# ``DataSource``/``UrlSource`` — and kept every old name as an ALIAS OF THE SAME
# CLASS. Nothing breaks at runtime, so this is invisible to the code; it is only
# visible to anything that reads a NAME.
#
# These tests run against two different SDKs. The locked ``langgraph-python``
# lane installs this repo's ``sdks/python``, which exports both vocabularies.
# The ``langgraph-python-declared-floor`` lane installs the published floor out
# of ``pyproject.toml``, which exports only the OLD names. So the tests must not
# import either vocabulary directly: the new names are absent under the floor,
# and the old ones are the vocabulary 1.0 retired.
#
# Binding the new names to whatever the installed SDK has resolves that once,
# here, and lets every test read in 1.0's vocabulary without pinning a version.
def _part_class(new_name: str, old_name: str):
    """The SDK's part class, under whichever of its two names it exports."""
    part = getattr(ag_ui.core, new_name, None)
    if part is None:
        part = getattr(ag_ui.core, old_name)
    return part


TextPart = _part_class("TextPart", "TextInputContent")
ImagePart = _part_class("ImagePart", "ImageInputContent")
AudioPart = _part_class("AudioPart", "AudioInputContent")
VideoPart = _part_class("VideoPart", "VideoInputContent")
DocumentPart = _part_class("DocumentPart", "DocumentInputContent")
DataSource = _part_class("DataSource", "InputContentDataSource")
UrlSource = _part_class("UrlSource", "InputContentUrlSource")

# The label a part carries in `../../cross-runtime-parity-cases.json`, keyed by
# CLASS IDENTITY rather than by ``type(part).__name__``.
#
# The runtime ``__name__`` is exactly the thing that differs between the two
# lanes above: under the published floor ``ImagePart`` above IS the class still
# literally named ``ImageInputContent``, so a harness that derived its label
# from ``__name__`` would compare ``"ImageInputContent"`` against a table
# written in 1.0's vocabulary and fail on the installed SDK version rather than
# on adapter behaviour. Identity does not move when the alias does.
#
# ``BinaryInputContent`` is deliberately absent: the legacy part was RETIRED
# from the protocol rather than renamed, ``ag_ui_langgraph.utils`` owns whatever
# shape is in play, and the table records it under that one name. It falls
# through to the ``__name__`` default alongside ``dict`` and ``NoneType``.
PART_LABELS = {
    TextPart: "TextPart",
    ImagePart: "ImagePart",
    AudioPart: "AudioPart",
    VideoPart: "VideoPart",
    DocumentPart: "DocumentPart",
}


def part_label(part: Any) -> str:
    """The parity table's label for one built item — a part, or anything else.

    Anything the map above does not name (a raw ``dict`` an item could not be
    validated into, ``NoneType``, the legacy ``BinaryInputContent``) reports its
    own class name, which is what the table records for those.
    """
    return PART_LABELS.get(type(part), type(part).__name__)


def make_agent(subgraph_names: Optional[Iterable[str]] = None, **agent_kwargs) -> LangGraphAgent:
    """Return a ``LangGraphAgent`` backed by a mock graph; each name in
    ``subgraph_names`` becomes a node whose ``bound`` is a
    ``CompiledStateGraph`` mock (how the agent detects subgraphs at
    construction). Extra keyword arguments are forwarded to ``LangGraphAgent``
    (e.g. ``emit_interrupt_outcome=True``)."""
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    nodes = {}
    names_iter: Iterable[str] = subgraph_names if subgraph_names is not None else []
    for name in names_iter:
        node = MagicMock()
        node.bound = MagicMock(spec=CompiledStateGraph)
        nodes[name] = node
    graph.nodes = nodes
    return LangGraphAgent(name="test", graph=graph, **agent_kwargs)


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
    subgraph_names: Optional[Iterable[str]] = None,
) -> LangGraphAgent:
    """Build an agent with a mocked checkpoint and a recording dispatcher.

    The mocked ``graph.aget_state`` returns a state whose ``.values``
    carries ``checkpoint_messages`` under the ``messages`` key."""
    agent = make_agent(list(subgraph_names) if subgraph_names else ["hotels_agent"])
    agent.active_run = {
        "id": "run-1",
    }
    _record_dispatch(agent)
    agent.get_state_snapshot = MagicMock(return_value={})
    state = MagicMock()
    state.values = {"messages": checkpoint_messages}
    agent.graph.aget_state = AsyncMock(return_value=state)
    return agent


def snapshot_event(dispatched: List[Any]):
    """Return the first ``MESSAGES_SNAPSHOT`` event in a dispatched list.

    Raises ``AssertionError`` with the sequence of actually-dispatched
    event types when no snapshot is present, so test failures point
    directly at what was emitted."""
    for ev in dispatched:
        if getattr(ev, "type", None) == EventType.MESSAGES_SNAPSHOT:
            return ev
    dispatched_types = [getattr(e, "type", None) for e in dispatched]
    raise AssertionError(
        "no MESSAGES_SNAPSHOT dispatched; got: "
        f"{dispatched_types!r}"
    )
