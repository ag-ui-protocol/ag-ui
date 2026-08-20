"""AWS Strands Agent adapter for AG-UI.

Translates Strands streaming events into the AG-UI event protocol.
"""

import asyncio
import base64
import hashlib
import inspect
import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import version as distribution_version
from typing import Any, AsyncIterator, Dict, List, Tuple

from strands import Agent as StrandsAgentCore
from strands.session import SessionManager
from strands.types.interrupt import InterruptResponseContent

# Params handled explicitly by StrandsAgent — excluded from auto-forwarding.
# "messages" is excluded: per-thread agents start with no history;
# AG-UI injects messages at runtime via RunAgentInput.
# "hooks" is excluded: Agent stores hooks as a HookRegistry after init, not
# the original list the constructor expects — forwarding it causes a TypeError.
# "session_manager" is excluded: it is supplied per-thread via
# StrandsAgentConfig.session_manager_provider (see run()). Forwarding a
# template-level session_manager would make every thread share one session_id.
_AGUI_EXPLICIT_PARAMS = {
    "self",
    "model",
    "system_prompt",
    "tools",
    "messages",
    "hooks",
    "session_manager",
}


def _extract_agent_kwargs(agent: StrandsAgentCore) -> dict:
    """Build kwargs for StrandsAgentCore by introspecting its constructor signature.

    Tries ``self.<name>`` first, falls back to ``self._<name>`` — Strands stores
    some init params with an underscore prefix (e.g. ``retry_strategy`` lives at
    ``self._retry_strategy``). This keeps the adapter forward-compatible with
    any future param that follows either naming convention.
    """
    kwargs = {}
    for name in inspect.signature(StrandsAgentCore.__init__).parameters:
        if name in _AGUI_EXPLICIT_PARAMS:
            continue
        if hasattr(agent, name):
            value = getattr(agent, name)
        elif hasattr(agent, f"_{name}"):
            value = getattr(agent, f"_{name}")
        else:
            continue
        if value is None:
            continue
        # state is an AgentState container; extract the underlying plain dict
        if name == "state" and hasattr(value, "get"):
            value = value.get()
        kwargs[name] = value
    return kwargs


# Upper bound on the per-agent wire->native map held in session state. Bounds
# growth from frontend calls that never receive a client result (abandoned HITL)
# and so are never consumed/pruned. Generous — a thread rarely has this many
# outstanding frontend calls at once.
_WIRE_MAP_MAX = 512

# Upper bound on the per-agent tool-call metadata map held in session state.
# It bounds abandoned entries (tool calls whose result never returns)
# so state cannot grow without bound.
_TOOL_CALL_MAP_MAX = 512

# Sentinel handed back to a paused ``tool_context.interrupt()`` when the client
# cancels (``ResumeEntry.status == "cancelled"``) rather than resolving. The
# tool receives this in place of a real answer and can treat it as a denial.
INTERRUPT_CANCELLED = {"cancelled": True}

# Message for a rejected overlapping run. Worded identically to the TypeScript
# bridge so a client sees one contract across both, and kept next to the code
# it pairs with rather than inlined at the one call site.
_THREAD_BUSY_MESSAGE_TEMPLATE = (
    'Another run is already in progress on thread "{thread_id}". Wait for '
    "RUN_FINISHED before starting a new run on the same thread."
)

# Upper bound on how long a finishing run may hold its thread claim while its
# cleanup drains. Cleanup delegates into Strands, which can block on a model
# call or a session write, and an unbounded wait turns one hung call into a
# thread that answers THREAD_BUSY for the life of the process. Generous, since
# every ordinary cleanup finishes in milliseconds and the bound exists only to
# convert "wedged forever" into "late".
_RUN_CLEANUP_TIMEOUT_SECONDS = 30.0

# Reserved native-interrupt name prefix for interrupts this adapter's approval
# hook raises. Anything else is a generic native interrupt.
_TOOL_APPROVAL_NAME_PREFIX = "ag_ui:tool_call:"


def _strands_uses_presence_based_interrupt_responses(installed_version: str) -> bool:
    """Return the interrupt-response contract of a Strands SDK version."""
    try:
        major, minor = map(int, installed_version.split(".", 2)[:2])
    except ValueError as exc:
        raise RuntimeError(
            "Cannot determine interrupt response semantics for "
            f"strands-agents version {installed_version!r}"
        ) from exc
    return (major, minor) >= (1, 19)


# Strands 1.15 through 1.18 returns a recorded response only when it is truthy.
# Version 1.19 changed that predicate to presence (``response is not None``).
_STRANDS_USES_PRESENCE_BASED_INTERRUPT_RESPONSES = (
    _strands_uses_presence_based_interrupt_responses(
        distribution_version("strands-agents")
    )
)


def _tool_approval_response_schema() -> dict:
    """The response contract advertised for a tool-approval interrupt.

    Single source for both the schema published on the AG-UI ``Interrupt`` and
    the resume-payload validation, so a resume can still be checked when the
    AG-UI bookkeeping did not survive a process restart.
    """
    return {
        "type": "object",
        "properties": {"approved": {"type": "boolean"}},
        "required": ["approved"],
    }


def _is_tool_approval_interrupt(native_interrupt: Any) -> bool:
    """True when a native Strands interrupt came from the approval hook."""
    name = getattr(native_interrupt, "name", None)
    return (
        isinstance(name, str)
        and name.startswith(_TOOL_APPROVAL_NAME_PREFIX)
        and isinstance(getattr(native_interrupt, "reason", None), dict)
    )


def _wrap_resume_response(status: str, payload: Any) -> dict:
    """Package a ``ResumeEntry`` for Strands' ``interruptResponse`` shape.

    Supported Strands releases read a recorded answer either by truthiness
    (1.15 through 1.18) or by presence (1.19+). Forwarding a raw falsy payload
    can therefore re-raise the same interrupt and re-run the tool body on the
    compatibility floor. Always hand Strands a truthy envelope; the tool
    implementation unwraps it via ``.get("cancelled")`` / ``.get("response")``.
    """
    if status == "cancelled":
        return dict(INTERRUPT_CANCELLED)
    return {"response": payload}


def _native_resume_response(entry: Any, native_interrupt: Any) -> Any:
    """Return the answer Strands records when this entry is forwarded.

    One definition, read both by the batch the run forwards and by the replay
    comparison below, so the two cannot disagree about what was submitted.
    """
    if _is_tool_approval_interrupt(native_interrupt):
        return {"approved": False} if entry.status == "cancelled" else entry.payload
    return _wrap_resume_response(entry.status, entry.payload)


def _replays_recorded_answers(interrupt_state: Any, resume_entries: Any) -> bool:
    """True when this batch re-submits exactly the answers the checkpoint holds.

    Strands records the submitted answers before it reruns hooks and the parked
    tool execution, and clears the checkpoint only once that work succeeds. So a
    hook failure, or a crash after session persistence, can restore a checkpoint
    that is activated with every interrupt already answered. That thread has no
    way forward: fresh input is refused because the checkpoint is active, and a
    resume finds nothing open to address. Handing Strands the identical batch is
    the way out, because it lets the SDK finish the parked execution. The
    checkpoint itself must be left alone: clearing it would discard exactly that
    parked execution. Anything short of an exact replay stays refused.
    """
    recorded = getattr(interrupt_state, "interrupts", {}) or {}
    if not recorded or len(resume_entries) != len(recorded):
        return False
    addressed: set[str] = set()
    for entry in resume_entries:
        interrupt_id = getattr(entry, "interrupt_id", None)
        native_interrupt = recorded.get(interrupt_id)
        if native_interrupt is None or interrupt_id in addressed:
            return False
        addressed.add(interrupt_id)
        if not _native_interrupt_is_answered(native_interrupt):
            return False
        if native_interrupt.response != _native_resume_response(
            entry, native_interrupt
        ):
            return False
    return True


def _get_strands_session_manager(agent: Any) -> Any:
    """Return the agent's Strands ``SessionManager``, or ``None``.

    Strands stores it publicly as ``session_manager``; some versions keep a
    private ``_session_manager`` alias.
    """
    return getattr(agent, "session_manager", None) or getattr(
        agent, "_session_manager", None
    )


async def _sync_session_state(agent: Any) -> None:
    """Flush agent state through the SessionManager without blocking the loop.

    ``SessionManager.sync_agent`` is synchronous and writes to whatever backend
    the deployment configured — a file, a database, S3. Calling it inline stalls
    the event loop, and therefore every other request the process is serving,
    for the duration of that write. It runs many times per request on this path,
    so the stall compounds. A worker thread keeps the wait ordered against this
    run — the write still completes before the event it guards is yielded — while
    leaving the loop free.
    """
    session_manager = _get_strands_session_manager(agent)
    if session_manager is None:
        return
    await asyncio.to_thread(session_manager.sync_agent, agent)


async def _sync_frontend_wait_state(agent: Any) -> None:
    """Persist an adapter-owned frontend-wait transition."""
    await _sync_session_state(agent)


async def _mark_frontend_wait_end_handed_off(
    agent: Any,
    batch: "FrontendToolWaitBatch",
    wire_tool_call_id: str,
) -> "FrontendToolWaitBatch":
    """Persist one ToolCallEnd handoff before advancing the event stream."""
    marked = batch.mark_end_handed_off(wire_tool_call_id)
    agent.state.set(FRONTEND_TOOL_WAIT_STATE_KEY, marked.to_dict())
    await _sync_frontend_wait_state(agent)
    return marked


def _strands_interrupt_to_agui(strands_interrupt: Any) -> "Interrupt":
    """Map a native Strands ``Interrupt`` onto an AG-UI ``Interrupt``.

    Interrupts raised by this adapter's approval hook use its reserved
    ``ag_ui:tool_call:`` name prefix and map to AG-UI tool-call approvals.
    All other native interrupts retain their generic name and reason payload.
    """
    s_id = getattr(strands_interrupt, "id", "")
    name = getattr(strands_interrupt, "name", None) or "interrupt"
    raw_reason = getattr(strands_interrupt, "reason", None)

    if _is_tool_approval_interrupt(strands_interrupt):
        tool_name = raw_reason.get("tool_name", "unknown")
        return Interrupt(
            id=s_id,
            reason="tool_call",
            message=f"Approve call to {tool_name}?",
            tool_call_id=raw_reason.get("tool_use_id"),
            response_schema=_tool_approval_response_schema(),
            metadata={
                "tool_name": tool_name,
                "tool_input": raw_reason.get("tool_input", {}),
            },
        )

    return Interrupt(
        id=s_id,
        reason=name,
        message=None,
        tool_call_id=None,
        response_schema=None,
        metadata={"reason": raw_reason} if raw_reason is not None else None,
    )


def _native_interrupt_is_answered(interrupt: Any) -> bool:
    """True when this interrupt already carries an answer Strands will hand back.

    Match the installed SDK's own ``ToolContext.interrupt`` predicate. Strands
    1.15 through 1.18 uses truthiness; 1.19 and later uses presence, with
    ``None`` as the unanswered default.
    """
    response = getattr(interrupt, "response", None)
    if _STRANDS_USES_PRESENCE_BASED_INTERRUPT_RESPONSES:
        return response is not None
    return bool(response)


def _is_native_interrupt_state(interrupt_state: Any) -> bool:
    """True when this object is shaped like Strands' native checkpoint state.

    Structural rather than an isinstance check against a private SDK class, and
    structural rather than a check on where the object came from: the question
    is whether ``activated`` and ``interrupts`` can be read as the audit below
    reads them, and a stand-in that answers them faithfully is as good as the
    real thing.
    """
    return isinstance(getattr(interrupt_state, "activated", None), bool) and isinstance(
        getattr(interrupt_state, "interrupts", None), Mapping
    )


def _open_native_interrupts(interrupts: Any) -> dict:
    """Return the entries of ``interrupts`` still awaiting a human, keyed by id.

    The native interrupt state is the only record of what is still in flight, and
    every "is anything still open?" decision reads it through this one predicate,
    so the pause this run reports and the resume the next one submits cannot
    disagree and strand a client between them.
    """
    return {
        interrupt_id: interrupt
        for interrupt_id, interrupt in (interrupts or {}).items()
        if not _native_interrupt_is_answered(interrupt)
    }


def _extract_interrupts(agent: Any, terminal_result: Any) -> list:
    """Return the native Strands interrupts for a paused run, or ``[]``.

    Prefers the terminal ``AgentResult`` (``stop_reason == "interrupt"`` with a
    populated ``interrupts``); falls back to the live agent's
    ``_interrupt_state`` so a pause is still detected if the result event was
    consumed by the stream's early-break path.
    """
    if terminal_result is not None:
        if getattr(terminal_result, "stop_reason", None) == "interrupt":
            interrupts = getattr(terminal_result, "interrupts", None) or []
            if interrupts:
                return list(interrupts)
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is not None and getattr(interrupt_state, "activated", False):
        open_interrupts = _open_native_interrupts(
            getattr(interrupt_state, "interrupts", {})
        )
        if not open_interrupts:
            # The checkpoint is still activated yet every interrupt is answered
            # under the installed SDK's semantics, so this run reports success
            # while the agent may remain parked.
            logger.debug(
                "Native interrupt state is activated but every interrupt is "
                "answered; reporting no pending interrupts"
            )
        return list(open_interrupts.values())
    return []


def _interrupt_session_required_error() -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message=(
            "A SessionManager is required for a mixed frontend-proxy/native interrupt checkpoint"
        ),
        code="INTERRUPT_SESSION_REQUIRED",
    )


def _interrupt_session_capability_error() -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message=(
            "Mixed frontend-proxy/native interrupt state requires session_id, "
            "a stable agent_id, and a session_repository exposing "
            "list_messages() and update_message()"
        ),
        code="INTERRUPT_SESSION_CAPABILITY_ERROR",
    )


def _interrupt_reconciliation_error() -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message="Active interrupt tool result reconciliation failed",
        code="INTERRUPT_RECONCILIATION_ERROR",
    )


def _interrupt_resume_error(message: str) -> "RunErrorEvent":
    return RunErrorEvent(
        type=EventType.RUN_ERROR,
        message=message,
        code="INTERRUPT_RESUME_ERROR",
    )


def _preflight_resume_entries(
    agent: Any,
    resume_entries: Any,
    pending_ag_ui: dict[str, Any] | None = None,
    *,
    require_complete: bool = True,
) -> "RunErrorEvent | None":
    """Validate submitted resume entries without mutating interrupt state."""
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is None or not getattr(interrupt_state, "activated", False):
        return _interrupt_resume_error(
            "Cannot resume without an active native interrupt checkpoint"
        )
    if not isinstance(resume_entries, list) or not resume_entries:
        return _interrupt_resume_error(
            "A submitted resume must contain at least one entry"
        )

    open_interrupts = _open_native_interrupts(
        getattr(interrupt_state, "interrupts", {})
    )
    # An active checkpoint whose every interrupt is answered is a thread the SDK
    # parked mid-resume (see _replays_recorded_answers). The interrupts an exact
    # replay may address are the answered ones it is replaying.
    if _replays_recorded_answers(interrupt_state, resume_entries):
        addressable = dict(getattr(interrupt_state, "interrupts", {}) or {})
    else:
        addressable = open_interrupts
    seen_ids: set[str] = set()
    for entry in resume_entries:
        interrupt_id = getattr(entry, "interrupt_id", None)
        if not isinstance(interrupt_id, str) or not interrupt_id.strip():
            return _interrupt_resume_error(
                "Resume entries must contain a non-blank interrupt id"
            )
        if interrupt_id in seen_ids:
            return _interrupt_resume_error(
                f"Resume contains duplicate interrupt id: {interrupt_id}"
            )
        seen_ids.add(interrupt_id)
        interrupt = addressable.get(interrupt_id)
        if interrupt is None:
            return _interrupt_resume_error(
                f"Resume references an interrupt that is not open: {interrupt_id}"
            )

    missing_ids = set(addressable) - seen_ids
    if require_complete and missing_ids:
        return RunErrorEvent(
            type=EventType.RUN_ERROR,
            message=(
                f"Partial resume: missing interrupt IDs {sorted(missing_ids)}. All open interrupts must be addressed."
            ),
            code="PARTIAL_RESUME",
        )

    pending_ag_ui = pending_ag_ui or {}
    for entry in resume_entries:
        ag_ui_interrupt = pending_ag_ui.get(entry.interrupt_id)

        if ag_ui_interrupt and getattr(ag_ui_interrupt, "expires_at", None):
            expiry = datetime.fromisoformat(ag_ui_interrupt.expires_at)
            if datetime.now(timezone.utc) > expiry:
                return RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=f"Interrupt '{entry.interrupt_id}' has expired.",
                    code="INTERRUPT_EXPIRED",
                )

        schema = (
            getattr(ag_ui_interrupt, "response_schema", None)
            if ag_ui_interrupt
            else None
        )
        if not schema and _is_tool_approval_interrupt(
            addressable.get(entry.interrupt_id)
        ):
            # AG-UI bookkeeping can be lost to a restart while the native
            # interrupt is restored. A tool approval's contract is fixed, so
            # validate against it rather than waving the payload through.
            schema = _tool_approval_response_schema()

        if entry.status != "resolved" or not schema:
            continue

        payload = entry.payload
        if schema.get("type") != "object":
            continue
        if not isinstance(payload, dict):
            return RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=(
                    f"Invalid payload for interrupt '{entry.interrupt_id}': expected an object."
                ),
                code="INVALID_PAYLOAD",
            )
        required = schema.get("required", [])
        missing_keys = [key for key in required if key not in payload]
        if missing_keys:
            return RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=(
                    f"Invalid payload for interrupt '{entry.interrupt_id}': missing required keys {missing_keys}."
                ),
                code="INVALID_PAYLOAD",
            )
        type_error = _validate_object_payload_property_types(schema, payload)
        if type_error:
            return RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=(
                    f"Invalid payload for interrupt '{entry.interrupt_id}': {type_error}"
                ),
                code="INVALID_PAYLOAD",
            )
    return None


def _error_events(
    input_data: "RunAgentInput",
    message: str,
    code: str,
) -> tuple[Any, Any]:
    """Return (RunStartedEvent, RunErrorEvent) tuple for early-exit error paths.

    Use with: yield ev1; yield ev2 where (ev1, ev2) = _error_events(...)
    """
    return (
        RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        ),
        RunErrorEvent(
            type=EventType.RUN_ERROR,
            message=message,
            code=code,
        ),
    )

logger = logging.getLogger(__name__)
from ag_ui.core import (
    AssistantMessage,
    CustomEvent,
    EventType,
    FunctionCall,
    Interrupt,
    MessagesSnapshotEvent,
    ReasoningEncryptedValueEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    ResumeEntry,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
    RunStartedEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
    UserMessage,
)

from ag_ui_a2ui_toolkit import split_a2ui_schema_context

from .a2ui_tool import (
    A2UI_STREAM_KEY,
    is_auto_injected_a2ui_tool,
    plan_a2ui_injection,
)
from .client_proxy_tool import (
    _install_frontend_wait_resume_proxy_overlay,
    _is_proxy,
    sync_proxy_tools,
)
from .frontend_tool_wait import (
    FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
    FRONTEND_TOOL_WAIT_STATE_KEY,
    MAX_CHECKPOINT_MESSAGE_IDS,
    FrontendToolWaitBatch,
    FrontendToolWaitCall,
    is_frontend_wait_interrupt,
    load_frontend_tool_wait,
    parse_frontend_wait_interrupt,
)
from .session_reconcile import (
    AG_UI_TOOL_CALL_MAP_STATE_KEY,
    AG_UI_WIRE_MAP_STATE_KEY,
    _supports_repository_reconciliation,
    active_proxy_placeholder_ids,
    has_placeholder_results,
    reconcile_frontend_tool_results,
    resolve_native_ids,
)
from .config import (
    StrandsAgentConfig,
    ToolBehavior,
    ToolCallContext,
    ToolResultContext,
    ToolStreamEventContext,
    maybe_await,
    normalize_predict_state,
)
from .utils import convert_agui_content_to_strands, flatten_content_to_text


_FRONTEND_TOOL_SERVER_RESPONSES_STATE_KEY = (
    "ag_ui_frontend_tool_wait_server_responses"
)


def _successful_noop_events(input_data: RunAgentInput) -> tuple[Any, Any]:
    return (
        RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        ),
        RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
            outcome=RunFinishedSuccessOutcome(type="success"),
        ),
    )


def _checkpoint_message_ids(messages: list[Any]) -> tuple[str, ...]:
    """Return stable, de-duplicated AG-UI identities at a wait boundary."""
    latest_unique: list[str] = []
    seen: set[str] = set()
    for message in reversed(messages):
        message_id = getattr(message, "id", None)
        if isinstance(message_id, str) and message_id and message_id not in seen:
            seen.add(message_id)
            latest_unique.append(message_id)
            if len(latest_unique) == MAX_CHECKPOINT_MESSAGE_IDS:
                break
    return tuple(reversed(latest_unique))


def _has_unrecoverable_frontend_wait_result(
    input_data: RunAgentInput,
    agent: Any,
    batch: FrontendToolWaitBatch,
    tool_behaviors: Mapping[str, Any],
) -> bool:
    """Detect a waiting result whose native checkpoint was not restored.

    This guard runs only for a newly-created per-thread core. A result-only
    delta is otherwise indistinguishable from a new turn when the caller used
    no SessionManager, or when a shared store was opened with the wrong
    ``agent_id``. Every trailing ToolMessage must have evidence tied to its
    exact ID; current declarations or name-only placeholders are insufficient.
    """
    if not _is_native_interrupt_state(getattr(agent, "_interrupt_state", None)):
        # A core that does not expose Strands' native checkpoint state cannot
        # participate in this restoration audit.
        return False

    trailing_tool_messages: list[Any] = []
    for message in reversed(list(input_data.messages or [])):
        if getattr(message, "role", None) != "tool":
            break
        trailing_tool_messages.append(message)
    if not trailing_tool_messages:
        return False

    registry = getattr(getattr(agent, "tool_registry", None), "registry", {})
    if not isinstance(registry, Mapping):
        registry = {}
    input_tool_names: dict[str, str] = {}
    for message in input_data.messages or []:
        if getattr(message, "role", None) != "assistant":
            continue
        for tool_call in getattr(message, "tool_calls", None) or []:
            function = getattr(tool_call, "function", None)
            name = (
                function.get("name")
                if isinstance(function, Mapping)
                else getattr(function, "name", None)
            )
            tool_call_id = getattr(tool_call, "id", None)
            if isinstance(tool_call_id, str) and isinstance(name, str) and name:
                input_tool_names[tool_call_id] = name

    state = getattr(agent, "state", None)
    get_state = getattr(state, "get", None)
    wire_map: Mapping[str, Any] = {}
    tool_meta: Mapping[str, Any] = {}
    state_metadata_malformed = False
    if callable(get_state):
        try:
            candidate_wire_map = get_state(AG_UI_WIRE_MAP_STATE_KEY)
            candidate_tool_meta = get_state(AG_UI_TOOL_CALL_MAP_STATE_KEY)
        except Exception:
            state_metadata_malformed = True
            candidate_wire_map = candidate_tool_meta = None
        if candidate_wire_map is not None and not isinstance(
            candidate_wire_map, Mapping
        ):
            state_metadata_malformed = True
        elif isinstance(candidate_wire_map, Mapping):
            wire_map = candidate_wire_map
        if candidate_tool_meta is not None and not isinstance(
            candidate_tool_meta, Mapping
        ):
            state_metadata_malformed = True
        elif isinstance(candidate_tool_meta, Mapping):
            tool_meta = candidate_tool_meta

    restored_native_ids: set[str] = set()
    for message in getattr(agent, "messages", None) or []:
        if not isinstance(message, Mapping) or message.get("role") != "assistant":
            continue
        for block in message.get("content") or []:
            tool_use = block.get("toolUse") if isinstance(block, Mapping) else None
            native_id = tool_use.get("toolUseId") if isinstance(tool_use, Mapping) else None
            if isinstance(native_id, str) and native_id:
                restored_native_ids.add(native_id)

    completed_ids = set(batch.last_completed_wire_ids)
    missing = object()

    def explicit_mode(meta: Any, expected_native_id: str) -> bool | None:
        """Return true-mode proof, legacy absence, or invalid/false proof."""
        if not isinstance(meta, Mapping):
            return False
        has_proxy_flag = "is_proxy" in meta
        has_mode_flag = "continue_after_frontend_call" in meta
        if not has_proxy_flag and not has_mode_flag:
            stored_native_id = meta.get("strands_tool_id")
            return (
                None
                if stored_native_id is None
                or stored_native_id == expected_native_id
                else False
            )
        return bool(
            meta.get("strands_tool_id") == expected_native_id
            and meta.get("is_proxy") is True
            and meta.get("continue_after_frontend_call") is True
        )

    for message in trailing_tool_messages:
        wire_id = getattr(message, "tool_call_id", None)
        if not isinstance(wire_id, str) or not wire_id:
            return True
        if wire_id in completed_ids:
            continue
        if state_metadata_malformed:
            return True

        mapped_native_id = wire_map.get(wire_id, missing)
        if mapped_native_id is not missing and (
            not isinstance(mapped_native_id, str) or not mapped_native_id
        ):
            return True
        if isinstance(mapped_native_id, str) and mapped_native_id:
            meta = tool_meta.get(mapped_native_id, missing)
            if meta is missing:
                meta = tool_meta.get(wire_id, missing)
            if meta is missing:
                # Wire maps predate explicit proxy-mode metadata. Exact map
                # ownership remains valid legacy continuation provenance.
                continue
            mode = explicit_mode(meta, mapped_native_id)
            if mode is False:
                return True
            # Explicit true and genuinely legacy metadata (neither mode field)
            # both retain the historical continuation path.
            continue

        direct_meta = tool_meta.get(wire_id, missing)
        if direct_meta is not missing:
            direct_mode = explicit_mode(direct_meta, wire_id)
            if direct_mode is False:
                return True
            if direct_mode is True:
                continue
        if wire_id in restored_native_ids:
            continue

        tool_name = input_tool_names.get(wire_id)
        if tool_name is None:
            return True
        if tool_name in registry and not _is_proxy(registry[tool_name]):
            continue
        behavior = tool_behaviors.get(tool_name)
        if behavior is not None and behavior.continue_after_frontend_call is True:
            continue
        return True

    return False


