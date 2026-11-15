"""Narrow AG-UI 1.0 message content and roles to what the Agent Spec runtimes take.

AG-UI 1.0 lets user and tool messages carry ``ContentPart[]`` instead of a plain
string, and clients send ``developer``, ``activity`` and ``reasoning`` messages in
ordinary conversations. Neither runtime the adapter drives (LangGraph through
pyagentspec, WayFlow) accepts AG-UI content parts or those roles, so the runners
narrow every message through the helpers here before handing it over.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("ag_ui_agentspec.tracing")

# Roles that carry UI- or model-side bookkeeping rather than conversation turns.
# Neither runtime has a slot for them, so they are dropped from the model input.
SKIPPED_ROLES = frozenset({"activity", "reasoning"})


def _field(part: Any, name: str) -> Any:
    if isinstance(part, dict):
        return part.get(name)
    return getattr(part, name, None)


def content_to_text(content: Any, *, message_id: Optional[str] = None) -> str:
    """Flatten string-or-parts content to the text the runtimes accept.

    Mirrors ``contentToText()`` from ``@ag-ui/core``: a string passes through,
    a part list becomes its text parts concatenated. Every other part (image,
    audio, video, document, whatever its source, ``FileSource`` handles
    included) is skipped with a warning, because neither runtime can take it.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content

    texts = []
    for part in content:
        part_type = _field(part, "type")
        if part_type == "text":
            texts.append(_field(part, "text") or "")
            continue
        source_type = _field(_field(part, "source"), "type")
        if source_type == "file":
            logger.warning(
                "[AG-UI Agent Spec] Skipping %s part with a provider file handle "
                "(FileSource) in message %s: the Agent Spec runtimes cannot pass "
                "provider file handles to the model.",
                part_type,
                message_id,
            )
        else:
            logger.warning(
                "[AG-UI Agent Spec] Skipping non-text %r content part in message %s: "
                "the Agent Spec runtimes accept text content only.",
                part_type,
                message_id,
            )
    return "".join(texts)


def should_skip_role(role: str, *, message_id: Optional[str] = None) -> bool:
    """True for roles that are dropped from the runtime input (activity, reasoning)."""
    if role in SKIPPED_ROLES:
        logger.debug(
            "[AG-UI Agent Spec] Skipping %s message %s: not part of the model input.",
            role,
            message_id,
        )
        return True
    return False
