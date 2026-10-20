"""
Event handlers for Claude SDK stream processing.

Breaks down stream processing into focused handler functions.
"""

import json
import logging
import uuid
from typing import AsyncIterator, Any, List, Optional

from ag_ui.core import (
    EventType,
    BaseEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    StateSnapshotEvent,
    CustomEvent,
    ActivitySnapshotEvent,
    ActivityDeltaEvent,
)

from .utils import strip_mcp_prefix, _is_state_management_tool, fix_surrogates, fix_surrogates_deep, native_tool_content, merge_state_update

logger = logging.getLogger(__name__)

# Claude's native subagent-orchestration tool. A call to it is not an ordinary
# tool call: it dispatches a whole nested agent run, which a UI wants to render
# as its own progress widget rather than as another Bash/Read row.
SUBAGENT_TASK_TOOL_NAME = "Task"

# Every name that tool arrives under. Newer Claude Code CLIs (bundled with
# claude-agent-sdk 0.2.x) name it "Agent" and keep "Task" only as an alias;
# older ones name it "Task". Match both so a fresh install still opens the
# activity.
SUBAGENT_TASK_TOOL_NAMES = frozenset({SUBAGENT_TASK_TOOL_NAME, "Agent"})

# AG-UI ``activity_type`` used for those subagent runs. Renderers register
# against this string (CopilotKit's ``useRenderActivityMessage`` /
# ``renderActivityMessages``).
#
# The ``content`` shape follows the Mastra integration's background-task
# activity (``MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE`` in
# integrations/mastra/typescript/src/mastra.ts) so the two integrations agree —
# one activity per task, camelCase keys, an ``outputs`` list, and a lifecycle
# ``status`` advanced by RFC-6902 deltas:
#
#     {
#       "taskId": str,          # == the activity message_id
#       "toolName": "Task",
#       "toolCallId": str,      # originating tool call
#       "status": "running" | "completed" | "failed",
#       "subagentType"?: str,   # Task's subagent_type input
#       "description"?: str,    # Task's description input
#       "prompt"?: str,         # Task's prompt input
#       "outputs": list,        # reserved for streamed subagent output
#       "result"?: Any,         # final result on completion
#       "error"?: Any,          # payload on failure
#     }
SUBAGENT_TASK_ACTIVITY_TYPE = "claude-subagent-task"


def open_task_activity(
    tool_id: str,
    tool_input: Optional[dict],
    open_task_activities: dict,
) -> Optional[ActivitySnapshotEvent]:
    """
    Open an AG-UI activity for a Claude ``Task`` (subagent) tool call.

    Returns the ACTIVITY_SNAPSHOT that opens the activity, or ``None`` when an
    activity is already open for this tool call id. Both adapter paths call
    this — the streaming path at ``content_block_stop`` and the non-streaming
    fallback in :func:`handle_tool_use_block` — so an id seen by both produces
    exactly one snapshot, and the closing delta in
    :func:`handle_tool_result_block` has exactly one activity to close.

    Args:
        tool_id: The Task tool call id. Doubles as the activity message id.
        tool_input: The Task tool's arguments, when they parsed. A missing or
            unparseable argument payload still opens the activity — losing the
            subagent from the UI is worse than showing it without its prompt.
        open_task_activities: The RUN's registry of Task tool_use_ids with an
            open activity, mapped to the activity_type they were opened with,
            so the matching ToolResultBlock closes the right activity. Created
            per run alongside ``processed_tool_ids`` and threaded through
            explicitly, so concurrent runs never see each other's activities
            and the registry dies with the run that owns it.
    """
    if not tool_id or tool_id in open_task_activities:
        return None

    content: dict = {
        "taskId": tool_id,
        # Normalized identifier; the real name ("Task" or "Agent") is on TOOL_CALL_START.
        "toolName": SUBAGENT_TASK_TOOL_NAME,
        "toolCallId": tool_id,
        # The subagent is already executing; surface it as running so the UI
        # reads as active immediately.
        "status": "running",
    }
    # Only carry the inputs that are actually present, so the payload stays
    # minimal (mirrors Mastra's optional `args`).
    for source_key, content_key in (
        ("subagent_type", "subagentType"),
        ("description", "description"),
        ("prompt", "prompt"),
    ):
        value = (tool_input or {}).get(source_key)
        if value is not None:
            content[content_key] = value
    content["outputs"] = []

    open_task_activities[tool_id] = SUBAGENT_TASK_ACTIVITY_TYPE

    logger.debug(f"Opened subagent activity for Task tool call {tool_id}")
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT,
        message_id=tool_id,
        activity_type=SUBAGENT_TASK_ACTIVITY_TYPE,
        content=fix_surrogates_deep(content),
    )


