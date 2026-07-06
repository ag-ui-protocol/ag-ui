"""Internal helpers shared by both translator directions.

These are deliberately tiny, side-effect-free, and dependency-light so they
can be reused by either translator without coupling them.
"""

from __future__ import annotations

import json
import uuid
from typing import Any


# ---------------------------------------------------------------------------
# ID generation
# ---------------------------------------------------------------------------

def new_message_id() -> str:
    """Generate a fresh AG-UI message id (``msg_<hex>``)."""
    return f"msg_{uuid.uuid4().hex}"


def new_reasoning_id() -> str:
    """Generate a fresh reasoning id (``rs_<hex>``, matching the wire prefix)."""
    return f"rs_{uuid.uuid4().hex}"


def new_tool_call_id() -> str:
    """Generate a fresh tool call id (``call_<hex>``)."""
    return f"call_{uuid.uuid4().hex}"


def new_tool_result_id(call_id: str) -> str:
    """Derive the tool result message id (``<call_id>-result``).

    Deterministic — the wire has no id on ``function_call_output``, so the
    result id is derived from the ``call_id`` it answers. Hyphen never
    appears in wire ids, marking the suffix as ours.
    """
    return f"{call_id}-result"


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


__all__ = [
    "new_message_id",
    "new_tool_call_id",
    "new_tool_result_id",
    "read_attr",
    "coerce_to_str",
]
