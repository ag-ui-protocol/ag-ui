"""
Public data containers for the translator package.

Holds typed result objects produced by the translators. Translator *behavior*
lives in :mod:`agui_to_sdk` and :mod:`sdk_to_agui`; this module only describes
the shapes those translators hand back.
"""

from __future__ import annotations

from typing import Any

from agents import FunctionTool, TResponseInputItem
from ag_ui.core import Context
from pydantic import BaseModel, ConfigDict, SkipValidation


class TranslatedInput(BaseModel):
    """
    SDK-ready bundle produced by translating an AG-UI ``RunAgentInput``.

    The field shape **mirrors** :class:`ag_ui.core.RunAgentInput` field-for-
    field — same required/optional pattern — so callers familiar with the
    wire format can map between the two without thinking. Two fields are
    renamed because their *content* was translated, not just passed through:

    * ``messages`` → ``input_items`` — now Responses-API input items.
    * ``tools``    → ``function_tools`` — now SDK :class:`FunctionTool` proxies.

    Everything else is passed through unchanged so downstream code decides
    what to do with raw frontend payloads (e.g. ``context``, ``forwarded_props``).

    Required fields (must always be provided):
        thread_id, run_id, input_items, function_tools,
        state, context, forwarded_props.

    Optional fields (default to ``None``):
        parent_run_id, resume.
    """

    # ── Identity ─────────────────────────────────────────────────────────
    thread_id: str
    """
    Session key for this conversation. Same value across multi-turn runs and
    used by the session manager for HITL resume.
    """

    run_id: str
    """
    Unique id for this specific run. Tagged onto ``RUN_STARTED`` /
    ``RUN_FINISHED`` events emitted back to the client.
    """

    parent_run_id: str | None = None
    """
    Optional parent run id — set when this run was triggered by another run
    (e.g. a nested or branched agent invocation). ``None`` for top-level runs.
    """

    # ── Translated payload (the actual work the translator does) ────────
    messages: list[TResponseInputItem]
    """
    Responses-API input list. Feed straight into
    ``Runner.run_streamed(input=...)``. Built from
    :attr:`ag_ui.core.RunAgentInput.messages`.

    Validation is skipped to avoid Pydantic forward-ref resolution issues
    with the agents SDK's internal types.
    """

    # tools: SkipValidation[list[FunctionTool]]
    """
    SDK :class:`FunctionTool` proxies for the AG-UI client tools. Merge with
    the SDK agent's static tools before running. Built from
    :attr:`ag_ui.core.RunAgentInput.tools`.

    Validation is skipped to avoid Pydantic forward-ref resolution issues
    with the agents SDK's internal types.
    """

    # ── Passthroughs (raw from the wire) ────────────────────────────────
    state: Any
    """
    The AG-UI user state as sent by the client. Typed ``Any`` because AG-UI
    itself doesn't constrain its shape.
    """

    context: list[Context]
    """
    Ambient context items (CopilotKit's ``useCopilotReadable`` etc.) — each
    a ``{description, value}`` pair. Not auto-folded anywhere; use
    :meth:`AGUIToSDKTranslator.translate_context` to render for the model.
    """

    forwarded_props: Any
    """
    Catch-all client-supplied props (model overrides, temperature, debug
    flags, anything the client doesn't have a typed field for).
    """

    resume: list[Any] | None = None
    """
    HITL resume entries from the client — each ``{interruptId, status,
    payload?}``. Only present when continuing from a previous interrupt.

    The Python AG-UI SDK does not expose this field yet; the translator reads
    it defensively so the bundle is forward-compatible with the wire protocol.
    """

    # FunctionTool is not a Pydantic model, so we need to opt in.
    model_config = ConfigDict(arbitrary_types_allowed=True)


__all__ = ["TranslatedInput"]
