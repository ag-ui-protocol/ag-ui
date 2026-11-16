"""Tool approvals as AG-UI interrupts, with no paused run kept on the server.

A tool marked ``needs_approval`` pauses the OpenAI Agents SDK run before it
executes: the run ends with the call on ``result.interruptions`` and the model
is not called again. The translator already closes that AG-UI run with the
call in its ``MESSAGES_SNAPSHOT`` and no result, so the client keeps the
paused call in its history. That history is all a resume needs:

* Pause: ``approval_interrupts`` turns each paused call into an AG-UI
  interrupt (id = the tool call id), which ``AGUITranslator.to_agui`` puts on
  RUN_FINISHED's ``interrupt`` outcome.
* Proof: the history is the client's, so the server signs each call it
  pauses and the MESSAGES_SNAPSHOT carries the token on that call (see
  ``approvals``). Only a call whose token verifies counts as paused.
* Resume: the next request carries the same history plus ``resume`` entries.
  ``resume_tool_calls`` answers every unanswered call of the agent's own
  tools before the model runs. An approved call runs its tool once; a
  rejected or cancelled one gets a result saying it did not run. A paused
  call with no entry (the user sent a new message instead) stays open: the
  run answers what the entries cover and ends with its interrupt again,
  without calling the model. A call without a valid token is never run.

The SDK's own resume (``RunState``) is not used, because it would mean
keeping the paused run on the server, or shipping it to the client and
trusting it back. The cost: a resumed call runs outside the SDK's run loop,
so tool guardrails and run hooks do not see it.
"""

from __future__ import annotations

import inspect
import json
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from agents import Agent, FunctionTool, RunConfig, RunContextWrapper, Usage
from agents.items import ToolApprovalItem
from agents.tool import invoke_function_tool
from openai.types.responses import ResponseFunctionToolCall
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
from .approvals import ApprovalSigner, canonical_arguments, default_approval_signer
from .engine.agui_to_openai import AGUIToOpenAITranslator
from .engine.helpers import new_tool_result_id, read_attr, to_string
from .engine.types import HOSTED_TOOL_CALL_TYPES

logger = logging.getLogger(__name__)

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
"""Result of an unfinished call that needs no approval when the next request
has no entry for it (it stopped before its tool ran, such as a backend call
cancelled by a client tool in the same turn)."""

AMBIGUOUS = (
    "This tool call could not be resumed: more than one agent has a tool with this "
    "name, so it is unclear which one to run. It did not run."
)
"""Result of an approved call whose tool name more than one agent uses."""

UNAVAILABLE = "This tool is not available now, so the call did not run."
"""Result of a call whose tool is disabled (``is_enabled``) or gone at resume."""

UNVERIFIED = (
    "This tool call was not paused for approval by this server, or its approval "
    "expired. It did not run."
)
"""Result of a call that a resume entry decides but that has no valid token:
the client wrote it, changed it, or the approval expired."""

ALREADY_ANSWERED = "This tool call was already answered. It did not run again."
"""Result of a call whose approval was already decided once."""


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
        interrupts.append(_approval_interrupt(call_id, name, read_attr(raw, "arguments")))
    return interrupts


def _approval_interrupt(call_id: str, name: str, arguments: Any) -> Interrupt:
    return Interrupt(
        id=call_id,
        reason="tool_approval",
        message=f"Approve call to {name}?",
        tool_call_id=call_id,
        response_schema=APPROVAL_SCHEMA,
        metadata={"tool_name": name, "tool_input": _parse_arguments(arguments)},
    )


class UnresumableApprovalError(RuntimeError):
    """The run paused on an approval that ``resume_tool_calls`` cannot answer.

    Only function tools whose call this run streamed can be resumed from the
    conversation. Two kinds of approval cannot:

    * a tool inside an agent used as a tool (``Agent.as_tool()``) pauses
      within the sub-agent's own run, and the conversation only holds the
      outer call to the agent tool. Gate the agent tool itself
      (``as_tool(..., needs_approval=True)``), or reach the sub-agent through
      a handoff.
    * a built-in tool (``ShellTool``, ``ApplyPatchTool`` and the like) has an
      executor of its own rather than a function to call.

    Resuming either would need the paused SDK run kept on the server.
    """


