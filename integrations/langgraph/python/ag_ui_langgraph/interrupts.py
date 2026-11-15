from typing import Any, List, Mapping

from ag_ui.core import Interrupt as AGUIInterrupt
from langgraph.types import Interrupt as LangGraphInterrupt

from .utils import make_json_safe


def _first_not_none(*values):
    return next((v for v in values if v is not None), None)


def _native_response_schema(lg: LangGraphInterrupt):
    """The JSON Schema LangGraph itself attaches to the interrupt, or None.

    ``interrupt(value, response_schema=...)`` (langgraph >= 1.2.12) stores it on
    ``Interrupt.response_schema``, next to ``value``, already converted to JSON
    Schema. Older langgraph has no such attribute. Anything that is not a
    mapping (an ``Interrupt`` built by hand with the Python type) is ignored, so
    it cannot fail validation of the AG-UI interrupt.
    """
    schema = getattr(lg, "response_schema", None)
    return schema if isinstance(schema, Mapping) else None


def lg_interrupt_to_agui(lg: LangGraphInterrupt) -> AGUIInterrupt:
    raw = lg.value
    is_dict = isinstance(raw, Mapping)

    interrupt_id = getattr(lg, "id", None)
    if not interrupt_id:
        raise ValueError(
            "LangGraph Interrupt is missing `id`. The id is required to "
            "match a resume answer back to the originating step; synthesising "
            "an id here would silently misroute multi-interrupt resumes. "
            "Upgrade to langgraph>=0.4 (which always populates Interrupt.id)."
        )

    # Default only when reason is absent (None), not when it is a falsy-but-real
    # value: an explicit reason="" must be preserved, matching the TS side's
    # `?? "langgraph:interrupt"`. Using `or` here would drop "".
    _reason = raw.get("reason") if is_dict else None
    reason = _reason if _reason is not None else "langgraph:interrupt"

    message = (
        raw if isinstance(raw, str)
        else raw.get("message") if is_dict else None
    )
    tool_call_id = _first_not_none(
        raw.get("toolCallId") if is_dict else None,
        raw.get("tool_call_id") if is_dict else None,
    )
    # LangGraph's own field first; keys inside the value stay as the fallback
    # for graphs that carry the schema there.
    response_schema = _first_not_none(
        _native_response_schema(lg),
        raw.get("responseSchema") if is_dict else None,
        raw.get("response_schema") if is_dict else None,
    )
    expires_at = _first_not_none(
        raw.get("expiresAt") if is_dict else None,
        raw.get("expires_at") if is_dict else None,
    )

    metadata: dict[str, Any] = {
        "langgraph": {
            "raw": make_json_safe(raw),
            "ns": getattr(lg, "ns", None),
            "resumable": getattr(lg, "resumable", None),
            "when": getattr(lg, "when", None),
        }
    }

    return AGUIInterrupt(
        id=interrupt_id,
        reason=reason,
        message=message,
        tool_call_id=tool_call_id,
        response_schema=response_schema,
        expires_at=expires_at,
        metadata=metadata,
    )


def lg_interrupts_to_agui(items) -> List[AGUIInterrupt]:
    return [lg_interrupt_to_agui(i) for i in items]


DEFAULT_RESUME_SENTINEL_CANCELLED = "__agui_cancelled__"
DEFAULT_RESUME_SENTINEL_MAP = "__agui_resume_map__"