def _partition_frontend_wait_interrupts(
    agent: Any,
    native_interrupts: list[Any],
    *,
    checkpoint_messages: list[Any],
    deferred_end_ids: list[str],
) -> tuple[FrontendToolWaitBatch, list[Any]]:
    """Split adapter-owned frontend waits from client-visible interrupts.

    The reserved reason tag is necessary but deliberately insufficient. Every
    tagged interrupt must also agree with the emission-time proxy provenance,
    native tool identity, current proxy registry entry, and wire/native map.
    """
    state = getattr(agent, "state", None)
    tool_meta = state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY) if state is not None else None
    wire_map = state.get(AG_UI_WIRE_MAP_STATE_KEY) if state is not None else None
    if tool_meta is None:
        tool_meta = {}
    if wire_map is None:
        wire_map = {}
    if not isinstance(tool_meta, dict) or not isinstance(wire_map, dict):
        raise ValueError("malformed frontend wait provenance metadata")

    registry = getattr(getattr(agent, "tool_registry", None), "registry", {})
    hidden_calls: list[FrontendToolWaitCall] = []
    visible: list[Any] = []
    for interrupt in native_interrupts:
        reason = getattr(interrupt, "reason", None)
        if not is_frontend_wait_interrupt(reason):
            visible.append(interrupt)
            continue
        if getattr(interrupt, "name", None) != FRONTEND_TOOL_WAIT_INTERRUPT_NAME:
            raise ValueError("frontend wait interrupt name mismatch")

        native_id = parse_frontend_wait_interrupt(reason)
        meta = tool_meta.get(native_id)
        if not isinstance(meta, dict):
            raise ValueError(
                f"Frontend wait provenance is missing for native tool use: {native_id}"
            )
        tool_name = meta.get("name")
        if (
            not isinstance(tool_name, str)
            or not tool_name
            or meta.get("strands_tool_id") != native_id
            or meta.get("is_proxy") is not True
            or meta.get("continue_after_frontend_call") is not False
            or not _is_proxy(registry.get(tool_name))
        ):
            raise ValueError(
                f"Frontend wait provenance mismatch for native tool use: {native_id}"
            )

        wire_ids = [
            wire_id
            for wire_id, mapped_native_id in wire_map.items()
            if isinstance(wire_id, str) and mapped_native_id == native_id
        ]
        if len(wire_ids) != 1:
            raise ValueError(
                f"Frontend wait wire mapping mismatch for native tool use: {native_id}"
            )
        interrupt_id = getattr(interrupt, "id", None)
        if not isinstance(interrupt_id, str) or not interrupt_id:
            raise ValueError("frontend wait interrupt id must be a nonempty string")
        hidden_calls.append(
            FrontendToolWaitCall(
                interrupt_id=interrupt_id,
                native_tool_use_id=native_id,
                wire_tool_call_id=wire_ids[0],
            )
        )

    hidden_by_wire_id = {
        call.wire_tool_call_id: call for call in hidden_calls
    }
    ordered_hidden_end_ids = [
        wire_id for wire_id in deferred_end_ids if wire_id in hidden_by_wire_id
    ]
    if (
        len(ordered_hidden_end_ids) != len(set(ordered_hidden_end_ids))
        or set(ordered_hidden_end_ids) != set(hidden_by_wire_id)
    ):
        raise ValueError(
            "frontend wait interrupts do not match deferred ToolCallEnd ids"
        )
    hidden_calls = [
        hidden_by_wire_id[wire_id] for wire_id in ordered_hidden_end_ids
    ]

    return (
        FrontendToolWaitBatch(
            calls=hidden_calls,
            checkpoint_message_ids=_checkpoint_message_ids(checkpoint_messages),
        ),
        visible,
    )


def _recover_disjoint_checkpoint_after_consumed_wait(
    agent: Any,
    native_interrupts: Mapping[str, Any],
    old_batch: FrontendToolWaitBatch,
    checkpoint_messages: Sequence[Any],
) -> tuple[FrontendToolWaitBatch | None, list[Any]]:
    """Rebuild a later checkpoint that superseded a stranded consumed wait."""
    state = getattr(agent, "state", None)
    tool_meta = state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY) if state is not None else None
    wire_map = state.get(AG_UI_WIRE_MAP_STATE_KEY) if state is not None else None
    if not isinstance(tool_meta, Mapping) or not isinstance(wire_map, Mapping):
        raise ValueError("malformed recovered frontend wait provenance metadata")
    hidden_by_wire_id: dict[str, FrontendToolWaitCall] = {}
    visible: list[Any] = []
    for interrupt in native_interrupts.values():
        reason = getattr(interrupt, "reason", None)
        if not is_frontend_wait_interrupt(reason):
            visible.append(interrupt)
            continue
        if getattr(interrupt, "name", None) != FRONTEND_TOOL_WAIT_INTERRUPT_NAME:
            raise ValueError("recovered frontend wait interrupt name mismatch")
        native_id = parse_frontend_wait_interrupt(reason)
        meta = tool_meta.get(native_id)
        if (
            not isinstance(meta, Mapping)
            or meta.get("strands_tool_id") != native_id
            or meta.get("is_proxy") is not True
            or meta.get("continue_after_frontend_call") is not False
            or not isinstance(meta.get("name"), str)
            or not meta.get("name")
        ):
            raise ValueError(
                f"Recovered frontend wait provenance mismatch: {native_id}"
            )
        wire_ids = [
            wire_id
            for wire_id, mapped_native_id in wire_map.items()
            if isinstance(wire_id, str) and mapped_native_id == native_id
        ]
        if len(wire_ids) != 1:
            raise ValueError(
                f"Recovered frontend wait wire mapping mismatch: {native_id}"
            )
        hidden_by_wire_id[wire_ids[0]] = FrontendToolWaitCall(
            interrupt_id=interrupt.id,
            native_tool_use_id=native_id,
            wire_tool_call_id=wire_ids[0],
        )
    hidden_calls = [
        hidden_by_wire_id[wire_id]
        for wire_id in wire_map
        if wire_id in hidden_by_wire_id
    ]
    if not hidden_calls:
        return None, visible
    recovered_message_ids = [
        meta["message_id"]
        for call in hidden_calls
        if isinstance((meta := tool_meta.get(call.native_tool_use_id)), Mapping)
        and isinstance(meta.get("message_id"), str)
        and meta["message_id"]
    ]
    recovered_message_id_set = set(recovered_message_ids)
    recovered_boundary_index: int | None = None
    for index, message in enumerate(checkpoint_messages):
        message_id = getattr(message, "id", None)
        role = getattr(message, "role", None)
        if message_id in recovered_message_id_set and role == "assistant":
            recovered_boundary_index = index
    old_checkpoint_ids = set(old_batch.checkpoint_message_ids)
    if recovered_boundary_index is None and any(
        getattr(message, "role", None) == "user"
        and getattr(message, "id", None) not in old_checkpoint_ids
        for message in checkpoint_messages
    ):
        raise ValueError(
            "Recovered frontend wait checkpoint boundary is ambiguous"
        )
    recovered_checkpoint_messages = (
        list(checkpoint_messages[: recovered_boundary_index + 1])
        if recovered_boundary_index is not None
        else []
    )
    checkpoint_ids = [
        *old_batch.checkpoint_message_ids,
        *_checkpoint_message_ids(recovered_checkpoint_messages),
        *recovered_message_ids,
    ]
    latest_unique: list[str] = []
    seen_checkpoint_ids: set[str] = set()
    for message_id in reversed(checkpoint_ids):
        if message_id in seen_checkpoint_ids:
            continue
        seen_checkpoint_ids.add(message_id)
        latest_unique.append(message_id)
        if len(latest_unique) == MAX_CHECKPOINT_MESSAGE_IDS:
            break
    return (
        FrontendToolWaitBatch(
            calls=hidden_calls,
            last_completed_wire_ids=(
                old_batch.mark_consumed().last_completed_wire_ids
                if old_batch.calls
                else old_batch.last_completed_wire_ids
            ),
            checkpoint_message_ids=tuple(reversed(latest_unique)),
        ),
        visible,
    )


def _decode_tool_result_data(tool_result: Any) -> Any:
    """Decode the first text block exactly like the normal result stream."""
    if not isinstance(tool_result, dict):
        return None
    result_content = tool_result.get("content", [])
    if not result_content or not isinstance(result_content, list):
        return None
    for content_item in result_content:
        if not isinstance(content_item, dict) or "text" not in content_item:
            continue
        text_content = content_item["text"]
        try:
            return json.loads(text_content)
        except json.JSONDecodeError:
            try:
                return json.loads(text_content.replace("'", '"'))
            except Exception:
                return text_content
    return None


def _frontend_wait_calls_by_end_phase(
    agent: Any,
    batch: FrontendToolWaitBatch,
    tool_behaviors: Mapping[str, Any],
    declared_tool_names: set[str],
) -> tuple[tuple[FrontendToolWaitCall, ...], tuple[FrontendToolWaitCall, ...]]:
    """Partition unhanded wait calls by their original End ordering phase."""
    unhanded_calls = batch.unhanded_calls
    if not unhanded_calls:
        return (), ()
    raw_meta = agent.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)
    if not isinstance(raw_meta, Mapping):
        raise ValueError("frontend wait End phase metadata is missing")
    tool_meta = raw_meta
    custom: list[FrontendToolWaitCall] = []
    standard: list[FrontendToolWaitCall] = []
    for call in unhanded_calls:
        meta = tool_meta.get(call.native_tool_use_id)
        if not isinstance(meta, Mapping):
            raise ValueError(
                "frontend wait End phase metadata is missing for native tool "
                f"use: {call.native_tool_use_id}"
            )
        use_streaming = meta.get("use_streaming")
        if isinstance(use_streaming, bool):
            uses_custom_args = not use_streaming
        else:
            tool_name = meta.get("name")
            if (
                not isinstance(tool_name, str)
                or not tool_name
                or (
                    tool_name not in declared_tool_names
                    and tool_name not in tool_behaviors
                )
            ):
                raise ValueError(
                    "frontend wait End phase metadata is malformed for native "
                    f"tool use: {call.native_tool_use_id}"
                )
            behavior = tool_behaviors.get(tool_name)
            uses_custom_args = bool(behavior and behavior.args_streamer)
        (custom if uses_custom_args else standard).append(call)
    return tuple(custom), tuple(standard)


@dataclass
class _CheckpointResultDelivery:
    metadata_changed: bool = False
    stop_streaming_after_result: bool = False


async def _checkpoint_result_events(
    *,
    agent: Any,
    batch: FrontendToolWaitBatch,
    persisted_tool_call_meta: dict[str, dict[str, Any]],
    emitted_backend_result_ids: set[str],
    input_data: RunAgentInput,
    config: StrandsAgentConfig,
    emit_snapshots: bool,
    snapshot_messages: list[Any],
    current_state: dict[str, Any],
    message_id: str,
    delivery: _CheckpointResultDelivery,
) -> AsyncIterator[Any]:
    """Stream checkpointed backend results without re-running Strands."""
    if batch.stop_streaming_after_result:
        return
    interrupt_context = getattr(
        getattr(agent, "_interrupt_state", None), "context", None
    )
    checkpoint_results = (
        interrupt_context.get("tool_results", [])
        if batch.calls and isinstance(interrupt_context, dict)
        else []
    )
    for tool_result in checkpoint_results:
        if not isinstance(tool_result, dict):
            continue
        result_tool_id = tool_result.get("toolUseId")
        if (
            not isinstance(result_tool_id, str)
            or result_tool_id in emitted_backend_result_ids
        ):
            continue
        call_info = persisted_tool_call_meta.get(result_tool_id)
        if not isinstance(call_info, dict):
            continue
        if (
            call_info.get("is_proxy") is True
            or call_info.get("checkpoint_result_emitted") is True
        ):
            continue
        tool_name = call_info.get("name")
        if not isinstance(tool_name, str) or not tool_name:
            continue

        result_data = _decode_tool_result_data(tool_result)
        if result_data is None:
            continue

        tool_result_message_id = str(uuid.uuid4())
        tool_result_content = json.dumps(result_data)
        yield ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            tool_call_id=result_tool_id,
            message_id=tool_result_message_id,
            content=tool_result_content,
        )
        emitted_backend_result_ids.add(result_tool_id)

        behavior = config.tool_behaviors.get(tool_name)
        if emit_snapshots and not (
            behavior and behavior.skip_messages_snapshot
        ):
            snapshot_messages.append(
                ToolMessage(
                    id=tool_result_message_id,
                    role="tool",
                    content=tool_result_content,
                    tool_call_id=result_tool_id,
                )
            )
            yield MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=list(snapshot_messages),
            )

        result_context = ToolResultContext(
            input_data=input_data,
            tool_name=tool_name,
            tool_use_id=result_tool_id,
            tool_input=call_info.get("input"),
            args_str=call_info.get("args") or "{}",
            result_data=result_data,
            message_id=(
                call_info["message_id"]
                if isinstance(call_info.get("message_id"), str)
                and call_info["message_id"]
                else message_id
            ),
        )
        # Preserve the adapter's established live-stream contract for these
        # optional projection hooks: the tool result is already delivered and
        # cannot be rolled back, so hook failures are logged with a traceback.
        if behavior and behavior.state_from_result:
            try:
                snapshot = await maybe_await(
                    behavior.state_from_result(result_context)
                )
                if snapshot:
                    current_state.update(snapshot)
                    yield StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=snapshot,
                    )
            except Exception as exc:
                logger.warning(
                    f"state_from_result failed for {tool_name}: {exc}",
                    exc_info=True,
                )
        if behavior and behavior.custom_result_handler:
            try:
                async for custom_event in behavior.custom_result_handler(
                    result_context
                ):
                    if custom_event is not None:
                        yield custom_event
            except Exception as exc:
                logger.warning(
                    f"custom_result_handler failed for {tool_name}: {exc}",
                    exc_info=True,
                )

        call_info["checkpoint_result_emitted"] = True
        delivery.metadata_changed = True
        if behavior and behavior.stop_streaming_after_result:
            delivery.stop_streaming_after_result = True
            break


@dataclass(frozen=True)
class _FrontendResumeRequest:
    """Pure request classification against the restored native checkpoint."""

    canonical_messages: tuple[Any, ...]
    trailing_messages: tuple[Any, ...]
    actionable_trailing_messages: tuple[Any, ...]
    frontend_responses: tuple[dict[str, Any], ...]
    recognized_frontend_response: bool
    tombstone_replays: tuple[Any, ...]
    has_genuine_new_user: bool
    frontend_batch_candidate: FrontendToolWaitBatch
    server_responses_candidate: dict[str, Any]
    server_validation_error: RunErrorEvent | None


def _frontend_tool_message_responses(
    messages: list[Any], batch: FrontendToolWaitBatch
) -> tuple[list[dict[str, Any]], bool]:
    """Extract only ToolMessages owned by the active wait batch."""
    incoming: list[dict[str, Any]] = []
    recognized = False
    for message in messages:
        if getattr(message, "role", None) != "tool":
            continue
        wire_id = getattr(message, "tool_call_id", None)
        call = batch.call_for_wire_id(wire_id) if isinstance(wire_id, str) else None
        if call is None:
            continue
        recognized = True
        content = getattr(message, "content", None)
        if not call.has_response and isinstance(content, str):
            incoming.append(
                {
                    "tool_call_id": wire_id,
                    "content": content,
                    "is_error": bool(getattr(message, "error", None)),
                }
            )
    return incoming, recognized


def _classify_frontend_resume_request(
    messages: list[Any],
    batch: FrontendToolWaitBatch,
    *,
    agent: Any,
    resume_entries: list[Any],
    staged_server_responses: dict[str, Any],
    pending_ag_ui: dict[str, Any] | None,
) -> _FrontendResumeRequest:
    """Classify a request from stable AG-UI identities in one pass."""
    checkpoint_message_ids = set(batch.checkpoint_message_ids)
    boundary_id = (
        batch.checkpoint_message_ids[-1]
        if batch.checkpoint_message_ids
        else None
    )
    boundary_index: int | None = None
    if boundary_id is not None:
        for index in range(len(messages) - 1, -1, -1):
            if getattr(messages[index], "id", None) == boundary_id:
                boundary_index = index
                break

    def is_after_checkpoint(index: int, message: Any) -> bool:
        if boundary_index is not None:
            return index > boundary_index
        return getattr(message, "id", None) not in checkpoint_message_ids

    tombstones = set(batch.last_completed_wire_ids)
    tombstone_replays = tuple(
        message
        for message in messages
        if (
            getattr(message, "role", None) == "tool"
            and getattr(message, "tool_call_id", None) in tombstones
        )
    )
    actionable = tuple(
        message
        for index, message in enumerate(messages)
        if (
            (
                getattr(message, "role", None) == "user"
                and is_after_checkpoint(index, message)
            )
            or (
                getattr(message, "role", None) == "tool"
                and is_after_checkpoint(index, message)
                and getattr(message, "tool_call_id", None) not in tombstones
            )
        )
    )
    frontend_responses, recognized = _frontend_tool_message_responses(
        messages, batch
    )
    frontend_candidate = batch.stage_responses(frontend_responses)
    server_candidate = dict(staged_server_responses)
    server_validation_error = None
    if resume_entries:
        server_candidate, server_validation_error = _stage_server_resume_entries(
            agent,
            resume_entries,
            {call.interrupt_id for call in frontend_candidate.calls},
            staged_server_responses,
            pending_ag_ui,
        )
    return _FrontendResumeRequest(
        canonical_messages=tuple(messages),
        trailing_messages=actionable,
        actionable_trailing_messages=actionable,
        frontend_responses=tuple(frontend_responses),
        recognized_frontend_response=recognized,
        tombstone_replays=tombstone_replays,
        has_genuine_new_user=any(
            getattr(message, "role", None) == "user"
            and is_after_checkpoint(index, message)
            for index, message in enumerate(messages)
        ),
        frontend_batch_candidate=frontend_candidate,
        server_responses_candidate=server_candidate,
        server_validation_error=server_validation_error,
    )


def _load_staged_server_responses(state: Any) -> dict[str, Any]:
    get = getattr(state, "get", None)
    if not callable(get):
        return {}
    raw = get(_FRONTEND_TOOL_SERVER_RESPONSES_STATE_KEY)
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("malformed staged server interrupt responses")
    if not all(
        isinstance(interrupt_id, str) and interrupt_id for interrupt_id in raw
    ):
        raise ValueError("malformed staged server interrupt responses")
    return dict(raw)


def _validate_visible_wait_interrupt_bookkeeping(
    agent: Any,
    batch: FrontendToolWaitBatch,
    pending_ag_ui: Mapping[str, Any] | None,
) -> tuple[tuple[str, ...], RunErrorEvent | None]:
    """Validate durable AG-UI metadata for visible siblings of a hidden wait."""
    interrupt_state = getattr(agent, "_interrupt_state", None)
    current = getattr(interrupt_state, "interrupts", {})
    hidden_ids = {call.interrupt_id for call in batch.calls}
    visible_ids = tuple(
        interrupt_id
        for interrupt_id in current
        if interrupt_id not in hidden_ids
    )
    if not visible_ids:
        if pending_ag_ui:
            return (), _interrupt_resume_error(
                "Visible interrupt bookkeeping does not match the native checkpoint"
            )
        return (), None
    if not isinstance(pending_ag_ui, Mapping):
        return (), _interrupt_resume_error(
            "Visible interrupt bookkeeping is missing for the native checkpoint"
        )
    if set(pending_ag_ui) != set(visible_ids):
        return (), _interrupt_resume_error(
            "Visible interrupt bookkeeping does not match the native checkpoint"
        )
    if any(
        not isinstance(interrupt, Interrupt)
        or interrupt.id != interrupt_id
        for interrupt_id, interrupt in pending_ag_ui.items()
    ):
        return (), _interrupt_resume_error(
            "Visible interrupt bookkeeping is malformed"
        )
    return visible_ids, None


def _staged_server_responses_match_retry(
    resume_entries: list[Any],
    staged: Mapping[str, Any],
    pending_ag_ui: Mapping[str, Interrupt],
) -> bool:
    """Prove a retry repeats the server half of an accepted combined resume."""
    if not resume_entries or set(staged) != set(pending_ag_ui):
        return False
    if {entry.interrupt_id for entry in resume_entries} != set(staged):
        return False
    for entry in resume_entries:
        interrupt = pending_ag_ui.get(entry.interrupt_id)
        if not isinstance(interrupt, Interrupt):
            return False
        if interrupt.reason == "tool_call":
            expected = (
                {"approved": False}
                if entry.status == "cancelled"
                else entry.payload
            )
        else:
            expected = _wrap_resume_response(entry.status, entry.payload)
        if staged.get(entry.interrupt_id) != expected:
            return False
    return True


def _stage_server_resume_entries(
    agent: Any,
    resume_entries: list[Any],
    frontend_interrupt_ids: set[str],
    staged: dict[str, Any],
    pending_ag_ui: dict[str, Any] | None,
) -> tuple[dict[str, Any], RunErrorEvent | None]:
    preflight_error = _preflight_resume_entries(
        agent,
        resume_entries,
        pending_ag_ui,
        require_complete=False,
    )
    if preflight_error is not None:
        return staged, preflight_error

    current = agent._interrupt_state.interrupts
    result = dict(staged)
    for entry in resume_entries:
        interrupt_id = entry.interrupt_id
        if interrupt_id in frontend_interrupt_ids:
            return staged, _interrupt_resume_error(
                "Frontend tool interrupts must be answered by ToolMessage"
            )
        native_interrupt = current.get(interrupt_id)
        if interrupt_id not in result:
            result[interrupt_id] = _native_resume_response(
                entry, native_interrupt
            )
    return result, None


def _build_frontend_wait_resume_prompt(
    agent: Any,
    batch: FrontendToolWaitBatch,
    staged_server_responses: dict[str, Any],
) -> tuple[list[dict[str, Any]] | None, RunErrorEvent | None]:
    """Build a complete native resume after rechecking live interrupt metadata."""
    metadata_error = _validate_frontend_wait_metadata(agent, batch)
    if metadata_error is not None:
        return None, metadata_error

    interrupt_state = agent._interrupt_state
    current = interrupt_state.interrupts
    frontend_responses = batch.responses()
    expected_server_ids = set(current) - set(frontend_responses)
    unknown_server_ids = set(staged_server_responses) - expected_server_ids
    if unknown_server_ids:
        return None, _interrupt_resume_error(
            f"Staged response references an unknown interrupt: {sorted(unknown_server_ids)}"
        )
    if expected_server_ids != set(staged_server_responses):
        return None, None

    combined = {**frontend_responses, **staged_server_responses}
    prompt: list[dict[str, Any]] = []
    for interrupt_id, interrupt in current.items():
        if _native_interrupt_is_answered(interrupt):
            return None, _interrupt_resume_error(
                f"Resume references an interrupt that is not open: {interrupt_id}"
            )
        if interrupt_id not in combined:
            return None, _interrupt_resume_error(
                f"Missing response for native interrupt: {interrupt_id}"
            )
        prompt.append(
            {
                "interruptResponse": {
                    "interruptId": interrupt_id,
                    "response": combined[interrupt_id],
                }
            }
        )
    return prompt, None


