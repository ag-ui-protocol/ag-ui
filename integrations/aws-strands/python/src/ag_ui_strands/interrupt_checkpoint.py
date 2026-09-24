"""Read and write the tool batch a Strands interrupt checkpoint parks.

When a tool raises an interrupt, Strands checkpoints the whole batch it was
dispatching: the assistant message holding every ``toolUse`` of that turn, plus
the results of the calls that already finished. The resume re-dispatches that
message and answers the finished calls from the checkpoint rather than running
them again, so the adapter has to read the batch (to know which tools must stay
registered) and correct results inside it (so a frontend tool's real answer,
which only arrives on the next request, replaces the proxy placeholder before
the model ever sees it).

Where that batch lives is private to Strands and has already moved once:

* Up to 1.54 it sat on ``_InterruptState.context`` under the string keys
  ``"tool_results"`` and ``"tool_use_message"``.
* From 1.55 it sits on ``_InterruptState.pending_tool_execution``, an object
  with ``assistant_message`` and ``completed_tool_results``, and the legacy
  keys are migrated out of ``context`` on load.

Reading either shape directly from the call sites is what broke on 1.55: every
read returned nothing, so a corrected frontend result silently stopped reaching
the model. This module is the single place that knows both shapes. It reads the
new one when the installed release has it and the legacy one otherwise, so the
adapter keeps working across the whole supported range rather than tracking one
release's private layout.
"""

from __future__ import annotations

from typing import Any, Mapping

# The keys Strands used before the batch became a typed field.
_LEGACY_RESULTS_KEY = "tool_results"
_LEGACY_MESSAGE_KEY = "tool_use_message"


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


def _pending_tool_execution(interrupt_state: Any) -> Any:
    """Return the release's typed parked-batch field, or None when it has none.

    ``None`` covers both "this release predates the field" and "this release
    has it but nothing is parked", because both mean the same thing to every
    caller: look at the legacy ``context`` keys instead.
    """
    return getattr(interrupt_state, "pending_tool_execution", None)


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
    pending = _pending_tool_execution(interrupt_state)
    if pending is not None:
        results = getattr(pending, "completed_tool_results", None)
        return results if isinstance(results, list) else None

    context = getattr(interrupt_state, "context", None)
    if not isinstance(context, Mapping):
        return None
    results = context.get(_LEGACY_RESULTS_KEY)
    return results if isinstance(results, list) else None


def parked_assistant_message(interrupt_state: Any) -> Any:
    """Return the assistant message whose tool batch *interrupt_state* parked.

    Three answers, which callers must tell apart:

    * :data:`NO_PARKED_BATCH` when the checkpoint holds no batch.
    * :data:`UNREADABLE_CHECKPOINT` when the checkpoint holds state this
      adapter cannot inspect at all.
    * Otherwise the parked message itself, which is usually a mapping but is
      whatever the checkpoint holds; the caller decides what it can do with it.
    """
    pending = _pending_tool_execution(interrupt_state)
    if pending is not None:
        return getattr(pending, "assistant_message", None)

    context = getattr(interrupt_state, "context", None)
    if not isinstance(context, Mapping):
        return UNREADABLE_CHECKPOINT
    if _LEGACY_MESSAGE_KEY not in context:
        return NO_PARKED_BATCH
    return context[_LEGACY_MESSAGE_KEY]


def publish_parked_tool_results(interrupt_state: Any, tool_results: list) -> None:
    """Republish corrected parked results so the session manager persists them.

    Correcting the results in place is enough for the run in flight, but not
    for the next process: ``RepositorySessionManager.sync_agent`` only writes
    interrupt state back when the state's own version counter has moved, and an
    in-place edit of the parked list moves nothing. ``set_pending_tool_results``
    bumps that counter, so routing the corrected list back through it is what
    makes a correction survive a rebuilt agent.

    On a release with no such method the in-place edit is all there is, and this
    is a no-op.
    """
    if _pending_tool_execution(interrupt_state) is None:
        return
    setter = getattr(interrupt_state, "set_pending_tool_results", None)
    if not callable(setter):
        return
    setter(tool_results)