# Payload handed to a still-open activity when the run ends before the subagent
# reported anything. It is the ``/error`` value, so it sits where a real
# failure's error payload would.
TASK_ACTIVITY_UNFINISHED_ERROR = "The run ended before the subagent reported a result."


def close_open_task_activities(
    open_task_activities: dict,
    error: Any = TASK_ACTIVITY_UNFINISHED_ERROR,
) -> List[ActivityDeltaEvent]:
    """
    Close every activity still open on a run's registry, and empty it.

    An activity is normally closed by the ``ToolResultBlock`` carrying the
    subagent's result. When the run ends first — interrupted, timed out, ended
    on an error, or the SDK stream dropped — that result never arrives, and
    without this the activity is left at ``status: "running"`` with no terminal
    delta behind it, so the subagent widget spins for good.

    Returns the closing deltas in the order the activities were opened, so a
    consumer sees them in the same order it saw the snapshots.
    """
    events: List[ActivityDeltaEvent] = []
    for tool_id, activity_type in list(open_task_activities.items()):
        events.append(
            ActivityDeltaEvent(
                type=EventType.ACTIVITY_DELTA,
                message_id=tool_id,
                activity_type=activity_type,
                patch=[
                    {"op": "add", "path": "/status", "value": "failed"},
                    {"op": "add", "path": "/error", "value": error},
                ],
            )
        )
    open_task_activities.clear()
    return events


def _task_activity_value(content: Any) -> Any:
    """
    The value a closing subagent activity delta carries.

    A subagent normally replies with a single text block. That text is handed
    over as the parsed object when it is a JSON object, so a renderer gets
    structure rather than a string to parse, and as the repaired text
    otherwise. Anything richer (several blocks, images, documents) is handed
    over as the same content parts the TOOL_CALL_RESULT carries, so nothing
    the subagent returned is dropped from the activity.
    """
    value = native_tool_content(content, False)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            return value
        if isinstance(parsed, dict):
            return fix_surrogates_deep(parsed)
    return value


