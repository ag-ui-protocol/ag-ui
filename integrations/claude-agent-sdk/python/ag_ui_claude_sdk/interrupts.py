"""Bridge Claude Agent SDK ``defer`` into the AG-UI interrupt/resume contract.

The Claude Agent SDK has no in-flight tool suspension. When a ``PreToolUse``
hook returns ``permissionDecision: "defer"``, the run halts at the tool
boundary and the terminating ``ResultMessage`` carries a ``DeferredToolUse``
(the frozen ``id``/``name``/``input`` of the proposed call) plus a
``session_id``. Resuming means starting a fresh ``query(resume=session_id)``:
the same frozen tool call fires ``PreToolUse`` again, and the hook then allows
or denies it based on the resume verdict.

This module is the thin translation layer between that primitive and the
AG-UI wire types, matching how ``ag_ui_langgraph.interrupts`` reshapes
LangGraph's native ``Interrupt`` into ``ag_ui.core.Interrupt``. It performs no
suspension itself — it only reshapes a halt into the standard contract.
"""

from typing import Any, Dict, List, Optional

from ag_ui.core import Interrupt

# Prefix used to derive the AG-UI interrupt id from the deferred tool-use id.
# The interrupt id (the approval-request id) is intentionally distinct from the
# tool_call_id (the proposed call id) — the client resolves an interrupt by its
# own id, not by the tool call id. This mirrors the AG-UI reference contract.
_INTERRUPT_ID_PREFIX = "interrupt_"

# ``reason`` value for interrupts raised by a deferred tool call.
INTERRUPT_REASON_TOOL_CALL = "tool_call"


def interrupt_id_for_tool_use(deferred_tool_use_id: str) -> str:
    """Return the AG-UI interrupt id for a deferred tool-use id."""
    return f"{_INTERRUPT_ID_PREFIX}{deferred_tool_use_id}"


def tool_use_id_from_interrupt_id(interrupt_id: str) -> str:
    """Recover the deferred tool-use id from an AG-UI interrupt id.

    Inverse of :func:`interrupt_id_for_tool_use`. If the id does not carry the
    expected prefix (e.g. a client sent a bare tool_call_id), it is returned
    unchanged so resume stays best-effort rather than raising.
    """
    if interrupt_id.startswith(_INTERRUPT_ID_PREFIX):
        return interrupt_id[len(_INTERRUPT_ID_PREFIX):]
    return interrupt_id


def _response_schema_for_tool(
    tool_name: str,
    tools: Optional[List[Any]],
) -> Optional[Dict[str, Any]]:
    """Best-effort JSON Schema describing the resume payload for ``tool_name``.

    Pulls the tool's declared input schema from the run's ``tools`` so a client
    can render an approval form. Returns ``None`` when the tool or its schema
    cannot be found; a missing schema must never fail the run.
    """
    if not tools:
        return None
    for tool in tools:
        name = getattr(tool, "name", None)
        if name is None and isinstance(tool, dict):
            name = tool.get("name")
        if name != tool_name:
            continue
        schema = getattr(tool, "parameters", None)
        if schema is None and isinstance(tool, dict):
            schema = tool.get("parameters")
        if isinstance(schema, dict):
            return schema
        return None
    return None


def deferred_tool_use_to_interrupt(
    deferred_tool_use: Any,
    tools: Optional[List[Any]] = None,
    message: Optional[str] = None,
) -> Interrupt:
    """Convert a Claude SDK ``DeferredToolUse`` into an AG-UI ``Interrupt``.

    Args:
        deferred_tool_use: The ``DeferredToolUse`` from the terminating
            ``ResultMessage`` (carries ``id``, ``name``, ``input``).
        tools: The run's declared tools, used to derive ``response_schema``.
        message: Optional human-readable prompt for the approval surface.

    Returns:
        An ``Interrupt`` whose ``tool_call_id`` is the frozen deferred call id
        and whose ``id`` is the distinct approval-request id.
    """
    tool_use_id = deferred_tool_use.id
    tool_name = deferred_tool_use.name
    return Interrupt(
        id=interrupt_id_for_tool_use(tool_use_id),
        reason=INTERRUPT_REASON_TOOL_CALL,
        message=message,
        tool_call_id=tool_use_id,
        response_schema=_response_schema_for_tool(tool_name, tools),
        metadata={"tool_name": tool_name},
    )


def is_resume_resolved(status: str) -> bool:
    """Return True when a ``ResumeEntry.status`` means "proceed"."""
    return status == "resolved"
