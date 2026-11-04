"""Tool approvals as AG-UI interrupts, with nothing kept on the server.

A tool marked ``needs_approval`` pauses the OpenAI Agents SDK run before it
executes: the run ends with the call on ``result.interruptions`` and the model
is not called again. The translator already closes that AG-UI run with the
call in its ``MESSAGES_SNAPSHOT`` and no result, so the client keeps the
paused call in its history. That history is all a resume needs:

* Pause: ``approval_interrupts`` turns each paused call into an AG-UI
  interrupt (id = the tool call id), which ``AGUITranslator.to_agui`` puts on
  RUN_FINISHED's ``interrupt`` outcome.
* Resume: the next request carries the same history plus ``resume`` entries.
  ``resume_tool_calls`` answers every unanswered call of the agent's own
  tools before the model runs. An approved call runs its tool; a rejected,
  cancelled or abandoned one (the user sent a new message instead) gets a
  result saying it did not run.

The SDK's own resume (``RunState``) is not used, because it would mean
keeping the paused run on the server, or shipping it to the client and
trusting it back. The cost: a resumed call runs outside the SDK's run loop,
so tool guardrails and run hooks do not see it.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from agents import Agent, FunctionTool
from agents.items import ToolApprovalItem
from agents.tool_context import ToolContext

from ag_ui.core import (
    AssistantMessage,
    EventType,
    Interrupt,
    Message,
    ResumeEntry,
    RunAgentInput,
    ToolCallResultEvent,
    ToolMessage,
)
from .engine.helpers import new_tool_result_id, read_attr, to_string

APPROVAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"approved": {"type": "boolean"}},
    "required": ["approved"],
}
"""The answer an approval interrupt expects: ``{"approved": true | false}``."""

REJECTED = "Tool execution was not approved."
"""Result of a rejected call; the SDK's own default rejection text."""

CANCELLED = "The user cancelled this tool call. It did not run."
"""Result of a call whose interrupt was cancelled."""

ABANDONED = "The user moved on without answering this tool call. It did not run."
"""Result of a call left unanswered when the next request has no entry for it."""


def approval_interrupts(items: Iterable[ToolApprovalItem]) -> list[Interrupt]:
    """One AG-UI interrupt per tool call the SDK paused for approval.

    The interrupt and the call share an id, so the resume entry answering it
    names the call. ``metadata`` carries the tool name and its parsed
    arguments for the UI to show.

    The reason is ``"tool_approval"``, not ``"tool_call"``: clients such as
    CopilotKit read ``"tool_call"`` as a call the client answers itself and
    write the response into the history as the tool's result. Here the
    backend runs the tool, and the response is only the decision.

    Args:
        items: ``result.interruptions`` of a paused run.

    Returns:
        The interrupts, in the order the SDK reported the calls.
    """
    interrupts = []
    for item in items:
        raw = item.raw_item
        call_id = (
            getattr(item, "call_id", None)
            or read_attr(raw, "call_id")
            or read_attr(raw, "id")
        )
        name = item.tool_name or read_attr(raw, "name") or ""
        interrupts.append(
            Interrupt(
                id=call_id,
                reason="tool_approval",
                message=f"Approve call to {name}?",
                tool_call_id=call_id,
                response_schema=APPROVAL_SCHEMA,
                metadata={
                    "tool_name": name,
                    "tool_input": _parse_arguments(read_attr(raw, "arguments")),
                },
            )
        )
    return interrupts


@dataclass(frozen=True)
class ResumedInput:
    """A request whose paused tool calls have been answered.

    Attributes:
        run_input: The request with a tool message after each answered call.
            Translate and run this, and pass it to ``to_agui`` so the
            MESSAGES_SNAPSHOT includes the answers.
        tool_results: One TOOL_CALL_RESULT per answered call, for
            ``to_agui(..., tool_results=...)`` to stream.
    """

    run_input: RunAgentInput
    tool_results: list[ToolCallResultEvent] = field(default_factory=list)


