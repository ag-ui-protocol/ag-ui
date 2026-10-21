"""Per-session runtime context, delivered atomically with the turn that consumes it."""
import json
from dataclasses import dataclass
from typing import Any
from .types import SessionRecord
from ._util import get

HEADER = "AG-UI runtime context snapshot. Replace all earlier AG-UI runtime context snapshots with this complete list; an empty list clears them.\n"

class ContextDeliveryError(ValueError):
    """The native API cannot deliver changed context on this kind of turn."""

@dataclass
class ContextDelivery:
    snapshot: str
    with_results: bool

    def acknowledge(self, record: SessionRecord, *, results: bool) -> None:
        if results == self.with_results:
            record.runtime_context = self.snapshot


def attach_context(events: list[dict[str, Any]], context: Any, record: SessionRecord) -> ContextDelivery | None:
    entries = [{"description": item.description, "value": item.value} for item in (context or [])]
    snapshot = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    if not events or snapshot == record.runtime_context or (snapshot == "[]" and record.runtime_context is None):
        return None
    if record.session_thread_id:
        raise ContextDeliveryError("Runtime context cannot be injected into a native child thread.")
    results = [event for event in events if event["type"] != "user.message"]
    companion = results[-1] if results else events[-1]
    if companion["type"] not in ("user.message", "user.custom_tool_result", "user.tool_result"):
        raise ContextDeliveryError("Changed runtime context requires a user message or tool result; an approval alone cannot carry system context.")
    events.insert(events.index(companion) + 1, {"type": "system.message", "content": [{"type": "text", "text": HEADER + snapshot}]})
    return ContextDelivery(snapshot, bool(results))


def split_outbound(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    results: list[dict[str, Any]] = []
    followups: list[dict[str, Any]] = []
    batch = followups
    for event in events:
        if event["type"] != "system.message":
            batch = followups if event["type"] == "user.message" else results
        batch.append(event)
    return results, followups


def restore_context(content: Any, record: SessionRecord) -> None:
    """Recognize only our full snapshots; native system text may be unrelated."""
    if record.session_thread_id or not isinstance(content, list) or len(content) != 1:
        return
    text = get(content[0], "text")
    if not isinstance(text, str) or not text.startswith(HEADER):
        return
    try:
        entries = json.loads(text[len(HEADER):])
    except json.JSONDecodeError:
        return  # Malformed native system text was not produced by this adapter.
    if isinstance(entries, list) and all(isinstance(entry, dict) and isinstance(entry.get("description"), str) and isinstance(entry.get("value"), str) for entry in entries):
        record.runtime_context = json.dumps([{"description": entry["description"], "value": entry["value"]} for entry in entries], ensure_ascii=False, separators=(",", ":"))