def _validate_frontend_wait_metadata(
    agent: Any, batch: FrontendToolWaitBatch
) -> RunErrorEvent | None:
    """Validate the tracked frontend calls against the live checkpoint."""
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is None or not getattr(interrupt_state, "activated", False):
        return _interrupt_resume_error(
            "Cannot resume without an active native interrupt checkpoint"
        )

    state = getattr(agent, "state", None)
    get_state = getattr(state, "get", None)
    if not callable(get_state):
        return _interrupt_resume_error(
            "Frontend wait provenance state is unavailable"
        )
    try:
        wire_map = get_state(AG_UI_WIRE_MAP_STATE_KEY)
        tool_meta = get_state(AG_UI_TOOL_CALL_MAP_STATE_KEY)
    except Exception as exc:
        return _interrupt_resume_error(
            f"Frontend wait provenance state could not be loaded: {exc}"
        )
    if not isinstance(wire_map, Mapping) or not isinstance(tool_meta, Mapping):
        return _interrupt_resume_error(
            "Frontend wait provenance state is missing or malformed"
        )

    current = getattr(interrupt_state, "interrupts", {})
    tracked_frontend_ids = {call.interrupt_id for call in batch.calls}
    for interrupt_id, native_interrupt in current.items():
        reason = getattr(native_interrupt, "reason", None)
        has_reserved_name = (
            getattr(native_interrupt, "name", None)
            == FRONTEND_TOOL_WAIT_INTERRUPT_NAME
        )
        try:
            is_frontend_wait = is_frontend_wait_interrupt(reason)
            if has_reserved_name and not is_frontend_wait:
                parse_frontend_wait_interrupt(reason)
        except ValueError as exc:
            return _interrupt_resume_error(str(exc))
        if is_frontend_wait and not has_reserved_name:
            return _interrupt_resume_error(
                f"Frontend wait interrupt name mismatch: {interrupt_id}"
            )
        if is_frontend_wait and interrupt_id not in tracked_frontend_ids:
            return _interrupt_resume_error(
                f"Frontend wait metadata is missing for interrupt: {interrupt_id}"
            )
    for call in batch.calls:
        mapped_wire_ids = [
            wire_id
            for wire_id, native_id in wire_map.items()
            if isinstance(wire_id, str)
            and native_id == call.native_tool_use_id
        ]
        if (
            wire_map.get(call.wire_tool_call_id) != call.native_tool_use_id
            or mapped_wire_ids != [call.wire_tool_call_id]
        ):
            return _interrupt_resume_error(
                f"Frontend wait wire mapping mismatch: {call.interrupt_id}"
            )
        meta = tool_meta.get(call.native_tool_use_id)
        if not isinstance(meta, Mapping):
            return _interrupt_resume_error(
                f"Frontend wait provenance is missing: {call.interrupt_id}"
            )
        if (
            not isinstance(meta.get("name"), str)
            or not meta.get("name")
            or meta.get("strands_tool_id") != call.native_tool_use_id
            or meta.get("is_frontend") is not True
            or meta.get("is_proxy") is not True
            or meta.get("continue_after_frontend_call") is not False
        ):
            return _interrupt_resume_error(
                f"Frontend wait provenance mismatch: {call.interrupt_id}"
            )

        native_interrupt = current.get(call.interrupt_id)
        if native_interrupt is None or _native_interrupt_is_answered(native_interrupt):
            return _interrupt_resume_error(
                f"Frontend wait interrupt is not open: {call.interrupt_id}"
            )
        if getattr(native_interrupt, "name", None) != (
            FRONTEND_TOOL_WAIT_INTERRUPT_NAME
        ):
            return _interrupt_resume_error(
                f"Frontend wait interrupt name mismatch: {call.interrupt_id}"
            )
        try:
            native_tool_use_id = parse_frontend_wait_interrupt(
                getattr(native_interrupt, "reason", None)
            )
        except ValueError as exc:
            return _interrupt_resume_error(str(exc))
        if native_tool_use_id != call.native_tool_use_id:
            return _interrupt_resume_error(
                f"Frontend wait metadata mismatch: {call.interrupt_id}"
            )
    return None


def _frontend_wait_native_ids_by_tool_name(
    agent: Any,
    batch: FrontendToolWaitBatch,
) -> dict[str, set[str]]:
    """Group parked native IDs using only persisted false-mode provenance."""
    raw_meta = agent.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)
    if not isinstance(raw_meta, Mapping):
        raise ValueError("frontend wait proxy provenance is missing or malformed")
    native_ids_by_name: dict[str, set[str]] = {}
    for call in batch.calls:
        meta = raw_meta.get(call.native_tool_use_id)
        if (
            not isinstance(meta, Mapping)
            or not isinstance(meta.get("name"), str)
            or not meta["name"]
            or meta.get("strands_tool_id") != call.native_tool_use_id
            or meta.get("is_proxy") is not True
            or meta.get("continue_after_frontend_call") is not False
        ):
            raise ValueError(
                "frontend wait proxy provenance mismatch for native tool use: "
                f"{call.native_tool_use_id}"
            )
        native_ids_by_name.setdefault(meta["name"], set()).add(
            call.native_tool_use_id
        )
    return native_ids_by_name


def _frontend_wait_resume_was_accepted(
    agent: Any, batch: FrontendToolWaitBatch
) -> bool:
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is None or not getattr(interrupt_state, "activated", False):
        return True
    current = getattr(interrupt_state, "interrupts", {})
    return all(
        call.interrupt_id not in current
        or _native_interrupt_is_answered(current[call.interrupt_id])
        for call in batch.calls
    )


def _frontend_wait_consumption_is_durable(
    agent: Any, batch: FrontendToolWaitBatch
) -> bool:
    """Prove a complete batch was consumed before its final state sync failed."""
    if not batch.calls or not batch.is_complete:
        return False
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is None:
        return False
    if getattr(interrupt_state, "activated", False):
        current_interrupts = getattr(interrupt_state, "interrupts", None)
        if not isinstance(current_interrupts, Mapping) or any(
            call.interrupt_id in current_interrupts for call in batch.calls
        ):
            return False

    state = getattr(agent, "state", None)
    get_state = getattr(state, "get", None)
    if not callable(get_state):
        return False
    tool_meta = get_state(AG_UI_TOOL_CALL_MAP_STATE_KEY)
    wire_map = get_state(AG_UI_WIRE_MAP_STATE_KEY)
    if not isinstance(wire_map, Mapping) or (
        tool_meta is not None and not isinstance(tool_meta, Mapping)
    ):
        return False

    expected_results: dict[str, tuple[str, str]] = {}
    for call in batch.calls:
        meta = tool_meta.get(call.native_tool_use_id) if tool_meta else None
        if wire_map.get(call.wire_tool_call_id) != call.native_tool_use_id:
            return False
        # Successful result processing prunes this metadata before Strands'
        # own AfterInvocation sync. If an entry remains, it must still prove
        # the original waiting-proxy mode.
        if meta is not None and (
            not isinstance(meta, Mapping)
            or meta.get("strands_tool_id") != call.native_tool_use_id
            or meta.get("is_proxy") is not True
            or meta.get("continue_after_frontend_call") is not False
        ):
            return False
        expected_results[call.native_tool_use_id] = (
            "error" if call.is_error else "success",
            call.content,
        )

    messages = getattr(agent, "messages", None) or []
    latest_tool_use_index: dict[str, int] = {}
    for index, message in enumerate(messages):
        if not isinstance(message, Mapping) or message.get("role") != "assistant":
            continue
        for block in message.get("content") or []:
            if not isinstance(block, Mapping):
                continue
            tool_use = block.get("toolUse")
            if not isinstance(tool_use, Mapping):
                continue
            native_id = tool_use.get("toolUseId")
            if native_id in expected_results:
                latest_tool_use_index[native_id] = index

    for native_id, (expected_status, expected_content) in expected_results.items():
        tool_use_index = latest_tool_use_index.get(native_id)
        if tool_use_index is None or tool_use_index + 1 >= len(messages):
            return False
        result_message = messages[tool_use_index + 1]
        if (
            not isinstance(result_message, Mapping)
            or result_message.get("role") != "user"
        ):
            return False
        matching_results = []
        for block in result_message.get("content") or []:
            if not isinstance(block, Mapping):
                continue
            result = block.get("toolResult")
            if (
                isinstance(result, Mapping)
                and result.get("toolUseId") == native_id
            ):
                matching_results.append(result)
        if len(matching_results) != 1:
            return False
        result = matching_results[0]
        if (
            result.get("status") != expected_status
            or result.get("content") != [{"text": expected_content}]
        ):
            return False
    return True


async def _mark_frontend_wait_consumed(
    agent: Any,
    batch: FrontendToolWaitBatch,
    fingerprint: str | None,
) -> None:
    agent.state.set(
        FRONTEND_TOOL_WAIT_STATE_KEY,
        batch.mark_consumed().to_dict(),
    )
    agent.state.set(_FRONTEND_TOOL_SERVER_RESPONSES_STATE_KEY, {})
    await _persist_interrupt_bookkeeping(
        agent,
        None,
        fingerprint,
        strict=True,
    )


async def _commit_recovered_frontend_wait(
    agent: Any,
    batch: FrontendToolWaitBatch,
    pending: Mapping[str, Interrupt] | None,
    fingerprint: str | None,
    *,
    replacement_batch: FrontendToolWaitBatch | None = None,
) -> None:
    """Sync a recovered tombstone and its checkpoint bookkeeping together."""
    agent.state.set(
        FRONTEND_TOOL_WAIT_STATE_KEY,
        (
            replacement_batch
            if replacement_batch is not None
            else batch.mark_consumed()
        ).to_dict(),
    )
    agent.state.set(_FRONTEND_TOOL_SERVER_RESPONSES_STATE_KEY, {})
    await _persist_interrupt_bookkeeping(
        agent,
        pending,
        fingerprint,
        strict=True,
        synchronize=False,
    )
    await _sync_frontend_wait_state(agent)


def _resume_fingerprint(resume_entries: list[ResumeEntry]) -> str:
    """Return an order-independent idempotency fingerprint for ``resume[]``.

    A resume addresses a set of pending interrupts, so clients may submit the
    same entries in a different order when replaying a request. Canonicalizing
    both payload object keys and entry order prevents that harmless difference
    from re-invoking the model or tools.
    """
    canonical_entries = [
        (entry.interrupt_id, entry.status, entry.payload)
        for entry in resume_entries
    ]
    canonical_entries.sort(
        key=lambda entry: json.dumps(
            entry, sort_keys=True, default=str, separators=(",", ":")
        )
    )
    serialized = json.dumps(
        canonical_entries, sort_keys=True, default=str, separators=(",", ":")
    )
    return hashlib.md5(  # noqa: S324 -- non-security idempotency key
        serialized.encode(), usedforsecurity=False
    ).hexdigest()


def _validate_object_payload_property_types(
    schema: dict[str, Any], payload: dict[str, Any]
) -> str | None:
    """Validate supplied primitive object properties from a JSON Schema.

    This intentionally complements, rather than replaces, the lightweight
    required-field validation in ``run()``. It supports the primitive types
    used by adapter-issued schemas without adding a full JSON Schema runtime.
    """
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return None

    for field, field_schema in properties.items():
        if field not in payload or not isinstance(field_schema, dict):
            continue
        expected_type = field_schema.get("type")
        if not isinstance(expected_type, str):
            continue
        if _json_schema_type_matches(payload[field], expected_type):
            continue
        article = "an" if expected_type in {"object", "array"} else "a"
        return f"field '{field}' must be {article} {expected_type}."

    return None


def _json_schema_type_matches(value: Any, expected_type: str) -> bool:
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "null":
        return value is None
    # Unsupported JSON Schema constructs remain the caller's responsibility.
    return True


def _coerce_text(content: Any) -> str:
    """Best-effort string view of an AG-UI message content field."""
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    return str(content)


def _coerce_id(value: Any) -> str:
    """Return ``value`` if it is a non-empty string, else a fresh UUID."""
    return value if isinstance(value, str) and value else str(uuid.uuid4())


def _build_snapshot_messages(input_messages: List[Any]) -> List[Any]:
    """Convert ``RunAgentInput.messages`` to AG-UI message objects.

    Used to seed the running ``MessagesSnapshotEvent`` payload so each
    snapshot carries the full thread history (prior turns + whatever
    this turn produces).
    """
    out: List[Any] = []
    for msg in input_messages or []:
        role = getattr(msg, "role", None)
        if role not in ("user", "assistant", "tool"):
            continue
        msg_id = _coerce_id(getattr(msg, "id", None))
        if role == "user":
            raw = msg.content
            # Preserve list content (multimodal) as-is; only stringify unexpected types.
            content = raw if isinstance(raw, (str, list)) else _coerce_text(raw)
            out.append(UserMessage(id=msg_id, role="user", content=content))
        elif role == "assistant":
            tool_calls_list = None
            raw_tool_calls = getattr(msg, "tool_calls", None)
            if raw_tool_calls:
                tool_calls_list = []
                for tc in raw_tool_calls:
                    fn = getattr(tc, "function", None)
                    if isinstance(fn, dict):
                        fn_name = fn.get("name") or "unknown"
                        fn_args = fn.get("arguments") or "{}"
                    else:
                        fn_name = getattr(fn, "name", None) or "unknown"
                        fn_args = getattr(fn, "arguments", None) or "{}"
                    tc_id = _coerce_id(getattr(tc, "id", None))
                    tool_calls_list.append(
                        ToolCall(
                            id=tc_id,
                            type="function",
                            function=FunctionCall(
                                name=str(fn_name),
                                arguments=str(fn_args),
                            ),
                        )
                    )
            out.append(
                AssistantMessage(
                    id=msg_id,
                    role="assistant",
                    content=_coerce_text(msg.content),
                    tool_calls=tool_calls_list,
                )
            )
        elif role == "tool":
            tool_call_id = getattr(msg, "tool_call_id", "")
            if not isinstance(tool_call_id, str):
                tool_call_id = ""
            out.append(
                ToolMessage(
                    id=msg_id,
                    role="tool",
                    content=_coerce_text(msg.content),
                    tool_call_id=tool_call_id,
                    # This is an AG-UI -> AG-UI rebuild of the client's own message, so
                    # preserve its error/encrypted_value on the snapshot echo instead of
                    # silently dropping the client's own fields.
                    error=getattr(msg, "error", None),
                    encrypted_value=getattr(msg, "encrypted_value", None),
                )
            )
    return out


def _build_strands_history(input_messages: List[Any]) -> List[Dict[str, Any]]:
    """Convert ``RunAgentInput.messages`` to Strands native ``Messages``.

    Strands has only ``user`` and ``assistant`` roles; tool calls and
    tool results live as ``toolUse`` / ``toolResult`` ContentBlocks.
    Reconciling the cached agent's ``self.messages`` with this list
    before invoking ``stream_async(None)`` ensures the LLM sees the
    real conversation state — including frontend tool results — rather
    than a fresh prompt that re-fires the same tool every turn.
    """
    out: List[Dict[str, Any]] = []
    pending_tool_results: List[Dict[str, Any]] = []

    def flush_tool_results() -> None:
        if not pending_tool_results:
            return
        out.append({"role": "user", "content": list(pending_tool_results)})
        pending_tool_results.clear()

    for msg in input_messages or []:
        role = getattr(msg, "role", None)
        if role == "tool":
            pending_tool_results.append(
                {
                    "toolResult": {
                        "toolUseId": getattr(msg, "tool_call_id", "") or "",
                        "content": [{"text": _coerce_text(msg.content)}],
                        # Carry the AG-UI failure signal onto Bedrock's toolResult status,
                        # so a client-reported tool failure is not asserted to the model as
                        # a success.
                        "status": "error" if getattr(msg, "error", None) else "success",
                    }
                }
            )
            continue

        flush_tool_results()

        if role == "user":
            content = msg.content
            if isinstance(content, list):
                has_media = any(
                    getattr(item, "type", None) in ("image", "audio", "video", "document")
                    for item in content
                )
                if has_media:
                    blocks = convert_agui_content_to_strands(content)
                    if isinstance(blocks, list) and blocks:
                        out.append({"role": "user", "content": blocks})
                        continue
                text = flatten_content_to_text(content) or ""
                out.append({"role": "user", "content": [{"text": text}]})
            else:
                out.append({"role": "user", "content": [{"text": _coerce_text(content)}]})
        elif role == "assistant":
            blocks: List[Dict[str, Any]] = []
            text = _coerce_text(msg.content)
            if text:
                blocks.append({"text": text})
            raw_tool_calls = getattr(msg, "tool_calls", None) or []
            for tc in raw_tool_calls:
                fn = getattr(tc, "function", None)
                if isinstance(fn, dict):
                    name = fn.get("name") or "unknown"
                    args = fn.get("arguments") or "{}"
                else:
                    name = getattr(fn, "name", None) or "unknown"
                    args = getattr(fn, "arguments", None) or "{}"
                try:
                    parsed = json.loads(args) if isinstance(args, str) else (args or {})
                except (json.JSONDecodeError, TypeError):
                    parsed = {}
                blocks.append(
                    {
                        "toolUse": {
                            "toolUseId": tc.id,
                            "name": name,
                            "input": parsed if isinstance(parsed, dict) else {},
                        }
                    }
                )
            if not blocks:
                blocks = [{"text": ""}]
            out.append({"role": "assistant", "content": blocks})

    flush_tool_results()
    # Normalize so Bedrock's toolUse/toolResult pairing holds even when results
    # arrive out of order, are wedged apart by other messages, or span multiple
    # consecutive tool-call turns (parallel tool calls).
    return _normalize_tool_turns(out)


def _is_tooluse_only_assistant(m):
    return (
        m.get("role") == "assistant"
        and m.get("content")
        and all("toolUse" in b for b in m["content"])
    )


def _is_toolresult_only_user(m):
    return (
        m.get("role") == "user"
        and m.get("content")
        and all("toolResult" in b for b in m["content"])
    )


def _normalize_tool_turns(msgs):
    """Merge same-turn toolUse into one assistant msg and their toolResults
    into the immediately following user msg, dropping any messages wedged
    between a toolUse turn and its toolResults so Bedrock accepts the history.

    Messages that legitimately *follow* a completed toolUse/toolResult pair are
    preserved in place; only messages wedged *between* the toolUse turn and its
    results are dropped.
    """
    out = []
    i = 0
    n = len(msgs)
    while i < n:
        m = msgs[i]
        if not _is_tooluse_only_assistant(m):
            out.append(m)
            i += 1
            continue

        # Collect consecutive toolUse-only assistant messages into one.
        merged_tooluse = list(m["content"])
        j = i + 1
        while j < n and _is_tooluse_only_assistant(msgs[j]):
            merged_tooluse.extend(msgs[j]["content"])
            j += 1
        # Preserve first-seen order and de-duplicate ids: a repeated toolUseId
        # must not later emit a duplicate toolResult (Bedrock rejects that).
        tooluse_ids = []
        seen_ids = set()
        for b in merged_tooluse:
            rid = b["toolUse"]["toolUseId"]
            if rid not in seen_ids:
                seen_ids.add(rid)
                tooluse_ids.append(rid)

        # Scan forward for the matching toolResults. Anything that is not a
        # matching result and appears *before* results are complete is "wedged"
        # and dropped; once every result is collected, the remaining messages
        # are left untouched to be processed in place by the outer loop.
        results_by_id = {}
        k = j
        while k < n and len(results_by_id) < len(tooluse_ids):
            mk = msgs[k]
            if _is_toolresult_only_user(mk):
                for b in mk["content"]:
                    rid = b["toolResult"].get("toolUseId")
                    if rid in seen_ids and rid not in results_by_id:
                        results_by_id[rid] = b
                    # non-matching / duplicate result blocks wedged in are dropped
            # non-toolResult messages wedged before completion are dropped
            k += 1

        # Emit merged assistant(toolUse) + merged user(toolResult) adjacently.
        out.append({"role": "assistant", "content": merged_tooluse})
        ordered = [results_by_id[tid] for tid in tooluse_ids if tid in results_by_id]
        if ordered:
            out.append({"role": "user", "content": ordered})

        # Continue with whatever legitimately follows, in place (no reordering).
        i = k
    return out


# ---------------------------------------------------------------------------
# Interrupt bookkeeping persistence
# ---------------------------------------------------------------------------
#
# ``_pending_interrupts_by_thread`` and ``_last_resume_fingerprint`` are the
# adapter's own bookkeeping (idempotency fingerprint + AG-UI-specific
# interrupt metadata like responseSchema/expiresAt) layered on top of
# Strands' native ``_interrupt_state``. Strands' own SessionManager already
# persists/restores ``_interrupt_state`` (and, on a fresh process, the
# per-thread agent + session are reconstructed before this bookkeeping is
# consulted — see the resume-validation gate in ``run()``), but this
# adapter-only bookkeeping lived purely in a Python dict on the
# ``StrandsAgent`` instance, so a process restart lost it: rules 6/7
# (payload-schema validation, expiresAt enforcement) would silently degrade,
# and a replayed resume request would no longer be recognized as a duplicate
# and could re-invoke the model/tool.
#
# To survive a restart, this bookkeeping is now mirrored into
# ``strands_agent.state`` under a single namespaced key — the same
# per-thread, SessionManager-persisted key-value store the adapter already
# uses for ``agui_context``. On every read, if nothing is cached in-process
# for this thread_id, fall back to what's persisted in state.

_INTERRUPT_BOOKKEEPING_STATE_KEY = "ag_ui_interrupt_bookkeeping"


def _load_persisted_interrupt_bookkeeping(
    strands_agent: Any,
) -> tuple[Dict[str, Interrupt] | None, str | None]:
    """Read the persisted (fingerprint, pending-interrupts) pair from
    ``strands_agent.state``, if present and well-formed.

    Defensive by design: a test double (e.g. a bare ``MagicMock()`` standing
    in for the Strands agent) will happily return another mock from
    ``state.get(...)`` rather than ``None``, so every layer of the expected
    shape is checked explicitly before trusting it. Anything that doesn't
    match is treated as "nothing persisted" rather than raised.
    """
    try:
        state = getattr(strands_agent, "state", None)
        get = getattr(state, "get", None)
        if not callable(get):
            return None, None
        raw = get(_INTERRUPT_BOOKKEEPING_STATE_KEY)
    except Exception:  # noqa: BLE001 — never let bookkeeping restore crash a run
        return None, None

    if not isinstance(raw, dict):
        return None, None

    fingerprint = raw.get("last_resume_fingerprint")
    if fingerprint is not None and not isinstance(fingerprint, str):
        fingerprint = None

    pending_raw = raw.get("pending_interrupts")
    pending: Dict[str, Interrupt] | None = None
    if isinstance(pending_raw, dict):
        pending = {}
        for interrupt_id, data in pending_raw.items():
            if not isinstance(interrupt_id, str) or not isinstance(data, dict):
                continue
            try:
                pending[interrupt_id] = Interrupt.model_validate(data)
            except Exception:  # noqa: BLE001 — skip malformed entries, don't crash
                continue

    return pending, fingerprint


async def _persist_interrupt_bookkeeping(
    strands_agent: Any,
    pending: Mapping[str, Interrupt] | None,
    fingerprint: str | None,
    *,
    strict: bool = False,
    synchronize: bool = True,
) -> None:
    """Write the (fingerprint, pending-interrupts) pair to
    ``strands_agent.state`` and flush it through the configured SessionManager.

    Strands' ``AfterInvocation`` persistence hook runs before ``stream_async``
    yields its terminal result, while this adapter can only derive bookkeeping
    from that result. Explicitly syncing after the state write makes the
    metadata durable before the AG-UI run returns. Persistence remains
    best-effort for legacy pure-server checkpoints. Mixed checkpoints request
    strict persistence because a hidden frontend handoff cannot be exposed
    safely without its visible sibling bookkeeping. A validated resume may
    defer the explicit sync to Strands' imminent ``AfterInvocation`` hook.
    """
    try:
        state = getattr(strands_agent, "state", None)
        set_fn = getattr(state, "set", None)
        if not callable(set_fn):
            if strict:
                raise RuntimeError("Interrupt bookkeeping state is not writable")
            return
        payload = {
            "last_resume_fingerprint": fingerprint,
            "pending_interrupts": (
                {i_id: i.model_dump(mode="json") for i_id, i in pending.items()}
                if pending
                else {}
            ),
        }
        set_fn(_INTERRUPT_BOOKKEEPING_STATE_KEY, payload)
        if synchronize:
            session_manager = _get_strands_session_manager(strands_agent)
            if callable(getattr(session_manager, "sync_agent", None)):
                await _sync_session_state(strands_agent)
    except Exception as e:  # noqa: BLE001 — caller selects strictness
        if strict:
            raise
        logger.warning(f"Failed to persist interrupt bookkeeping: {e}")