async def handle_tool_use_block(
    block: Any,
    message: Any,
    thread_id: str,
    run_id: str,
    current_state: Optional[Any],
    open_task_activities: dict,
    parent_message_id: Optional[str] = None,
) -> tuple[Optional[Any], AsyncIterator[BaseEvent]]:
    """
    Handle ToolUseBlock from Claude SDK.

    Intercepts state management tool calls and emits STATE_SNAPSHOT.
    For regular tools, emits TOOL_CALL_START/ARGS events.

    Args:
        block: ToolUseBlock from Claude SDK
        message: Parent message containing the block
        thread_id: Thread identifier
        run_id: Run identifier
        current_state: Current state for state management tools
        open_task_activities: The run's open-Task-activity registry (see
            :func:`open_task_activity`).
        parent_message_id: ID of the assistant message that owns this tool
            call. The streaming path uses the current assistant message id for
            ``ToolCallStartEvent.parent_message_id``; this mirrors that
            semantics on the non-streaming fallback path.

    Returns:
        Tuple of (updated_state, event_generator)
    """
    tool_name = getattr(block, 'name', '') or 'unknown'
    tool_input = getattr(block, 'input', {}) or {}
    tool_id = getattr(block, 'id', None) or str(uuid.uuid4())

    # Strip MCP prefix for client matching (same as streaming path)
    tool_display_name = strip_mcp_prefix(tool_name)
    if tool_display_name != tool_name:
        logger.debug(f"Stripped MCP prefix in handler: {tool_name} -> {tool_display_name}")
    
    logger.debug(f"ToolUseBlock detected: {tool_name}")

    # Compute the merged state SYNCHRONOUSLY, before building the generator, so
    # the returned first element reflects the post-merge state. The adapter
    # persists this returned value (self._per_thread_state[thread_id]) BEFORE it
    # iterates the event generator, so a value computed inside event_gen() would
    # not yet exist when the tuple is built — the adapter would persist the
    # stale pre-merge state while the emitted STATE_SNAPSHOT carried the merged
    # state. Computing here keeps the returned/persisted state == the snapshot.
    merged_state = current_state
    # When the state_updates JSON fails to parse we emit ONLY a CUSTOM error and
    # must NOT mutate state nor emit a STATE_SNAPSHOT (mirrors the streaming
    # path in adapter.py). This flag carries that decision out to the generator.
    state_parse_error: Optional[str] = None
    # Whether the merge actually changed state. The streaming path only emits a
    # STATE_SNAPSHOT when the merged state differs from the prior; mirror that
    # here so a no-op update doesn't emit a spurious snapshot (Item 3).
    state_changed: bool = False

    if _is_state_management_tool(tool_name):
        logger.debug("Intercepting ag_ui_update_state tool call")

        try:
            merged_state = merge_state_update(current_state, tool_input)
            state_changed = merged_state != current_state
        except (ValueError, TypeError) as error:
            state_parse_error = str(error)

    async def event_gen():
        # Intercept state management tool calls (check both prefixed and unprefixed names)
        if _is_state_management_tool(tool_name):
            if state_parse_error is not None:
                yield CustomEvent(
                    type=EventType.CUSTOM,
                    name="state_update_error",
                    value={"error": state_parse_error},
                )
                # Emit ONLY the error event — do not fall through and emit a
                # spurious STATE_SNAPSHOT with un-updated state. Mirrors the
                # streaming path (adapter.py), which emits the error alone.
                return

            # Emit STATE_SNAPSHOT only when the merge actually changed state,
            # matching the streaming path (Item 3). The snapshot carries the
            # SAME merged state we return below, so the persisted state and the
            # snapshot never diverge.
            if state_changed:
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=merged_state
                )
                logger.debug("Emitted STATE_SNAPSHOT with updated state")
            else:
                logger.debug("State unchanged — suppressing no-op STATE_SNAPSHOT")
            return  # Skip normal tool call events

        # Regular tool handling for non-state tools
        yield ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_id,
            tool_call_name=tool_display_name,  # Use unprefixed name
            parent_message_id=parent_message_id,
        )
        
        if tool_input:
            args_json = json.dumps(tool_input)
            yield ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                thread_id=thread_id,
                run_id=run_id,
                tool_call_id=tool_id,
                delta=args_json,
            )

        # Emit TOOL_CALL_END so the runtime doesn't think the tool call is still active.
        # In the streaming path this is emitted at content_block_stop, but when tools
        # arrive only via the complete AssistantMessage (non-streaming), this fallback
        # is the only place that closes the tool call.
        yield ToolCallEndEvent(
            type=EventType.TOOL_CALL_END,
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_id,
        )

        # Claude's Task tool dispatches a subagent run. Open an AG-UI activity
        # for it so a frontend can render the subagent distinctly, in addition
        # to (not instead of) the tool-call events above: the subagent's result
        # arrives later as an ordinary ToolResultBlock addressed to this same
        # tool_call_id, and a TOOL_CALL_RESULT with no preceding
        # TOOL_CALL_START is rejected by the runtime.
        #
        # The activity is opened after the tool call is closed, mirroring the
        # Mastra bridge's ordering when work continues as an activity.
        if tool_name in SUBAGENT_TASK_TOOL_NAMES:
            snapshot = open_task_activity(tool_id, tool_input, open_task_activities)
            if snapshot is not None:
                yield snapshot

    return merged_state, event_gen()


