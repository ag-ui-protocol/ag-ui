"""Map LangChain/LangGraph token usage metadata into AG-UI ``TokenUsage``.

Kept dependency-free (only ``ag_ui.core``) so it can be unit-tested without the
full LangGraph runtime, and so the numeric-only mapping stays isolated from the
streaming logic. Only provider/model labels and numeric counts are read — never
prompt/completion content.
"""
from typing import Any, Dict, List, Optional

from ag_ui.core import TokenUsage

# Numeric fields summed during aggregation.
_COUNT_FIELDS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cached_input_tokens",
)


def token_usage_from_chunk(
    usage_metadata: Optional[Dict[str, Any]],
    *,
    provider: Optional[str],
    model: Optional[str],
) -> Optional[TokenUsage]:
    """Build a ``TokenUsage`` from a LangChain ``usage_metadata`` mapping.

    Returns ``None`` when no usage metadata is present, so callers can skip
    emitting empty usage rather than reporting zeros.
    """
    if not usage_metadata:
        return None

    input_details = usage_metadata.get("input_token_details") or {}
    output_details = usage_metadata.get("output_token_details") or {}

    return TokenUsage(
        provider=provider,
        model=model,
        input_tokens=usage_metadata.get("input_tokens"),
        output_tokens=usage_metadata.get("output_tokens"),
        total_tokens=usage_metadata.get("total_tokens"),
        reasoning_tokens=output_details.get("reasoning"),
        cached_input_tokens=input_details.get("cache_read"),
    )


def aggregate_token_usage(entries: List[TokenUsage]) -> List[TokenUsage]:
    """Sum per-call usage into one entry per ``(provider, model)`` pair.

    Order follows first appearance. A count field stays ``None`` when no member
    of the group reported it (so "not reported" is distinguishable from zero).
    """
    grouped: Dict[tuple, TokenUsage] = {}
    order: List[tuple] = []

    for entry in entries:
        key = (entry.provider, entry.model)
        if key not in grouped:
            grouped[key] = TokenUsage(provider=entry.provider, model=entry.model)
            order.append(key)
        target = grouped[key]
        for field in _COUNT_FIELDS:
            value = getattr(entry, field)
            if value is None:
                continue
            current = getattr(target, field)
            setattr(target, field, (current or 0) + value)

    return [grouped[key] for key in order]