# ---------------------------------------------------------------------------
# Strands-native interrupt hook
# ---------------------------------------------------------------------------

class StrandsInterruptHook:
    """Interrupts server tools configured with ``interrupt_on_call=True``.

    Registered automatically by :class:`StrandsAgent` when any entry in
    ``config.tool_behaviors`` has ``interrupt_on_call=True``.

    Client-provided proxy tools warn and skip the interrupt because their
    execution must be gated in the client.

    On the **first** call for a configured server-executed tool the hook calls
    ``event.interrupt()``, which raises ``InterruptException`` internally and
    suspends the Strands agent loop. On the **resume** call Strands has already
    written the human response into the interrupt object, so
    ``event.interrupt()`` returns the response payload instead of raising. The
    hook then grants approval only for ``{"approved": True}``; otherwise it
    sets ``event.cancel_tool`` so the tool is skipped.
    """

    def __init__(self, tool_behaviors: "Dict[str, ToolBehavior]") -> None:
        self._tool_behaviors = tool_behaviors

    def register_hooks(self, registry: Any, **kwargs: Any) -> None:
        """Register the BeforeToolCallEvent callback."""
        from strands.hooks.events import BeforeToolCallEvent as _BeforeToolCallEvent
        registry.add_callback(_BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event: Any) -> None:
        """Skip client proxies; interrupt or enforce approval for server tools."""
        tool_name = event.tool_use.get("name", "")
        behavior = self._tool_behaviors.get(tool_name)
        if not behavior or not behavior.interrupt_on_call:
            return
        if _is_proxy(event.selected_tool):
            logger.warning(
                "interrupt_on_call is ignored for client-provided tool '%s'; gate execution in the client.",
                tool_name,
            )
            return

        # event.interrupt() either:
        #   - raises InterruptException (first call, no response yet) → suspends loop
        #   - returns the human response payload (resume call) → enforce decision
        response = event.interrupt(
            f"{_TOOL_APPROVAL_NAME_PREFIX}{tool_name}",
            reason={
                "tool_name": tool_name,
                "tool_input": event.tool_use.get("input", {}),
                "tool_use_id": event.tool_use.get("toolUseId"),
            },
        )
        # If we reach here we are on the resume path.
        # Enforce a strict payload contract matching the advertised
        # response_schema ({"approved": bool}, required): only a dict with
        # "approved" set to an actual bool of True grants approval. Anything
        # else — a missing key, a non-bool value (e.g. a truthy string like
        # "false", a number, None), or a non-dict response — is treated as
        # an explicit denial rather than being coerced by truthiness.
        approved = (
            isinstance(response, dict)
            and isinstance(response.get("approved"), bool)
            and response["approved"] is True
        )
        if not approved:
            event.cancel_tool = f"User denied approval for '{tool_name}'."



