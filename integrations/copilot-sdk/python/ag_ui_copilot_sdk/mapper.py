"""Allowlisted, stateful projection of native Copilot SDK events onto AG-UI events."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from ag_ui.core import (
    BaseEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

MAX_OUTPUT_CHARS = 65_536


class EventMapper:
    """One mapper per live SDK session, retained across frontend-tool handoffs.

    ``finish()`` closes text and reasoning blocks; it never invents a tool result.
    """

    def __init__(self) -> None:
        self.seen: set[str] = set()
        self.blocks: dict[str, dict[str, Any]] = {}
        self.tools: dict[str, dict[str, Any]] = {}

    def _block(self, key: str, *, reasoning: bool, out: list[BaseEvent]) -> dict[str, Any]:
        block = self.blocks.get(key)
        if block is None:
            block = self.blocks[key] = {"id": key, "text": "", "closed": False,
                                        "reasoning": reasoning}
            if reasoning:
                out.append(ReasoningStartEvent(message_id=key))
                out.append(ReasoningMessageStartEvent(message_id=key, role="reasoning"))
            else:
                out.append(TextMessageStartEvent(message_id=key, role="assistant"))
        return block

    def _append(
        self, block: dict[str, Any], content: str, out: list[BaseEvent], *, final: bool = False
    ) -> None:
        if block["closed"] or not isinstance(content, str):
            return
        if final:
            # A final event repeats what already streamed; keep only the new suffix.
            delta = content[len(block["text"]):] if content.startswith(block["text"]) else ""
        else:
            delta = content
        if not delta:
            return
        block["text"] += delta
        cls = ReasoningMessageContentEvent if block["reasoning"] else TextMessageContentEvent
        out.append(cls(message_id=block["id"], delta=delta))

    def _close(self, block: dict[str, Any], out: list[BaseEvent]) -> None:
        if block["closed"]:
            return
        block["closed"] = True
        if block["reasoning"]:
            out.append(ReasoningMessageEndEvent(message_id=block["id"]))
            out.append(ReasoningEndEvent(message_id=block["id"]))
        else:
            out.append(TextMessageEndEvent(message_id=block["id"]))

    def _tool_call(
        self, call_id: str, name: str, arguments: Any, out: list[BaseEvent]
    ) -> None:
        if call_id in self.tools:
            return
        encoded = arguments if isinstance(arguments, str) else json.dumps(
            arguments or {}, separators=(",", ":")
        )
        self.tools[call_id] = {"name": name, "completed": False}
        out.append(ToolCallStartEvent(tool_call_id=call_id, tool_call_name=name))
        if encoded:
            out.append(ToolCallArgsEvent(tool_call_id=call_id, delta=encoded))
        out.append(ToolCallEndEvent(tool_call_id=call_id))

    def map_event(self, event: Mapping[str, Any]) -> list[BaseEvent]:
        identity = event.get("id")
        if identity in self.seen:
            return []
        if identity is not None:
            self.seen.add(identity)
        kind, data = event["type"], event.get("data") or {}
        out: list[BaseEvent] = []
        if kind == "assistant.message_start":
            self._block(data["messageId"], reasoning=False, out=out)
        elif kind == "assistant.message_delta":
            block = self._block(data["messageId"], reasoning=False, out=out)
            self._append(block, data["deltaContent"], out)
        elif kind == "assistant.reasoning_delta":
            block = self._block(data["reasoningId"], reasoning=True, out=out)
            self._append(block, data["deltaContent"], out)
        elif kind == "assistant.reasoning":
            block = self._block(data["reasoningId"], reasoning=True, out=out)
            self._append(block, data["content"], out, final=True)
            self._close(block, out)
        elif kind == "assistant.message":
            if data.get("content") or data["messageId"] in self.blocks:
                block = self._block(data["messageId"], reasoning=False, out=out)
                self._append(block, data.get("content") or "", out, final=True)
                self._close(block, out)
            for request in data.get("toolRequests") or []:
                self._tool_call(
                    request["toolCallId"], request["name"], request.get("arguments"), out
                )
        elif kind in ("tool.execution_start", "external_tool.requested"):
            self._tool_call(data["toolCallId"], data["toolName"], data.get("arguments"), out)
        elif kind == "tool.execution_complete":
            tool = self.tools.get(data["toolCallId"])
            if tool is not None and not tool["completed"]:
                tool["completed"] = True
                result = (data.get("result") or {}).get("content") or (
                    data.get("error") or {}
                ).get("message") or ""
                out.append(
                    ToolCallResultEvent(
                        message_id=f"result:{data['toolCallId']}",
                        tool_call_id=data["toolCallId"],
                        content=str(result)[:MAX_OUTPUT_CHARS],
                        role="tool",
                    )
                )
        elif kind == "assistant.turn_end":
            for block in self.blocks.values():
                self._close(block, out)
        return out

    def finish(self) -> list[BaseEvent]:
        out: list[BaseEvent] = []
        for block in self.blocks.values():
            self._close(block, out)
        return out