def unresumable_approvals(
    items: Iterable[ToolApprovalItem], streamed_call_ids: Iterable[str]
) -> list[str]:
    """Names of the paused tools ``resume_tool_calls`` could not answer.

    Args:
        items: ``result.interruptions`` of a paused run.
        streamed_call_ids: Ids of the tool calls the run streamed.

    Returns:
        The tool names, in the order the SDK reported the calls.
    """
    streamed = set(streamed_call_ids)
    names = []
    for item in items:
        raw = item.raw_item
        call_id = getattr(item, "call_id", None) or read_attr(raw, "call_id")
        if read_attr(raw, "type") != "function_call" or call_id not in streamed:
            names.append(item.tool_name or read_attr(raw, "name") or read_attr(raw, "type") or "tool")
    return names


@dataclass(frozen=True)
class ResumedInput:
    """A request whose paused tool calls have been answered.

    Pass it to ``to_agui(..., resumed=...)``, which streams the results and
    counts the usage.

    Attributes:
        run_input: The request with a tool message after each answered call.
            Translate and run this, and pass it to ``to_agui`` so the
            MESSAGES_SNAPSHOT includes the answers.
        tool_results: One TOOL_CALL_RESULT per answered call.
        usage: Model usage of the tools that ran (an approved agent tool runs
            its sub-agent), or None when they made no model calls.
        open_interrupts: The approvals the request left undecided, one
            interrupt per call. They stay open, so do not run the model when
            there are any (its input would hold a call without an output):
            pass this to ``to_agui`` with no events, which ends the run with
            these interrupts again.
    """

    run_input: RunAgentInput
    tool_results: list[ToolCallResultEvent] = field(default_factory=list)
    usage: Usage | None = None
    open_interrupts: list[Interrupt] = field(default_factory=list)


