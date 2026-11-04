"""Read and write the tool batch a Strands interrupt checkpoint parks.

When a tool raises an interrupt, Strands checkpoints the whole batch it was
dispatching: the assistant message holding every ``toolUse`` of that turn, plus
the results of the calls that already finished. The resume re-dispatches that
message and answers the finished calls from the checkpoint rather than running
them again, so the adapter has to read the batch (to know which tools must stay
registered) and correct results inside it (so a frontend tool's real answer,
which only arrives on the next request, replaces the proxy placeholder before
the model ever sees it).

Strands >=1.55 stores this batch in ``pending_tool_execution``. Its
``_InterruptState.from_dict`` migrates saved pre-1.55 context keys on restore;
this module only reads the unified live layout. Keep that SDK restore boundary
when loading durable sessions, including sessions interrupted before upgrade.
"""

from __future__ import annotations

from typing import Any


class _CheckpointSignal:
    """A distinguishable answer for a checkpoint that carries no message."""

    def __init__(self, label: str) -> None:
        self._label = label

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return self._label


#: No tool batch is parked at all. An interrupt raised before any tool ran
#: checkpoints exactly this way, and it has no batch to protect or correct.
NO_PARKED_BATCH = _CheckpointSignal("NO_PARKED_BATCH")

#: A checkpoint is carrying something, but this adapter cannot get at it. The
#: caller must assume a batch is parked and behave conservatively, because the
#: alternative is breaking a resume that is already in flight.
UNREADABLE_CHECKPOINT = _CheckpointSignal("UNREADABLE_CHECKPOINT")


def parked_tool_results(interrupt_state: Any) -> list | None:
    """Return the live list of completed results parked by *interrupt_state*.

    The list is returned as-is rather than copied: correcting a result in place
    is how the adapter gets the client's real answer into the batch Strands is
    about to replay, and a copy would correct nothing. Callers that mutate it
    must still publish it through :func:`publish_parked_tool_results` so the
    session manager learns the state changed.

    Returns ``None`` when nothing is parked or when what is parked is not a
    list of results.
    """
    pending = getattr(interrupt_state, "pending_tool_execution", None)
    if pending is not None:
        results = getattr(pending, "completed_tool_results", None)
        return results if isinstance(results, list) else None

    return None


def parked_assistant_message(interrupt_state: Any) -> Any:
    """Return the assistant message whose tool batch *interrupt_state* parked.

    Three answers, which callers must tell apart:

    * :data:`NO_PARKED_BATCH` when the checkpoint holds no batch.
    * :data:`UNREADABLE_CHECKPOINT` when the checkpoint holds state this
      adapter cannot inspect at all.
    * Otherwise the parked message itself, which is usually a mapping but is
      whatever the checkpoint holds; the caller decides what it can do with it.
    """
    pending = getattr(interrupt_state, "pending_tool_execution", UNREADABLE_CHECKPOINT)
    if pending is UNREADABLE_CHECKPOINT:
        return UNREADABLE_CHECKPOINT
    if pending is None:
        return NO_PARKED_BATCH
    return getattr(pending, "assistant_message", UNREADABLE_CHECKPOINT)


def publish_parked_tool_results(interrupt_state: Any, tool_results: list) -> None:
    """Republish corrected parked results so the session manager persists them.

    Correcting the results in place is enough for the run in flight, but not
    for the next process: ``RepositorySessionManager.sync_agent`` only writes
    interrupt state back when the state's own version counter has moved, and an
    in-place edit of the parked list moves nothing. ``set_pending_tool_results``
    bumps that counter, so routing the corrected list back through it is what
    makes a correction survive a rebuilt agent.

    The SDK floor guarantees this setter. A missing setter must fail rather
    than acknowledge a correction that would disappear on restart.
    """
    if getattr(interrupt_state, "pending_tool_execution", None) is None:
        return
    interrupt_state.set_pending_tool_results(tool_results)