class _ActiveThreadRuns:
    """Track active wrapper-local runs without queueing contenders.

    A claim is identified by a token rather than by its thread id alone. An
    abandoned cleanup keeps running after its claim was released, and it will
    still try to release on its way out; by then the thread may belong to a
    later run, and releasing by id would hand that run's exclusivity away.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._claims: dict[str, object] = {}
        self._abandoned_cleanups: set[asyncio.Task] = set()

    async def claim(self, thread_id: str) -> object | None:
        """Return a token owning ``thread_id``, or ``None`` if it is taken."""
        async with self._lock:
            if thread_id in self._claims:
                return None
            token = object()
            self._claims[thread_id] = token
            return token

    async def release(self, thread_id: str, token: object) -> None:
        """Release ``thread_id`` only if ``token`` still owns it."""
        async with self._lock:
            if self._claims.get(thread_id) is token:
                del self._claims[thread_id]

    def abandon(
        self, thread_id: str, token: object, cleanup_task: asyncio.Task
    ) -> None:
        """Release an overrunning claim without awaiting anything.

        Deliberately synchronous. This runs on the path where the caller is
        often already being cancelled, and ``await lock.acquire()`` would raise
        there and skip the release, leaving the thread claimed for the life of
        the process. Reading and deleting one dict entry cannot interleave with
        ``claim``'s check-then-add, since neither awaits between them.

        The task is retained until it settles because the event loop holds only
        a weak reference to it, and a garbage-collected cleanup task would
        cancel the very work this path is trying to let finish.
        """
        if self._claims.get(thread_id) is token:
            del self._claims[thread_id]
        self._abandoned_cleanups.add(cleanup_task)
        cleanup_task.add_done_callback(self._abandoned_cleanups.discard)


def _cancellation_from_exception_chain(
    error: BaseException,
) -> asyncio.CancelledError | None:
    """Find a cancellation masked anywhere in an exception graph."""
    pending = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, asyncio.CancelledError):
            return current
        # LIFO keeps the implicit caller-unwind branch ahead of any explicit
        # cleanup-child cause while still visiting both branches.
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)
    return None


async def _drain_cleanup(
    cleanup: Callable[[], Awaitable[None]],
    *,
    cancellation_error_message: str,
    log_context: Mapping[str, Any],
    caller_cancellation: asyncio.CancelledError | None = None,
    observed_cleanup_error: BaseException | None = None,
    timeout: float | None = None,
    on_abandoned: Callable[[asyncio.Task], None] | None = None,
) -> None:
    """Shield cleanup to completion before propagating caller cancellation.

    ``timeout`` bounds that wait. Cleanup delegates to whatever the run was
    doing — a model call, a session write — and any of those can hang, so
    without a bound the wait is unbounded too and everything it gates stays
    gated forever. On expiry ``on_abandoned`` is handed the still-running task
    so its owner can release what it was holding, and the task is left to
    finish on its own rather than cancelled, because cancelling a half-written
    session is worse than a late one.
    """

    async def capture_cleanup_outcome() -> BaseException | None:
        try:
            await cleanup()
        except BaseException as exc:
            return exc
        return None

    cleanup_task = asyncio.create_task(capture_cleanup_outcome())
    pending_cancellation = caller_cancellation
    loop = asyncio.get_running_loop()
    # A single deadline rather than a per-iteration timeout: a caller that is
    # cancelled repeatedly re-enters this loop, and a fresh budget each time
    # would make the bound unbounded again.
    deadline = None if timeout is None else loop.time() + timeout

    while not cleanup_task.done():
        remaining = None if deadline is None else deadline - loop.time()
        if remaining is not None and remaining <= 0:
            break
        try:
            if remaining is None:
                await asyncio.shield(cleanup_task)
            else:
                await asyncio.wait_for(asyncio.shield(cleanup_task), remaining)
        except asyncio.TimeoutError:
            break
        except asyncio.CancelledError as exc:
            if pending_cancellation is None:
                pending_cancellation = exc

    if not cleanup_task.done():
        logger.error(
            "Cleanup did not finish within %ss; abandoning it and releasing "
            "what it was holding",
            timeout,
            extra=dict(log_context),
        )
        if on_abandoned is not None:
            on_abandoned(cleanup_task)
        if pending_cancellation is not None:
            if observed_cleanup_error is not None:
                logger.error(
                    cancellation_error_message,
                    exc_info=(
                        type(observed_cleanup_error),
                        observed_cleanup_error,
                        observed_cleanup_error.__traceback__,
                    ),
                    extra=dict(log_context),
                )
                raise pending_cancellation from observed_cleanup_error
            raise pending_cancellation
        if observed_cleanup_error is not None:
            raise observed_cleanup_error
        return

    cleanup_error = cleanup_task.result()

    if pending_cancellation is not None:
        cleanup_errors = [
            error
            for error in (observed_cleanup_error, cleanup_error)
            if error is not None
        ]
        if (
            len(cleanup_errors) == 2
            and cleanup_errors[0] is cleanup_errors[1]
        ):
            cleanup_errors.pop()
        for error in cleanup_errors:
            logger.error(
                cancellation_error_message,
                exc_info=(
                    type(error),
                    error,
                    error.__traceback__,
                ),
                extra=dict(log_context),
            )
        if cleanup_errors:
            raise pending_cancellation from cleanup_errors[-1]
        raise pending_cancellation
    if cleanup_error is not None:
        raise cleanup_error
    if observed_cleanup_error is not None:
        raise observed_cleanup_error


async def _close_run_stream_and_release(
    run_stream: Any,
    active_threads: _ActiveThreadRuns,
    thread_id: str,
    claim_token: object,
    *,
    caller_cancellation: asyncio.CancelledError | None = None,
    observed_cleanup_error: BaseException | None = None,
    cleanup_timeout: float | None = None,
) -> None:
    """Drain delegated cleanup before releasing a thread claim."""
    # Resolved here rather than as a default so the bound stays one module
    # global, readable and overridable in one place.
    timeout = (
        _RUN_CLEANUP_TIMEOUT_SECONDS if cleanup_timeout is None else cleanup_timeout
    )

    async def cleanup() -> None:
        try:
            await run_stream.aclose()
        finally:
            await active_threads.release(thread_id, claim_token)

    await _drain_cleanup(
        cleanup,
        cancellation_error_message=(
            "Run cleanup failed during caller cancellation"
        ),
        log_context={"thread_id": thread_id},
        caller_cancellation=caller_cancellation,
        observed_cleanup_error=observed_cleanup_error,
        timeout=timeout,
        on_abandoned=lambda task: active_threads.abandon(
            thread_id, claim_token, task
        ),
    )


class StrandsAgent:
    """AWS Strands Agent wrapper for AG-UI integration."""

    def __init__(
        self,
        agent: StrandsAgentCore,
        name: str,
        description: str = "",
        config: "StrandsAgentConfig | None" = None,
        hooks: "list | None" = None,
        agents_by_thread: "Dict[str, Any] | None" = None,
    ):
        # Store template agent configuration for creating fresh instances
        self._model = agent.model
        self._system_prompt = agent.system_prompt
        self._tools = (
            list(agent.tool_registry.registry.values())
            if hasattr(agent, "tool_registry")
            else []
        )
        self._agent_kwargs = _extract_agent_kwargs(agent)

        # Hook providers forwarded to each per-thread StrandsAgentCore.
        #
        # Why a dedicated kwarg instead of reading them off the template?
        # Strands initializes ``Agent.hooks`` as a ``HookRegistry`` containing
        # only the registered callbacks — the original list of HookProvider
        # objects is not retained, and the registry also contains callbacks
        # bound to internal Strands objects (conversation manager, retry
        # strategy) that belong to the template and must not be cross-wired
        # into per-thread agents. We therefore take providers directly from
        # the caller and forward them to every per-thread instance so any
        # observability / loop-cap / policy-enforcement hook actually fires.
        self._hooks = list(hooks) if hooks else []

        self.name = name
        self.description = description
        self.config = config or StrandsAgentConfig()

        # Auto-register StrandsInterruptHook when any tool has interrupt_on_call=True.
        # Prepend so it fires before any caller-supplied hooks.
        interrupt_tools = {
            name: b
            for name, b in self.config.tool_behaviors.items()
            if b.interrupt_on_call
        }
        if interrupt_tools:
            self._hooks = [StrandsInterruptHook(interrupt_tools), *self._hooks]

        # Detect the common footgun: session_manager set on the template Agent
        # (stored as `_session_manager` by Strands) with no per-thread provider.
        # Forwarding it would make every AG-UI thread share one session_id.
        template_session_manager = getattr(agent, "_session_manager", None)
        if (
            template_session_manager is not None
            and self.config.session_manager_provider is None
        ):
            logger.warning(
                "session_manager was set on the template Agent but will be ignored: "
                "forwarding it would cause every AG-UI thread to share the same "
                "session_id. Construct per-thread session managers via "
                "StrandsAgentConfig.session_manager_provider instead."
            )

        # Dictionary to store agent instances per thread
        self._agents_by_thread: Dict[str, StrandsAgentCore] = agents_by_thread if agents_by_thread is not None else {}
        # Track proxy tool names registered per thread
        self._proxy_tool_names_by_thread: Dict[str, set] = {}
        # AG-UI interrupt metadata per thread: the answer shape advertised to
        # the client and validated on the way back, the tool card an interrupt
        # belongs to, and an expiry. Never consulted to decide whether anything
        # is pending; the native interrupt state answers that on its own.
        self._pending_interrupts_by_thread: Dict[str, Dict[str, Interrupt]] = {}
        # Fingerprint of last successfully-processed resume per thread (idempotency)
        self._last_resume_fingerprint: Dict[str, str] = {}
        # Reject overlapping runs for the same thread before any adapter or
        # Strands state is touched. This registry is intentionally local to
        # this wrapper and does not claim cross-process coordination.
        self._active_threads = _ActiveThreadRuns()
        # Guards first-time thread initialization. The session_manager_provider
        # call introduces an async yield point between the "is this thread
        # new?" check and the dict assignment, so concurrent requests for the
        # same new thread_id could otherwise both create an agent and one
        # would clobber the other.
        self._thread_init_lock = asyncio.Lock()

    def _will_emit_tool_snapshot(self, behavior: Any, emit_snapshots: bool) -> bool:
        # ``emit_snapshots`` is the per-run gate (config flag AND not a
        # delta-only payload); callers pass it so snapshot emission stays
        # suppressed on delta payloads that would otherwise wipe prior turns.
        return emit_snapshots and not (
            behavior and behavior.skip_messages_snapshot
        )

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        """Run once for a thread, rejecting overlapping wrapper-local runs."""
        thread_id = input_data.thread_id or "default"
        claim_token = await self._active_threads.claim(thread_id)
        if claim_token is None:
            # A rejected contender is a protocol outcome, not a crash. Raising
            # here surfaces only after the transport has already answered 200
            # and opened the event stream, so the client sees the stream die
            # with nothing in it. Emit the same RUN_ERROR/THREAD_BUSY pair the
            # TypeScript bridge emits instead.
            ev_started, ev_error = _error_events(
                input_data,
                _THREAD_BUSY_MESSAGE_TEMPLATE.format(thread_id=thread_id),
                "THREAD_BUSY",
            )
            yield ev_started
            yield ev_error
            return
        run_stream = self._run_unlocked(input_data)
        caller_cancellation: asyncio.CancelledError | None = None
        observed_cleanup_error: BaseException | None = None
        try:
            async for event in run_stream:
                yield event
        except asyncio.CancelledError as exc:
            caller_cancellation = exc
            raise
        except BaseException as exc:
            caller_cancellation = _cancellation_from_exception_chain(exc)
            if caller_cancellation is not None:
                observed_cleanup_error = exc
            raise
        finally:
            await _close_run_stream_and_release(
                run_stream,
                self._active_threads,
                thread_id,
                claim_token,
                caller_cancellation=caller_cancellation,
                observed_cleanup_error=observed_cleanup_error,
            )

    async def _run_unlocked(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        """Run the Strands agent and yield AG-UI events."""

        # Get or create the agent instance for this request. Session-managed
        # cores are intentionally reconstructed from a fresh provider-created
        # manager on every request so the shared store, rather than a stale
        # wrapper-local core, remains authoritative across load-balanced runs.
        # Without a provider, state continues to live in the cached per-thread
        # core.
        thread_id = input_data.thread_id or "default"
        core_created_this_run = False
        managed_request = self.config.session_manager_provider is not None
        run_close_requested = False

        core_kwargs = dict(self._agent_kwargs)
        if self._hooks:
            core_kwargs["hooks"] = list(self._hooks)

        if managed_request:
            try:
                session_manager = await maybe_await(
                    self.config.session_manager_provider(input_data)
                )
            except Exception as e:
                logger.error(
                    f"session_manager_provider failed: {e}",
                    exc_info=True,
                )
                ev_started, ev_error = _error_events(
                    input_data,
                    f"Failed to initialize session manager: {e}",
                    "SESSION_MANAGER_ERROR",
                )
                yield ev_started
                yield ev_error
                return
            if session_manager is not None and not isinstance(
                session_manager, SessionManager
            ):
                actual = type(session_manager).__name__
                logger.error(
                    "session_manager_provider returned %s; expected a SessionManager instance.",
                    actual,
                )
                ev_started, ev_error = _error_events(
                    input_data,
                    f"session_manager_provider returned {actual}; expected a SessionManager instance",
                    "SESSION_MANAGER_INVALID_TYPE",
                )
                yield ev_started
                yield ev_error
                return

            cached_agent = self._agents_by_thread.get(thread_id)
            if (
                session_manager is not None
                and cached_agent is not None
                and _get_strands_session_manager(cached_agent) is None
            ):
                ev_started, ev_error = _error_events(
                    input_data,
                    "session_manager_provider returned a manager after this "
                    "thread was initialized without session persistence",
                    "SESSION_MANAGER_ERROR",
                )
                yield ev_started
                yield ev_error
                return
            if session_manager is None and cached_agent is not None:
                if _get_strands_session_manager(cached_agent) is not None:
                    ev_started, ev_error = _error_events(
                        input_data,
                        "session_manager_provider returned None after this thread was session-managed",
                        "SESSION_MANAGER_ERROR",
                    )
                    yield ev_started
                    yield ev_error
                    return
                logger.warning(
                    f"session_manager_provider returned None for thread_id={thread_id}; "
                    "reusing the existing in-memory agent"
                )
            else:
                if session_manager is None:
                    logger.warning(
                        f"session_manager_provider returned None for thread_id={thread_id}; "
                        "agent will run without session persistence"
                    )
                try:
                    fresh_agent = StrandsAgentCore(
                        model=self._model,
                        system_prompt=self._system_prompt,
                        tools=self._tools,
                        session_manager=session_manager,
                        **core_kwargs,
                    )
                except Exception as e:
                    logger.error(
                        "Failed to initialize session-managed Strands agent: %s",
                        e,
                        exc_info=True,
                    )
                    ev_started, ev_error = _error_events(
                        input_data,
                        f"Failed to initialize session manager: {e}",
                        "SESSION_MANAGER_ERROR",
                    )
                    yield ev_started
                    yield ev_error
                    return
                self._agents_by_thread[thread_id] = fresh_agent
                # These mirrors belong to the core that was just replaced.
                # Reload their durable counterparts below.
                self._pending_interrupts_by_thread.pop(thread_id, None)
                self._last_resume_fingerprint.pop(thread_id, None)
                self._proxy_tool_names_by_thread.pop(thread_id, None)
                core_created_this_run = True
        elif thread_id not in self._agents_by_thread:
            async with self._thread_init_lock:
                if thread_id not in self._agents_by_thread:
                    self._agents_by_thread[thread_id] = StrandsAgentCore(
                        model=self._model,
                        system_prompt=self._system_prompt,
                        tools=self._tools,
                        session_manager=None,
                        **core_kwargs,
                    )
                    core_created_this_run = True
        strands_agent = self._agents_by_thread[thread_id]

        # Consume the adapter-owned native frontend wait before any context,
        # registry, history, or Strands conversation mutation. Task 5 extends
        # this same-wrapper AgentState boundary across process restarts.
        frontend_wait_resume_prompt: list[dict[str, Any]] | None = None
        frontend_wait_batch_for_consumption: FrontendToolWaitBatch | None = None
        suppressed_checkpoint_result_ids: set[str] = set()
        combined_wait_resume_accepted = False
        accepted_frontend_wait_resume_fingerprint: str | None = None
        accepted_server_resume_fingerprint: str | None = None
        frontend_wait_server_responses: dict[str, Any] = {}
        try:
            agent_state = getattr(strands_agent, "state", None)
            frontend_wait_batch = load_frontend_tool_wait(agent_state)
            frontend_wait_server_responses = _load_staged_server_responses(
                agent_state
            )
        except (TypeError, ValueError) as exc:
            ev_started, _ = _error_events(
                input_data, str(exc), "INTERRUPT_RESUME_ERROR"
            )
            yield ev_started
            yield _interrupt_resume_error(str(exc))
            return

        native_interrupt_state = getattr(strands_agent, "_interrupt_state", None)
        native_interrupts = (
            getattr(native_interrupt_state, "interrupts", {})
            if getattr(native_interrupt_state, "activated", False)
            else {}
        )
        has_tagged_frontend_interrupt = any(
            getattr(interrupt, "name", None) == FRONTEND_TOOL_WAIT_INTERRUPT_NAME
            or (
                isinstance(getattr(interrupt, "reason", None), Mapping)
                and getattr(interrupt, "reason", {}).get("name")
                == FRONTEND_TOOL_WAIT_INTERRUPT_NAME
            )
            for interrupt in native_interrupts.values()
        )
        submitted_resume_entries = getattr(input_data, "resume", None)
        resume_field_submitted = isinstance(submitted_resume_entries, list)
        has_submitted_resume_entries = (
            resume_field_submitted and bool(submitted_resume_entries)
        )
        pending_wait_ag_ui = self._pending_interrupts_by_thread.get(thread_id)
        consumed_resume_fingerprint = self._last_resume_fingerprint.get(thread_id)
        persisted_pending, persisted_fingerprint = (
            _load_persisted_interrupt_bookkeeping(strands_agent)
        )
        if pending_wait_ag_ui is None and persisted_pending is not None:
            pending_wait_ag_ui = persisted_pending
            self._pending_interrupts_by_thread[thread_id] = persisted_pending
        if consumed_resume_fingerprint is None and persisted_fingerprint is not None:
            consumed_resume_fingerprint = persisted_fingerprint
            self._last_resume_fingerprint[thread_id] = persisted_fingerprint

        def cache_interrupt_bookkeeping(
            pending: Mapping[str, Interrupt] | None,
            fingerprint: str | None,
        ) -> None:
            if pending:
                self._pending_interrupts_by_thread[thread_id] = dict(pending)
            else:
                self._pending_interrupts_by_thread.pop(thread_id, None)
            if fingerprint is None:
                self._last_resume_fingerprint.pop(thread_id, None)
            else:
                self._last_resume_fingerprint[thread_id] = fingerprint

        exact_persisted_resume_replay = (
            has_submitted_resume_entries
            and consumed_resume_fingerprint is not None
            and all(
                isinstance(
                    interrupt_id := getattr(entry, "interrupt_id", None), str
                )
                and interrupt_id not in native_interrupts
                for entry in submitted_resume_entries
            )
            and consumed_resume_fingerprint
            == _resume_fingerprint(list(submitted_resume_entries))
        )
        recovered_consumed_resume_replay = False
        recovered_visible_interrupts: list[Interrupt] = []
        recovered_combined_fingerprint: str | None = None
        durable_frontend_wait_consumption = _frontend_wait_consumption_is_durable(
            strands_agent, frontend_wait_batch
        )
        if durable_frontend_wait_consumption:
            recovered_old_pending: Dict[str, Interrupt] | None = None
            if frontend_wait_server_responses:
                recovered_old_pending, _ = _load_persisted_interrupt_bookkeeping(
                    strands_agent
                )
                if (
                    recovered_old_pending is None
                    or set(recovered_old_pending)
                    != set(frontend_wait_server_responses)
                ):
                    ev_started, _ = _error_events(
                        input_data, "", "INTERRUPT_RESUME_ERROR"
                    )
                    yield ev_started
                    yield _interrupt_resume_error(
                        "Visible interrupt bookkeeping does not match the "
                        "consumed combined checkpoint"
                    )
                    return
                retry_entries = (
                    list(input_data.resume)
                    if isinstance(input_data.resume, list)
                    else []
                )
                if _staged_server_responses_match_retry(
                    retry_entries,
                    frontend_wait_server_responses,
                    recovered_old_pending,
                ):
                    recovered_combined_fingerprint = _resume_fingerprint(
                        retry_entries
                    )
            recovered_pending: Dict[str, Interrupt] | None = None
            recovered_replacement_batch: FrontendToolWaitBatch | None = None
            if native_interrupts:
                try:
                    (
                        recovered_replacement_batch,
                        recovered_visible_native,
                    ) = _recover_disjoint_checkpoint_after_consumed_wait(
                        strands_agent,
                        native_interrupts,
                        frontend_wait_batch,
                        list(input_data.messages or []),
                    )
                except ValueError as exc:
                    ev_started, _ = _error_events(
                        input_data, str(exc), "INTERRUPT_RESUME_ERROR"
                    )
                    yield ev_started
                    yield _interrupt_resume_error(str(exc))
                    return
                recovered_visible_interrupts = [
                    _strands_interrupt_to_agui(interrupt)
                    for interrupt in recovered_visible_native
                ]
                if recovered_visible_interrupts:
                    recovered_pending = {
                        interrupt.id: interrupt
                        for interrupt in recovered_visible_interrupts
                    }
            try:
                await _commit_recovered_frontend_wait(
                    strands_agent,
                    frontend_wait_batch,
                    recovered_pending,
                    recovered_combined_fingerprint,
                    replacement_batch=recovered_replacement_batch,
                )
            except Exception as exc:
                ev_started, ev_error = _error_events(
                    input_data, str(exc), "STRANDS_ERROR"
                )
                yield ev_started
                yield ev_error
                return
            frontend_wait_batch = (
                recovered_replacement_batch
                if recovered_replacement_batch is not None
                else frontend_wait_batch.mark_consumed()
            )
            frontend_wait_server_responses = {}
            cache_interrupt_bookkeeping(
                recovered_pending, recovered_combined_fingerprint
            )
            if recovered_combined_fingerprint is not None:
                recovered_consumed_resume_replay = True
            pending_wait_ag_ui = recovered_pending or {}
            consumed_resume_fingerprint = recovered_combined_fingerprint
        elif (
            not frontend_wait_batch.calls
            and has_tagged_frontend_interrupt
        ):
            recovery_requires_exact_resume = (
                consumed_resume_fingerprint is not None
                and (
                    bool(frontend_wait_batch.last_completed_wire_ids)
                    or bool(pending_wait_ag_ui)
                )
            )
            if (
                recovery_requires_exact_resume
                and not exact_persisted_resume_replay
            ):
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield _interrupt_resume_error(
                    "Recovering the superseding frontend wait requires the "
                    "exact consumed resume request"
                )
                return
            recovered_consumed_resume_replay = recovery_requires_exact_resume
            recovered_checkpoint_fingerprint = (
                consumed_resume_fingerprint
                if recovery_requires_exact_resume
                else None
            )
            try:
                (
                    recovered_replacement_batch,
                    recovered_visible_native,
                ) = _recover_disjoint_checkpoint_after_consumed_wait(
                    strands_agent,
                    native_interrupts,
                    frontend_wait_batch,
                    list(input_data.messages or []),
                )
            except ValueError as exc:
                ev_started, _ = _error_events(
                    input_data, str(exc), "INTERRUPT_RESUME_ERROR"
                )
                yield ev_started
                yield _interrupt_resume_error(str(exc))
                return
            if recovered_replacement_batch is None:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield _interrupt_resume_error(
                    "Active frontend wait checkpoint could not be reconstructed"
                )
                return
            recovered_visible_interrupts = [
                _strands_interrupt_to_agui(interrupt)
                for interrupt in recovered_visible_native
            ]
            recovered_pending = (
                {
                    interrupt.id: interrupt
                    for interrupt in recovered_visible_interrupts
                }
                if recovered_visible_interrupts
                else None
            )
            try:
                await _commit_recovered_frontend_wait(
                    strands_agent,
                    frontend_wait_batch,
                    recovered_pending,
                    recovered_checkpoint_fingerprint,
                    replacement_batch=recovered_replacement_batch,
                )
            except Exception as exc:
                ev_started, ev_error = _error_events(
                    input_data, str(exc), "STRANDS_ERROR"
                )
                yield ev_started
                yield ev_error
                return
            frontend_wait_batch = recovered_replacement_batch
            frontend_wait_server_responses = {}
            cache_interrupt_bookkeeping(
                recovered_pending, recovered_checkpoint_fingerprint
            )
            pending_wait_ag_ui = recovered_pending or {}
            consumed_resume_fingerprint = recovered_checkpoint_fingerprint
        elif (
            frontend_wait_batch.calls
            and frontend_wait_batch.is_complete
            and native_interrupt_state is not None
            and not getattr(native_interrupt_state, "activated", False)
        ):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield _interrupt_resume_error(
                "Cannot prove that the completed frontend tool wait was durably "
                "consumed: the native checkpoint is inactive but its exact "
                "tool results were not restored."
            )
            return
        if frontend_wait_batch.calls or has_tagged_frontend_interrupt:
            wait_metadata_error = _validate_frontend_wait_metadata(
                strands_agent, frontend_wait_batch
            )
            if wait_metadata_error is not None:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield wait_metadata_error
                return

        if (
            core_created_this_run
            and not frontend_wait_batch.calls
            and not has_tagged_frontend_interrupt
            and not getattr(native_interrupt_state, "activated", False)
            and _has_unrecoverable_frontend_wait_result(
                input_data,
                strands_agent,
                frontend_wait_batch,
                self.config.tool_behaviors,
            )
        ):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield _interrupt_resume_error(
                "Cannot recover frontend tool wait because its native interrupt "
                "checkpoint was not restored. Reuse the same wrapper or configure "
                "a compatible shared SessionManager with a stable agent_id."
            )
            return

        consumed_resume_replay = (
            (
                bool(
                    frontend_wait_batch.calls
                    or frontend_wait_batch.last_completed_wire_ids
                )
                and exact_persisted_resume_replay
            )
            or recovered_consumed_resume_replay
        )

        visible_wait_interrupt_ids: tuple[str, ...] = ()
        if frontend_wait_batch.calls:
            (
                visible_wait_interrupt_ids,
                visible_bookkeeping_error,
            ) = _validate_visible_wait_interrupt_bookkeeping(
                strands_agent,
                frontend_wait_batch,
                pending_wait_ag_ui,
            )
            if visible_bookkeeping_error is not None:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield visible_bookkeeping_error
                return
        resume_request = _classify_frontend_resume_request(
            list(input_data.messages or []),
            frontend_wait_batch,
            agent=strands_agent,
            resume_entries=(
                list(submitted_resume_entries)
                if has_submitted_resume_entries and not consumed_resume_replay
                else []
            ),
            staged_server_responses=frontend_wait_server_responses,
            pending_ag_ui=pending_wait_ag_ui,
        )
        # Tombstones are classification metadata, never a reason to rewrite
        # the canonical full history supplied by the client. A replay with no
        # trailing work remains an idempotent no-op.
        if (
            (resume_request.tombstone_replays or consumed_resume_replay)
            and not resume_request.actionable_trailing_messages
            and not frontend_wait_batch.calls
            and (not resume_field_submitted or consumed_resume_replay)
        ):
            active_visible_interrupts: list[Interrupt] = []
            if native_interrupts:
                (
                    active_visible_ids,
                    active_visible_error,
                ) = _validate_visible_wait_interrupt_bookkeeping(
                    strands_agent,
                    FrontendToolWaitBatch(),
                    pending_wait_ag_ui,
                )
                if active_visible_error is not None:
                    yield RunStartedEvent(
                        type=EventType.RUN_STARTED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    )
                    yield active_visible_error
                    return
                active_visible_interrupts = [
                    pending_wait_ag_ui[interrupt_id]
                    for interrupt_id in active_visible_ids
                ]
            try:
                await _sync_frontend_wait_state(strands_agent)
            except Exception as exc:
                ev_started, ev_error = _error_events(
                    input_data, str(exc), "STRANDS_ERROR"
                )
                yield ev_started
                yield ev_error
                return
            ev_started, ev_finished = _successful_noop_events(input_data)
            visible_interrupts = (
                active_visible_interrupts or recovered_visible_interrupts
            )
            if visible_interrupts:
                ev_finished = RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=RunFinishedInterruptOutcome(
                        type="interrupt",
                        interrupts=visible_interrupts,
                    ),
                )
            yield ev_started
            yield ev_finished
            return

        if frontend_wait_batch.calls:
            if resume_request.has_genuine_new_user:
                ev_started, ev_error = _error_events(
                    input_data,
                    "Thread has pending interrupts. Complete them before a new user turn.",
                    "PENDING_INTERRUPTS",
                )
                yield ev_started
                yield ev_error
                return

            staged_wait_batch = resume_request.frontend_batch_candidate
            staged_server = resume_request.server_responses_candidate

            if has_submitted_resume_entries:
                if resume_request.server_validation_error is not None:
                    yield RunStartedEvent(
                        type=EventType.RUN_STARTED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    )
                    yield resume_request.server_validation_error
                    return

            has_wait_response_work = (
                resume_request.recognized_frontend_response
                or has_submitted_resume_entries
            )
            if has_wait_response_work:
                wait_metadata_error = _validate_frontend_wait_metadata(
                    strands_agent, staged_wait_batch
                )
                if wait_metadata_error is not None:
                    yield RunStartedEvent(
                        type=EventType.RUN_STARTED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    )
                    yield wait_metadata_error
                    return

            if staged_wait_batch.is_complete:
                frontend_wait_resume_prompt, wait_resume_error = (
                    _build_frontend_wait_resume_prompt(
                        strands_agent,
                        staged_wait_batch,
                        staged_server,
                    )
                )
                if wait_resume_error is not None:
                    yield RunStartedEvent(
                        type=EventType.RUN_STARTED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    )
                    yield wait_resume_error
                    return
                if frontend_wait_resume_prompt is not None:
                    frontend_wait_batch_for_consumption = staged_wait_batch
                    accepted_frontend_wait_resume_fingerprint = (
                        _resume_fingerprint(list(submitted_resume_entries))
                        if has_submitted_resume_entries
                        else None
                    )
                    if staged_wait_batch.stop_streaming_after_result:
                        interrupt_context = getattr(
                            getattr(strands_agent, "_interrupt_state", None),
                            "context",
                            None,
                        )
                        checkpoint_results = (
                            interrupt_context.get("tool_results", [])
                            if isinstance(interrupt_context, Mapping)
                            else []
                        )
                        suppressed_checkpoint_result_ids = {
                            result_id
                            for result in checkpoint_results
                            if isinstance(result, Mapping)
                            and isinstance(
                                result_id := result.get("toolUseId"), str
                            )
                        }

            # Commit both candidate channels only after every request-level
            # validation has succeeded. A corrected retry can therefore
            # replace content from a previously rejected request.
            wait_state_changed = staged_wait_batch != frontend_wait_batch
            server_state_changed = staged_server != frontend_wait_server_responses
            try:
                if wait_state_changed:
                    strands_agent.state.set(
                        FRONTEND_TOOL_WAIT_STATE_KEY, staged_wait_batch.to_dict()
                    )
                if server_state_changed:
                    strands_agent.state.set(
                        _FRONTEND_TOOL_SERVER_RESPONSES_STATE_KEY,
                        staged_server,
                    )
                if frontend_wait_resume_prompt is not None:
                    cache_interrupt_bookkeeping(
                        pending_wait_ag_ui,
                        accepted_frontend_wait_resume_fingerprint,
                    )
                    await _persist_interrupt_bookkeeping(
                        strands_agent,
                        pending_wait_ag_ui,
                        accepted_frontend_wait_resume_fingerprint,
                        strict=True,
                    )
                # Reflush recognized first-wins retries even when AgentState
                # already contains the equal candidate from a prior failed
                # sync. Equality proves no semantic change, not durability.
                if (
                    has_wait_response_work
                    and frontend_wait_resume_prompt is None
                ):
                    await _sync_frontend_wait_state(strands_agent)
            except Exception as exc:
                ev_started, ev_error = _error_events(
                    input_data, str(exc), "STRANDS_ERROR"
                )
                yield ev_started
                yield ev_error
                return
            frontend_wait_server_responses = staged_server

            if frontend_wait_resume_prompt is None:
                # An incomplete native wait remains a barrier even when a
                # reconnect carries no new ToolMessage. Re-expose only Ends
                # whose handoff is not durable, preserving the original
                # custom-End -> backend-result -> standard-End ordering,
                # without invoking Strands or executing a backend tool.
                # A previous End handoff may have updated AgentState before
                # its SessionManager sync failed. Re-flush that in-memory
                # transition before a no-response retry can report success;
                # otherwise a later wrapper restores the older checkpoint and
                # replays an End that this wrapper already handed off.
                if not has_wait_response_work:
                    try:
                        await _sync_frontend_wait_state(strands_agent)
                    except Exception as exc:
                        ev_started, ev_error = _error_events(
                            input_data, str(exc), "STRANDS_ERROR"
                        )
                        yield ev_started
                        yield ev_error
                        return
                ev_started, ev_finished = _successful_noop_events(input_data)
                unresolved_visible_interrupts = [
                    pending_wait_ag_ui[interrupt_id]
                    for interrupt_id in visible_wait_interrupt_ids
                    if interrupt_id not in staged_server
                ]
                if unresolved_visible_interrupts:
                    ev_finished = RunFinishedEvent(
                        type=EventType.RUN_FINISHED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                        outcome=RunFinishedInterruptOutcome(
                            type="interrupt",
                            interrupts=unresolved_visible_interrupts,
                        ),
                    )
                yield ev_started
                declared_tool_names = {
                    name
                    for tool in input_data.tools or []
                    if isinstance(
                        name := (
                            tool.get("name")
                            if isinstance(tool, Mapping)
                            else getattr(tool, "name", None)
                        ),
                        str,
                    )
                    and name
                }
                try:
                    custom_calls, standard_calls = (
                        _frontend_wait_calls_by_end_phase(
                            strands_agent,
                            staged_wait_batch,
                            self.config.tool_behaviors,
                            declared_tool_names,
                        )
                    )
                except ValueError as exc:
                    yield _interrupt_resume_error(str(exc))
                    return
                for call in custom_calls:
                    try:
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=call.wire_tool_call_id,
                        )
                    finally:
                        staged_wait_batch = await _mark_frontend_wait_end_handed_off(
                            strands_agent,
                            staged_wait_batch,
                            call.wire_tool_call_id,
                        )

                raw_tool_meta = strands_agent.state.get(
                    AG_UI_TOOL_CALL_MAP_STATE_KEY
                )
                replay_tool_meta = (
                    raw_tool_meta if isinstance(raw_tool_meta, dict) else {}
                )
                replay_delivery = _CheckpointResultDelivery()
                session_messages = getattr(strands_agent, "messages", None) or []
                replay_snapshots = self.config.emit_messages_snapshot and not (
                    session_messages
                    and len(session_messages) > len(input_data.messages or [])
                )
                replay_snapshot_messages = (
                    _build_snapshot_messages(input_data.messages)
                    if replay_snapshots
                    else []
                )
                async for checkpoint_event in _checkpoint_result_events(
                    agent=strands_agent,
                    batch=staged_wait_batch,
                    persisted_tool_call_meta=replay_tool_meta,
                    emitted_backend_result_ids=set(),
                    input_data=input_data,
                    config=self.config,
                    emit_snapshots=replay_snapshots,
                    snapshot_messages=replay_snapshot_messages,
                    current_state=dict(input_data.state or {}),
                    message_id=str(uuid.uuid4()),
                    delivery=replay_delivery,
                ):
                    yield checkpoint_event
                if replay_delivery.stop_streaming_after_result:
                    staged_wait_batch = (
                        staged_wait_batch.mark_stop_streaming_after_result()
                    )
                    strands_agent.state.set(
                        FRONTEND_TOOL_WAIT_STATE_KEY,
                        staged_wait_batch.to_dict(),
                    )
                if (
                    replay_delivery.metadata_changed
                    or replay_delivery.stop_streaming_after_result
                ):
                    strands_agent.state.set(
                        AG_UI_TOOL_CALL_MAP_STATE_KEY,
                        replay_tool_meta,
                    )
                    await _sync_frontend_wait_state(strands_agent)

                for call in standard_calls:
                    try:
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=call.wire_tool_call_id,
                        )
                    finally:
                        staged_wait_batch = await _mark_frontend_wait_end_handed_off(
                            strands_agent,
                            staged_wait_batch,
                            call.wire_tool_call_id,
                        )
                yield ev_finished
                return

        # A submitted resume must be validated before any adapter mutation
        # (context writes, proxy synchronization, history reconciliation, or
        # metadata pruning). Strands otherwise applies entries one at a time,
        # which lets a later invalid id partially consume the checkpoint.
        resume_entries = getattr(input_data, "resume", None)
        # ``RunAgentInput.resume`` is a list when the field was submitted.
        # Some legacy callers pass mock-like inputs whose undeclared
        # attributes auto-materialize; do not mistake those for a resume.
        resume_submitted = (
            isinstance(resume_entries, list)
            or frontend_wait_resume_prompt is not None
        )
        interrupt_state = getattr(strands_agent, "_interrupt_state", None)
        pending_resume_interrupts = self._pending_interrupts_by_thread.get(thread_id)
        resume_fingerprint = self._last_resume_fingerprint.get(thread_id)
        if frontend_wait_resume_prompt is None and resume_submitted and (
            pending_resume_interrupts is None or resume_fingerprint is None
        ):
            persisted_pending, persisted_fingerprint = (
                _load_persisted_interrupt_bookkeeping(strands_agent)
            )
            if pending_resume_interrupts is None:
                pending_resume_interrupts = persisted_pending
            if resume_fingerprint is None:
                resume_fingerprint = persisted_fingerprint
        if frontend_wait_resume_prompt is None and resume_submitted and (
            not resume_entries
            or (
                interrupt_state is not None
                and getattr(interrupt_state, "activated", False)
            )
        ):
            resume_error = _preflight_resume_entries(
                strands_agent,
                resume_entries,
                pending_resume_interrupts,
            )
            if resume_error is not None:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield resume_error
                return
            if resume_entries:
                accepted_server_resume_fingerprint = _resume_fingerprint(
                    list(resume_entries)
                )

        # Rule 4: reject new input against a parked checkpoint before context
        # or tool registries can be updated by a run that will not proceed. The
        # SDK owns the checkpoint, so a checkpoint it still holds active blocks
        # the turn and is left exactly as it stands: deactivating it here would
        # discard the tool use and tool results parked behind it.
        if (
            not resume_submitted
            and getattr(interrupt_state, "activated", False) is True
        ):
            ev_started, ev_error = _error_events(
                input_data,
                "Thread has pending interrupts. Include resume[] to address them.",
                "PENDING_INTERRUPTS",
            )
            yield ev_started
            yield ev_error
            return

        # An inactive checkpoint may be an idempotent replay of a resume that
        # already completed. Resolve that before any per-run mutable setup.
        if frontend_wait_resume_prompt is None and resume_submitted and resume_entries and not getattr(
            interrupt_state, "activated", False
        ):
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            fingerprint = _resume_fingerprint(resume_entries)
            if resume_fingerprint == fingerprint:
                if (
                    frontend_wait_batch.last_completed_wire_ids
                    and resume_request.actionable_trailing_messages
                ):
                    yield _interrupt_resume_error(
                        "A completed interrupt replay cannot be combined "
                        "with new messages"
                    )
                else:
                    yield RunFinishedEvent(
                        type=EventType.RUN_FINISHED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                        outcome=RunFinishedSuccessOutcome(type="success"),
                    )
            else:
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message="No pending interrupt for this thread.",
                    code="UNKNOWN_INTERRUPT_ID",
                )
            return

        session_manager = _get_strands_session_manager(strands_agent)
        has_active_interrupt = bool(
            getattr(
                getattr(strands_agent, "_interrupt_state", None),
                "activated",
                False,
            )
        )
        active_proxy_native_ids = active_proxy_placeholder_ids(strands_agent)
        if active_proxy_native_ids and not frontend_wait_batch.calls:
            if session_manager is None:
                session_error = _interrupt_session_required_error()
            elif not _supports_repository_reconciliation(
                session_manager, strands_agent
            ):
                session_error = _interrupt_session_capability_error()
            else:
                session_error = None
            if session_error is not None:
                yield RunStartedEvent(
                    type=EventType.RUN_STARTED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield session_error
                return

        # Forward ``RunAgentInput.context`` to the per-thread Strands agent's
        # state so user tools can read it (e.g. catalog/component schemas
        # injected by the CopilotKit FE for A2UI rendering). Mirrors the
        # langgraph integration where tools read ``runtime.state["copilotkit"]
        # ["context"]``. Stored as a plain list of ``{description, value}``
        # dicts to satisfy ``JSONSerializableDict`` validation.
        agui_context = []
        for ctx in (input_data.context or []):
            if isinstance(ctx, dict):
                agui_context.append(
                    {
                        "description": ctx.get("description", ""),
                        "value": ctx.get("value", ""),
                    }
                )
            else:
                agui_context.append(
                    {
                        "description": getattr(ctx, "description", "") or "",
                        "value": getattr(ctx, "value", "") or "",
                    }
                )
        try:
            strands_agent.state.set("agui_context", agui_context)
        except Exception as e:
            logger.warning(f"Failed to set agui_context on strands_agent.state: {e}")

        # Sync proxy tools from client-defined tools
        if input_data.tools:
            proxy_names = sync_proxy_tools(
                strands_agent.tool_registry,
                input_data.tools,
                self._proxy_tool_names_by_thread.get(thread_id, set()),
                tool_behaviors=self.config.tool_behaviors,
            )
            self._proxy_tool_names_by_thread[thread_id] = proxy_names
        elif self._proxy_tool_names_by_thread.get(thread_id):
            # Remove all stale proxy tools when no tools are sent
            sync_proxy_tools(
                strands_agent.tool_registry,
                [],
                self._proxy_tool_names_by_thread[thread_id],
                tool_behaviors=self.config.tool_behaviors,
            )
            self._proxy_tool_names_by_thread[thread_id] = set()

        # A2UI auto-injection. When the runtime forwards
        # ``injectA2UITool`` (or the host opts in via ``config.a2ui``), register
        # a ``generate_a2ui`` recovery tool bound to this agent's model and drop
        # the injected ``render_a2ui`` proxy so the model calls generate_a2ui
        # directly. Best-effort: a failure here logs and runs without A2UI
        # rather than crashing the turn.
        try:
            registry = strands_agent.tool_registry
            # Remove our OWN prior-turn auto-injected tool first, so (a) the
            # refreshed tool carries THIS turn's messages/state, and (b) the
            # USER-PREVAILS check only ever sees a dev-wired
            # generate_a2ui — not our own from a previous turn on this cached
            # agent. Without this, turn 2+ leaks the re-synced render_a2ui back
            # to the model.
            for name in [
                n for n, t in list(registry.registry.items())
                if is_auto_injected_a2ui_tool(t)
            ]:
                registry.registry.pop(name, None)
                getattr(registry, "dynamic_tools", {}).pop(name, None)
            # Lift the A2UI component schema + remaining context under
            # state["ag-ui"] so the generate_a2ui sub-agent prompt carries the
            # "## Available Components" block + context — same routing the
            # LangGraph adapter does in its state merge. Uses the shared toolkit
            # split so both adapters agree on the schema-context description.
            a2ui_schema_value, a2ui_regular_ctx = split_a2ui_schema_context(
                input_data.context
            )
            a2ui_state = (
                dict(input_data.state)
                if isinstance(input_data.state, dict)
                else {}
            )
            a2ui_ag_ui: dict = {"context": a2ui_regular_ctx}
            if a2ui_schema_value is not None:
                a2ui_ag_ui["a2ui_schema"] = a2ui_schema_value
            a2ui_state["ag-ui"] = a2ui_ag_ui

            a2ui_plan = plan_a2ui_injection(
                model=getattr(strands_agent, "model", None),
                input=input_data,
                existing_tool_names=list(registry.registry.keys()),
                config=self.config.a2ui,
                log=logger,
                strands_agent=strands_agent,
                agui_state=a2ui_state,
            )
            if a2ui_plan:
                # Register FIRST: if this raises, the except below degrades to
                # "render proxy leaks through" (middleware still paints,
                # unvalidated) instead of a turn with no A2UI path at all.
                registry.register_tool(a2ui_plan["tool"])
                for name in a2ui_plan["drop_tool_names"]:
                    registry.registry.pop(name, None)
                    getattr(registry, "dynamic_tools", {}).pop(name, None)
                    # Keep the proxy bookkeeping honest — the dropped render
                    # tool is no longer registered.
                    self._proxy_tool_names_by_thread.get(thread_id, set()).discard(name)
        except Exception as e:  # noqa: BLE001 — never crash the turn here
            # ERROR, not warning: the runtime explicitly requested injection
            # (injectA2UITool) and this turn runs without it.
            logger.error(
                "A2UI auto-injection failed; running without A2UI for this turn: %s",
                e,
                exc_info=True,
            )

        # ── Interrupt resume handling ──────────────────────────────────────
        # If the client is resuming an interrupted run, validate the
        # interrupt_id against the Strands _interrupt_state, build
        # interruptResponse dicts, and pass them to stream_async() so Strands
        # resumes from its checkpoint.  Cancelled resumes end the run cleanly.
        _resume_prompt: list | None = None
        _resumed_tool_call_ids: set = set()
        resume_entries: list[ResumeEntry] = list(resume_entries or [])

        if frontend_wait_resume_prompt is not None:
            # This complete prompt was built from both authoritative sources
            # and revalidated against the live native interrupt checkpoint.
            _resume_prompt = frontend_wait_resume_prompt
        elif resume_entries:
            interrupt_state = getattr(strands_agent, "_interrupt_state", None)
            pending_ag_ui = pending_resume_interrupts or {}
            interrupt_responses: list[dict] = []

            for entry in resume_entries:
                ag_ui_interrupt = pending_ag_ui.get(entry.interrupt_id)
                native_interrupt = interrupt_state.interrupts.get(entry.interrupt_id)

                if entry.status in ("cancelled", "resolved"):
                    # A cancelled entry still carries a response, so Strands
                    # marks the interrupt answered and stops re-raising it.
                    interrupt_responses.append({
                        "interruptResponse": {
                            "interruptId": entry.interrupt_id,
                            "response": _native_resume_response(
                                entry, native_interrupt
                            ),
                        }
                    })
                    # Track tool_call_ids so the tool card is not re-emitted.
                    if ag_ui_interrupt and getattr(ag_ui_interrupt, "tool_call_id", None):
                        _resumed_tool_call_ids.add(ag_ui_interrupt.tool_call_id)

            # Note: even when ALL entries are cancelled, we still forward the
            # denial responses to Strands via stream_async() below rather than
            # short-circuiting here. This ensures native interrupt-state
            # cleanup, hooks, snapshots, and session persistence all run
            # through Strands' normal completion path instead of being
            # bypassed by a synthetic RUN_FINISHED.

            # Pass interruptResponse dicts as the prompt — Strands resumes from
            # its checkpoint without replaying the full conversation.
            logger.debug(
                f"Resuming interrupted run: thread_id={input_data.thread_id}, interrupt_responses={interrupt_responses}"
            )
            _resume_prompt: list | None = interrupt_responses
            # Bookkeeping is cleared only after successful processing below so
            # reconciliation failures leave the checkpoint retryable.

        # ── Start run ─────────────────────────────────────────────────────
        # Start run
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

        try:
            # Detect delta-only payloads (where the client sent fewer
            # messages than the session has — e.g. only the trailing
            # tool result, or only the new user message in a continued
            # chat). CopilotKit V2's MESSAGES_SNAPSHOT handler treats
            # the snapshot as authoritative: any existing client message
            # whose id is not in the snapshot gets dropped. Emitting a
            # partial snapshot on a delta payload would wipe prior turns
            # from the UI. The frontend already has the full history with
            # the original ids, so we suppress snapshot emission for this
            # run and let TEXT_MESSAGE_*/TOOL_CALL_* streaming events
            # reconcile naturally.
            session_msgs = getattr(strands_agent, "messages", None) or []
            is_delta_payload = (
                bool(session_msgs)
                and len(session_msgs) > len(input_data.messages or [])
            )
            emit_snapshots = (
                self.config.emit_messages_snapshot and not is_delta_payload
            )

            # Seed the running ``MessagesSnapshotEvent`` payload from the
            # full conversation history sent by the client. Each emitted
            # snapshot then carries prior turns + whatever this turn adds.
            snapshot_messages: List[Any] = (
                _build_snapshot_messages(input_data.messages)
                if emit_snapshots
                else []
            )

            # Emit state snapshot if provided
            if hasattr(input_data, "state") and input_data.state is not None:
                # Filter out messages from state to avoid "Unknown message role" errors
                # The frontend manages messages separately and doesn't recognize "tool" role
                state_snapshot = {
                    k: v for k, v in input_data.state.items() if k != "messages"
                }
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT, snapshot=state_snapshot
                )

            # Splice point 1 of 4: emit the initial messages snapshot right
            # after ``RunStartedEvent`` / ``StateSnapshotEvent`` so the
            # frontend can render the seeded thread before any new content
            # streams in.
            if emit_snapshots and snapshot_messages:
                yield MessagesSnapshotEvent(
                    type=EventType.MESSAGES_SNAPSHOT,
                    messages=list(snapshot_messages),
                )

            # Extract frontend tool names from input_data.tools
            frontend_tool_names = set()
            if input_data.tools:
                for tool_def in input_data.tools:
                    tool_name = (
                        tool_def.get("name")
                        if isinstance(tool_def, dict)
                        else getattr(tool_def, "name", None)
                    )
                    if tool_name:
                        frontend_tool_names.add(tool_name)

            # Collect tool_call_ids that already have results in the message history
            # so we suppress duplicate TOOL_CALL_START events only for those specific calls
            pending_tool_result_ids: set[str] = set()
            if input_data.messages:
                for msg in reversed(input_data.messages):
                    if msg.role == "tool":
                        tool_call_id = getattr(msg, "tool_call_id", None)
                        if tool_call_id:
                            pending_tool_result_ids.add(tool_call_id)
                    else:
                        break
                if pending_tool_result_ids:
                    logger.debug(
                        f"Has pending tool results detected: tool_call_ids={pending_tool_result_ids}, thread_id={input_data.thread_id}"
                    )

            # Rule 8: suppress ToolCallStart/Args/End for resumed tool-bound
            # interrupts — only ToolCallResult should be emitted on resume.
            if _resumed_tool_call_ids:
                pending_tool_result_ids.update(_resumed_tool_call_ids)

            # Convert AG-UI messages to Strands format
            # Strands expects content as List[ContentBlock] for most messages
            # OpenAI requires tool messages to follow assistant messages with tool_calls
            strands_messages = []
            last_msg_had_tool_calls = False
            expected_tool_call_ids = set()  # Track which tool_call_ids are valid

            logger.debug(
                f"Converting {len(input_data.messages)} messages to Strands format, thread_id={input_data.thread_id}"
            )

            for i, msg in enumerate(input_data.messages):
                logger.debug(
                    f"Message {i}: role={msg.role}, has_tool_calls={hasattr(msg, 'tool_calls') and bool(msg.tool_calls)}, tool_call_id={getattr(msg, 'tool_call_id', None)}"
                )
                strands_msg: Dict[str, Any] = {"role": msg.role}

                # Handle assistant messages with tool_calls
                if (
                    msg.role == "assistant"
                    and hasattr(msg, "tool_calls")
                    and msg.tool_calls
                ):
                    # Convert tool calls to format expected by Strands/OpenAI
                    strands_msg["content"] = []
                    if msg.content:
                        if isinstance(msg.content, str):
                            strands_msg["content"].append({"text": msg.content})
                        elif isinstance(msg.content, list):
                            strands_msg["content"] = msg.content

                    strands_msg["tool_calls"] = []
                    expected_tool_call_ids.clear()  # Reset for this assistant message
                    for tc in msg.tool_calls:
                        expected_tool_call_ids.add(tc.id)  # Track this tool call ID
                        strands_msg["tool_calls"].append(
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.function.get("name")
                                    if isinstance(tc.function, dict)
                                    else tc.function.name,
                                    "arguments": tc.function.get("arguments")
                                    if isinstance(tc.function, dict)
                                    else tc.function.arguments,
                                },
                            }
                        )
                    last_msg_had_tool_calls = True
                    strands_messages.append(strands_msg)

                # Handle tool messages (must follow assistant message with tool_calls)
                elif msg.role == "tool":
                    # Skip tool messages that don't have a preceding assistant message
                    # with tool_calls — UNLESS this is a pending frontend tool result
                    # (delta-only payloads only contain the tool result, so the
                    # assistant message is absent but the result is still valid).
                    is_pending_frontend_result = (
                        msg.tool_call_id in pending_tool_result_ids
                    )
                    if (
                        not last_msg_had_tool_calls
                        or msg.tool_call_id not in expected_tool_call_ids
                    ) and not is_pending_frontend_result:
                        logger.debug(
                            f"Skipping orphaned tool message: tool_call_id={msg.tool_call_id}, last_msg_had_tool_calls={last_msg_had_tool_calls}, valid_ids={expected_tool_call_ids}, thread_id={input_data.thread_id}"
                        )
                        continue

                    # Include the tool message for OpenAI format compliance
                    strands_msg["tool_call_id"] = msg.tool_call_id
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    else:
                        strands_msg["content"] = msg.content

                    expected_tool_call_ids.discard(msg.tool_call_id)
                    if not expected_tool_call_ids:
                        last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

                # Handle regular messages (user, assistant without tool_calls)
                else:
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    elif isinstance(msg.content, list):
                        strands_msg["content"] = msg.content
                    else:
                        strands_msg["content"] = [{"text": ""}]
                    last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

            # Build a lookup of tool_call_id -> tool_name from the input messages
            # directly (the assistant message in Run 2 already carries the name).
            _tool_call_id_to_name: dict = {}
            for _msg in (input_data.messages or []):
                if _msg.role == "assistant" and hasattr(_msg, "tool_calls") and _msg.tool_calls:
                    for tc in _msg.tool_calls:
                        tc_name = tc.function.get("name") if isinstance(tc.function, dict) else tc.function.name
                        if tc.id and tc_name:
                            _tool_call_id_to_name[tc.id] = tc_name

            # On delta-only continuation payloads, the assistant message that
            # carries the tool_call is absent from input_data.messages, so the
            # lookup above misses. The session manager still holds the full
            # native history — scan its ``toolUse`` blocks so we resolve the
            # tool that actually executed rather than guessing.
            for _smsg in session_msgs:
                if not isinstance(_smsg, dict) or _smsg.get("role") != "assistant":
                    continue
                for _block in (_smsg.get("content") or []):
                    tool_use = _block.get("toolUse") if isinstance(_block, dict) else None
                    if tool_use:
                        tu_id = tool_use.get("toolUseId")
                        tu_name = tool_use.get("name")
                        if tu_id and tu_name and tu_id not in _tool_call_id_to_name:
                            _tool_call_id_to_name[tu_id] = tu_name

            # Get the latest user message for state context builder.
            # For continuation runs (has_pending_tool_result), derive a meaningful
            # message from the frontend tool that was just executed so the agent
            # understands the context and can generate a proper conclusion.
            # Skip derivation on the interrupt resume path — _resume_prompt is used instead.
            user_message: Any = ""
            if _resume_prompt is not None:
                # Resume path: pass interruptResponse dicts directly to Strands.
                user_message = _resume_prompt
            elif pending_tool_result_ids and input_data.messages:
                # Collect ALL trailing tool results (not just the first). A parallel
                # frontend-tool turn sends N results in one continuation run; the model
                # must see every answer.
                _result_parts: list[str] = []
                for msg in reversed(input_data.messages):
                    if msg.role == "tool" and hasattr(msg, "tool_call_id"):
                        tool_name = _tool_call_id_to_name.get(msg.tool_call_id)
                        if tool_name and tool_name in frontend_tool_names:
                            # Forward the ACTUAL result so the model can act on the
                            # human's decision (e.g. an approval resolving to
                            # {"approved": false}). Hardcoding a success string here
                            # silently breaks HITL — the model would be told the tool
                            # "executed successfully with no return value" regardless
                            # of what the human returned. Only use that synthetic
                            # acknowledgement when the result is genuinely empty.
                            result_text = (
                                msg.content
                                if isinstance(msg.content, str)
                                else flatten_content_to_text(msg.content)
                            )
                            if result_text and result_text.strip():
                                _result_parts.append(f"{tool_name} returned: {result_text}")
                            else:
                                _result_parts.append(
                                    f"{tool_name} executed successfully with no return value."
                                )
                        else:
                            # Could not resolve this tool's name from input messages
                            # or session history (e.g. a delta-only payload with no
                            # assistant tool_calls). Skip it rather than guessing:
                            # picking an arbitrary frontend tool would feed false
                            # context to the LLM when several frontend tools exist.
                            # Strands still has the real result in session history to
                            # conclude the round-trip from.
                            logger.warning(
                                f"Could not resolve tool name for tool_call_id={msg.tool_call_id} "
                                f"from input messages or session history (delta-only payload). "
                                f"Skipping this tool result in the continuation message."
                            )
                    else:
                        break
                user_message = "\n".join(reversed(_result_parts))
            elif input_data.messages:
                for msg in reversed(input_data.messages):
                    if (msg.role == "user" or msg.role == "tool") and msg.content:
                        if isinstance(msg.content, list):
                            has_media = any(
                                getattr(item, "type", None) in ("image", "audio", "video", "document")
                                for item in msg.content
                            )
                            if has_media:
                                user_message = convert_agui_content_to_strands(msg.content)
                                if not user_message:
                                    # All content blocks failed conversion — fall back to text
                                    user_message = flatten_content_to_text(msg.content) or ""
                                    logger.warning("All media content blocks failed conversion, falling back to text")
                            else:
                                user_message = flatten_content_to_text(msg.content)
                        else:
                            user_message = msg.content
                        break

            # Optionally allow configuration to adjust the outgoing user message
            if self.config.state_context_builder:
                try:
                    text_for_builder = flatten_content_to_text(user_message) if isinstance(user_message, list) else user_message
                    builder_result = self.config.state_context_builder(
                        input_data, text_for_builder
                    )
                    if not isinstance(user_message, list):
                        user_message = builder_result
                    else:
                        logger.debug("state_context_builder result not applied to multimodal message — multimodal content preserved")
                    # If state_context_builder modifies the message, update the last user message
                    if not isinstance(user_message, list) and strands_messages and strands_messages[-1]["role"] == "user":
                        strands_messages[-1]["content"] = [{"text": user_message}]
                except Exception as e:
                    # If the builder fails, keep the original message
                    logger.warning(f"State context builder failed: {e}", exc_info=True)

            # Generate unique message ID
            message_id = str(uuid.uuid4())
            message_started = False
            accumulated_text = ""
            # Tracks the latest assistant text id that was actually emitted on
            # the wire. Tool calls use it only when no snapshot will expose the
            # tool-call AssistantMessage id.
            last_emitted_text_message_id: str | None = None
            tool_calls_seen = {}
            current_state = dict(input_data.state or {})  # Track state for final snapshot
            stop_text_streaming = False
            halt_event_stream = False
            # Waiting frontend-tool ToolCallEnd ids are buffered until their
            # native checkpoint is durable. Standard streaming calls retain
            # backend-result-before-End ordering; custom args streamers retain
            # their established End-before-backend-result ordering.
            deferred_frontend_tool_ends: list[str] = []
            deferred_custom_frontend_tool_ends: list[str] = []
            # Native ``toolUseId``s whose ``toolResult`` was processed this
            # run. Drained after each result batch to prune the persisted
            # tool-call meta map.
            processed_result_native_ids: set[str] = set()
            emitted_backend_result_ids: set[str] = set()
            # Terminal ``AgentResult`` from Strands (carried on the final
            # ``{"result": ...}`` stream event). Used after the loop to detect a
            # native interrupt pause (``stop_reason == "interrupt"``).
            terminal_result = None
            # ``force_stop`` is an abnormal terminal signal. Keep consuming the
            # stream so Strands can unwind and raise its underlying exception,
            # then translate the failure into AG-UI's terminal error event.
            force_stop_error: str | None = None
            pending_interrupt_outcome: RunFinishedInterruptOutcome | None = None

            # Reasoning/thinking state tracking
            reasoning_started = False
            reasoning_message_id = None

            logger.debug(
                f"Starting agent run: thread_id={input_data.thread_id}, run_id={input_data.run_id}, pending_tool_result_ids={pending_tool_result_ids}, message_count={len(input_data.messages)}, strands_message_count={len(strands_messages)}"
            )

            # Collect the real results the client produced for proxied
            # frontend tools. These arrive in ``RunAgentInput.messages`` on the
            # continuation run and are used to reconcile the session-persisted
            # "Forwarded to client" placeholder. A tool result is a frontend
            # result when its tool name is client-declared, or (for delta-only
            # payloads that omit the assistant message) when its wire id was
            # recorded in the wire->native map when the call was emitted.
            # The durable wire->native map recorded at emission, read back from
            # session state (restored from the store on a fresh process).
            wire_to_native: Dict[str, str] = {}
            reconciliation_setup_error: Exception | None = None
            if session_manager is not None:
                try:
                    wire_to_native = (
                        strands_agent.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
                    )
                except Exception as e:  # noqa: BLE001 - handled below by checkpoint state
                    reconciliation_setup_error = e

            # The durable per-``toolUseId`` call metadata map recorded at
            # emission (see the ``current_tool_use`` handler). On a RESUME
            # run this is the ONLY source of ``{name, args, input,
            # strands_tool_id}`` for the interrupted tool, since Strands does
            # not re-emit ``current_tool_use`` events for it. Guarded because
            # test doubles / stub agents may lack ``state`` entirely; a
            # missing store just means "no persisted meta yet".
            persisted_tool_call_meta: Dict[str, Dict[str, Any]] = {}
            _agent_state = getattr(strands_agent, "state", None)
            if _agent_state is not None:
                try:
                    persisted_tool_call_meta = (
                        _agent_state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY) or {}
                    )
                except Exception as e:  # noqa: BLE001 - handled by checkpoint state
                    if has_active_interrupt:
                        if reconciliation_setup_error is None:
                            reconciliation_setup_error = e
                    else:
                        logger.warning(
                            "Persisted tool-call metadata is unavailable; "
                            "continuing without historical callback metadata: %s",
                            e,
                            exc_info=True,
                        )

            continuation_proxy_native_ids = {
                native_id
                for native_id in active_proxy_native_ids
                if isinstance(persisted_tool_call_meta.get(native_id), Mapping)
                and persisted_tool_call_meta[native_id].get("strands_tool_id")
                == native_id
                and persisted_tool_call_meta[native_id].get("is_proxy") is True
                and persisted_tool_call_meta[native_id].get(
                    "continue_after_frontend_call"
                )
                is True
            }
            correction_required_proxy_native_ids = (
                active_proxy_native_ids - continuation_proxy_native_ids
            )

            # Scope to the TRAILING tool results (this continuation's just-
            # returned results). ``pending_tool_result_ids`` holds those ids;
            # without this, a multi-turn continuation re-sends already-reconciled
            # historical results, which can never be re-corrected and would force
            # the legacy fallback every turn.
            frontend_results: List[Dict[str, Any]] = []
            for msg in (input_data.messages or []):
                if getattr(msg, "role", None) != "tool":
                    continue
                wire_id = getattr(msg, "tool_call_id", None)
                if not wire_id or wire_id not in pending_tool_result_ids:
                    continue
                if (
                    frontend_wait_batch_for_consumption is not None
                    and frontend_wait_batch_for_consumption.call_for_wire_id(wire_id)
                    is None
                ):
                    # A legacy continue=true proxy in the same checkpoint is
                    # not part of the hidden wait channel. Its placeholder must
                    # remain parked for the existing continuation path.
                    continue
                name = _tool_call_id_to_name.get(wire_id)
                if name not in frontend_tool_names and wire_id not in wire_to_native:
                    continue
                content = msg.content
                text = (
                    content
                    if isinstance(content, str)
                    else flatten_content_to_text(content)
                )
                frontend_results.append(
                    {
                        "wire_id": wire_id,
                        "text": text or "",
                        # Carry the client's failure signal alongside the text so
                        # reconciliation can stamp the persisted toolResult status
                        # too, not just its content.
                        "is_error": bool(getattr(msg, "error", None)),
                    }
                )

            # Translate the client's wire tool_call_id back to the native
            # toolUseId Strands persisted (they differ for frontend tools — see
            # the fresh-uuid assignment in the streaming loop). Only reconcile
            # when there is at least one NON-EMPTY frontend result: a void tool
            # returns nothing, and the synthetic "executed successfully with no
            # return value" continuation message conveys that better than an
            # empty toolResult. A failed void result is the exception: it must
            # reconcile so its status replaces the proxy's hardcoded success.
            # When reconciling, void placeholders in the same
            # turn are still cleared (to "") so the literal "Forwarded to client"
            # is never fed to the model.
            resolved_native_results: Dict[str, Tuple[str, bool]] = {}
            corrected_native_ids: set[str] = set()
            has_nonvoid_frontend_result = any(
                (r["text"] or "").strip() or r["is_error"] for r in frontend_results
            )
            if reconciliation_setup_error is None and session_manager is not None and (
                self.config.replay_history_into_strands
                or (resume_submitted and bool(active_proxy_native_ids))
            ):
                try:
                    resolved_native_results = resolve_native_ids(
                        wire_to_native, frontend_results
                    )
                except Exception as e:  # noqa: BLE001 - handled below by checkpoint state
                    reconciliation_setup_error = e

            if reconciliation_setup_error is not None:
                if has_active_interrupt:
                    logger.error(
                        "Active interrupt tool result reconciliation failed",
                        exc_info=reconciliation_setup_error,
                    )
                    yield _interrupt_reconciliation_error()
                    return
                logger.warning(
                    "Frontend tool result reconciliation failed; falling back to "
                    f"the legacy continuation path: {reconciliation_setup_error}",
                    exc_info=reconciliation_setup_error,
                )

            # Resuming clears the parked context. Every exact proxy placeholder
            # in that context therefore needs a mapped client result before
            # repository or live checkpoint mutation begins.
            if (
                frontend_wait_resume_prompt is None
                and resume_submitted
                and active_proxy_native_ids
            ):
                missing_active_results = (
                    correction_required_proxy_native_ids
                    - resolved_native_results.keys()
                )
                if missing_active_results:
                    logger.error(
                        "Active interrupt is missing mapped frontend results for native ids %s",
                        sorted(missing_active_results),
                    )
                    yield _interrupt_reconciliation_error()
                    return

            # Reconcile Strands' internal conversation history with
            # ``RunAgentInput.messages``. Without this, frontend tool results
            # sent by the client never reach the LLM — Strands sees an open
            # ``toolUse`` from the prior turn and the LLM re-fires the same tool
            # every run, producing the "chart loops forever" symptom.
            #
            # No session manager: rebuild history in-memory and stream it.
            # With a session manager (which owns persistence): overwrite the
            # persisted placeholder toolResult(s) with the real client result
            # via the session repository, then continue from the corrected
            # native history — keeping a single source of truth rather than a
            # placeholder plus a synthetic "tool returned: X" message.
            replay_history = (
                self.config.replay_history_into_strands and session_manager is None
            )
            # A native-only live checkpoint needs no repository access. Exact
            # proxy placeholders do, including when the client result is void.
            reconcile_session_results = (
                reconciliation_setup_error is None
                and _supports_repository_reconciliation(session_manager, strands_agent)
                and (
                    (
                        self.config.replay_history_into_strands
                        and (
                            has_nonvoid_frontend_result
                            or bool(active_proxy_native_ids)
                        )
                    )
                    or (
                        frontend_wait_resume_prompt is None
                        and resume_submitted
                        and bool(active_proxy_native_ids)
                    )
                )
            )

            # Default prompt: the legacy path, passing only the latest user
            # message and trusting Strands (via session_manager) to track
            # history. Each branch below may narrow this further; a resume run
            # can carry BOTH a fresh frontend tool result and an interrupt
            # response in the same batch, so the resume-entries translation
            # below runs unconditionally after the other branches and layers
            # on top, rather than short-circuiting them.
            resume_prompt: str | List[Dict[str, Any]] | list[InterruptResponseContent] | None = user_message
            if replay_history:
                native_history = _build_strands_history(input_data.messages)
                # Apply ``state_context_builder`` to the last user-text
                # message in the reconciled history rather than to the
                # synthetic ``user_message`` string. This matches what the
                # builder is actually trying to enrich (the prompt the LLM
                # will see).
                if self.config.state_context_builder and native_history:
                    for native_msg in reversed(native_history):
                        if (
                            native_msg.get("role") == "user"
                            and native_msg.get("content")
                            and isinstance(native_msg["content"], list)
                            and "text" in native_msg["content"][0]
                        ):
                            try:
                                augmented = self.config.state_context_builder(
                                    input_data, native_msg["content"][0]["text"]
                                )
                                if isinstance(augmented, str):
                                    native_msg["content"][0]["text"] = augmented
                            except Exception as e:
                                logger.warning(
                                    f"state_context_builder failed: {e}", exc_info=True
                                )
                            break
                preserve_live_interrupt_history = (
                    frontend_wait_resume_prompt is not None
                    or (resume_submitted and has_active_interrupt and is_delta_payload)
                )
                if not preserve_live_interrupt_history:
                    strands_agent.messages = native_history
                # ``None`` tells Strands to use existing ``self.messages`` as-is.
                # The LLM sees real tool results (including ones produced by the
                # frontend) and emits a proper follow-up turn instead of
                # re-calling the tool.
                resume_prompt = None
            elif reconcile_session_results:
                try:
                    corrected_native_ids = reconcile_frontend_tool_results(
                        session_manager, strands_agent, resolved_native_results
                    )
                except Exception as e:  # noqa: BLE001 — degrade, don't crash the turn
                    if has_active_interrupt:
                        logger.error(
                            "Active interrupt tool result reconciliation failed",
                            exc_info=True,
                        )
                        yield _interrupt_reconciliation_error()
                        return
                    logger.warning(
                        "Frontend tool result reconciliation failed; falling back to "
                        f"the legacy continuation path: {e}",
                        exc_info=True,
                    )
                missing_corrections = (
                    correction_required_proxy_native_ids - corrected_native_ids
                )
                if missing_corrections:
                    logger.error(
                        "Active interrupt frontend results were not corrected for native ids %s",
                        sorted(missing_corrections),
                    )
                    yield _interrupt_reconciliation_error()
                    return
                # Continue from the corrected native history only when every
                # NON-EMPTY frontend result this turn resolved to a native id
                # (i.e. was present in the wire->native map) AND none of those
                # placeholders remain uncleared. The scan is scoped to this
                # turn's results so a stale placeholder from a prior (e.g. void)
                # turn doesn't force the legacy path. Any shortfall means
                # forwarding the real result as a synthetic user message is
                # safer than replaying a stub.
                non_void_results = [
                    r for r in frontend_results if (r["text"] or "").strip()
                ]
                resolved_non_void = {
                    native
                    for native, (text, _is_error) in resolved_native_results.items()
                    if (text or "").strip()
                }
                all_non_void_resolved = len(resolved_non_void) == len(non_void_results)
                # Scan all of this turn's resolved native ids (void included, so a
                # resolved-but-uncleared void placeholder also blocks) — but not
                # unrelated historical placeholders.
                reconciled = all_non_void_resolved and not has_placeholder_results(
                    getattr(strands_agent, "messages", None) or [],
                    only_ids=set(resolved_native_results),
                )
                resume_prompt = None if reconciled else user_message

            # A client answering to an interrupt sends its responses
            # in ``RunAgentInput.resume`` (as per the AG-UI interrupt round-trip),
            # not as a new user message. Translate those into the Strands resume
            # prompt shape ``[{"interruptResponse": {"interruptId", "response"}}]``
            # and drive the stream with it — this runs after (and takes
            # precedence over) every branch above, since a resume batch may
            # still carry a fresh frontend tool result that needed reconciling.
            if resume_submitted:
                resume_prompt = _resume_prompt

            # Drop only the entries whose placeholder was actually corrected
            # this turn — they won't recur. Entries that were NOT corrected
            # (unresolved, or a reconcile that raised) are kept so a later turn
            # can retry; pruning them would strand the persisted placeholder
            # forever. (Genuinely-abandoned entries are bounded by the size cap
            # applied at emission.)
            if wire_to_native and corrected_native_ids:
                remaining = {
                    wire: native
                    for wire, native in wire_to_native.items()
                    if native not in corrected_native_ids
                }
                if len(remaining) != len(wire_to_native):
                    strands_agent.state.set(AG_UI_WIRE_MAP_STATE_KEY, remaining)

            resume_proxy_overlay = None
            if frontend_wait_batch_for_consumption is not None:
                try:
                    native_ids_by_name = (
                        _frontend_wait_native_ids_by_tool_name(
                            strands_agent,
                            frontend_wait_batch_for_consumption,
                        )
                    )
                    resume_proxy_overlay = (
                        _install_frontend_wait_resume_proxy_overlay(
                            strands_agent.tool_registry,
                            list(input_data.tools or []),
                            native_ids_by_name,
                        )
                    )
                except ValueError as exc:
                    yield _interrupt_resume_error(str(exc))
                    return
            if accepted_server_resume_fingerprint is not None:
                cache_interrupt_bookkeeping(
                    pending_resume_interrupts,
                    accepted_server_resume_fingerprint,
                )
                await _persist_interrupt_bookkeeping(
                    strands_agent,
                    pending_resume_interrupts,
                    accepted_server_resume_fingerprint,
                    synchronize=False,
                )
            try:
                agent_stream = strands_agent.stream_async(resume_prompt)
            except BaseException:
                if resume_proxy_overlay is not None:
                    resume_proxy_overlay.restore()
                raise
            try:
                async for event in agent_stream:
                    # Capture the terminal ``AgentResult`` (always emitted last
                    # by ``stream_async``) so a native interrupt pause can be
                    # detected after the loop. Recorded first so it is never
                    # dropped, even on the halt-event-stream break below.
                    if "result" in event and event["result"] is not None:
                        terminal_result = event["result"]

                    # ``halt_event_stream`` is reserved for backend
                    # stop_streaming_after_result. Frontend calls that wait use
                    # Strands' native interrupt checkpoint and must be allowed
                    # to reach its terminal result.
                    if halt_event_stream:
                        break

                    logger.debug(f"Received event: {event}")

                    # Skip lifecycle events
                    if event.get("init_event_loop") or event.get("start_event_loop"):
                        continue
                    # ``force_stop`` means Strands caught an exception mid-cycle.
                    # It is a failed run, not assistant-authored content or a
                    # successful finish. Continue once more so Strands can raise
                    # the underlying exception and unwind the generator cleanly.
                    if event.get("force_stop"):
                        raw_reason = str(event.get("force_stop_reason", "")).strip()
                        force_stop_error = (
                            raw_reason or "The Strands agent stopped unexpectedly."
                        )
                        logger.error(
                            "Agent stream force-stopped (thread_id=%s, reason=%s)",
                            input_data.thread_id,
                            force_stop_error,
                        )
                        continue

                    # Legacy terminator from pre-typed-events Strands.
                    if event.get("complete"):
                        logger.debug(
                            f"Breaking event stream: complete received (thread_id={input_data.thread_id})"
                        )
                        break

                    # Modern Strands emits AgentResultEvent last. Consume the
                    # generator to exhaustion after handling it so its cleanup
                    # and trace finalizers run before AG-UI reports completion.
                    if "result" in event:
                        result = event["result"]
                        if result is not None:
                            stop_reason = getattr(result, "stop_reason", None)
                            logger.info(
                                "agent_result: thread_id=%s stop_reason=%s",
                                input_data.thread_id,
                                stop_reason,
                            )
                            # Surface non-normal stops to the client as a CustomEvent
                            # so a UI can render a hint (truncated / filtered / etc.).
                            # end_turn and tool_use are the normal stops — no event.
                            if stop_reason in (
                                "max_tokens",
                                "guardrail_intervened",
                                "content_filtered",
                            ):
                                yield CustomEvent(
                                    type=EventType.CUSTOM,
                                    name="AgentStopped",
                                    value={"stop_reason": stop_reason},
                                )
                        continue  # never yield the raw result event

                    # Handle text streaming
                    if "data" in event and event["data"]:
                        if stop_text_streaming:
                            continue

                        if not message_started:
                            yield TextMessageStartEvent(
                                type=EventType.TEXT_MESSAGE_START,
                                message_id=message_id,
                                role="assistant",
                            )
                            message_started = True
                            last_emitted_text_message_id = message_id

                        text_chunk = str(event["data"])
                        accumulated_text += text_chunk
                        yield TextMessageContentEvent(
                            type=EventType.TEXT_MESSAGE_CONTENT,
                            message_id=message_id,
                            delta=text_chunk,
                        )

                    # Handle reasoning/thinking text streaming
                    elif "reasoningText" in event and event.get("reasoning"):
                        reasoning_text = event["reasoningText"]

                        if not reasoning_started:
                            reasoning_message_id = str(uuid.uuid4())

                            # Emit reasoning events
                            yield ReasoningStartEvent(
                                type=EventType.REASONING_START,
                                message_id=reasoning_message_id
                            )
                            yield ReasoningMessageStartEvent(
                                type=EventType.REASONING_MESSAGE_START,
                                message_id=reasoning_message_id,
                                role="reasoning"
                            )
                            reasoning_started = True

                        # Stream reasoning content
                        if reasoning_text:
                            yield ReasoningMessageContentEvent(
                                type=EventType.REASONING_MESSAGE_CONTENT,
                                message_id=reasoning_message_id,
                                delta=reasoning_text
                            )

                    # Handle encrypted/redacted reasoning content
                    elif "reasoningRedactedContent" in event and event.get("reasoning"):
                        redacted_content = event["reasoningRedactedContent"]

                        if redacted_content is None:
                            logger.debug(f"Ignoring reasoning event with None redacted content (thread_id={input_data.thread_id})")
                            continue

                        if not reasoning_started:
                            reasoning_message_id = str(uuid.uuid4())
                            yield ReasoningStartEvent(
                                type=EventType.REASONING_START,
                                message_id=reasoning_message_id
                            )
                            yield ReasoningMessageStartEvent(
                                type=EventType.REASONING_MESSAGE_START,
                                message_id=reasoning_message_id,
                                role="reasoning"
                            )
                            reasoning_started = True

                        # Encode bytes to base64 string for transport
                        if isinstance(redacted_content, bytes):
                            encrypted_value = base64.b64encode(redacted_content).decode()
                        elif isinstance(redacted_content, str):
                            encrypted_value = redacted_content
                        else:
                            logger.warning(f"Unexpected type for reasoningRedactedContent: {type(redacted_content)}, converting to str")
                            encrypted_value = str(redacted_content)

                        yield ReasoningEncryptedValueEvent(
                            type=EventType.REASONING_ENCRYPTED_VALUE,
                            subtype="message",
                            entity_id=reasoning_message_id,
                            encrypted_value=encrypted_value
                        )

                    # Handle reasoning signature (verification token) - typically not exposed to UI
                    elif "reasoning_signature" in event and event.get("reasoning"):
                        sig = event.get("reasoning_signature", "")
                        logger.debug(f"Received reasoning signature: {str(sig)[:20]}...")

                    # Handle multi-agent node start (maps to STEP_STARTED)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_node_start":
                        node_id = event.get("node_id", "unknown")
                        node_type = event.get("node_type", "agent")
                        yield StepStartedEvent(
                            type=EventType.STEP_STARTED,
                            step_name=f"{node_type}:{node_id}"
                        )

                    # Handle multi-agent node stop (maps to STEP_FINISHED)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_node_stop":
                        node_id = event.get("node_id", "unknown")
                        node_type = event.get("node_type", "agent")
                        yield StepFinishedEvent(
                            type=EventType.STEP_FINISHED,
                            step_name=f"{node_type}:{node_id}"
                        )

                    # Handle multi-agent handoff (emit as CUSTOM event)
                    elif isinstance(event, dict) and event.get("type") == "multiagent_handoff":
                        yield CustomEvent(
                            type=EventType.CUSTOM,
                            name="MultiAgentHandoff",
                            value={
                                "from_nodes": event.get("from_node_ids", []),
                                "to_nodes": event.get("to_node_ids", []),
                                "message": event.get("message")
                            }
                        )

                    # Handle tool streaming events for real-time state updates
                    # Strands tools can yield intermediate results as tool_stream_event
                    elif "tool_stream_event" in event:
                        tool_stream = event["tool_stream_event"]
                        stream_data = tool_stream.get("data", {})
                        _tse_tool_use = tool_stream.get("tool_use", {})
                        _tse_tool_name = _tse_tool_use.get("name", "")
                        _tse_tool_use_id = _tse_tool_use.get("toolUseId")

                        # A2UI sub-agent streaming: re-emit the
                        # generate_a2ui tool's inner render_a2ui progress as
                        # synthetic TOOL_CALL events. The a2ui middleware's
                        # streaming path keys its "building" skeleton +
                        # progressive paint off these — without them the
                        # surface only paints in bulk from the final result.
                        # This path is keyed off A2UI_STREAM_KEY in the
                        # payload, not the tool's toolUseId, so it must run
                        # even when toolUseId is absent.
                        if (
                            isinstance(stream_data, dict)
                            and isinstance(stream_data.get(A2UI_STREAM_KEY), dict)
                        ):
                            a2ui_ev = stream_data[A2UI_STREAM_KEY]
                            kind = a2ui_ev.get("kind")
                            a2ui_call_id = a2ui_ev.get("tool_call_id", "")
                            if kind == "start":
                                yield ToolCallStartEvent(
                                    type=EventType.TOOL_CALL_START,
                                    tool_call_id=a2ui_call_id,
                                    tool_call_name=a2ui_ev.get(
                                        "tool_call_name", "render_a2ui"
                                    ),
                                )
                            elif kind == "args" and a2ui_ev.get("delta"):
                                yield ToolCallArgsEvent(
                                    type=EventType.TOOL_CALL_ARGS,
                                    tool_call_id=a2ui_call_id,
                                    delta=a2ui_ev["delta"],
                                )
                            elif kind == "end":
                                yield ToolCallEndEvent(
                                    type=EventType.TOOL_CALL_END,
                                    tool_call_id=a2ui_call_id,
                                )
                        elif _tse_tool_use_id is None:
                            logger.debug(
                                "tool_stream_event missing toolUseId — skipping handler dispatch"
                            )
                        else:
                            _tse_behavior = self.config.tool_behaviors.get(_tse_tool_name) if _tse_tool_name else None

                            if _tse_behavior and _tse_behavior.tool_stream_event_handler:
                                _tse_ctx = ToolStreamEventContext(
                                    tool_use_id=_tse_tool_use_id,
                                    tool_name=_tse_tool_name,
                                    stream_data=stream_data,
                                )
                                try:
                                    async for _tse_event in _tse_behavior.tool_stream_event_handler(
                                        _tse_ctx
                                    ):
                                        if _tse_event is not None:
                                            yield _tse_event
                                except Exception as _tse_exc:
                                    logger.warning(
                                        f"tool_stream_event_handler failed for {_tse_tool_name}: {_tse_exc}",
                                        exc_info=True,
                                    )
                            elif isinstance(stream_data, dict) and "state" in stream_data:
                                # Default behaviour: emit state snapshot when tool yields {"state": ...}
                                yield StateSnapshotEvent(
                                    type=EventType.STATE_SNAPSHOT,
                                    snapshot=stream_data["state"],
                                )

                    # Handle tool results from Strands for backend tool rendering
                    elif "message" in event and event["message"].get("role") == "user":
                        message_content = event["message"].get("content", [])
                        if not message_content or not isinstance(message_content, list):
                            continue

                        for item in message_content:
                            if not isinstance(item, dict) or "toolResult" not in item:
                                continue

                            tool_result = item["toolResult"]
                            result_tool_id = tool_result.get("toolUseId")
                            result_data = _decode_tool_result_data(tool_result)

                            if not result_tool_id or result_data is None:
                                continue

                            # Direct lookup works for backend tools (keyed by Strands ID).
                            # Frontend tools are keyed by a generated UUID, so we fall back
                            # to scanning by strands_tool_id when the direct lookup misses.
                            call_info = tool_calls_seen.get(result_tool_id, {})
                            if not call_info:
                                for _tid, _data in tool_calls_seen.items():
                                    if _data.get("strands_tool_id") == result_tool_id:
                                        call_info = _data
                                        break
                            # RESUME-run fallback: the interrupted tool never
                            # re-emits ``current_tool_use`` on resume, so
                            # ``tool_calls_seen`` is empty for it. The
                            # persisted meta map was populated when the call
                            # was originally streamed (possibly in a prior
                            # process). Direct native-id first, then scan by
                            # ``strands_tool_id`` to match the frontend-tool
                            # case.
                            if not call_info:
                                call_info = persisted_tool_call_meta.get(
                                    result_tool_id, {}
                                )
                            if not call_info:
                                for _pdata in persisted_tool_call_meta.values():
                                    if (
                                        isinstance(_pdata, dict)
                                        and _pdata.get("strands_tool_id")
                                        == result_tool_id
                                    ):
                                        call_info = _pdata
                                        break
                            # Record consumption once the lookup is complete
                            # (even if it missed): the result was processed
                            # this turn, so any persisted entry keyed on this
                            # native id is safe to prune. Recording BEFORE the
                            # frontend-skip / behavior branches ensures a
                            # ``stop_streaming_after_result`` early break still
                            # flags this id for prune.
                            if not (
                                frontend_wait_batch_for_consumption is not None
                                and call_info.get("is_proxy") is True
                                and call_info.get("continue_after_frontend_call")
                                is True
                            ):
                                processed_result_native_ids.add(result_tool_id)
                            tool_name = call_info.get("name")
                            tool_args = call_info.get("args")
                            tool_input = call_info.get("input")
                            behavior = (
                                self.config.tool_behaviors.get(tool_name)
                                if tool_name
                                else None
                            )

                            if result_tool_id in suppressed_checkpoint_result_ids:
                                continue

                            # A backend result parked in a mixed native
                            # checkpoint is emitted from checkpoint context at
                            # the end of the original run. On resume Strands
                            # includes it again beside the proxy's real result;
                            # do not duplicate wire events or callbacks.
                            if call_info.get("checkpoint_result_emitted") is True:
                                continue

                            logger.debug(
                                f"Processing tool result: tool_name={tool_name}, result_tool_id={result_tool_id}, pending_tool_result_ids={pending_tool_result_ids}, thread_id={input_data.thread_id}"
                            )

                            # Skip only results proven to belong to a forwarded/proxy
                            # call. A registered backend tool may legitimately share
                            # its name with a client declaration; name membership alone
                            # must not hide that server result.
                            is_frontend_result = (
                                call_info.get("is_frontend") is True
                                or call_info.get("is_proxy") is True
                                or result_tool_id in wire_to_native.values()
                            )
                            if is_frontend_result:
                                continue

                            # Emit ToolCallResultEvent WITHOUT role field to complete the tool in UI
                            # but prevent it from being added to conversation history.
                            # A fresh message ID is used so CopilotKit creates a proper standalone
                            # ToolMessage and closes the spinner correctly.
                            tool_result_message_id = str(uuid.uuid4())
                            tool_result_content = json.dumps(result_data)
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=result_tool_id,
                                message_id=tool_result_message_id,
                                content=tool_result_content,
                                # role is intentionally omitted - without role="tool",
                                # the frontend won't add this to conversation history
                            )
                            emitted_backend_result_ids.add(result_tool_id)

                            # Splice point 3 of 4: append the ToolMessage
                            # carrying the backend tool result to the
                            # running snapshot so the frontend can pair
                            # call + result in the message tree.
                            if (
                                emit_snapshots
                                and not (
                                    behavior
                                    and behavior.skip_messages_snapshot
                                )
                            ):
                                snapshot_messages.append(
                                    ToolMessage(
                                        id=tool_result_message_id,
                                        role="tool",
                                        content=tool_result_content,
                                        tool_call_id=result_tool_id,
                                    )
                                )
                                yield MessagesSnapshotEvent(
                                    type=EventType.MESSAGES_SNAPSHOT,
                                    messages=list(snapshot_messages),
                                )

                            result_context = ToolResultContext(
                                input_data=input_data,
                                tool_name=tool_name or "",
                                tool_use_id=result_tool_id,
                                tool_input=tool_input,
                                args_str=tool_args or "{}",
                                result_data=result_data,
                                message_id=message_id,
                            )

                            if behavior and behavior.state_from_result:
                                try:
                                    snapshot = await maybe_await(
                                        behavior.state_from_result(result_context)
                                    )
                                    if snapshot:
                                        current_state.update(snapshot)
                                        yield StateSnapshotEvent(
                                            type=EventType.STATE_SNAPSHOT,
                                            snapshot=snapshot,
                                        )
                                except Exception as e:
                                    logger.warning(
                                        f"state_from_result failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.custom_result_handler:
                                try:
                                    async for (
                                        custom_event
                                    ) in behavior.custom_result_handler(result_context):
                                        if custom_event is not None:
                                            yield custom_event
                                except Exception as e:
                                    logger.warning(
                                        f"custom_result_handler failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.stop_streaming_after_result:
                                stop_text_streaming = True
                                if message_started:
                                    yield TextMessageEndEvent(
                                        type=EventType.TEXT_MESSAGE_END,
                                        message_id=message_id,
                                    )
                                    message_started = False
                                    # Splice point 4 of 4 (early-exit
                                    # variant): commit any accumulated
                                    # assistant text into the snapshot.
                                    if (
                                        emit_snapshots
                                        and accumulated_text
                                    ):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content=accumulated_text,
                                            )
                                        )
                                        accumulated_text = ""
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                halt_event_stream = True
                                logger.debug(
                                    f"Breaking event stream: stop_streaming_after_result behavior triggered (thread_id={input_data.thread_id}, tool_name={tool_name})"
                                )
                                # Break inner loop — no further results should be emitted
                                break

                        # Prune the persisted tool-call meta map for entries
                        # whose native id (or ``strands_tool_id`` for frontend
                        # tools stored under a wire key) was just consumed.
                        # The emission-time size cap (``_TOOL_CALL_MAP_MAX``) is
                        # only a backstop for abandoned entries.
                        if (
                            persisted_tool_call_meta
                            and processed_result_native_ids
                        ):
                            _remaining = {
                                _k: _v
                                for _k, _v in persisted_tool_call_meta.items()
                                if _k not in processed_result_native_ids
                                and (
                                    not isinstance(_v, dict)
                                    or _v.get("strands_tool_id")
                                    not in processed_result_native_ids
                                )
                            }
                            if len(_remaining) != len(persisted_tool_call_meta):
                                strands_agent.state.set(
                                    AG_UI_TOOL_CALL_MAP_STATE_KEY, _remaining
                                )
                                persisted_tool_call_meta = _remaining
                        processed_result_native_ids.clear()

                        # The batch is fully emitted; stop before Strands runs
                        # another model cycle. Breaking HERE rather than relying
                        # on the check at the top of the loop means termination
                        # does not depend on Strands happening to yield one more
                        # event after this message.
                        if halt_event_stream:
                            break

                    # Handle tool calls
                    elif "current_tool_use" in event and event["current_tool_use"]:
                        tool_use = event["current_tool_use"]
                        tool_name = tool_use.get("name")
                        strands_tool_id = tool_use.get("toolUseId")
                        _raw_in = tool_use.get("input", "")

                        # Generate unique ID for actual registered proxy tools
                        # (not merely a native tool whose name also appeared in
                        # the client tool list).
                        # Use Strands' ID for backend tools (so result lookup works)
                        registered_tool = getattr(
                            strands_agent.tool_registry, "registry", {}
                        ).get(tool_name)
                        is_registered_proxy = _is_proxy(registered_tool)
                        is_frontend_tool = tool_name in frontend_tool_names and (
                            registered_tool is None or is_registered_proxy
                        )

                        # Check if we've already seen this tool (by Strands' internal ID)
                        existing_entry = None
                        for tid, data in tool_calls_seen.items():
                            if data.get("strands_tool_id") == strands_tool_id:
                                existing_entry = tid
                                break

                        if existing_entry:
                            # Reuse the existing ID
                            tool_use_id = existing_entry
                        elif is_frontend_tool:
                            # Generate new UUID for frontend tools
                            tool_use_id = str(uuid.uuid4())
                            # Record wire id -> Strands native id in AgentState
                            # for same-wrapper native frontend waits regardless
                            # of SessionManager availability. A SessionManager
                            # additionally makes this map durable across process
                            # restarts; that shared persistence is handled by the
                            # existing state synchronization path.
                            if strands_tool_id:
                                _wire_map = dict(
                                    strands_agent.state.get(AG_UI_WIRE_MAP_STATE_KEY)
                                    or {}
                                )
                                _wire_map[tool_use_id] = strands_tool_id
                                # Bound growth: entries for frontend calls that
                                # never get a client result (abandoned/dismissed
                                # HITL) are never consumed/pruned. Keep only the
                                # most-recent ``_WIRE_MAP_MAX`` (insertion order).
                                if len(_wire_map) > _WIRE_MAP_MAX:
                                    for _stale in list(_wire_map)[
                                        : len(_wire_map) - _WIRE_MAP_MAX
                                    ]:
                                        _wire_map.pop(_stale, None)
                                strands_agent.state.set(
                                    AG_UI_WIRE_MAP_STATE_KEY, _wire_map
                                )
                        else:
                            # Use Strands' ID for backend tools
                            tool_use_id = strands_tool_id or str(uuid.uuid4())

                        logger.debug(
                            f"Tool call event received: tool_name={tool_name}, tool_use_id={tool_use_id}, strands_id={strands_tool_id}, is_frontend={is_frontend_tool}, already_seen={tool_use_id in tool_calls_seen}, thread_id={input_data.thread_id}"
                        )

                        # Update tool input as it streams in
                        tool_input_raw = tool_use.get("input", "")

                        # Raw string form is what FE incrementally parses for
                        # predict_state. Use it as-is for delta computation so
                        # the wire stream matches what the LLM actually emitted.
                        raw_str = (
                            tool_input_raw
                            if isinstance(tool_input_raw, str)
                            else json.dumps(tool_input_raw, default=str)
                        )

                        # Try to parse as JSON if it looks complete
                        tool_input = {}
                        if isinstance(tool_input_raw, str) and tool_input_raw:
                            try:
                                tool_input = json.loads(tool_input_raw)
                            except json.JSONDecodeError:
                                # Input is still streaming, keep as string
                                tool_input = tool_input_raw
                        elif isinstance(tool_input_raw, dict):
                            tool_input = tool_input_raw

                        args_str = (
                            json.dumps(tool_input)
                            if isinstance(tool_input, dict)
                            else str(tool_input)
                        )

                        # Track or update tool call as input streams in
                        is_new_tool_call = (
                            tool_name and tool_use_id not in tool_calls_seen
                        )
                        if is_new_tool_call:
                            is_pending_now = tool_use_id in pending_tool_result_ids
                            behavior_now = self.config.tool_behaviors.get(tool_name)
                            # Use the streaming path (emit ToolCallStart +
                            # PredictState now, ToolCallArgs on each growth,
                            # ToolCallEnd at contentBlockStop) unless the tool
                            # is a continuation (already-resolved) or supplies
                            # a custom args_streamer that wants to drive args
                            # emission itself at contentBlockStop.
                            use_streaming = not is_pending_now and not (
                                behavior_now and behavior_now.args_streamer
                            )
                            tool_calls_seen[tool_use_id] = {
                                "name": tool_name,
                                "args": args_str,
                                "input": tool_input,
                                "raw": raw_str,
                                "emitted": False,  # legacy flag (still used by contentBlockStop scan)
                                "start_emitted": False,
                                "end_emitted": False,
                                "last_emitted_raw_len": 0,
                                "is_pending": is_pending_now,
                                "is_frontend": is_frontend_tool,
                                "is_proxy": is_registered_proxy,
                                "use_streaming": use_streaming,
                                "strands_tool_id": strands_tool_id,
                            }

                            # Mirror the minimum-sufficient subset into live
                            # agent state. A SessionManager may persist it, but
                            # the cached core itself is the same-process native
                            # checkpoint and must restore callbacks without one.
                            _tc_meta = dict(
                                strands_agent.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)
                                or {}
                            )
                            # Key by the NATIVE ``toolUseId`` — that is what
                            # arrives on ``toolResult``. For backend tools
                            # this equals ``tool_use_id``; for frontend tools
                            # ``tool_use_id`` is a fresh wire UUID while
                            # ``strands_tool_id`` is native.
                            _tc_key = strands_tool_id or tool_use_id
                            _tc_entry = {
                                "name": tool_name,
                                "args": args_str,
                                "input": tool_input,
                                "strands_tool_id": strands_tool_id,
                                "use_streaming": use_streaming,
                                "message_id": message_id,
                            }
                            if is_frontend_tool:
                                _tc_entry.update(
                                    is_frontend=True,
                                    is_proxy=is_registered_proxy,
                                    continue_after_frontend_call=bool(
                                        behavior_now
                                        and behavior_now.continue_after_frontend_call
                                    ),
                                )
                            _tc_meta[_tc_key] = _tc_entry
                            if len(_tc_meta) > _TOOL_CALL_MAP_MAX:
                                for _stale in list(_tc_meta)[
                                    : len(_tc_meta) - _TOOL_CALL_MAP_MAX
                                ]:
                                    _tc_meta.pop(_stale, None)
                            strands_agent.state.set(
                                AG_UI_TOOL_CALL_MAP_STATE_KEY, _tc_meta
                            )
                            persisted_tool_call_meta = _tc_meta

                            if use_streaming:
                                # Close any open assistant text turn so the
                                # snapshot order matches the wire-event order
                                # and so message_id can rotate cleanly.
                                if message_started:
                                    yield TextMessageEndEvent(
                                        type=EventType.TEXT_MESSAGE_END,
                                        message_id=message_id,
                                    )
                                    if (
                                        emit_snapshots
                                        and accumulated_text
                                    ):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content=accumulated_text,
                                            )
                                        )
                                        accumulated_text = ""
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                    message_started = False
                                    message_id = str(uuid.uuid4())

                                # PredictState mapping must reach the FE BEFORE
                                # any args delta so the FE knows which tool
                                # argument feeds which state key while parsing
                                # incremental JSON.
                                if behavior_now:
                                    predict_state_payload = [
                                        mapping.to_payload()
                                        for mapping in normalize_predict_state(
                                            behavior_now.predict_state
                                        )
                                    ]
                                    if predict_state_payload:
                                        yield CustomEvent(
                                            type=EventType.CUSTOM,
                                            name="PredictState",
                                            value=predict_state_payload,
                                        )

                                # Must mirror the later tool snapshot emission condition.
                                tool_parent_message_id = (
                                    message_id
                                    if self._will_emit_tool_snapshot(behavior_now, emit_snapshots)
                                    else last_emitted_text_message_id
                                )
                                yield ToolCallStartEvent(
                                    type=EventType.TOOL_CALL_START,
                                    tool_call_id=tool_use_id,
                                    tool_call_name=tool_name,
                                    parent_message_id=tool_parent_message_id,
                                )
                                tool_calls_seen[tool_use_id]["start_emitted"] = True
                        elif tool_name and tool_use_id in tool_calls_seen:
                            # Update the input and args as they stream in
                            tool_calls_seen[tool_use_id]["input"] = tool_input
                            tool_calls_seen[tool_use_id]["args"] = args_str
                            tool_calls_seen[tool_use_id]["raw"] = raw_str

                            # Keep the persisted meta in sync with the final
                            # streamed args. Without this refresh, resume runs
                            # would see the first partial-JSON delta rather
                            # than the complete args the model emitted.
                            _tc_meta = dict(
                                strands_agent.state.get(AG_UI_TOOL_CALL_MAP_STATE_KEY)
                                or {}
                            )
                            _tc_key = strands_tool_id or tool_use_id
                            _existing = _tc_meta.get(_tc_key)
                            if _existing is not None:
                                _existing["input"] = tool_input
                                _existing["args"] = args_str
                                strands_agent.state.set(
                                    AG_UI_TOOL_CALL_MAP_STATE_KEY, _tc_meta
                                )
                                persisted_tool_call_meta = _tc_meta

                        # Stream incremental ToolCallArgs deltas as the LLM
                        # produces more characters of the JSON args. The FE
                        # uses these to drive predictive state updates per the
                        # PredictState mapping that was just emitted.
                        entry = tool_calls_seen.get(tool_use_id)
                        if (
                            entry
                            and entry.get("start_emitted")
                            and entry.get("use_streaming")
                        ):
                            new_len = len(raw_str)
                            last_len = entry.get("last_emitted_raw_len", 0)
                            if new_len > last_len:
                                yield ToolCallArgsEvent(
                                    type=EventType.TOOL_CALL_ARGS,
                                    tool_call_id=tool_use_id,
                                    delta=raw_str[last_len:new_len],
                                )
                                entry["last_emitted_raw_len"] = new_len

                    # Handle content block stop - this signals tool input is complete
                    elif "event" in event and isinstance(event.get("event"), dict):
                        inner_event = event["event"]
                        if "contentBlockStop" in inner_event:
                            # Close reasoning events if active
                            if reasoning_started:
                                yield ReasoningMessageEndEvent(
                                    type=EventType.REASONING_MESSAGE_END,
                                    message_id=reasoning_message_id
                                )
                                yield ReasoningEndEvent(
                                    type=EventType.REASONING_END,
                                    message_id=reasoning_message_id
                                )
                                reasoning_started = False
                                reasoning_message_id = None

                            # Find the most recent tool call that hasn't been emitted yet
                            tool_name = None
                            tool_input = None
                            args_str = None
                            tool_use_id = None

                            for tid, tool_data in tool_calls_seen.items():
                                if not tool_data.get("emitted", True):
                                    tool_name = tool_data["name"]
                                    tool_input = tool_data["input"]
                                    args_str = tool_data["args"]
                                    tool_use_id = tid
                                    break  # Process one tool at a time

                            # Only process if we found a tool to emit
                            if tool_name and tool_use_id:
                                entry = tool_calls_seen[tool_use_id]
                                # Mark as emitted (legacy compat)
                                entry["emitted"] = True
                                entry["end_emitted"] = True

                                is_frontend_tool = entry.get("is_frontend", tool_name in frontend_tool_names)
                                behavior = self.config.tool_behaviors.get(tool_name)
                                is_pending = entry.get("is_pending", tool_use_id in pending_tool_result_ids)
                                use_streaming = entry.get("use_streaming", False)

                                logger.debug(
                                    f"contentBlockStop close: tool_name={tool_name}, tool_use_id={tool_use_id}, is_frontend_tool={is_frontend_tool}, is_pending={is_pending}, use_streaming={use_streaming}, thread_id={input_data.thread_id}"
                                )
                                call_context = ToolCallContext(
                                    input_data=input_data,
                                    tool_name=tool_name,
                                    tool_use_id=tool_use_id,
                                    tool_input=tool_input,
                                    args_str=args_str,
                                )

                                if use_streaming:
                                    # Streaming path: ToolCallStart, PredictState
                                    # and the args deltas have already been
                                    # emitted from the current_tool_use handler.
                                    # Flush any final delta the LLM tacked on
                                    # between the last current_tool_use update
                                    # and contentBlockStop, then close the call.
                                    raw_str = entry.get("raw", "") or ""
                                    last_len = entry.get("last_emitted_raw_len", 0)
                                    if len(raw_str) > last_len:
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=raw_str[last_len:],
                                        )
                                        entry["last_emitted_raw_len"] = len(raw_str)

                                    # Emit ``state_from_args`` BEFORE
                                    # ``ToolCallEnd``. CopilotKit v2 releases
                                    # the predict_state buffer at ToolCallEnd;
                                    # if the authoritative StateSnapshot lands
                                    # after that, the FE momentarily reverts
                                    # to the last server-confirmed state and
                                    # re-applies, producing a "re-stream"
                                    # animation. Delivering the snapshot first
                                    # means the FE has the real state in hand
                                    # at the moment prediction is released.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )

                                    # Defer hand-off: for frontend tools, buffer the
                                    # ToolCallEnd instead of emitting it now. It is
                                    # flushed after this turn's backend results (see
                                    # the pending_halt handler). Backend tools and
                                    # continue_after_frontend_call tools emit now.
                                    if is_frontend_tool and not (
                                        behavior and behavior.continue_after_frontend_call
                                    ):
                                        deferred_frontend_tool_ends.append(tool_use_id)
                                    else:
                                        yield ToolCallEndEvent(
                                            type=EventType.TOOL_CALL_END,
                                            tool_call_id=tool_use_id,
                                        )

                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content="",
                                                tool_calls=[
                                                    ToolCall(
                                                        id=tool_use_id,
                                                        type="function",
                                                        function=FunctionCall(
                                                            name=tool_name or "unknown",
                                                            arguments=args_str or "{}",
                                                        ),
                                                    )
                                                ],
                                            )
                                        )
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                        # Rotate so the next assistant message
                                        # in the snapshot (text or another
                                        # tool call) carries a distinct id —
                                        # CopilotKit v2 dedupes by id.
                                        message_id = str(uuid.uuid4())

                                elif is_pending:
                                    # Continuation turn — tool already resolved
                                    # in conversation history. Don't re-emit any
                                    # wire events but still let state callbacks
                                    # fire so derived state stays consistent.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )
                                else:
                                    # Legacy path: behavior.args_streamer is
                                    # configured. Emit the full burst at
                                    # contentBlockStop using the custom
                                    # streamer so existing args_streamer
                                    # consumers keep working.
                                    if behavior and behavior.state_from_args:
                                        try:
                                            snapshot = await maybe_await(
                                                behavior.state_from_args(call_context)
                                            )
                                            if snapshot:
                                                current_state.update(snapshot)
                                                yield StateSnapshotEvent(
                                                    type=EventType.STATE_SNAPSHOT,
                                                    snapshot=snapshot,
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"state_from_args failed for {tool_name}: {e}",
                                                exc_info=True,
                                            )

                                    if behavior:
                                        predict_state_payload = [
                                            mapping.to_payload()
                                            for mapping in normalize_predict_state(
                                                behavior.predict_state
                                            )
                                        ]
                                        if predict_state_payload:
                                            yield CustomEvent(
                                                type=EventType.CUSTOM,
                                                name="PredictState",
                                                value=predict_state_payload,
                                            )

                                    if message_started:
                                        yield TextMessageEndEvent(
                                            type=EventType.TEXT_MESSAGE_END, message_id=message_id
                                        )
                                        if (
                                            emit_snapshots
                                            and accumulated_text
                                        ):
                                            snapshot_messages.append(
                                                AssistantMessage(
                                                    id=message_id,
                                                    role="assistant",
                                                    content=accumulated_text,
                                                )
                                            )
                                            accumulated_text = ""
                                            yield MessagesSnapshotEvent(
                                                type=EventType.MESSAGES_SNAPSHOT,
                                                messages=list(snapshot_messages),
                                            )
                                        message_started = False
                                        message_id = str(uuid.uuid4())

                                    # Must mirror the later tool snapshot emission condition.
                                    tool_parent_message_id = (
                                        message_id
                                        if self._will_emit_tool_snapshot(behavior, emit_snapshots)
                                        else last_emitted_text_message_id
                                    )
                                    yield ToolCallStartEvent(
                                        type=EventType.TOOL_CALL_START,
                                        tool_call_id=tool_use_id,
                                        tool_call_name=tool_name,
                                        parent_message_id=tool_parent_message_id,
                                    )

                                    try:
                                        async for chunk in behavior.args_streamer(
                                            call_context
                                        ):
                                            if chunk is None:
                                                continue
                                            yield ToolCallArgsEvent(
                                                type=EventType.TOOL_CALL_ARGS,
                                                tool_call_id=tool_use_id,
                                                delta=str(chunk),
                                            )
                                    except Exception as e:
                                        logger.warning(
                                            f"args_streamer failed for {tool_name}, falling back to full args: {e}"
                                        )
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=args_str,
                                        )

                                    if is_frontend_tool and not (
                                        behavior
                                        and behavior.continue_after_frontend_call
                                    ):
                                        deferred_custom_frontend_tool_ends.append(
                                            tool_use_id
                                        )
                                    else:
                                        yield ToolCallEndEvent(
                                            type=EventType.TOOL_CALL_END,
                                            tool_call_id=tool_use_id,
                                        )

                                    if self._will_emit_tool_snapshot(behavior, emit_snapshots):
                                        snapshot_messages.append(
                                            AssistantMessage(
                                                id=message_id,
                                                role="assistant",
                                                content="",
                                                tool_calls=[
                                                    ToolCall(
                                                        id=tool_use_id,
                                                        type="function",
                                                        function=FunctionCall(
                                                            name=tool_name or "unknown",
                                                            arguments=args_str or "{}",
                                                        ),
                                                    )
                                                ],
                                            )
                                        )
                                        yield MessagesSnapshotEvent(
                                            type=EventType.MESSAGES_SNAPSHOT,
                                            messages=list(snapshot_messages),
                                        )
                                        message_id = str(uuid.uuid4())

            except GeneratorExit:
                run_close_requested = True
                raise
            except Exception:
                if force_stop_error is None:
                    raise
                # Strands normally raises immediately after ForceStopEvent.
                # Keep it from bypassing message cleanup below, but preserve its
                # traceback in case a distinct hook/finalizer failure occurred.
                logger.exception(
                    "Strands stream raised after force_stop (thread_id=%s)",
                    input_data.thread_id,
                )
            finally:
                try:
                    # Always close the delegated Strands stream. ``ag_running`` is
                    # false both when an async generator is exhausted and while it
                    # is suspended at a yield, so it cannot distinguish a closed
                    # stream from one whose model/tool cleanup still needs to run.
                    await agent_stream.aclose()
                finally:
                    if resume_proxy_overlay is not None:
                        resume_proxy_overlay.restore()

            if frontend_wait_batch_for_consumption is not None:
                if not _frontend_wait_resume_was_accepted(
                    strands_agent, frontend_wait_batch_for_consumption
                ):
                    if force_stop_error is None:
                        yield _interrupt_resume_error(
                            "Strands did not consume the native frontend wait resume"
                        )
                        return
                else:
                    consumed_frontend_wait_batch = frontend_wait_batch_for_consumption
                    frontend_wait_batch_for_consumption = None
                    await _mark_frontend_wait_consumed(
                        strands_agent,
                        consumed_frontend_wait_batch,
                        accepted_frontend_wait_resume_fingerprint,
                    )
                    combined_wait_resume_accepted = True
                    cache_interrupt_bookkeeping(
                        None, accepted_frontend_wait_resume_fingerprint
                    )

            # Close reasoning if still open
            if reasoning_started:
                yield ReasoningMessageEndEvent(
                    type=EventType.REASONING_MESSAGE_END,
                    message_id=reasoning_message_id
                )
                yield ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=reasoning_message_id
                )

            # End message if started
            if message_started:
                yield TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END, message_id=message_id
                )
                # Splice point 4 of 4 (terminal): commit the final
                # assistant text turn into the snapshot so the frontend
                # has the closing message in canonical history.
                if emit_snapshots and accumulated_text:
                    snapshot_messages.append(
                        AssistantMessage(
                            id=message_id,
                            role="assistant",
                            content=accumulated_text,
                        )
                    )
                    accumulated_text = ""
                    yield MessagesSnapshotEvent(
                        type=EventType.MESSAGES_SNAPSHOT,
                        messages=list(snapshot_messages),
                    )

            if force_stop_error is not None:
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=force_stop_error,
                    code="STRANDS_FORCE_STOP",
                )
                return

            native_interrupts = _extract_interrupts(strands_agent, terminal_result)
            superseding_resume_fingerprint = (
                accepted_frontend_wait_resume_fingerprint
                if combined_wait_resume_accepted
                else None
            )

            # Validate and record adapter-owned waits before touching any
            # checkpointed results. Pure server-interrupt checkpoints retain
            # their existing timing and rendering behavior.
            hidden_batch = FrontendToolWaitBatch()
            visible_native_interrupts = native_interrupts
            if native_interrupts:
                hidden_batch, visible_native_interrupts = (
                    _partition_frontend_wait_interrupts(
                        strands_agent,
                        native_interrupts,
                        checkpoint_messages=[
                            *list(input_data.messages or []),
                            *snapshot_messages,
                        ],
                        deferred_end_ids=[
                            *deferred_custom_frontend_tool_ends,
                            *deferred_frontend_tool_ends,
                        ],
                    )
                )
                if hidden_batch.calls:
                    previous_wait = load_frontend_tool_wait(strands_agent.state)
                    hidden_batch = FrontendToolWaitBatch(
                        calls=hidden_batch.calls,
                        last_completed_wire_ids=previous_wait.last_completed_wire_ids,
                        checkpoint_message_ids=hidden_batch.checkpoint_message_ids,
                    )
                    strands_agent.state.set(
                        FRONTEND_TOOL_WAIT_STATE_KEY,
                        hidden_batch.to_dict(),
                    )
            if hidden_batch.calls and superseding_resume_fingerprint is None:
                superseding_resume_fingerprint = accepted_server_resume_fingerprint

            # Streaming can create a mixed checkpoint that was not observable
            # during preflight. Do not advertise or finish it unless the same
            # repository boundary needed for a safe resume is available.
            has_hidden_native_wait = bool(hidden_batch.calls)
            if (
                active_proxy_placeholder_ids(strands_agent)
                and not has_hidden_native_wait
            ):
                if session_manager is None:
                    yield _interrupt_session_required_error()
                    return
                if not _supports_repository_reconciliation(
                    session_manager, strands_agent
                ):
                    yield _interrupt_session_capability_error()
                    return

            # Persist visible interrupt bookkeeping before any waiting
            # frontend ToolCallEnd can tell the client to start executing.
            if native_interrupts:
                ag_ui_interrupts = [
                    _strands_interrupt_to_agui(interrupt)
                    for interrupt in visible_native_interrupts
                ]
                if ag_ui_interrupts:
                    pending_interrupt_outcome = RunFinishedInterruptOutcome(
                        type="interrupt",
                        interrupts=ag_ui_interrupts,
                    )
                    pending_interrupts = {
                        interrupt.id: interrupt for interrupt in ag_ui_interrupts
                    }
                    cache_interrupt_bookkeeping(
                        pending_interrupts, superseding_resume_fingerprint
                    )
                    await _persist_interrupt_bookkeeping(
                        strands_agent,
                        pending_interrupts,
                        superseding_resume_fingerprint,
                        strict=(
                            has_hidden_native_wait
                            or (
                                combined_wait_resume_accepted
                                and superseding_resume_fingerprint is not None
                            )
                        ),
                    )
                    logger.debug(
                        f"Strands interrupt detected: thread_id={input_data.thread_id}, "
                        f"interrupt_ids={[i.id for i in ag_ui_interrupts]}"
                    )

            # Make every hidden wait checkpoint durable before any externally
            # visible handoff or checkpointed backend result. Custom args
            # streamers still expose End before results; standard calls still
            # expose End afterward.
            if hidden_batch.calls:
                if not ag_ui_interrupts:
                    cache_interrupt_bookkeeping(
                        None, superseding_resume_fingerprint
                    )
                    await _persist_interrupt_bookkeeping(
                        strands_agent,
                        None,
                        superseding_resume_fingerprint,
                        strict=True,
                    )
            if deferred_custom_frontend_tool_ends:
                for _fe_tool_use_id in deferred_custom_frontend_tool_ends:
                    try:
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=_fe_tool_use_id,
                        )
                    finally:
                        if hidden_batch.call_for_wire_id(_fe_tool_use_id):
                            hidden_batch = await _mark_frontend_wait_end_handed_off(
                                strands_agent,
                                hidden_batch,
                                _fe_tool_use_id,
                            )
                deferred_custom_frontend_tool_ends = []

            # Strands parks completed backend results in checkpoint context when
            # a sibling tool interrupts, rather than emitting the usual user
            # message. Deliver those results now, exactly once, before exposing
            # the checkpoint boundary. The same blocks reappear during resume,
            # where ``checkpoint_result_emitted`` suppresses duplicates.
            checkpoint_delivery = _CheckpointResultDelivery()
            async for checkpoint_event in _checkpoint_result_events(
                agent=strands_agent,
                batch=hidden_batch,
                persisted_tool_call_meta=persisted_tool_call_meta,
                emitted_backend_result_ids=emitted_backend_result_ids,
                input_data=input_data,
                config=self.config,
                emit_snapshots=emit_snapshots,
                snapshot_messages=snapshot_messages,
                current_state=current_state,
                message_id=message_id,
                delivery=checkpoint_delivery,
            ):
                yield checkpoint_event

            if checkpoint_delivery.stop_streaming_after_result:
                hidden_batch = hidden_batch.mark_stop_streaming_after_result()
                strands_agent.state.set(
                    FRONTEND_TOOL_WAIT_STATE_KEY,
                    hidden_batch.to_dict(),
                )
            if checkpoint_delivery.metadata_changed:
                strands_agent.state.set(
                    AG_UI_TOOL_CALL_MAP_STATE_KEY,
                    persisted_tool_call_meta,
                )

            # Keep the later sync: result delivery metadata and a checkpoint
            # halt flag must be durable before a standard End is exposed.
            if hidden_batch.calls and checkpoint_delivery.metadata_changed:
                await _sync_frontend_wait_state(strands_agent)
            if deferred_frontend_tool_ends:
                for _fe_tool_use_id in deferred_frontend_tool_ends:
                    try:
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=_fe_tool_use_id,
                        )
                    finally:
                        if hidden_batch.call_for_wire_id(_fe_tool_use_id):
                            hidden_batch = await _mark_frontend_wait_end_handed_off(
                                strands_agent,
                                hidden_batch,
                                _fe_tool_use_id,
                            )
            deferred_frontend_tool_ends = []

            # Final state snapshot before finishing
            yield StateSnapshotEvent(
                type=EventType.STATE_SNAPSHOT,
                snapshot=current_state,
            )

            # Always finish the run - frontend handles keeping action executing
            if pending_interrupt_outcome is not None:
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=pending_interrupt_outcome,
                )
            else:
                # Store fingerprint for idempotency only after successful processing
                if resume_entries:
                    fp = _resume_fingerprint(resume_entries)
                    cache_interrupt_bookkeeping(None, fp)
                    await _persist_interrupt_bookkeeping(strands_agent, None, fp)
                elif combined_wait_resume_accepted:
                    # The visible server response may have been staged on an
                    # earlier request and the frontend ToolMessage arrived
                    # last. The combined native resume still consumed both
                    # channels, so clear stale visible bookkeeping now.
                    cache_interrupt_bookkeeping(None, None)
                    await _persist_interrupt_bookkeeping(strands_agent, None, None)
                yield RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=RunFinishedSuccessOutcome(type="success"),
                )

        except Exception as e:
            # ``aclose()`` injects GeneratorExit at the suspended yield. If
            # delegated Strands cleanup then fails, emitting RUN_ERROR here
            # would illegally yield while closing and replace the real error
            # with ``async generator ignored GeneratorExit``.
            if run_close_requested:
                raise
            if (
                frontend_wait_batch_for_consumption is not None
                and _frontend_wait_resume_was_accepted(
                    strands_agent, frontend_wait_batch_for_consumption
                )
            ):
                consumed_frontend_wait_batch = frontend_wait_batch_for_consumption
                frontend_wait_batch_for_consumption = None
                try:
                    await _mark_frontend_wait_consumed(
                        strands_agent,
                        consumed_frontend_wait_batch,
                        accepted_frontend_wait_resume_fingerprint,
                    )
                    cache_interrupt_bookkeeping(
                        None, accepted_frontend_wait_resume_fingerprint
                    )
                except Exception as persistence_error:
                    e = persistence_error
            import traceback

            traceback.print_exc()
            yield RunErrorEvent(
                type=EventType.RUN_ERROR, message=str(e), code="STRANDS_ERROR"
            )