async def handle_tool_result_block(
    block: Any,
    thread_id: str,
    run_id: str,
    open_task_activities: dict,
    parent_tool_use_id: Optional[str] = None,
    sdk_result: Any = None,
    sdk_message_id: Optional[str] = None,
) -> AsyncIterator[BaseEvent]:
    """
    Handle ToolResultBlock from Claude SDK.
    
    Emits TOOL_CALL_END and TOOL_CALL_RESULT events.
    Nested tool results (with parent_tool_use_id) are also emitted - they represent
    sub-agent calls (e.g., Task calling WebSearch).
    
    Args:
        block: ToolResultBlock from Claude SDK
        thread_id: Thread identifier
        run_id: Run identifier
        open_task_activities: The run's open-Task-activity registry (see
            :func:`open_task_activity`). A result whose tool call opened an
            activity in this run closes it.
        parent_tool_use_id: Parent tool ID if this is a nested result
        
    Yields:
        AG-UI tool result events
    """
    tool_use_id = getattr(block, 'tool_use_id', None)
    content = getattr(block, 'content', None)
    is_error = getattr(block, 'is_error', None)
    
    result_str = native_tool_content(content, bool(is_error))

    if tool_use_id:
        # NOTE: Do NOT emit TOOL_CALL_END here — it was already emitted
        # during content_block_stop (streaming path) or by handle_tool_use_block
        # (non-streaming path). Emitting it again causes "No active tool call"
        # errors in the CopilotKit runtime. The TS adapter follows the same
        # pattern: tool result handling only emits TOOL_CALL_RESULT.

        # Emit ToolCallResult with the actual result content.
        #
        # Nested / sub-agent results (e.g. Task calling WebSearch) carry a
        # parent_tool_use_id. AG-UI's ToolCallResultEvent has no first-class
        # field for it, so we surface the linkage via the protocol-standard
        # ``raw_event`` escape hatch — only when present, so top-level results
        # don't gain a spurious raw_event. (Item 8: previously this argument was
        # accepted but never used, leaving the documented nested behavior inert.)
        result_message_id = f"{tool_use_id}-result"
        raw_event = {"tool_use_id": tool_use_id, "content": content, "is_error": is_error}
        if parent_tool_use_id:
            raw_event["parent_tool_use_id"] = parent_tool_use_id
        if sdk_result is not None:
            raw_event["tool_use_result"] = sdk_result
        if sdk_message_id is not None:
            raw_event["uuid"] = sdk_message_id
        yield ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            thread_id=thread_id,
            run_id=run_id,
            message_id=result_message_id,
            tool_call_id=tool_use_id,
            content=result_str,
            role="tool",
            raw_event=fix_surrogates_deep(raw_event),
        )

        # Close the subagent activity this result belongs to, when the call was
        # a Task. Nothing is emitted for any other tool, or for a Task whose
        # activity was never opened (or has already been closed), so a stray
        # result cannot produce a delta with no snapshot in front of it.
        activity_type = open_task_activities.pop(tool_use_id, None)
        if activity_type is not None:
            # The same value sits at ``/result`` on success and ``/error`` on
            # failure, so a renderer reads both the same way. It is built from
            # the raw content rather than read back from ``result_str``, which
            # on the failure path is the TOOL_CALL_RESULT error envelope.
            activity_value = _task_activity_value(content)
            if is_error:
                patch = [
                    {"op": "add", "path": "/status", "value": "failed"},
                    {"op": "add", "path": "/error", "value": activity_value},
                ]
            else:
                patch = [
                    {"op": "add", "path": "/status", "value": "completed"},
                    {"op": "add", "path": "/result", "value": activity_value},
                ]
            yield ActivityDeltaEvent(
                type=EventType.ACTIVITY_DELTA,
                message_id=tool_use_id,
                activity_type=activity_type,
                patch=patch,
            )