async def resume_tool_calls(
    agent: Agent[Any],
    run_input: RunAgentInput,
    *,
    context: Any = None,
    run_config: RunConfig | None = None,
    approvals: ApprovalSigner | None = None,
) -> ResumedInput:
    """Answer the calls of ``agent``'s own tools that the history left open.

    A call is open when the history has no tool message for it: the run that
    made it paused for approval, or stopped before the tool ran. A call is
    held (paused by this server) when it carries a token ``approvals`` issued
    for this thread, call id, tool name and arguments, not yet expired. A held
    call with a ``resume`` entry is open even when the client added a tool
    message for it (some clients write their response there): the entry
    decides, and the client's message is replaced. A result this server wrote
    is never replaced. Each open call is answered from the request's
    ``resume`` entry for its id:

    * on a held call, resolved with ``{"approved": true}``: the tool runs, and
      its output is the result, unless its ``is_enabled`` now says no
      (``UNAVAILABLE``), as the SDK would check before offering it;
    * on a held call, resolved with anything else: ``REJECTED``;
    * on a held call, cancelled: ``CANCELLED``;
    * on a held call already decided once: ``ALREADY_ANSWERED``;
    * on any other call: ``UNVERIFIED``. The client wrote or changed it, or
      its approval expired;
    * no entry, for a held call: no answer. The approval stays open and is
      listed in ``open_interrupts``, as AG-UI requires for an approval nobody
      decided;
    * no entry, for any other call (it stopped before its tool ran):
      ``ABANDONED``.

    Calls of tools the agent does not own (client tools) are left alone: the
    client answers those itself. Tools of agents reachable through
    ``handoffs`` count as the agent's own. The history does not say which
    agent made a call, so when two of those agents have different tools with
    the call's name, an approved call is answered with ``AMBIGUOUS`` rather
    than running either.

    Args:
        agent: The agent about to run; its tools answer the calls.
        run_input: The incoming request.
        context: The SDK run context handed to the tools.
        run_config: The run's ``RunConfig``, handed to the tools as the SDK
            would (an agent used as a tool takes its model provider from it).
        approvals: The signer that issued the tokens of the paused calls.
            Defaults to ``default_approval_signer()``.

    Returns:
        The request with the answers in place, their TOOL_CALL_RESULT events,
        and the approvals still open. Returned unchanged when no call was
        open.
    """
    signer = approvals or default_approval_signer()
    tools, ambiguous, _ = await _function_tools(agent, context)
    client_tools = {tool.name for tool in run_input.tools or []}
    entries = {entry.interrupt_id: entry for entry in run_input.resume or []}
    history = list(run_input.messages)

    # Each call is matched to its result by position: the first tool message
    # for its id after it. Providers that reuse call ids across turns ("call_0",
    # a reset counter) would otherwise have one turn's result answer another's
    # call, or a decision re-run a call that already completed.
    occurrences: list[list[Any]] = []  # [message index, call, result index or None]
    for index, message in enumerate(history):
        if isinstance(message, AssistantMessage):
            occurrences.extend([index, call, None] for call in message.tool_calls or [])
        elif isinstance(message, ToolMessage):
            for occurrence in reversed(occurrences):
                if occurrence[1].id == message.tool_call_id and occurrence[2] is None:
                    occurrence[2] = index
                    break
    latest = {occurrence[1].id: occurrence for occurrence in occurrences}
    # Only the latest call with an id can be the paused one, and only when this
    # server signed it as paused: the history, names and arguments included, is
    # the client's.
    held = {
        call_id: proof
        for call_id, occurrence in latest.items()
        if occurrence[1].function.name in tools
        and (proof := signer.verify(run_input.thread_id, occurrence[1])) is not None
    }

    # A resume entry decides the latest call with its id. For a held call, a
    # tool message the client wrote for it (some clients write their response
    # there) is dropped: the entry decides. A result this server wrote stays:
    # the call was already answered.
    dropped: set[int] = set()
    for call_id, occurrence in latest.items():
        result = occurrence[2]
        if (
            call_id in entries
            and call_id in held
            and result is not None
            and not _server_result(history[result], call_id)
        ):
            dropped.add(result)
            occurrence[2] = None
    open_calls: dict[int, list[list[Any]]] = {}
    for occurrence in occurrences:
        if occurrence[2] is None:
            open_calls.setdefault(occurrence[0], []).append(occurrence)

    taken_ids = {message.id for message in history}
    messages: list[Message] = []
    results: list[ToolCallResultEvent] = []
    still_open: list[Interrupt] = []
    usage = Usage()  # what the tools that run here spend, for RUN_FINISHED
    for index, message in enumerate(history):
        if index in dropped:
            continue
        messages.append(message)
        for occurrence in open_calls.get(index, []):
            call = occurrence[1]
            owned = tools.get(call.function.name)
            if owned is None:
                name = call.function.name
                if name not in client_tools and name not in HOSTED_TOOL_CALL_TYPES:
                    # Neither ours, the client's, nor the provider's: a tool that
                    # is gone (removed, or no longer listed by its MCP server).
                    # Left open, the call would go back to the model without an
                    # output, answered or not.
                    _close(messages, results, taken_ids, call.id, UNAVAILABLE)
                continue
            tool, owner = owned
            # Only the latest call with this id is the paused one.
            paused = latest[call.id] is occurrence
            proof = held.get(call.id) if paused else None
            entry = entries.get(call.id) if paused else None
            # A held call runs on the text its token covers, read one way only.
            arguments = (
                canonical_arguments(call.function.arguments) if proof is not None else call.function.arguments
            )
            tool_context = ToolContext(
                context=context,
                usage=usage,
                tool_name=tool.name,
                tool_call_id=call.id,
                tool_arguments=arguments,
                # What a live call sees: the call itself, and the
                # conversation up to it as model input.
                tool_call=ResponseFunctionToolCall(
                    type="function_call",
                    call_id=call.id,
                    name=call.function.name,
                    arguments=arguments or "",
                ),
                turn_input=AGUIToOpenAITranslator().translate_messages(messages),
                agent=owner,
                run_config=run_config,
            )
            if entry is None and proof is not None:
                # Nobody decided: the approval stays open and is asked again.
                still_open.append(
                    _approval_interrupt(call.id, call.function.name, call.function.arguments)
                )
                continue
            if entry is not None and proof is None:
                # Not a call this server paused: never run it.
                logger.warning(
                    "Refused a resumed tool call with no valid approval token: "
                    "thread_id=%r tool_call_id=%r tool=%r",
                    run_input.thread_id,
                    call.id,
                    call.function.name,
                )
                _close(messages, results, taken_ids, call.id, UNVERIFIED)
                continue
            if proof is not None and not await signer.consume(proof):
                # This approval was decided before: never run the call twice.
                logger.warning(
                    "Refused a replayed tool approval that was already decided: "
                    "thread_id=%r tool_call_id=%r tool=%r",
                    run_input.thread_id,
                    call.id,
                    call.function.name,
                )
                _close(messages, results, taken_ids, call.id, ALREADY_ANSWERED)
                continue
            content = await _answer(
                tool,
                call.id,
                arguments,
                entry,
                tool_context,
                owner=owner,
                ambiguous=tool.name in ambiguous,
            )
            _close(messages, results, taken_ids, call.id, content)
    if not results and not dropped:
        return ResumedInput(run_input=run_input, open_interrupts=still_open)
    return ResumedInput(
        run_input=run_input.model_copy(update={"messages": messages}),
        tool_results=results,
        usage=usage if usage.requests or usage.total_tokens else None,
        open_interrupts=still_open,
    )


