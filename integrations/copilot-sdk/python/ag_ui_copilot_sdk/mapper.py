"""Allowlisted, stateful SDK JSON -> typed AG-UI events. No raw-event forwarding."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from ag_ui.core import (
    ActivitySnapshotEvent,
    BaseEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    SubagentErrorEvent,
    SubagentFinishedEvent,
    SubagentStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)


class EventMapper:
    """One mapper per live SDK session, retained across frontend handoffs.

    ``finish()`` closes text/reasoning blocks, never invents a tool result.
    Memory/output caps fail explicitly rather than silently dropping deltas.
    """

    def __init__(
        self, *, max_output_chars: int = 65_536, max_items: int = 4096, max_events: int = 20_000
    ):
        if min(max_output_chars, max_items, max_events) <= 0:
            raise ValueError("Mapper limits must be positive")
        self.max_output_chars = max_output_chars
        self.max_items = max_items
        self.max_events = max_events
        self.seen: set[str] = set()
        self.messages: dict[str, dict[str, Any]] = {}
        self.tools: dict[str, dict[str, Any]] = {}
        self.shell_tools: set[str] = set()
        self.children: dict[str, dict[str, Any]] = {}
        self.agent_tool_calls: dict[str, str] = {}
        self.argument_deltas: dict[str, str] = {}

    def _bounded(self, text: str) -> str:
        return text[: self.max_output_chars]

    def _capacity(self, additional: int = 1) -> None:
        if (
            sum(
                map(
                    len, (self.messages, self.tools, self.children, self.argument_deltas)
                )
            )
            + additional > self.max_items
        ):
            raise ValueError("SDK session entity limit exceeded")

    def _parent_scope(self, parent: str | None) -> str | None:
        if parent and (
            parent not in self.children or self.children[parent]["status"] != "running"
        ):
            raise ValueError("Unannounced subagent parent")
        return parent

    def _scope(self, data: Mapping[str, Any], event: Mapping[str, Any]) -> str | None:
        # parentId is chronological log linkage, NEVER agent ancestry.
        agent_id = event.get("agentId")
        if agent_id:
            if agent_id in self.agent_tool_calls:
                scope = self.agent_tool_calls[agent_id]
                if (
                    self.children[scope]["status"] != "running"
                    and event.get("type", "").startswith(("assistant.", "tool.execution_"))
                ):
                    raise ValueError("Late event for a finished subagent")
                return scope
            kind = event.get("type", "")
            if kind != "subagent.started" and (
                kind.startswith(("assistant.", "tool.execution_"))
                or kind in (
                    "external_tool.requested", "subagent.completed", "subagent.failed",
                    "abort", "agent.interrupted",
                )
            ):
                raise ValueError("Unannounced subagent identity")
        parent = data.get("parentToolCallId")
        return self._parent_scope(parent)

    def _text(
        self, key: str, content: str, *, final: bool, reasoning: bool, scope: str | None
    ) -> list[BaseEvent]:
        if not isinstance(content, str):
            raise TypeError("SDK text must be a string")
        message_id = f"{scope}:{key}" if scope else key
        entry = self.messages.get(message_id)
        events: list[BaseEvent] = []
        if entry is None:
            if not content:
                return []
            self._capacity()
            entry = self.messages[message_id] = {
                "text": "",
                "closed": False,
                "reasoning": reasoning,
                "scope": scope,
                "wire_id": message_id,
            }
            if reasoning:
                events.extend(
                    [
                        ReasoningStartEvent(message_id=message_id),
                        ReasoningMessageStartEvent(message_id=message_id, role="reasoning"),
                    ]
                )
            else:
                events.append(TextMessageStartEvent(message_id=message_id, role="assistant"))
        previous = entry["text"]
        delta = content[len(previous) :] if final and content.startswith(previous) else content
        if final and previous and not content.startswith(previous):
            delta = ""  # A final alternate representation must not repeat streamed text.
        if len(previous) + len(delta) > self.max_output_chars:
            raise ValueError("Assistant output limit exceeded")
        if entry["closed"]:
            if not delta:
                return []
            if scope and self.children.get(scope, {}).get("status") != "running":
                raise ValueError("Late text for a finished subagent")
            # A prior AG-UI segment is closed; retain only the new native suffix.
            entry["wire_id"] = str(uuid4())
            entry["closed"] = False
            if reasoning:
                events.append(ReasoningStartEvent(message_id=entry["wire_id"]))
                events.append(
                    ReasoningMessageStartEvent(message_id=entry["wire_id"], role="reasoning")
                )
            else:
                events.append(TextMessageStartEvent(message_id=entry["wire_id"], role="assistant"))
        if delta:
            cls = ReasoningMessageContentEvent if reasoning else TextMessageContentEvent
            events.append(cls(message_id=entry["wire_id"], delta=delta))
            entry["text"] += delta
        if final:
            events.extend(self._close_message(message_id))
        if scope:
            for event in events:
                event.__dict__["subagent_run_id"] = scope
        return events

    def _close_message(self, message_id: str) -> list[BaseEvent]:
        item = self.messages[message_id]
        if item["closed"]:
            return []
        item["closed"] = True
        wire_id = item["wire_id"]
        if item["reasoning"]:
            events = [
                ReasoningMessageEndEvent(message_id=wire_id),
                ReasoningEndEvent(message_id=wire_id),
            ]
        else:
            events = [TextMessageEndEvent(message_id=wire_id)]
        if item["scope"]:
            for event in events:
                event.__dict__["subagent_run_id"] = item["scope"]
        return events

    def _activity(self, call_id: str) -> ActivitySnapshotEvent:
        return ActivitySnapshotEvent(
            message_id=f"activity:{call_id}",
            activity_type="copilot-sdk:tool",
            content=dict(self.tools[call_id]),
            subagent_run_id=self.tools[call_id].get("parentToolCallId"),
        )

    def _start_tool(self, data: Mapping[str, Any], event: Mapping[str, Any]) -> list[BaseEvent]:
        call_id, name = data["toolCallId"], data.get("toolName", data.get("name"))
        if not isinstance(call_id, str) or not call_id.strip():
            raise ValueError("SDK tool call ID must be nonempty")
        is_shell = name in ("bash", "powershell") or data.get("shellToolInfo") is not None
        if call_id in self.tools:
            item = self.tools[call_id]
            scope = self._scope(data, event)
            if scope and item.get("parentToolCallId") != scope:
                raise ValueError("Tool owner changed")
            if is_shell:
                self.shell_tools.add(call_id)
            command = (data.get("shellToolInfo") or {}).get("displayCommand")
            if (
                command is None
                and call_id in self.shell_tools
                and isinstance(item["arguments"], Mapping)
            ):
                command = item["arguments"].get("command")
            changed = False
            if command is not None and item.get("command") != self._bounded(command):
                item["command"] = self._bounded(command)
                changed = True
            return [self._activity(call_id)] if changed else []
        if not isinstance(name, str) or not name:
            raise ValueError("SDK tool name missing")
        arguments = data.get("arguments")
        buffered = self.argument_deltas.get(call_id, "")
        if arguments is None:
            arguments = json.loads(buffered) if buffered else {}
        encoded = (
            arguments
            if isinstance(arguments, str)
            else json.dumps(arguments, separators=(",", ":"))
        )
        if len(encoded) > self.max_output_chars:
            raise ValueError("Tool arguments limit exceeded")
        scope = self._scope(data, event)
        self._capacity(0 if call_id in self.argument_deltas else 1)
        self.argument_deltas.pop(call_id, None)
        if is_shell:
            self.shell_tools.add(call_id)
        item = self.tools[call_id] = {
            "toolCallId": call_id,
            "toolName": name,
            "status": "running",
            "arguments": arguments,
            "output": "",
            "truncated": False,
        }
        if scope:
            item["parentToolCallId"] = scope
        command = (data.get("shellToolInfo") or {}).get("displayCommand")
        if command is None and call_id in self.shell_tools and isinstance(arguments, Mapping):
            command = arguments.get("command")
        if command is not None:
            item["command"] = self._bounded(command)
        start = ToolCallStartEvent(tool_call_id=call_id, tool_call_name=name)
        if data.get("parentMessageId"):
            parent_message_id = data["parentMessageId"]
            parent_key = f"{scope}:{parent_message_id}" if scope else parent_message_id
            start.parent_message_id = self.messages.get(parent_key, {}).get("wire_id", parent_key)
        events = [
            start,
            ToolCallArgsEvent(tool_call_id=call_id, delta=encoded),
            ToolCallEndEvent(tool_call_id=call_id),
            self._activity(call_id),
        ]
        if scope:
            for mapped in events:
                mapped.__dict__["subagent_run_id"] = scope
        return events

    def map_event(self, event: Mapping[str, Any]) -> list[BaseEvent]:
        """Map SDK ``SessionEvent.to_dict()`` JSON, omitting unsupported events."""
        kind = event.get("type")
        data = event.get("data", {})
        if not isinstance(kind, str) or not isinstance(data, Mapping):
            raise TypeError("Malformed SDK event")
        event_id = event.get("id")
        if event_id:
            if event_id in self.seen:
                return []
            if len(self.seen) >= self.max_events:
                raise ValueError("SDK event deduplication limit exceeded")
            self.seen.add(event_id)
        scope = self._scope(data, event)
        if kind in ("assistant.message_delta", "assistant.message"):
            events = self._text(
                data["messageId"],
                data.get("deltaContent", data.get("content", "")),
                final=kind == "assistant.message",
                reasoning=False,
                scope=scope,
            )
            for tool in data.get("toolRequests", []):
                events.extend(
                    self._start_tool(
                        {
                            **tool,
                            "parentMessageId": data["messageId"],
                            "parentToolCallId": scope,
                        },
                        event,
                    )
                )
            return events
        if kind in ("assistant.reasoning_delta", "assistant.reasoning"):
            return self._text(
                data["reasoningId"],
                data.get("deltaContent", data.get("content", "")),
                final=kind == "assistant.reasoning",
                reasoning=True,
                scope=scope,
            )
        if kind == "assistant.tool_call_delta":
            call_id = data["toolCallId"]
            if call_id not in self.tools:
                if call_id not in self.argument_deltas:
                    self._capacity()
                value = self.argument_deltas.get(call_id, "") + data.get("inputDelta", "")
                if len(value) > self.max_output_chars:
                    raise ValueError("Tool arguments limit exceeded")
                self.argument_deltas[call_id] = value
            return []
        if kind in ("tool.execution_start", "external_tool.requested"):
            return self._start_tool(data, event)
        if kind.startswith("tool.execution_"):
            call_id = data["toolCallId"]
            if call_id not in self.tools:
                return []  # No fabricated name/relationship for an orphaned tool event.
            item = self.tools[call_id]
            if item["status"] != "running":
                return []
            if kind == "tool.execution_partial_result":
                # Native shell partials are cumulative snapshots; other tools stream chunks.
                output = data["partialOutput"]
                if call_id not in self.shell_tools:
                    output = item["output"] + output
                item.update(
                    output=self._bounded(output),
                    truncated=item["truncated"] or len(output) > self.max_output_chars,
                )
                return [self._activity(call_id)]
            if kind == "tool.execution_progress":
                item["progress"] = self._bounded(data["progressMessage"])
                return [self._activity(call_id)]
            if kind == "tool.execution_complete":
                error = data.get("error") or {}
                cancelled = error.get("code", "").lower() in ("cancelled", "canceled", "abort")
                item["status"] = (
                    "completed" if data.get("success") else ("cancelled" if cancelled else "error")
                )
                result = (data.get("result") or {}).get("content", error.get("message", ""))
                result = (
                    result if isinstance(result, str) else json.dumps(result, separators=(",", ":"))
                )
                if result or not item["output"]:
                    item["output"] = self._bounded(result)
                exit_code = (data.get("shellExecution") or {}).get("exitCode")
                if isinstance(exit_code, int) and not isinstance(exit_code, bool):
                    item["exitCode"] = exit_code
                    if exit_code != 0 and item["status"] == "completed":
                        item["status"] = "error"
                item["truncated"] |= len(result) > self.max_output_chars
                tool_result = ToolCallResultEvent(
                    message_id=f"result:{call_id}",
                    tool_call_id=call_id,
                    content=self._bounded(result),
                    role="tool",
                )
                if item.get("parentToolCallId"):
                    tool_result.__dict__["subagent_run_id"] = item["parentToolCallId"]
                return [tool_result, self._activity(call_id)]
        if kind in ("subagent.started", "subagent.completed", "subagent.failed"):
            call_id = data["toolCallId"]
            if not isinstance(call_id, str) or not call_id:
                raise ValueError("SDK subagent tool call ID must be nonempty")
            existed = call_id in self.children
            item = self.children.get(call_id)
            parent = data.get("parentToolCallId") or self.tools.get(call_id, {}).get(
                "parentToolCallId"
            )
            if not parent and kind == "subagent.started" and data.get("parentId"):
                parent = self.agent_tool_calls.get(data["parentId"])
            if parent == call_id:
                raise ValueError("Unannounced subagent parent")
            parent = self._parent_scope(parent)
            agent_id = event.get("agentId")
            if kind == "subagent.started" and agent_id:
                previous = self.agent_tool_calls.get(agent_id)
                if (previous is not None and previous != call_id) or any(
                    known != agent_id and spawn == call_id
                    for known, spawn in self.agent_tool_calls.items()
                ):
                    raise ValueError("Subagent identity changed")
            if item is None:
                if kind != "subagent.started":
                    raise ValueError("Unannounced subagent identity")
                if not data.get("agentName"):
                    return []
                self._capacity()
                item = self.children[call_id] = {
                    "toolCallId": call_id,
                    "agentName": data["agentName"],
                    "status": "running",
                }
            if item["status"] != "running":
                return []
            if kind == "subagent.started" and agent_id:
                self.agent_tool_calls[agent_id] = call_id
            if data.get("agentDescription") is not None:
                item["description"] = self._bounded(data["agentDescription"])
            if parent:
                item["parentToolCallId"] = parent
            item["status"] = {
                "subagent.started": "running",
                "subagent.completed": "completed",
                "subagent.failed": "error",
            }[kind]
            if data.get("cancelled"):
                item["status"] = "cancelled"
            events = []
            if kind == "subagent.started" and not existed:
                events.append(
                    SubagentStartedEvent(
                        subagent_run_id=call_id,
                        name=item["agentName"],
                        description=item.get("description"),
                        parent_subagent_run_id=parent,
                        parent_tool_call_id=call_id,
                    )
                )
            elif kind != "subagent.started" and existed:
                events.extend(self.finish(scope=call_id))
                if item["status"] == "completed":
                    events.append(SubagentFinishedEvent(subagent_run_id=call_id))
                else:
                    events.append(
                        SubagentErrorEvent(
                            subagent_run_id=call_id,
                            message="Subagent cancelled"
                            if data.get("cancelled")
                            else "Subagent failed",
                        )
                    )
            events.append(
                ActivitySnapshotEvent(
                    message_id=f"subagent:{call_id}",
                    activity_type="copilot-sdk:subagent",
                    content=dict(item),
                    subagent_run_id=call_id,
                )
            )
            return events
        if kind in ("session.idle", "session.error"):
            return self.finish()
        if kind in ("abort", "agent.interrupted"):
            return self.finish(cancelled=True, scope=scope)
        if kind == "assistant.turn_end":
            events = []
            for message_id, item in self.messages.items():
                if item["scope"] == scope:
                    events.extend(self._close_message(message_id))
            return events
        return []

    def finish(self, *, cancelled: bool = False, scope: str | None = None) -> list[BaseEvent]:
        events: list[BaseEvent] = []
        for message_id, item in self.messages.items():
            if scope is None or item["scope"] == scope:
                events.extend(self._close_message(message_id))
        if cancelled:
            for call_id, item in self.tools.items():
                if item["status"] == "running" and (
                    scope is None or item.get("parentToolCallId") == scope
                ):
                    item["status"] = "cancelled"
                    events.append(self._activity(call_id))
            for call_id, item in self.children.items():
                if item["status"] == "running" and (
                    scope is None or item.get("parentToolCallId") == scope or call_id == scope
                ):
                    item["status"] = "cancelled"
                    events.append(
                        SubagentErrorEvent(subagent_run_id=call_id, message="Subagent cancelled")
                    )
                    events.append(
                        ActivitySnapshotEvent(
                            message_id=f"subagent:{call_id}",
                            activity_type="copilot-sdk:subagent",
                            content=dict(item),
                            subagent_run_id=call_id,
                        )
                    )
        return events
