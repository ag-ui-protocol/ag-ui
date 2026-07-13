"""Public data containers for the translator package.

Holds typed result objects produced by the translators. Translator
behavior lives in agui_to_openai.py and openai_to_agui.py; this module only
describes the shapes those translators hand back.
"""

from __future__ import annotations

from typing import Any

from agents import FunctionTool, TResponseInputItem
from pydantic import BaseModel, ConfigDict, SkipValidation

from ag_ui.core import Context


class TranslatedInput(BaseModel):
    """SDK-ready bundle produced by translating an AG-UI RunAgentInput.

    The fields line up one-for-one with ag_ui.core.RunAgentInput — same
    names, same required/optional split — so if you know the wire format
    you already know this. The only real work happens on `messages` and
    `tools` (translated into SDK shapes); everything else is handed
    straight through for you to use however your app needs.
    """

    # ── Identity ─────────────────────────────────────────────────────────
    thread_id: str
    """Conversation key. Stays the same across turns of one thread."""

    run_id: str
    """Id for this single run. Goes on the RUN_STARTED / RUN_FINISHED events."""

    parent_run_id: str | None = None
    """Set when this run was kicked off by another run (nested/branched);
    None for a top-level run."""

    # ── Translated payload (the actual work the translator does) ────────
    messages: list[TResponseInputItem]
    """Responses-API input items, ready to pass to Runner.run*(input=...).
    Validation is skipped here because the SDK's own input types use forward
    refs Pydantic can't resolve from this module."""

    tools: SkipValidation[list[FunctionTool]] = []
    """FunctionTool proxies for the client's tools. Merge these with your
    agent's own tools before running. The public translators fill this in; if
    you call the inbound engine directly, call translate_tools yourself.
    Validation skipped for the same forward-ref reason as messages."""

    # ── Passthroughs (raw from the wire) ────────────────────────────────
    state: Any
    """Whatever the client sent as state. Any, since AG-UI doesn't pin a shape."""

    context: list[Context]
    """Ambient {description, value} items from the frontend. Nothing folds these
    into the prompt for you — run them through translate_context if you want the
    model to see them."""

    forwarded_props: Any
    """Grab-bag of extra client props (model overrides, temperature, flags, ...)
    that don't have a dedicated field."""

    resume: list[Any] | None = None
    """Resume entries when continuing from an interrupt, else None. Read
    defensively since not every RunAgentInput version carries this field yet."""

    # FunctionTool isn't a Pydantic model, so Pydantic won't accept it unless
    # we explicitly allow arbitrary types.
    model_config = ConfigDict(arbitrary_types_allowed=True)


# FunctionTool's schema points at AgentBase, which Pydantic can't see from
# here. Pull it into scope and rebuild the model so the `tools` field resolves.
from agents.agent import AgentBase  # noqa: E402,F401

TranslatedInput.model_rebuild()

__all__ = ["TranslatedInput"]
