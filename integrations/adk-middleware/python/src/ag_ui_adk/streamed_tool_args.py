"""Incremental TOOL_CALL_ARGS deltas from ADK ``PartialArg`` chunks.

Since google-adk 2.10 (google/adk-python f449780) every model adapter —
Gemini (Vertex), LiteLLM, OpenAI, Anthropic, Apigee — surfaces streamed
function-call arguments the same way: partial ``FunctionCall`` events that
carry ``partial_args`` (a list of ``PartialArg(json_path, <value>)``) and
``will_continue=True``, followed by the final aggregated ``FunctionCall``.

``StreamedToolArgs`` rebuilds the argument object from those chunks with the
same semantics as ADK's own aggregator (``string_value`` is appended, other
scalars are set) and turns it into JSON-text deltas. The invariant is that the
concatenation of every emitted delta is always a prefix of the final
serialized arguments, so ``finish()`` can complete it with the exact tail and
clients always end up with valid JSON equal to the final ``FunctionCall.args``.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, List, Optional, Sequence, Union

logger = logging.getLogger(__name__)

# Mirrors google.adk.utils.streaming_utils._JSON_PATH_TOKEN_RE (kept local so
# the middleware does not depend on a private ADK helper).
_JSON_PATH_TOKEN_RE = re.compile(
    r"""
    \[\s*(\d+)\s*\]
    | \['((?:[^'\\]|\\.)*)'\]
    | \["((?:[^"\\]|\\.)*)"\]
    | (?:\.?((?:[^.\[\]\\]|\\.)+))
    """,
    re.VERBOSE,
)
_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f"}
_TRAILING_SCALAR_RE = re.compile(r"[-+0-9.eEtruefalsn]+$")

PathToken = Union[str, int]


def _unescape(s: str) -> str:
    def repl(m: re.Match[str]) -> str:
        if m.group(1):
            return chr(int(m.group(1), 16))
        return _ESCAPES.get(m.group(2), m.group(2))

    return re.sub(r"\\u([0-9a-fA-F]{4})|\\(.)", repl, s)


def parse_json_path(json_path: str) -> List[PathToken]:
    """Parse an ADK ``PartialArg.json_path`` (``$.a.b[0]['c d']``) into tokens."""
    path = json_path[2:] if json_path.startswith("$.") else json_path.lstrip("$")
    tokens: List[PathToken] = []
    for m in _JSON_PATH_TOKEN_RE.finditer(path):
        if m.group(1) is not None:
            tokens.append(int(m.group(1)))
        else:
            tokens.append(_unescape(next(g for g in m.groups()[1:] if g is not None)))
    return tokens


def _normalize(value: Any) -> Any:
    """``PartialArg.number_value`` is a float; render whole numbers as ints."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def _dumps(value: Any) -> str:
    return json.dumps(_normalize(value), ensure_ascii=False, separators=(",", ":"))


def _stable_prefix(serialized: str) -> str:
    """Drop the tail of a partial serialization that may still change.

    That is: closing brackets of still-open containers, then either the
    closing quote of a (possibly still growing) string or a trailing scalar
    literal that may not be complete yet.
    """
    end = len(serialized)
    while end and serialized[end - 1] in "}]":
        end -= 1
    if end and serialized[end - 1] == '"':
        return serialized[: end - 1]
    m = _TRAILING_SCALAR_RE.search(serialized, 0, end)
    return serialized[: m.start()] if m else serialized[:end]


class StreamedToolArgs:
    """Accumulates one streamed tool call's arguments and yields JSON deltas."""

    def __init__(self, tool_call_id: str, tool_name: Optional[str]):
        self.tool_call_id = tool_call_id
        self.tool_name = tool_name
        self._value: dict = {}
        self._emitted = ""
        # Once a chunk can't be applied faithfully we stop emitting incremental
        # deltas; finish() still completes the (valid) prefix from final args.
        self._degraded = False

    @property
    def emitted(self) -> str:
        return self._emitted

    def apply(self, partial_args: Optional[Sequence[Any]]) -> str:
        """Apply ``PartialArg`` chunks; return the new JSON delta (may be '')."""
        if self._degraded or not partial_args:
            return ""
        for pa in partial_args:
            if not self._apply_one(pa):
                self._degraded = True
                logger.debug(
                    "Streamed args for %s degraded at json_path=%r; remainder "
                    "will be sent with the final call",
                    self.tool_call_id,
                    getattr(pa, "json_path", None),
                )
                return ""
        return self._advance(_stable_prefix(_dumps(self._value)))

    def finish(self, final_args: Optional[dict]) -> str:
        """Return the delta that completes the arguments JSON.

        ``final_args`` is the aggregated ``FunctionCall.args``; when it's not
        available (stream cut short) the partially rebuilt object is closed.
        """
        target = _dumps(final_args if isinstance(final_args, dict) else self._value)
        if not target.startswith(self._emitted):
            # Should not happen: chunks disagreed with the final call. The
            # client-side JSON would be corrupt either way; log loudly.
            logger.warning(
                "Streamed args for %s diverged from the final function call; "
                "emitted=%r final=%r",
                self.tool_call_id,
                self._emitted[:200],
                target[:200],
            )
            return ""
        return self._advance(target)

    # ------------------------------------------------------------------ #
    def _advance(self, text: str) -> str:
        if not text.startswith(self._emitted):
            return ""  # value regressed (e.g. a string was replaced); wait for more
        delta = text[len(self._emitted) :]
        self._emitted = text
        return delta

    def _apply_one(self, pa: Any) -> bool:
        json_path = getattr(pa, "json_path", None)
        if not json_path:
            return False
        tokens = parse_json_path(json_path)
        if not tokens or not isinstance(tokens[0], str):
            return False

        if getattr(pa, "string_value", None) is not None:
            is_string, value = True, pa.string_value
        elif getattr(pa, "number_value", None) is not None:
            is_string, value = False, pa.number_value
        elif getattr(pa, "bool_value", None) is not None:
            is_string, value = False, pa.bool_value
        elif getattr(pa, "null_value", None) is not None:
            is_string, value = False, None
        else:
            # Valueless PartialArg: ADK uses it for empty {} / [] leaves, whose
            # type it cannot convey. Can't place it -> degrade.
            return False

        container: Any = self._value
        for tok, nxt in zip(tokens, tokens[1:]):
            child_default: Any = [] if isinstance(nxt, int) else {}
            if isinstance(tok, int):
                if not isinstance(container, list) or tok > len(container):
                    return False
                if tok == len(container):
                    container.append(child_default)
            elif not isinstance(container, dict):
                return False
            else:
                container.setdefault(tok, child_default)
            container = container[tok]
            if not isinstance(container, (dict, list)):
                return False

        leaf = tokens[-1]
        if isinstance(leaf, int):
            if not isinstance(container, list) or leaf > len(container):
                return False
            if leaf == len(container):
                container.append("" if is_string else value)
            current = container[leaf]
        else:
            if not isinstance(container, dict):
                return False
            current = container.setdefault(leaf, "" if is_string else value)

        if is_string:
            if not isinstance(current, str):
                return False
            container[leaf] = current + value
        else:
            container[leaf] = value
        return True
