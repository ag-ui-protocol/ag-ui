"""Internal helpers shared by both translator directions.

These are deliberately tiny, side-effect-free, and dependency-light so they
can be reused by either translator without coupling them.
"""

from __future__ import annotations

import copy
import json
import uuid
from typing import Any

import jsonpatch


# ---------------------------------------------------------------------------
# ID generation
# ---------------------------------------------------------------------------

def new_message_id() -> str:
    """Generate a fresh AG-UI message id (``msg_<hex>``)."""
    return f"msg_{uuid.uuid4().hex}"


def new_tool_call_id() -> str:
    """Generate a fresh tool call id (``call_<hex>``)."""
    return f"call_{uuid.uuid4().hex}"


def new_tool_result_id() -> str:
    """Generate a fresh tool result id (``toolresult_<hex>``)."""
    return f"toolresult_{uuid.uuid4().hex}"


# ---------------------------------------------------------------------------
# Polymorphic attribute / value reading
# ---------------------------------------------------------------------------

def read_attr(obj: Any, name: str) -> Any:
    """Read ``name`` from a pydantic model **or** a dict — whichever we got.

    The SDK and AG-UI both hand us a mix of dicts and pydantic objects depending
    on whether something has been through JSON serialization yet. This shields
    callers from caring.
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def coerce_to_str(value: Any) -> str:
    """Best-effort stringification for tool outputs and content payloads."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, default=str)
    except (TypeError, ValueError):
        return str(value)


# ---------------------------------------------------------------------------
# State diffing (JSON Patch RFC 6902)
# ---------------------------------------------------------------------------

def snapshot_state(state: dict[str, Any]) -> dict[str, Any]:
    """Deep-copy ``state`` so later mutations don't pollute the baseline."""
    return copy.deepcopy(state)


class StateDiffer:
    """Tracks a baseline state and yields JSON Patch ops when it changes.

    Used by the outbound translator (and the agent loop) to surface mutations
    that tools/instructions made to ``AGUIContext.state`` as AG-UI
    ``STATE_DELTA`` events.

    Lifecycle::

        differ = StateDiffer(initial=context.state)
        # ... after each SDK event ...
        ops = differ.diff(context.state)
        if ops is not None:
            yield StateDeltaEvent(type=..., delta=ops)
    """

    def __init__(self, initial: dict[str, Any]) -> None:
        self._baseline: dict[str, Any] = snapshot_state(initial)

    def diff(self, current: dict[str, Any]) -> list[dict[str, Any]] | None:
        """Return JSON Patch ops if ``current`` differs from the baseline.

        Returns ``None`` (not ``[]``) when nothing changed — so callers can use
        a simple ``if ops is not None`` check before emitting an event.
        After a non-empty diff, the baseline advances to ``current``.
        """
        patch = jsonpatch.make_patch(self._baseline, current)
        ops = list(patch)
        if not ops:
            return None
        self._baseline = snapshot_state(current)
        return ops

    @property
    def baseline(self) -> dict[str, Any]:
        """Return a copy of the current baseline (defensive)."""
        return snapshot_state(self._baseline)

    def reset(self, state: dict[str, Any]) -> None:
        """Force-reset the baseline to ``state`` without emitting a diff."""
        self._baseline = snapshot_state(state)


__all__ = [
    "new_message_id",
    "new_tool_call_id",
    "new_tool_result_id",
    "read_attr",
    "coerce_to_str",
    "snapshot_state",
    "StateDiffer",
]
