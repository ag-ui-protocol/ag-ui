"""Gemini 3 workarounds for streaming function call arguments.

These workarounds address ADK bugs that affect streaming function call
arguments with Gemini 3 models.

Both workarounds are auto-applied by the middleware when
``streaming_function_call_arguments=True``:

- ``apply_aggregator_patch`` is called once in ``ADKAgent.__init__``.
- ``repair_thought_signatures`` is injected as a ``before_model_callback``.

Remove these workarounds when the upstream fixes are released:
- https://github.com/google/adk-python/issues/4311
"""

from __future__ import annotations

import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Workaround 1 – Monkey-patch StreamingResponseAggregator
# ---------------------------------------------------------------------------
# Upstream bug: https://github.com/google/adk-python/issues/4311
#
# The original _process_function_call_part dispatches on whether partial_args
# is present.  The FIRST streaming chunk carries the function name and
# will_continue=True but *no* partial_args, so it falls into the non-streaming
# branch and gets appended with empty args.  The fix: also check will_continue
# to decide whether this is the start of a streaming function call.

_patch_applied = False


def apply_aggregator_patch() -> None:
    """Monkey-patch StreamingResponseAggregator to handle streaming FC first chunk.

    This patch is idempotent — calling it multiple times has no effect after
    the first successful application.
    """
    global _patch_applied
    if _patch_applied:
        return

    try:
        from google.adk.utils.streaming_utils import StreamingResponseAggregator
    except ImportError:
        logger.warning("Could not import StreamingResponseAggregator; skipping patch")
        return

    from google.genai import types  # noqa: F811

    _original = StreamingResponseAggregator._process_function_call_part

    def _patched_process_function_call_part(self: Any, part: types.Part) -> None:
        fc = part.function_call

        has_partial_args = hasattr(fc, "partial_args") and fc.partial_args
        will_continue = getattr(fc, "will_continue", None)

        # Streaming first chunk: has name + will_continue but no partial_args yet.
        # Route it to the streaming path so _current_fc_name is set properly.
        if not has_partial_args and will_continue and fc.name:
            if getattr(part, "thought_signature", None) and not self._current_thought_signature:
                self._current_thought_signature = part.thought_signature
            if getattr(fc, "partial_args", None) is None:
                fc.partial_args = []
            self._process_streaming_function_call(fc)
            return

        # End-of-stream marker: no partial_args, no name, will_continue is None/False.
        # If we have accumulated streaming state, flush it.
        if (
            not has_partial_args
            and not fc.name
            and not will_continue
            and self._current_fc_name
        ):
            self._flush_text_buffer_to_sequence()
            self._flush_function_call_to_sequence()
            return

        # Default: delegate to original implementation
        _original(self, part)

    StreamingResponseAggregator._process_function_call_part = _patched_process_function_call_part
    _patch_applied = True
    logger.info("Applied StreamingResponseAggregator monkey-patch for streaming FC first-chunk bug")


# ---------------------------------------------------------------------------
# Workaround 2 – Thought-signature repair callback
# ---------------------------------------------------------------------------
# Related to https://github.com/google/adk-python/issues/4311

SKIP_SENTINEL = b"skip_thought_signature_validator"


def repair_thought_signatures(
    callback_context: Any,
    llm_request: Any,
) -> None:
    """Ensure every function_call Part has a thought_signature before the LLM call.

    Strategy:
    1. Harvest real signatures already present in contents or session events.
    2. Inject cached real signature or skip sentinel for any missing ones.

    This function is intended to be used as a ``before_model_callback`` on an
    ``LlmAgent``.
    """
    session_id = getattr(callback_context.session, "id", "unknown")

    sig_cache: Dict[str, bytes] = {}

    def _harvest(parts: list) -> None:
        for part in parts:
            fc = getattr(part, "function_call", None)
            if not fc:
                continue
            sig = getattr(part, "thought_signature", None)
            if sig and sig != SKIP_SENTINEL:
                fc_id = getattr(fc, "id", None)
                fc_name = getattr(fc, "name", None)
                key = f"{session_id}:{fc_id or fc_name}"
                sig_cache[key] = sig

    for content in llm_request.contents:
        _harvest(getattr(content, "parts", None) or [])

    if hasattr(callback_context.session, "events"):
        for event in callback_context.session.events:
            if hasattr(event, "content") and event.content:
                _harvest(getattr(event.content, "parts", None) or [])

    repaired = 0
    for content in llm_request.contents:
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if not fc:
                continue
            if getattr(part, "thought_signature", None):
                continue

            fc_id = getattr(fc, "id", None)
            fc_name = getattr(fc, "name", None)
            key = f"{session_id}:{fc_id or fc_name}"
            cached = sig_cache.get(key)
            part.thought_signature = cached if cached else SKIP_SENTINEL
            repaired += 1

    if repaired:
        logger.info("Repaired %d function_call part(s) with missing thought_signature", repaired)

    return None  # continue to LLM
