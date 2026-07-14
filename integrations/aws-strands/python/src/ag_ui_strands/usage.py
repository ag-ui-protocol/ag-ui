"""Map Strands accumulated token usage into an AG-UI ``TokenUsage``.

Kept dependency-free (only ``ag_ui.core``) so the numeric-only mapping stays
isolated from the streaming logic and is unit-testable without the Strands SDK.
Only numeric counts (+ optional provider/model labels) are read — never
prompt/completion content.
"""
from typing import Any, Optional

from ag_ui.core import TokenUsage


def _int(value: Any) -> Optional[int]:
    # bool is a subclass of int in Python — exclude it so a stray True/False
    # never becomes a token count.
    if isinstance(value, bool):
        return None
    return value if isinstance(value, int) else None


def token_usage_from_strands(
    accumulated_usage: Any,
    *,
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> Optional[TokenUsage]:
    """Build a ``TokenUsage`` from a Strands ``EventLoopMetrics.accumulated_usage``.

    ``accumulated_usage`` is Strands' ``Usage`` mapping
    (``{"inputTokens", "outputTokens", "totalTokens", ...}``). Accepts a dict or
    an attribute-style object. Returns ``None`` when no numeric count is present
    so callers can omit usage rather than report zeros.
    """
    if not accumulated_usage:
        return None

    if isinstance(accumulated_usage, dict):
        get = accumulated_usage.get
    else:
        get = lambda key, default=None: getattr(accumulated_usage, key, default)

    input_tokens = _int(get("inputTokens"))
    output_tokens = _int(get("outputTokens"))
    total_tokens = _int(get("totalTokens"))
    cached_input_tokens = _int(get("cacheReadInputTokens"))

    if input_tokens is None and output_tokens is None and total_tokens is None:
        return None

    return TokenUsage(
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cached_input_tokens=cached_input_tokens,
    )