def _server_result(message: Message, call_id: str) -> bool:
    """Whether ``message`` is a result this server wrote for ``call_id`` (see ``_close``)."""
    base = new_tool_result_id(call_id)
    return message.id == base or message.id.startswith(f"{base}-")


def _close(
    messages: list[Message],
    results: list[ToolCallResultEvent],
    taken_ids: set[str],
    call_id: str,
    content: str,
) -> None:
    """Answer a call: its tool message in the history, and the event for the client."""
    result_id = new_tool_result_id(call_id)
    suffix = 1
    while result_id in taken_ids:  # a reused call id already has a result
        result_id = f"{new_tool_result_id(call_id)}-{suffix}"
        suffix += 1
    taken_ids.add(result_id)
    messages.append(ToolMessage(id=result_id, role="tool", tool_call_id=call_id, content=content))
    results.append(
        ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id=result_id,
            tool_call_id=call_id,
            content=content,
            role="tool",
        )
    )


async def _answer(
    tool: FunctionTool,
    call_id: str,
    arguments: str,
    entry: ResumeEntry | None,
    tool_context: ToolContext[Any],
    *,
    owner: Agent[Any],
    ambiguous: bool,
) -> str:
    if entry is None:
        return ABANDONED
    if entry.status != "resolved":
        return CANCELLED
    if not _approved(entry.payload):
        return REJECTED
    if ambiguous:
        return AMBIGUOUS
    if not await _enabled(tool, tool_context, owner):
        return UNAVAILABLE
    # The SDK's own invocation, so the tool's timeout applies as in a live run.
    output = await invoke_function_tool(function_tool=tool, context=tool_context, arguments=arguments)
    if output is None and getattr(tool, "_is_agent_tool", False):
        # An agent tool returns nothing when its sub-agent paused for an
        # approval of its own; that pause has no call in the conversation.
        raise UnresumableApprovalError(
            f"The approved agent tool {tool.name} paused for an approval inside its "
            "sub-agent, which cannot be resumed from the conversation."
        )
    return to_string(output)


