"""Shared JSON serialization helpers for tool-call arguments.

Standard ``json.dumps`` fails when args dicts contain Pydantic models or
Python ``Enum`` values (e.g. ``SecuritySchemeType``).  The helper here uses
Pydantic's ``TypeAdapter`` which knows how to serialize those types.
"""

from __future__ import annotations

from typing import Any

from pydantic import TypeAdapter

_dict_adapter: TypeAdapter[dict[str, Any]] = TypeAdapter(dict[str, Any])


def serialize_tool_args(args: Any) -> str:
    """Serialize tool-call *args* to a JSON string.

    Handles dicts that may contain Pydantic models, Enums, or other
    non-stdlib-serializable values by delegating to Pydantic's
    ``TypeAdapter.dump_json``.

    Returns:
        A JSON-encoded string.  For non-dict values the result is
        ``str(args)``.
    """
    if isinstance(args, dict):
        return _dict_adapter.dump_json(args).decode()
    return str(args)
