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
    SubagentErrorEvent,
    SubagentFinishedEvent,
    SubagentFinishedSuccessOutcome,
    SubagentFinishedSuspendedOutcome,
    SubagentStartedEvent,
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
        self.subagents: dict[str, SubagentStartedEvent] = {}
        self.suspended = False

    def _block(
        self, key: str, *, reasoning: bool, out: list[BaseEvent], agent_id: str | None = None
    ) -> dict[str, Any]:
        block = self.blocks.get(key)
        if block is None:
            block = self.blocks[key] = {
                "id": key,
                "text": "",
                "closed": False,
                "reasoning": reasoning,
                "agent": agent_id,
            }
            if reasoning:
                out.append(ReasoningStartEvent(message_id=key, subagent_run_id=agent_id))
                out.append(
                    ReasoningMessageStartEvent(
                        message_id=key, role="reasoning", subagent_run_id=agent_id
                    )
                )
            else:
                out.append(
                    TextMessageStartEvent(
                        message_id=key, role="assistant", subagent_run_id=agent_id
                    )
                )
        return block

    def _append(
        self, block: dict[str, Any], content: str, out: list[BaseEvent], *, final: bool = False
    ) -> None:
        if block["closed"] or not isinstance(content, str):
            return
        if final:
            # A final event repeats what already streamed; keep only the new suffix.
            delta = content[len(block["text"]) :] if content.startswith(block["text"]) else ""
        else:
            delta = content
        if not delta:
            return
        block["text"] += delta
        cls = ReasoningMessageContentEvent if block["reasoning"] else TextMessageContentEvent
        out.append(cls(message_id=block["id"], delta=delta, subagent_run_id=block["agent"]))

    def _close(self, block: dict[str, Any], out: list[BaseEvent]) -> None:
        if block["closed"]:
            return
        block["closed"] = True
        agent = block["agent"]
        if block["reasoning"]:
            out.append(ReasoningMessageEndEvent(message_id=block["id"], subagent_run_id=agent))
            out.append(ReasoningEndEvent(message_id=block["id"], subagent_run_id=agent))
        else:
            out.append(TextMessageEndEvent(message_id=block["id"], subagent_run_id=agent))

    def _start_tool(
        self, call_id: str, name: str, out: list[BaseEvent], agent_id: str | None
    ) -> dict[str, Any]:
        tool = self.tools.setdefault(
            call_id,
            {
                "name": name,
                "completed": False,
                "ended": False,
                "agent": agent_id,
                "started": False,
                "args": "",
            },
        )
        if not tool["started"] and name:
            tool["name"] = name
            tool["started"] = True
            out.append(
                ToolCallStartEvent(
                    tool_call_id=call_id, tool_call_name=name, subagent_run_id=agent_id
                )
            )
        return tool

    def _stream_args(
        self, data: Mapping[str, Any], out: list[BaseEvent], agent_id: str | None
    ) -> None:
        """Streamed argument fragments: START on the first one, ARGS for each."""
        call_id = data["toolCallId"]
        started = self.tools.get(call_id, {}).get("started", False)
        tool = self._start_tool(call_id, data.get("toolName") or "", out, agent_id)
        if tool["ended"]:
            return
        tool["args"] += data.get("inputDelta") or ""
        fragment = data.get("inputDelta") if started else tool["args"]
        if tool["started"] and fragment:
            out.append(
                ToolCallArgsEvent(
                    tool_call_id=call_id, delta=fragment, subagent_run_id=tool["agent"]
                )
            )

    def _tool_call(
        self,
        call_id: str,
        name: str,
        arguments: Any,
        out: list[BaseEvent],
        agent_id: str | None = None,
    ) -> None:
        """Close a streamed call, or emit START/ARGS/END at once when nothing streamed."""
        tool = self.tools.get(call_id)
        if tool is not None and tool["ended"]:
            return
        streamed = tool is not None and tool["started"]
        tool = self._start_tool(call_id, name, out, agent_id)
        if not streamed:
            encoded = (
                arguments
                if isinstance(arguments, str)
                else json.dumps(arguments or {}, separators=(",", ":"))
            )
            if encoded:
                out.append(
                    ToolCallArgsEvent(
                        tool_call_id=call_id, delta=encoded, subagent_run_id=tool["agent"]
                    )
                )
        tool["ended"] = True
        out.append(ToolCallEndEvent(tool_call_id=call_id, subagent_run_id=tool["agent"]))

    def map_event(self, event: Mapping[str, Any]) -> list[BaseEvent]:
        identity = event.get("id")
        if identity in self.seen:
            return []
        if identity is not None:
            self.seen.add(identity)
        kind, data = event["type"], event.get("data") or {}
        # Events raised inside a subagent carry its id; AG-UI groups by it.
        agent = event.get("agentId")
        out: list[BaseEvent] = []
        if kind == "assistant.message_start":
            self._block(data["messageId"], reasoning=False, out=out, agent_id=agent)
        elif kind == "assistant.message_delta":
            block = self._block(data["messageId"], reasoning=False, out=out, agent_id=agent)
            self._append(block, data["deltaContent"], out)
        elif kind == "assistant.reasoning_delta":
            block = self._block(data["reasoningId"], reasoning=True, out=out, agent_id=agent)
            self._append(block, data["deltaContent"], out)
        elif kind == "assistant.reasoning":
            block = self._block(data["reasoningId"], reasoning=True, out=out, agent_id=agent)
            self._append(block, data["content"], out, final=True)
            self._close(block, out)
        elif kind == "assistant.tool_call_delta":
            self._stream_args(data, out, agent)
        elif kind == "assistant.message":
            if data.get("content") or data["messageId"] in self.blocks:
                block = self._block(data["messageId"], reasoning=False, out=out, agent_id=agent)
                self._append(block, data.get("content") or "", out, final=True)
                self._close(block, out)
            for request in data.get("toolRequests") or []:
                self._tool_call(
                    request["toolCallId"], request["name"], request.get("arguments"), out, agent
                )
        elif kind in ("tool.execution_start", "external_tool.requested"):
            self._tool_call(data["toolCallId"], data["toolName"], data.get("arguments"), out, agent)
        elif kind == "tool.execution_complete":
            tool = self.tools.get(data["toolCallId"])
            if tool is not None and not tool["completed"]:
                tool["completed"] = True
                result = (
                    (data.get("result") or {}).get("content")
                    or (data.get("error") or {}).get("message")
                    or ""
                )
                out.append(
                    ToolCallResultEvent(
                        message_id=f"result:{data['toolCallId']}",
                        tool_call_id=data["toolCallId"],
                        content=str(result)[:MAX_OUTPUT_CHARS],
                        role="tool",
                        subagent_run_id=tool["agent"],
                    )
                )
        elif kind == "subagent.started":
            # The runtime stamps the child's agentId on the envelope; the spawning
            # toolCallId is the fallback so the lifecycle stays correlatable.
            started = SubagentStartedEvent(
                subagent_run_id=agent or data["toolCallId"],
                name=data.get("agentDisplayName") or data["agentName"],
                description=data.get("agentDescription"),
                parent_subagent_run_id=(
                    data.get("parentId") if data.get("parentId") in self.subagents else None
                ),
                parent_tool_call_id=data["toolCallId"],
            )
            self.subagents[started.subagent_run_id] = started
            out.append(started)
        elif kind == "subagent.completed":
            self.subagents.pop(agent or data["toolCallId"], None)
            out.append(
                SubagentFinishedEvent(
                    subagent_run_id=agent or data["toolCallId"],
                    outcome=SubagentFinishedSuccessOutcome(),
                )
            )
        elif kind == "subagent.failed":
            self.subagents.pop(agent or data["toolCallId"], None)
            out.append(
                SubagentErrorEvent(
                    subagent_run_id=agent or data["toolCallId"], message=data["error"]
                )
            )
        elif kind == "assistant.turn_end":
            for block in self.blocks.values():
                if block["agent"] == agent:
                    self._close(block, out)
        return out

    def suspend(self) -> list[BaseEvent]:
        """AG-UI requires children to be suspended before their parent hands off."""
        self.suspended = True
        return [
            SubagentFinishedEvent(subagent_run_id=key, outcome=SubagentFinishedSuspendedOutcome())
            for key in reversed(self.subagents)
        ]

    def resume(self) -> list[BaseEvent]:
        if not self.suspended:
            return []
        self.suspended = False
        return list(self.subagents.values())

    def finish(self) -> list[BaseEvent]:
        out: list[BaseEvent] = []
        for block in self.blocks.values():
            self._close(block, out)
        for call_id, tool in self.tools.items():
            if tool["started"] and not tool["ended"]:
                tool["ended"] = True
                out.append(ToolCallEndEvent(tool_call_id=call_id, subagent_run_id=tool["agent"]))
        return out