async def _enabled(tool: FunctionTool, tool_context: ToolContext[Any], owner: Agent[Any]) -> bool:
    """``tool.is_enabled`` for this run, evaluated as the SDK does."""
    enabled = tool.is_enabled
    if isinstance(enabled, bool):
        return enabled
    result = enabled(tool_context, owner)
    if inspect.isawaitable(result):
        result = await result
    return bool(result)


def _approved(payload: Any) -> bool:
    # A real boolean only: truthiness would read the string "false" as approval.
    return isinstance(payload, Mapping) and payload.get("approved") is True


async def _function_tools(
    agent: Agent[Any], context: Any
) -> tuple[dict[str, tuple[FunctionTool, Agent[Any]]], set[str], dict[str, list[FunctionTool]]]:
    """The function tools of ``agent`` and of the agents it can hand off to.

    Includes the tools of an agent's ``mcp_servers``, which the SDK lists
    at run time rather than in ``agent.tools`` (the servers must be
    connected, as for a run).

    Returns:
        Each tool and the agent that owns it, by name; the names that belong
        to more than one tool; and every tool object of each name, one per
        agent that lists it (MCP wrappers of one server operation included).
    """
    tools: dict[str, tuple[FunctionTool, Agent[Any]]] = {}
    named: dict[str, list[FunctionTool]] = {}
    seen: set[int] = set()
    pending = [agent]
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        for tool in [*current.tools, *await _mcp_tools(current, context)]:
            if not isinstance(tool, FunctionTool):
                continue
            tools.setdefault(tool.name, (tool, current))
            named.setdefault(tool.name, []).append(tool)
        for target in current.handoffs:
            handed_to = target if isinstance(target, Agent) else _handoff_agent(target)
            if handed_to is not None:
                pending.append(handed_to)
    ambiguous = {
        name
        for name, same in named.items()
        if any(_identity(tool) != _identity(same[0]) for tool in same[1:])
    }
    return tools, ambiguous, named


def _identity(tool: FunctionTool) -> Any:
    """What makes two tool objects the same tool.

    Each listing of an MCP server makes new wrappers, so agents sharing a
    server get different objects for one operation; the SDK's (private)
    ``_mcp_tool_binding`` names the server and tool behind them. Without it,
    only the same object counts, which errs towards AMBIGUOUS.
    """
    return getattr(tool, "_mcp_tool_binding", None) or id(tool)


async def _mcp_tools(agent: Agent[Any], context: Any, *, strict: bool = False) -> list[Any]:
    """The tools ``agent``'s MCP servers offer.

    Args:
        strict: Raise when the servers cannot be listed. Otherwise a listing
            failure gives no tools.
    """
    if not getattr(agent, "mcp_servers", None):
        return []
    try:
        return await agent.get_mcp_tools(RunContextWrapper(context=context))
    except Exception:
        if strict:
            raise
        # A server that is not connected cannot be listed; its calls then stay
        # unowned, exactly as without this lookup.
        logger.warning("Could not list MCP tools of agent %s", agent.name, exc_info=True)
        return []


def _handoff_agent(target: Any) -> Agent[Any] | None:
    """The agent behind a ``handoff(...)`` object, if it is still alive.

    The SDK keeps it only behind the private ``Handoff._agent_ref`` weak
    reference; ``tests/engine/test_types_drift.py`` pins that field.
    """
    ref = getattr(target, "_agent_ref", None)
    agent = ref() if callable(ref) else None
    return agent if isinstance(agent, Agent) else None


def _parse_arguments(raw: Any) -> Any:
    if not isinstance(raw, str):
        return raw if raw is not None else {}
    try:
        return json.loads(raw or "{}")
    except ValueError:
        return raw


__all__ = [
    "UnresumableApprovalError",
    "unresumable_approvals",
    "ABANDONED",
    "ALREADY_ANSWERED",
    "AMBIGUOUS",
    "APPROVAL_SCHEMA",
    "UNAVAILABLE",
    "CANCELLED",
    "REJECTED",
    "UNVERIFIED",
    "ResumedInput",
    "approval_interrupts",
    "resume_tool_calls",
]
