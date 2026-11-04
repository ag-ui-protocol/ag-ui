"""AG-UI subagent attribution for Strands agents-as-tools.

A Strands tool that wraps another ``Agent`` (``Agent.as_tool()``, or a
generator tool re-yielding ``inner.stream_async(...)``) surfaces the inner
agent's whole event stream to the parent as ``tool_stream_event`` payloads.
With ``subagent_visibility="attributed"`` this module turns each such
invocation into an AG-UI subagent run:

- ``SUBAGENT_STARTED`` before the first attributed event, naming the spawning
  tool call as ``parentToolCallId`` (and the enclosing run, when nested);
- the sub-agent's text, reasoning and tool calls, each tagged with its
  ``subagentRunId``;
- ``SUBAGENT_FINISHED`` (or ``SUBAGENT_ERROR`` for an error result) right
  before the spawning call's ``TOOL_CALL_RESULT``;
- ``SUBAGENT_ERROR`` for a sub-agent closed with no result of its own before
  its loop ended, rather than a success it never reached;
- the sub-agent's messages, attributed, for ``MESSAGES_SNAPSHOT``, so a client
  that keeps the snapshot keeps the sub-agent's work across turns. They are
  held per top-level invocation, nested sub-agents included, so each answers
  to its own spawning tool's snapshot policy.

The run id is the spawning call's wire id, which is unique within a thread:
a top-level call keeps Strands' ``toolUseId`` and a nested one is namespaced
under its parent (``parent::child``), exactly as its tool card is. Every id
the sub-agent's messages carry is namespaced the same way.

Strands only persists the parent conversation, so sub-agent messages that a
client sends back are never handed to the parent model; see
:func:`strip_subagent_messages`.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import (
    Any,
    AsyncIterator,
    Callable,
    Dict,
    List,
    Literal,
    Optional,
    Sequence,
    Tuple,
)

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
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
    ToolCall,
    ToolMessage,
)

SubagentVisibility = Literal["inline", "attributed", "hidden"]
SUBAGENT_VISIBILITIES: Tuple[str, ...] = ("inline", "attributed", "hidden")

#: ``SUBAGENT_ERROR.code`` for a sub-agent whose spawning call returned an
#: error result.
SUBAGENT_ERROR_CODE = "STRANDS_SUBAGENT_ERROR"

#: ``SUBAGENT_ERROR.code`` for a sub-agent whose loop had not ended when it was
#: closed with no result of its own: its parent went away, or the tool never
#: answered.
SUBAGENT_ABANDONED_CODE = "STRANDS_SUBAGENT_ABANDONED"

# Separator for namespacing a sub-agent's tool call ids under the parent tool
# call that owns them. Two agents mint toolUseIds independently, so an inner id
# can be byte-identical to a parent one; without a namespace the inner result
# would resolve the PARENT's tool card (and vice versa). "::" is not produced by
# any Strands/Bedrock id generator, so the prefix is unambiguous.
INNER_TOOL_ID_SEP = "::"

# Model stream chunks as Strands wraps them in ``{"event": ...}``.
_MODEL_CHUNK_KEYS = frozenset(
    {
        "messageStart",
        "contentBlockStart",
        "contentBlockDelta",
        "contentBlockStop",
        "messageStop",
        "metadata",
        "redactContent",
    }
)

ForwardToolCalls = Callable[
    [Any, Dict[str, Any], Dict[str, Dict[str, Any]]], AsyncIterator[Any]
]


def _is_agent_stream_event(event: Any) -> bool:
    """Whether a tool-stream payload can only have come from an Agent's stream.

    A generator tool is free to yield ``{"data": ...}`` or ``{"message": ...}``
    as progress; only shapes ``stream_async`` produces start a subagent run.
    """
    if not isinstance(event, dict):
        return False
    if event.get("init_event_loop") is True or event.get("start_event_loop") is True:
        return True
    chunk = event.get("event")
    if isinstance(chunk, dict) and not _MODEL_CHUNK_KEYS.isdisjoint(chunk):
        return True
    message = event.get("message")
    if isinstance(message, dict) and message.get("role") in ("user", "assistant"):
        return True
    tool_use = event.get("current_tool_use")
    if isinstance(tool_use, dict) and "toolUseId" in tool_use:
        return True
    nested = event.get("tool_stream_event")
    return isinstance(nested, dict) and "tool_use" in nested


def _maybe_json(text: Any) -> Any:
    if not isinstance(text, str):
        return text
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return text


@dataclass
class _Segment:
    """One assistant message the sub-agent produced within a model turn."""

    content: str = ""
    tool_calls: List[str] = field(default_factory=list)


@dataclass
class _Invocation:
    """Snapshot messages a top-level spawning call is still to publish."""

    tool_name: str
    messages: List[Any] = field(default_factory=list)


@dataclass
class _Run:
    run_id: str
    parent_run_id: Optional[str]
    # The top-level spawning call this run descends from (its own id if none).
    root_id: str
    text_id: Optional[str] = None
    reasoning_id: Optional[str] = None
    # Assistant message the current model turn's tool calls hang off.
    message_id: Optional[str] = None
    segments: Dict[str, _Segment] = field(default_factory=dict)
    tool_names: Dict[str, str] = field(default_factory=dict)
    tool_args: Dict[str, str] = field(default_factory=dict)
    # Inner call id -> result status, filled when its result arrives.
    result_status: Dict[str, str] = field(default_factory=dict)
    # The sub-agent's loop ended: a model turn asked for no tool, or the
    # wrapping generator re-yielded the agent's final result.
    ended: bool = False

    def new_id(self) -> str:
        return f"{self.run_id}{INNER_TOOL_ID_SEP}{uuid.uuid4()}"


class SubagentRuns:
    """Per-run bookkeeping for attributed sub-agents.

    One instance per ``StrandsAgent.run``. ``forward`` translates one inner
    stream payload; ``finish`` closes a run when its spawning call's result
    arrives; ``close_all`` closes whatever is still open before
    ``RUN_FINISHED``.
    """

    def __init__(
        self,
        visibility: SubagentVisibility,
        forward_tool_calls: ForwardToolCalls,
    ) -> None:
        self.visibility = visibility
        self._forward_tool_calls = forward_tool_calls
        self._runs: Dict[str, _Run] = {}
        self._finished: set[str] = set()
        self._invocations: Dict[str, _Invocation] = {}
        self._hidden_calls: set[str] = set()

    @property
    def attributed(self) -> bool:
        return self.visibility == "attributed"

    def conceals(self, tool_use: Dict[str, Any], payload: Any) -> bool:
        """Whether ``"hidden"`` keeps this tool-stream payload from the client.

        A tool is ordinary, and its state updates reach the client, until a
        payload only an agent's stream produces shows it wraps a sub-agent.
        From then on everything it yields is behind the boundary.
        """
        if self.visibility != "hidden":
            return False
        call_id = str(tool_use.get("toolUseId") or "")
        if call_id and _is_agent_stream_event(payload):
            self._hidden_calls.add(call_id)
        return call_id in self._hidden_calls

    # ------------------------------------------------------------------
    # Inner stream
    # ------------------------------------------------------------------

    async def forward(
        self,
        inner_event: Any,
        parent_tool_use: Dict[str, Any],
        inner_tool_calls_seen: Dict[str, Dict[str, Any]],
        *,
        description: Optional[str] = None,
        parent_run_id: Optional[str] = None,
    ) -> AsyncIterator[Any]:
        """Translate one inner-agent payload under the configured visibility."""
        if self.visibility == "hidden":
            return
        run_id = str(parent_tool_use.get("toolUseId") or "")
        run = self._runs.get(run_id)
        if run is None and (
            self.visibility == "inline"
            or not run_id
            or not _is_agent_stream_event(inner_event)
        ):
            async for event in self._forward_tool_calls(
                inner_event, parent_tool_use, inner_tool_calls_seen
            ):
                yield event
            return
        if not isinstance(inner_event, dict) or run_id in self._finished:
            # The spawning call already resolved; a run is never reopened.
            return

        if run is None:
            name = str(parent_tool_use.get("name") or "subagent")
            parent_run = self._runs.get(parent_run_id or "")
            run = self._runs[run_id] = _Run(
                run_id=run_id,
                parent_run_id=parent_run_id,
                root_id=parent_run.root_id if parent_run else run_id,
            )
            if parent_run is None:
                self._invocations[run_id] = _Invocation(tool_name=name)
            yield SubagentStartedEvent(
                type=EventType.SUBAGENT_STARTED,
                subagent_run_id=run_id,
                name=name,
                description=description,
                parent_tool_call_id=run_id,
                parent_subagent_run_id=parent_run_id,
            )

        # A sub-agent of this sub-agent: recurse, namespaced under the call
        # that spawned it so its tool cards and run id match the wire.
        nested = inner_event.get("tool_stream_event")
        if isinstance(nested, dict):
            nested_use = nested.get("tool_use") or {}
            nested_id = nested_use.get("toolUseId")
            if nested_id:
                async for event in self.forward(
                    nested.get("data"),
                    {
                        "toolUseId": f"{run_id}{INNER_TOOL_ID_SEP}{nested_id}",
                        "name": nested_use.get("name"),
                    },
                    inner_tool_calls_seen,
                    parent_run_id=run_id,
                ):
                    yield event
            return

        if "result" in inner_event:
            run.ended = True
            for event in self._close_text(run) + self._close_reasoning(run):
                yield event
            return

        data = inner_event.get("data")
        if isinstance(data, str) and data:
            for event in self._close_reasoning(run):
                yield event
            if run.text_id is None:
                run.text_id = run.new_id()
                run.message_id = run.text_id
                run.segments[run.text_id] = _Segment()
                yield TextMessageStartEvent(
                    type=EventType.TEXT_MESSAGE_START,
                    message_id=run.text_id,
                    role="assistant",
                    subagent_run_id=run_id,
                )
            run.segments[run.text_id].content += data
            yield TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=run.text_id,
                delta=data,
                subagent_run_id=run_id,
            )
            return

        if inner_event.get("reasoning") and "reasoningText" in inner_event:
            text = inner_event.get("reasoningText")
            if run.reasoning_id is None:
                run.reasoning_id = run.new_id()
                yield ReasoningStartEvent(
                    type=EventType.REASONING_START,
                    message_id=run.reasoning_id,
                    subagent_run_id=run_id,
                )
                yield ReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=run.reasoning_id,
                    role="reasoning",
                    subagent_run_id=run_id,
                )
            if isinstance(text, str) and text:
                yield ReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=run.reasoning_id,
                    delta=text,
                    subagent_run_id=run_id,
                )
            return

        chunk = inner_event.get("event")
        if isinstance(chunk, dict) and "contentBlockStop" in chunk:
            for event in self._close_text(run) + self._close_reasoning(run):
                yield event

        message = inner_event.get("message")
        if isinstance(message, dict):
            content = message.get("content") or []
            if message.get("role") == "assistant":
                # The model turn is over: its messages are final, and a turn
                # that asks for no tool ends the sub-agent's loop.
                self._commit_turn(run)
                run.ended = not any(
                    isinstance(block, dict) and "toolUse" in block
                    for block in content
                )
            elif message.get("role") == "user":
                for block in content:
                    result = block.get("toolResult") if isinstance(block, dict) else None
                    if isinstance(result, dict) and result.get("toolUseId"):
                        call_id = f"{run_id}{INNER_TOOL_ID_SEP}{result['toolUseId']}"
                        run.result_status[call_id] = str(result.get("status") or "")

        async for event in self._forward_tool_calls(
            inner_event, parent_tool_use, inner_tool_calls_seen
        ):
            if event.type == EventType.TOOL_CALL_START:
                if run.message_id is None:
                    run.message_id = run.new_id()
                    run.segments[run.message_id] = _Segment()
                run.segments[run.message_id].tool_calls.append(event.tool_call_id)
                run.tool_names[event.tool_call_id] = event.tool_call_name
                event = event.model_copy(update={"parent_message_id": run.message_id})
            elif event.type == EventType.TOOL_CALL_ARGS:
                run.tool_args[event.tool_call_id] = (
                    run.tool_args.get(event.tool_call_id, "") + event.delta
                )
            elif event.type == EventType.TOOL_CALL_RESULT:
                # The result of a nested sub-agent's spawning call ends that
                # nested run, exactly as a top-level result ends its own.
                for closing in self.finish(
                    event.tool_call_id,
                    run.result_status.get(event.tool_call_id, ""),
                    event.content,
                ):
                    yield closing
                event = event.model_copy(
                    update={
                        "message_id": f"{run_id}{INNER_TOOL_ID_SEP}{event.message_id}"
                    }
                )
                self._invocations[run.root_id].messages.append(
                    ToolMessage(
                        id=event.message_id,
                        role="tool",
                        content=event.content,
                        tool_call_id=event.tool_call_id,
                        subagent_run_id=run_id,
                    )
                )
            yield event.model_copy(update={"subagent_run_id": run_id})

    # ------------------------------------------------------------------
    # Closing
    # ------------------------------------------------------------------

    def finish(self, tool_call_id: str, status: str, content: str) -> List[Any]:
        """Close the run spawned by ``tool_call_id``, if there is one.

        Called right before the spawning call's ``TOOL_CALL_RESULT`` with that
        result's wire content. Any nested run still open under it is closed
        first, deepest first: none of them got a result of its own, so one
        whose loop had not ended is abandoned, whatever the parent's status.
        """
        run = self._runs.get(tool_call_id)
        if run is None:
            return []
        events: List[Any] = []
        for child_id, child in [
            (rid, r)
            for rid, r in reversed(self._runs.items())
            if r.parent_run_id == tool_call_id
        ]:
            if child.ended:
                events += self.finish(child_id, "", "")
            else:
                events += self._abandon(child_id)
        self._runs.pop(tool_call_id)
        self._finished.add(tool_call_id)
        events += self._close_text(run) + self._close_reasoning(run)
        self._commit_turn(run)
        if status == "error":
            events.append(
                SubagentErrorEvent(
                    type=EventType.SUBAGENT_ERROR,
                    subagent_run_id=tool_call_id,
                    message=content or "Sub-agent failed",
                    code=SUBAGENT_ERROR_CODE,
                )
            )
        else:
            events.append(
                SubagentFinishedEvent(
                    type=EventType.SUBAGENT_FINISHED,
                    subagent_run_id=tool_call_id,
                    result=_maybe_json(content) if content else None,
                    outcome=SubagentFinishedSuccessOutcome(type="success"),
                )
            )
        return events

    def close_all(self, *, suspended: bool) -> List[Any]:
        """Close every open run before ``RUN_FINISHED``, deepest first.

        A run still open at that point is one its spawning call never
        answered. One that had ended only has its result parked in the same
        batch as a sibling's interrupt. One that had not is the one waiting
        (``suspended``) when the run paused on an interrupt, and abandoned
        otherwise.
        """
        events: List[Any] = []
        for run_id in reversed(list(self._runs)):
            run = self._runs[run_id]
            if not suspended and not run.ended:
                events += self._abandon(run_id)
                continue
            self._runs.pop(run_id)
            self._finished.add(run_id)
            events += self._close_text(run) + self._close_reasoning(run)
            self._commit_turn(run)
            outcome = (
                SubagentFinishedSuccessOutcome(type="success")
                if run.ended
                else SubagentFinishedSuspendedOutcome(type="suspended")
            )
            events.append(
                SubagentFinishedEvent(
                    type=EventType.SUBAGENT_FINISHED,
                    subagent_run_id=run_id,
                    outcome=outcome,
                )
            )
        return events

    def take_snapshot_messages(self, tool_call_id: str) -> List[Any]:
        """Messages of the invocation ``tool_call_id`` spawned, descendants included."""
        invocation = self._invocations.pop(tool_call_id, None)
        return invocation.messages if invocation else []

    def take_remaining_snapshot_messages(self) -> List[Tuple[str, List[Any]]]:
        """Every invocation no result published, as (spawning tool, messages)."""
        taken = [
            (invocation.tool_name, invocation.messages)
            for invocation in self._invocations.values()
            if invocation.messages
        ]
        self._invocations = {}
        return taken

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _abandon(self, run_id: str) -> List[Any]:
        """Close a run that stopped short of its own result, deepest first."""
        run = self._runs.pop(run_id)
        self._finished.add(run_id)
        events: List[Any] = []
        for child_id in [
            rid for rid, r in reversed(self._runs.items()) if r.parent_run_id == run_id
        ]:
            events += self._abandon(child_id)
        events += self._close_text(run) + self._close_reasoning(run)
        self._commit_turn(run)
        events.append(
            SubagentErrorEvent(
                type=EventType.SUBAGENT_ERROR,
                subagent_run_id=run_id,
                message="Sub-agent stopped before it finished",
                code=SUBAGENT_ABANDONED_CODE,
            )
        )
        return events

    def _close_text(self, run: _Run) -> List[Any]:
        if run.text_id is None:
            return []
        text_id, run.text_id = run.text_id, None
        return [
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=text_id,
                subagent_run_id=run.run_id,
            )
        ]

    def _close_reasoning(self, run: _Run) -> List[Any]:
        if run.reasoning_id is None:
            return []
        reasoning_id, run.reasoning_id = run.reasoning_id, None
        return [
            ReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=reasoning_id,
                subagent_run_id=run.run_id,
            ),
            ReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=reasoning_id,
                subagent_run_id=run.run_id,
            ),
        ]

    def _commit_turn(self, run: _Run) -> None:
        for message_id, segment in run.segments.items():
            tool_calls = [
                ToolCall(
                    id=call_id,
                    type="function",
                    function=FunctionCall(
                        name=run.tool_names.get(call_id, "unknown"),
                        arguments=run.tool_args.get(call_id) or "{}",
                    ),
                )
                for call_id in segment.tool_calls
            ]
            self._invocations[run.root_id].messages.append(
                AssistantMessage(
                    id=message_id,
                    role="assistant",
                    content=segment.content or None,
                    tool_calls=tool_calls or None,
                    subagent_run_id=run.run_id,
                )
            )
        run.segments = {}
        run.message_id = None


def strip_subagent_messages(messages: Sequence[Any]) -> List[Any]:
    """The client's messages minus everything a sub-agent produced.

    Strands persists only the parent conversation, and a parent model shown a
    sub-agent's internal calls would read them as its own. A sub-agent's
    message is recognised by either:

    - a ``subagent_run_id`` (a client that keeps attribution);
    - the adapter's own namespacing, ``<spawning call id>::<id>``, on the
      message id, on a ``tool`` result's call id, or on a tool call that a
      client flattened onto the spawning assistant message (how assistant-ui
      exports nested calls). The spawning call must be in the same
      conversation.

    An assistant message left with neither text nor tool calls is dropped.
    """
    call_ids = {
        getattr(tc, "id", None)
        for msg in messages
        if getattr(msg, "role", None) == "assistant"
        for tc in (getattr(msg, "tool_calls", None) or [])
    }

    def _is_inner(value: Any) -> bool:
        if not isinstance(value, str) or INNER_TOOL_ID_SEP not in value:
            return False
        return value.split(INNER_TOOL_ID_SEP, 1)[0] in call_ids

    out: List[Any] = []
    for msg in messages:
        tag = getattr(msg, "subagent_run_id", None)
        if (isinstance(tag, str) and tag) or _is_inner(getattr(msg, "id", None)):
            continue
        role = getattr(msg, "role", None)
        if role == "tool" and _is_inner(getattr(msg, "tool_call_id", None)):
            continue
        tool_calls = getattr(msg, "tool_calls", None)
        if role == "assistant" and tool_calls:
            kept = [tc for tc in tool_calls if not _is_inner(getattr(tc, "id", None))]
            if len(kept) != len(tool_calls):
                if not kept and not getattr(msg, "content", None):
                    continue
                msg = msg.model_copy(update={"tool_calls": kept or None})
        out.append(msg)
    return out