async def resume_tool_calls(
    agent: Agent[Any],
    run_input: RunAgentInput,
    *,
    context: Any = None,
) -> ResumedInput:
    """Answer the calls of ``agent``'s own tools that the history left open.

    A call is open when the history has no tool message for it: the run that
    made it paused for approval, or stopped before the tool ran. A call with a
    ``resume`` entry is open even when the client added a tool message for it
    (some clients write their response there): the entry decides, and the
    client's message is replaced. Each open call is answered from the
    request's ``resume`` entry for its id:

    * resolved with ``{"approved": true}``: the tool runs, and its output is
      the result;
    * resolved with anything else: ``REJECTED``;
    * cancelled: ``CANCELLED``;
    * no entry (the user moved on): ``ABANDONED``.

    Calls of tools the agent does not own (client tools) are left alone: the
    client answers those itself. Tools of agents reachable through
    ``handoffs`` count as the agent's own.

    Args:
        agent: The agent about to run; its tools answer the calls.
        run_input: The incoming request.
        context: The SDK run context handed to the tools.

    Returns:
        The request with the answers in place, and their TOOL_CALL_RESULT
        events. Returned unchanged when no call was open.
    """
    tools = _function_tools(agent)
    entries = {entry.interrupt_id: entry for entry in run_input.resume or []}
    own_calls = {
        call.id
        for message in run_input.messages
        if isinstance(message, AssistantMessage)
        for call in message.tool_calls or []
        if call.function.name in tools
    }
    # The decision on one of the agent's own calls comes from its resume entry,
    # so a tool message the client wrote for that call is dropped.
    replaced = own_calls & entries.keys()
    answered = {
        m.tool_call_id
        for m in run_input.messages
        if isinstance(m, ToolMessage) and m.tool_call_id not in replaced
    }

    messages: list[Message] = []
    results: list[ToolCallResultEvent] = []
    for message in run_input.messages:
        if isinstance(message, ToolMessage) and message.tool_call_id in replaced:
            continue
        messages.append(message)
        if not isinstance(message, AssistantMessage):
            continue
        for call in message.tool_calls or []:
            tool = tools.get(call.function.name)
            if tool is None or call.id in answered:
                continue
            content = await _answer(tool, call.id, call.function.arguments, entries.get(call.id), context)
            result_id = new_tool_result_id(call.id)
            messages.append(
                ToolMessage(id=result_id, role="tool", tool_call_id=call.id, content=content)
            )
            results.append(
                ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    message_id=result_id,
                    tool_call_id=call.id,
                    content=content,
                    role="tool",
                )
            )
    if not results and not replaced:
        return ResumedInput(run_input=run_input)
    return ResumedInput(
        run_input=run_input.model_copy(update={"messages": messages}),
        tool_results=results,
    )


async def _answer(
    tool: FunctionTool,
    call_id: str,
    arguments: str,
    entry: ResumeEntry | None,
    context: Any,
) -> str:
    if entry is None:
        return ABANDONED
    if entry.status != "resolved":
        return CANCELLED
    if not _approved(entry.payload):
        return REJECTED
    tool_context = ToolContext(
        context=context,
        tool_name=tool.name,
        tool_call_id=call_id,
        tool_arguments=arguments,
    )
    return to_string(await tool.on_invoke_tool(tool_context, arguments))


def _approved(payload: Any) -> bool:
    # A real boolean only: truthiness would read the string "false" as approval.
    return isinstance(payload, Mapping) and payload.get("approved") is True


def _function_tools(agent: Agent[Any]) -> dict[str, FunctionTool]:
    """The function tools of ``agent`` and of the agents it can hand off to."""
    tools: dict[str, FunctionTool] = {}
    seen: set[int] = set()
    pending = [agent]
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        for tool in current.tools:
            if isinstance(tool, FunctionTool):
                tools.setdefault(tool.name, tool)
        pending.extend(h for h in current.handoffs if isinstance(h, Agent))
    return tools


def _parse_arguments(raw: Any) -> Any:
    if not isinstance(raw, str):
        return raw if raw is not None else {}
    try:
        return json.loads(raw or "{}")
    except ValueError:
        return raw


__all__ = [
    "ABANDONED",
    "APPROVAL_SCHEMA",
    "CANCELLED",
    "REJECTED",
    "ResumedInput",
    "approval_interrupts",
    "resume_tool_calls",
]
