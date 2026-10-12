"""
AG-UI FastAPI server for CrewAI.
"""
import asyncio
import logging
import re
import threading
import time
from typing import Any
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import StreamingResponse

from ._env import _parse_env_float
from ._copyutil import safe_deepcopy, rebind_bound_methods

# The flow/method lifecycle events, the event bus, and the listener base moved
# from ``crewai.utilities.events`` (crewai 0.x) to ``crewai.events`` (crewai
# 1.x). ``_capabilities`` resolves whichever location exists and caches the
# crewai capability probe (run once at import).
from ._capabilities import flow_supports_stream_frames, flow_supports_conversational_stream, flow_supports_human_feedback, supported_checkpoint_kwargs, add_stream_sink, reset_stream_sinks, HITL_ENABLING_VERSIONS, HumanFeedbackPending
from ._checkpoint import build_checkpoint_kwargs
from ._frames import CREW_AGENT_LIFECYCLE_TYPES, StreamFrameTranslator, capture_method_emit_context, is_backend_tool_event, is_recognized_event, log_raw_loss, raw_event_for
from ._config import (
    DEFAULT_EMISSION_SHAPE,
    DEFAULT_FLOW_TIMEOUT_SECONDS,
    FLOW_TIMEOUT_ENV_VAR,
    MAX_CONVERSATION_WORKERS_ENV_VAR,
    resolve_emission_shape,
    resolve_emit_raw_events,
)
from ._hitl import (
    HITLOptions,
    feedback_from_resume,
    resume_requested,
)
from ._reasoning import is_thinking_event
from ._memory import apply_thread_memory_scope
from .mcp import is_mcp_event
from crewai.flow.flow import Flow
from crewai.types.streaming import AsyncStreamSession
from crewai.utilities.streaming import create_async_frame_generator, create_frame_streaming_state

from ag_ui.core import RunAgentInput, EventType, RunStartedEvent, RunErrorEvent, Message, Tool, Context
from ag_ui.core.events import MessagesSnapshotEvent
from ag_ui.encoder import EventEncoder

from .context import flow_context
from .utils import camel_to_snake, dump_agui_message
# Toolkit split: routes the A2UI component-schema context entry (stamped by
# ``@ag-ui/a2ui-middleware``) into ``state["ag-ui"]`` for the a2ui subagent tool.
from ag_ui_a2ui_toolkit import split_a2ui_schema_context
from .sdk import reset_node_snapshot_suppression
from .crews import ChatWithCrewFlow, CrewBaseInstance
from . import _conversation
from ._conversation import (
    AbandonmentSignal,
    ConversationCapacityExceeded,
    ConversationThreadBusy,
    ConversationalTurn,
    SyncStreamSessionAdapter,
    abandoned_conversational_run_for_thread,
    acquire_conversation_worker,
    conversation_worker_stats,
    conversational_flow_key,
    conversational_thread_busy_detail,
    hydrate_conversational_flow,
    force_per_turn_trace_finalization,
    overlay_conversational_persistence,
    prepare_conversational_turn,
    report_conversational_abandonment,
)

_LOGGER = logging.getLogger(__name__)

# Resolved off the module rather than imported by name: the abort signal belongs
# to the worker that raises it, so if it is renamed there the drain below loses
# one log distinction instead of failing this module's import.
_WORKER_ABORTED_EXC = getattr(_conversation, "ConversationWorkerAborted", None)

# Explicit ``__all__`` so ``from .endpoint import *`` only exposes the public
# surface (the FastAPI helpers + ``crewai_prepare_inputs``). Private helpers
# already have leading underscores and would be excluded from star-imports;
# pinning ``__all__`` makes the public contract explicit.
__all__ = [
    "add_crewai_flow_fastapi_endpoint",
    "add_crewai_crew_fastapi_endpoint",
    "crewai_prepare_inputs",
    "CrewBaseInstance",
]


# ``CrewBaseInstance`` (the structural type for a ``@CrewBase`` crew) lives in
# ``crews.py`` alongside ``ChatWithCrewFlow`` — which also annotates its
# constructor with it — and is imported above. It stays in ``__all__`` so
# downstream callers keep importing it from ``ag_ui_crewai.endpoint``.

class _NeverRaised(Exception):
    """Placeholder exception type that is never raised.

    Stands in for ``HumanFeedbackPending`` when the installed crewai predates
    async HITL (the resolved symbol is ``None``), so ``except`` clauses that
    catch a pause propagation stay valid without matching anything.
    """


# The pause signal to catch when it PROPAGATES out of astream / resume_async
# (rather than ending the stream cleanly). ``None`` on pre-HITL crewai, so fall
# back to the never-raised sentinel to keep the ``except`` clause well-typed.
_HUMAN_FEEDBACK_PENDING_EXC = HumanFeedbackPending or _NeverRaised


class _CeilingExceeded(Exception):
    """Sentinel raised when our configured flow-ceiling deadline fires.

    Distinguishes the ceiling-fired path (our ``asyncio.wait`` / monotonic
    deadline produced the timeout) from an upstream ``TimeoutError`` that
    bubbled out of ``kickoff_async`` (e.g. a LiteLLM/httpx read timeout).
    Downstream consumers treat ``AGUI_CREWAI_FLOW_TIMEOUT`` as "we hit our
    configured ceiling", so upstream failures must not be conflated under that
    code or alerting lies.
    """

# Hard wall-clock ceiling on a single flow run. A runaway flow (e.g. a hung
# LiteLLM stream or an infinite loop in a user task) must not be able to pin
# the process indefinitely. Override via the ``AGUI_CREWAI_FLOW_TIMEOUT_SECONDS``
# environment variable; defaults to 10 minutes. Deployments with legitimately
# long-running crews should set the env var explicitly or use a non-positive
# value to disable the ceiling.
#
# Both the NAME and the default come from ``_config``, which also reads this
# ceiling to size the agent execution ceiling and to warn when a provider read can
# outlast it. Either one spelled twice would drift the moment one moved.
_DEFAULT_FLOW_TIMEOUT_SECONDS = DEFAULT_FLOW_TIMEOUT_SECONDS

_CANCEL_GRACE_SECONDS = 1.0
_SESSION_CLOSE_TIMEOUT_SECONDS = 10.0
_RESUME_CLOSERS: set[asyncio.Task] = set()

# Cap on both bounded RAW buffers in ``_run_flow_frame_stream`` (``raw_events``,
# whose entries a frame always claims, is not one of them). They shed differently
# and deliberately: ``foreign_events`` is keyed and unordered, so at the cap it
# evicts the OLDEST entry, which is the one least likely to still have a frame
# coming; ``pending_raw`` is an ordered pre-RUN_STARTED hold that is flushed in
# arrival order, so at the cap it drops the NEWEST arrival and keeps the prefix it
# can still emit in order. Both log the loss. Either way the buffer self-heals:
# crewai raises some events that never produce a frame, and refusing every new
# entry instead would wedge the buffer for the whole run.
_FOREIGN_EVENT_BUFFER_MAX = 512

# Regex to sanitize exception class names before embedding them in a ``code``
# field. Peer events' codes match ``^[A-Z][A-Z0-9_]+$``; a custom exception
# with a dynamically-generated or unicode name (e.g.
# ``class WeirdError42(Exception): pass``) must be forced into that shape
# before going on the wire.
_CODE_SANITIZE_RE = re.compile(r"[^A-Z0-9_]")


def _sanitize_exception_code(name: str) -> str:
    """Sanitize an exception class name for the ``code`` field.

    Peer events on this wire use ``^[A-Z][A-Z0-9_]+$`` codes. Exception
    class names may contain lowercase letters, digits, or even unicode
    (custom exceptions with dynamically-generated names are legal in
    Python). Upper-case the name and replace any character that is not
    an ASCII uppercase letter, digit, or underscore with ``_`` so the
    composed code stays greppable and regex-matchable by downstream
    alerting.
    """
    sanitized = _CODE_SANITIZE_RE.sub("_", name.upper())
    # Collapse runs of underscores into a single underscore and strip
    # leading/trailing underscores so the result respects the peer
    # convention (e.g. a unicode name like ``ErrorXé`` sanitizes to
    # ``ERRORX_``, and ``Error__X`` to ``ERROR__X``). If the
    # sanitized-and-stripped result is empty or does NOT start with
    # ``[A-Z]`` (e.g. the class name was digits-only or all-unicode)
    # prefix ``E_`` so the composed code still matches ``^[A-Z][A-Z0-9_]+$``.
    sanitized = re.sub(r"_+", "_", sanitized).strip("_")
    if not sanitized or not sanitized[0].isascii() or not sanitized[0].isalpha():
        sanitized = f"E_{sanitized}" if sanitized else "E"
    return sanitized


def _stamp_correlation_ids(event: object, *, thread_id: str, run_id: str) -> None:
    """Stamp ``thread_id`` / ``run_id`` on ``event`` if the fields exist.

    Probe attributes with ``hasattr`` rather than enumerate event types so any
    event carrying thread/run correlation (RUN_STARTED / RUN_FINISHED today,
    plus any future correlated event) is covered automatically and does not
    ship the listener's ``"?"`` placeholders. Events without these fields
    (StepStartedEvent, MessagesSnapshotEvent, etc.) are left untouched. Model
    ``__setattr__`` on Pydantic events is allowed by ``model_config`` (no
    frozen).
    """
    if hasattr(event, "thread_id"):
        try:
            event.thread_id = thread_id
        except (AttributeError, ValueError):  # pragma: no cover - defensive
            pass
    if hasattr(event, "run_id"):
        try:
            event.run_id = run_id
        except (AttributeError, ValueError):  # pragma: no cover - defensive
            pass


def _flow_timeout_seconds() -> float | None:
    """Return the configured flow-execution ceiling in seconds.

    A non-positive value (e.g. ``0`` or ``-1``) disables the ceiling. A
    NaN or any other non-finite value is treated as unparseable and falls
    back to the default — ``float('nan') > 0`` is False, which would
    otherwise silently disable the ceiling.
    """
    return _parse_env_float(
        FLOW_TIMEOUT_ENV_VAR,
        _DEFAULT_FLOW_TIMEOUT_SECONDS,
        allow_disable=True,
    )


def _copy_flow(flow: object) -> object:
    """Return a per-request isolated copy of ``flow``.

    Delegates to ``_copyutil.safe_deepcopy`` — plain ``copy.deepcopy`` on
    healthy crewai builds, pin-and-share fallback on the crewai 1.15.x
    ``Flow`` deep-copy bug (found by running the suite on the 1.15.7 wheel).
    Isolation of the per-request conversation state is preserved either way.

    When the pin-and-share fallback runs, the copy SHARES the original's
    ``_methods`` dict (its bound ``@start`` / ``@listen`` methods
    trial-deep-copy-fail because they reference the uncopyable ``memory`` via
    ``__self__``, so the dict is pinned by reference). crewai 1.x executes
    ``self._methods[name]`` — still bound to the ORIGINAL — so
    ``kickoff_async``/``astream`` on the copy seeds the COPY's ``self._state``
    while ``@start`` runs against the ORIGINAL's un-seeded state
    (``KeyError: 'messages'`` at ``crews.py`` ``*self.state["messages"]``, and a
    total loss of per-request isolation). Rebind the copy's flow methods to the
    copy so state seeding and isolation both hold. No-op on healthy deep-copy
    builds (already rebound) and on non-flow copies (no ``_methods``).
    """
    flow_copy = safe_deepcopy(flow, what="flow")
    rebind_bound_methods(flow_copy)
    return flow_copy


def _format_timeout_message(timeout: float | None) -> str:
    """Build the ``TimeoutError`` message for the flow-ceiling path.

    Extracted so the two TimeoutError construction sites and the client-facing
    error message derive from a single source of truth.

    ``timeout`` is always a finite positive value here — the flow-ceiling code
    paths that raise ``TimeoutError`` are guarded by ``timeout is not None``.
    Using ``%g`` (up to 6 significant digits, no trailing zeros) avoids the
    truncation of sub-decisecond values that ``%.1f`` produces. For ``0.2``,
    ``%g`` renders ``0.2``; for ``0.25``, ``0.25``; for ``600``, ``600``.
    """
    return f"CrewAI flow exceeded {timeout:g}s ceiling"


# Per-alias WARN dedup: track ``(model_name, field_name)`` tuples that have
# already warned so ``_field_alias`` logs one line per divergence rather than
# per-event spam under a misconfigured ag-ui.core upgrade.
_ALIAS_WARN_SEEN: set[tuple[str, str]] = set()


def _field_alias(model_cls, field_name: str, default: str) -> str:
    """Return the serialization alias for ``field_name`` on ``model_cls``.

    Pydantic models in ag-ui.core set camelCase aliases via an alias
    generator; we derive the wire name here so a future rename of the alias
    policy propagates automatically instead of silently diverging from this
    module's hardcoded camelCase literals. Falls back to ``default`` if the
    model does not declare the field (keeps the code path stable under library
    upgrades).

    If BOTH ``serialization_alias`` and ``alias`` are ``None`` on an existing
    field, that almost certainly means Pydantic internals changed and our
    alias inference is silently wrong. Emit ONE WARN per (model, field) tuple
    (tracked in ``_ALIAS_WARN_SEEN``) so the divergence is visible without
    spamming a line per request / per event.
    """
    try:
        field = model_cls.model_fields[field_name]
    except (AttributeError, KeyError):
        return default
    # Pydantic v2 exposes the alias either as ``alias`` (explicit) or via
    # ``serialization_alias``; prefer the latter if set.
    serialization_alias = getattr(field, "serialization_alias", None)
    basic_alias = getattr(field, "alias", None)
    # Use an explicit None check rather than ``or`` so an empty string (legal,
    # if unusual) on ``serialization_alias`` does not silently fall through to
    # ``basic_alias``.
    alias = (
        serialization_alias
        if serialization_alias is not None
        else basic_alias
    )
    if alias is None:
        model_name = getattr(model_cls, "__name__", str(model_cls))
        dedup_key = (model_name, field_name)
        if dedup_key not in _ALIAS_WARN_SEEN:
            _ALIAS_WARN_SEEN.add(dedup_key)
            _LOGGER.warning(
                "ag-ui-crewai could not infer a serialization alias for "
                "%s.%s; both serialization_alias and alias were None — this "
                "usually indicates Pydantic internals changed. Falling back "
                "to hardcoded default=%r (further occurrences for this "
                "(model, field) will be silenced).",
                model_name,
                field_name,
                default,
            )
        return default
    return alias


def _run_error_extras(input_data: RunAgentInput) -> dict:
    """Return the extras kwargs for a RunErrorEvent, camelCased to match
    peer events' wire format.

    ``ConfiguredBaseModel`` uses ``extra="allow"`` — extras bypass the alias
    generator, so pre-camelCased keys are required to line up with
    declared-field peers (``RunStartedEvent.thread_id`` / ``run_id`` emit as
    ``threadId`` / ``runId`` via the alias generator). The alias names are
    derived from ``RunStartedEvent.model_fields`` so a rename of the alias
    policy in ag-ui.core does not silently regress this module.

    LOAD-BEARING ASSUMPTION: ``RunStartedEvent`` and ``RunErrorEvent`` share
    the same alias-generator policy (both derive from ``ConfiguredBaseModel``).
    We derive the alias names from ``RunStartedEvent.model_fields`` and apply
    them to ``RunErrorEvent`` extras on the premise that the wire name for
    ``thread_id`` / ``run_id`` is IDENTICAL across the two models. If ag-ui.core
    ever splits the alias policy per-model, this derivation silently diverges
    (extras camelCased while declared fields are not). The failure mode is
    subtle (wire format mismatch, not a crash), so verifying the shared policy
    at test time is the right escalation point rather than asserting it
    dynamically here.
    """
    thread_alias = _field_alias(RunStartedEvent, "thread_id", "threadId")
    run_alias = _field_alias(RunStartedEvent, "run_id", "runId")
    return {
        thread_alias: input_data.thread_id,
        run_alias: input_data.run_id,
    }


# The one sentence for "why is this still running and what caps it". Both
# conversational refusals carry it: neither the code nor the detail sentence says
# what an operator can change, and the answer is the same for both.
_TURN_BOUND_ADVICE = (
    "an abandoned turn is released only when its own work ends, which nothing in "
    "the bridge can cut short; shorten it with Agent(max_execution_time=...) on "
    "the flow's agents, which trims crewai's retry factor rather than capping the "
    "wall clock"
)


def _conversation_pool_state() -> str:
    """Pool occupancy plus the oldest abandoned turn's age, for a refusal message.

    ``active=held/size`` carries the pool SIZE, which is why neither refusal has to
    quote the env var as a stand-in for a number.

    ``oldest-abandoned-age`` is the PROCESS-wide oldest, which on the thread-busy
    path is not necessarily this conversation's holder; labelled as such rather
    than presented as the holder's own age.
    """
    stats = conversation_worker_stats()
    oldest = stats.oldest_abandoned_age_seconds
    return (
        f"active={stats.active}/{stats.max_workers} "
        f"abandoned={stats.abandoned_active} oldest-abandoned-age="
        + ("none" if oldest is None else f"{oldest:.0f}s")
    )


def _conversation_thread_busy_error(
    input_data: RunAgentInput,
    detail: str,
) -> RunErrorEvent:
    """The one wire shape for "another turn still owns this conversation".

    Shared by the kickoff and resume drivers so a client cannot tell the two
    refusals apart by their payload; only ``detail`` differs.
    """
    return RunErrorEvent(
        message=(
            f"thread={input_data.thread_id} run={input_data.run_id}: "
            f"CrewAI conversational thread is busy ({detail}); "
            f"{_conversation_pool_state()}. Retry this message once it ends: "
            f"{_TURN_BOUND_ADVICE}. Raising "
            f"{MAX_CONVERSATION_WORKERS_ENV_VAR} does not lift this refusal, "
            f"which is per-conversation rather than a capacity limit."
        ),
        code="AGUI_CREWAI_CONVERSATION_THREAD_BUSY",
        **_run_error_extras(input_data),
    )


async def _aclose_stream_session(
    session: object,
    *,
    thread_id: str | None,
    run_id: str | None,
) -> None:
    """Best-effort ``aclose()`` teardown for a crewai ``AsyncStreamSession``.

    CrewAI's async session cancels its producer task; the
    conversational sync adapter requests cooperative cancellation and logs
    when a blocked upstream operation must return before its worker can stop.

    On cancellation, complete teardown before propagating: on Python 3.11+ a bare
    ``await session.aclose()`` in a ``finally`` reached via outer cancellation
    would re-raise ``CancelledError`` on entry (``Task.cancelling()`` is still
    non-zero), so ``aclose`` would never run and the kickoff task would leak.
    We ``uncancel`` (via ``getattr`` for 3.10 compat) so the teardown
    completes; the original in-flight cancellation resumes propagating once the
    generator's ``finally`` unwinds.
    """
    aclose = getattr(session, "aclose", None)
    if not callable(aclose):
        return
    # Uncancel ONLY when a cancellation is actually pending on this task. An
    # unconditional ``uncancel()`` would consume a cancellation LEVEL even on
    # the happy-path teardown (``aclose`` reached with no outer cancel) — a
    # level that isn't ours to consume, so a later legitimate cancel would then
    # need one extra ``cancel()`` to take effect. The uncancel dance exists
    # only to let the ``await aclose()`` below run when we were reached VIA an
    # outer cancel (on 3.11+ a bare await in that state re-raises on entry).
    # ``cancelling()`` is 3.11+; on 3.10 it's absent and ``uncancel`` is too,
    # so the guard is a no-op there (the bare await works on 3.10 regardless).
    current = asyncio.current_task()
    uncancel = getattr(current, "uncancel", None)
    cancelling = getattr(current, "cancelling", None)
    if callable(uncancel) and callable(cancelling) and cancelling() > 0:
        uncancel()
    try:
        await aclose()
    except asyncio.CancelledError:
        # aclose itself was cancelled; re-raise so the cancellation is not
        # silently swallowed.
        raise
    except Exception as exc:  # pylint: disable=broad-exception-caught
        _LOGGER.debug(
            "CrewAI astream aclose failed thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            type(exc).__name__,
        )


async def _aclose_frame_iterator(
    aiter: object,
    *,
    thread_id: str | None,
    run_id: str | None,
) -> None:
    """Close the frame iterator the driver opened, if it is still suspended.

    Closing the SESSION is not the same thing. The iterator is a separate async
    generator, and on the two paths that leave it suspended -- a client that goes
    away while the driver is parked at a ``yield``, and the ceiling firing at the
    top of the loop before a read -- nothing throws into it. Its ``finally`` is
    what drops the conversational adapter's loop and queue, which keep every
    undelivered frame reachable, so leaving it suspended defers that release to
    asyncio's async-generator finalizer whenever the collector reaches it.

    A no-op on an iterator that already exhausted or unwound.
    """
    aclose = getattr(aiter, "aclose", None)
    if not callable(aclose):
        return
    # The same conditional uncancel as ``_aclose_stream_session``, for the same
    # reason and with the same "only a level that is ours" restraint: this runs in
    # a ``finally`` reached via an outer cancel, and reaching it THROUGH a session
    # close that re-raised is the case that leaves a level pending here. Measured
    # on the interpreters to hand: ``uncancel()`` clears ``Task._must_cancel`` when
    # it reaches zero on 3.13.14 and 3.14.4 but not on 3.12.0, so this rescues the
    # await below on the newer ones and is inert on the older.
    current = asyncio.current_task()
    uncancel = getattr(current, "uncancel", None)
    cancelling = getattr(current, "cancelling", None)
    if callable(uncancel) and callable(cancelling) and cancelling() > 0:
        uncancel()
    try:
        await aclose()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # pylint: disable=broad-exception-caught
        _LOGGER.debug(
            "CrewAI frame iterator aclose failed thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            type(exc).__name__,
        )


def _close_orphaned_sync_session(
    session: object,
    *,
    thread_id: str | None,
    run_id: str | None,
) -> None:
    """Close a conversational ``StreamSession`` no adapter ever took over.

    ``stream_turn`` hands back a live session before the adapter that owns its
    teardown exists, so a raising adapter constructor leaves the driver's own
    ``session`` local ``None``: the teardown ``aclose()`` would close nothing and
    crewai's session (and the thread behind it) would run with nobody to end it.
    """
    if session is None:
        return
    close = getattr(session, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception as exc:  # pylint: disable=broad-exception-caught
        _LOGGER.warning(
            "ag-ui-crewai could not close an unadopted conversational "
            "StreamSession thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            type(exc).__name__,
        )


async def _drain_frames_after_finish(
    aiter: Any,
    *,
    thread_id: str | None = None,
    run_id: str | None = None,
) -> bool:
    """Drain the terminal tail of a frame stream after RUN_FINISHED.

    Returns True only when the stream reached natural exhaustion. False means a
    producer is still running with nobody left to read it, which on the
    conversational path is the difference between a completed turn and an
    abandoned worker.

    Three distinct conditions produce that False and the return value cannot tell
    them apart, so each is logged: a healthy-but-slow tail that outlived the grace
    (DEBUG, routine on a successful conversational turn), an upstream error, and a
    worker that aborted its turn instead of finishing it (both WARNING, since the
    tail's real outcome is discarded here and can never reach the wire).

    crewai enqueues its end sentinel only AFTER ``kickoff_async`` fully returns —
    result recorded, trace batch finalized — see ``create_async_frame_generator``
    in crewai's ``utilities/streaming.py``: the ``flow_finished`` FRAME is emitted
    from inside ``kickoff_async``, but the ``None`` that ends the iterator lands
    only in the run task's ``finally``, one or more loop turns later.

    If the driver ``break``s the instant RUN_FINISHED is emitted and lets the
    ``finally`` ``aclose()`` the session, crewai's frame generator is
    ``GeneratorExit``-ed at its ``yield`` and its OWN ``finally`` ``task.cancel()``s
    the still-finalizing kickoff task — on EVERY happy-path run (verified against
    the 1.15.7 wheel: the session ends ``is_cancelled=True`` with no ``result``).
    Draining to natural ``StopAsyncIteration`` instead lets the run task reach its
    end sentinel, so the subsequent ``aclose()`` is a no-op and the kickoff is
    never cancelled mid-finalization. This is the frame-path analogue of the
    native producer's successful finalization.

    Bounded by ``_CANCEL_GRACE_SECONDS`` so a pathological finalization cannot
    stall teardown — on grace expiry we return and the ``finally``'s ``aclose()``
    force-cancels the tail (today's behavior, but only after the grace). Trailing
    frames are DISCARDED: emitting any wire event after RUN_FINISHED would violate
    the AG-UI run lifecycle, and a late upstream error can no longer become a
    RUN_ERROR, so it is kept off the wire and logged instead.
    """
    def _slow_tail() -> bool:
        """Log the grace expiry and report non-exhaustion."""
        _LOGGER.debug(
            "CrewAI post-RUN_FINISHED drain left a slow tail running thread=%s "
            "run=%s grace=%gs",
            thread_id,
            run_id,
            _CANCEL_GRACE_SECONDS,
        )
        return False

    grace_deadline = time.monotonic() + _CANCEL_GRACE_SECONDS
    while True:
        remaining = grace_deadline - time.monotonic()
        if remaining <= 0:
            return _slow_tail()
        try:
            await asyncio.wait_for(aiter.__anext__(), timeout=remaining)
        except StopAsyncIteration:
            # Run task reached its end sentinel: finalization completed.
            return True
        except (asyncio.TimeoutError, TimeoutError):
            # Grace window elapsed; fall back to the aclose() cancel.
            return _slow_tail()
        except Exception as exc:  # pylint: disable=broad-exception-caught
            # Post-terminal: a late error cannot become a RUN_ERROR now, so this
            # log is the only record of it.
            aborted = _WORKER_ABORTED_EXC is not None and isinstance(
                exc, _WORKER_ABORTED_EXC
            )
            _LOGGER.warning(
                "CrewAI post-RUN_FINISHED drain ended on %s thread=%s run=%s "
                "cause=%s; the tail's outcome is discarded",
                "an aborted conversational worker" if aborted else "an upstream error",
                thread_id,
                run_id,
                type(exc).__name__,
            )
            return False
        # A trailing frame arrived before exhaustion — discard it (no
        # post-RUN_FINISHED wire events) and keep draining.


async def _run_flow_frame_stream(
    *,
    flow_copy: object,
    encoder: EventEncoder,
    input_data: RunAgentInput,
    inputs: dict,
    timeout: float | None,
    checkpoint_kwargs: dict | None = None,
    hitl_options: HITLOptions | None = None,
    emit_raw_events: bool = False,
    emission_shape: str = DEFAULT_EMISSION_SHAPE,
    conversational_turn: ConversationalTurn | None = None,
    resume_feedback: str | None = None,
):
    """StreamFrame-path driver: drive one flow turn and yield encoded AG-UI events.

    Two transports, one translation seam. Without ``conversational_turn`` the
    driver opens ``flow.astream`` and iterates crewai's own async session. With
    one, crewai offers no async turn API, so the driver calls the public
    ``flow.stream_turn(message, session_id=threadId)`` and wraps the SYNCHRONOUS
    ``StreamSession`` it returns in a ``SyncStreamSessionAdapter``, which pumps it
    from a worker thread. Everything below the transport (translator, RUN_ERROR
    taxonomy, ceiling, raw-event parking, teardown) is shared.

    The conversational transport is what the containment machinery exists for,
    because Python cannot kill that worker thread:

    * a worker-pool LEASE is acquired before the flow is touched at all
      (``acquire_conversation_worker``), since crewai spawns its thread on the
      first frame read and a refusal after that point refuses nothing. It is keyed
      by (flow, threadId): the registry is process-wide, one process serves many
      endpoints, and the id is the client's, so keying on the id alone would let
      one flow's abandoned turn refuse another's. The adapter takes ownership of
      the lease and releases it when the worker really ends, not when the request
      does; every path that fails before the adapter exists gives the slot back
      itself;
    * one ``AbandonmentSignal`` per run is handed to every layer that can still
      publish or persist after this generator unwinds (the worker, the raw-event
      sink, the persistence overlay). It is set in the ``finally`` unless the run
      reached a terminal event or the stream exhausted, so a turn that FINISHED
      is never abandoned: it still owes its persistence writes and its tail;
    * a second, broader ``request_torn_down`` event gates the request-owned
      buffers alone. Once the generator has unwound, terminal or not, nothing may
      park into them again. Abandonment cannot serve that purpose, precisely
      because a completed turn's tail keeps emitting and is never abandoned.

    Kickoff and resume consume ordered native StreamFrame envelopes, with
    request-scoped raw-event capture for lossless translation. Shared behavior:

    * the five-code RUN_ERROR taxonomy (``AGUI_CREWAI_FLOW_TIMEOUT`` /
      ``AGUI_CREWAI_UPSTREAM_TIMEOUT`` / ``AGUI_CREWAI_FLOW_ERROR_<Class>`` /
      ``AGUI_CREWAI_CONVERSATION_CAPACITY`` /
      ``AGUI_CREWAI_CONVERSATION_THREAD_BUSY``) via ``_CeilingExceeded`` /
      ``_format_timeout_message`` / ``_sanitize_exception_code``;
    * the wall-clock ceiling + env knobs (``timeout`` is ``_flow_timeout_seconds()``);
    * ``_stamp_correlation_ids`` on every emitted event and
      ``_run_error_extras`` (camelCase wire aliases) on every RUN_ERROR;
    * client-disconnect teardown via ``aclose()`` (see ``_aclose_stream_session``).

    ``flow_context`` is set so the ``sdk.copilotkit_*`` helpers can emit their
    ``Bridged*`` events; those reach the scoped sink synchronously because
    ``event_bus._prepare_event`` calls ``publish_stream_event`` on every
    ``emit``.

    Payload + identity come from the RAW event, not ``frame.data``. We register
    our OWN scoped sink that parks the raw event object keyed by
    ``event.event_id``. Outer-flow lifecycle/method events are parked only when
    ``source is flow_copy`` (so a nested ``crew.kickoff``'s own flow's
    lifecycle/method events, which leak onto this same sink via the copied
    contextvars, are excluded); Crew/Agent lifecycle events are parked
    regardless of source (they are run-scoped and arrive with a non-outer
    source) so the translator can attribute the crew/agent hierarchy. The frame
    stream then supplies ORDERING; for each frame we look
    up the parked raw event by ``frame.id`` and translate it. A frame with no
    parked event is skipped.

    Because ``publish_stream_event`` runs the sink synchronously on ``emit``
    and crewai enqueues the frame via ``loop.call_soon_threadsafe`` (a later
    loop turn), the raw event is ALWAYS parked before its frame is dequeued.
    """
    token = flow_context.set(flow_copy)
    translator = StreamFrameTranslator(
        thread_id=input_data.thread_id,
        run_id=input_data.run_id,
        state_provider=lambda: getattr(flow_copy, "state", {}),
        # Lets the translator honor the sdk emit_state/predict_state suppression
        # flags stashed on this flow (legacy-listener parity).
        flow_provider=lambda: flow_copy,
        hitl_options=hitl_options,
        emission_shape=emission_shape,
        resumed=resume_feedback is not None,
    )
    # ``stream_turn`` records the current user message inside CrewAI, after the
    # run has opened. Its first normal MESSAGES_SNAPSHOT therefore arrives only
    # when the first flow method finishes. Reasoning/text can stream before that
    # snapshot and would be anchored above the user's prompt in AG-UI. Establish
    # the request conversation immediately after RUN_STARTED so all streamed
    # activity for this turn is rendered beneath the current user message.
    current_turn_snapshot_pending = conversational_turn is not None
    # ONE signal per run, handed to every layer that could still publish or
    # persist after this generator unwinds: the sync worker, the raw-event sink
    # below, and the conversational persistence overlay. Set in the ``finally``
    # unless the stream reached natural exhaustion.
    abandonment = AbandonmentSignal()
    # A second, BROADER condition, for the request-owned buffers alone: the
    # generator has unwound, terminal or not. A completed turn is deliberately
    # never abandoned (it still owes its persistence writes and its thread), so
    # abandonment cannot tell its tail to stop parking.
    request_torn_down = threading.Event()
    stream_exhausted = False

    def _closing_reasoning_frames():
        """Encoded REASONING_* END events for any reasoning left open at error.

        Emitted before a RUN_ERROR so a run that fails mid-reasoning does not
        leave a half-open lifecycle on the wire. A no-op when nothing is open.
        """
        for reasoning_event in translator.flush_open_reasoning():
            _stamp_correlation_ids(
                reasoning_event,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
            yield encoder.encode(reasoning_event)
    # Raw-event lookup buffer, populated by our scoped sink below. Keyed by
    # ``event.event_id`` (== ``StreamFrame.id``). Only OUTER-flow events land
    # here (source gate), which is exactly the nested-flow filter: nested
    # frames find nothing here and are dropped.
    raw_events: dict[str, Any] = {}
    # Second buffer for foreign-source events, populated only when RAW is enabled.
    # crewai emits its llm / agent / task / tool events with the EMITTER as source
    # (``crewai_event_bus.emit(self, event=...)``), never the flow, so the outer-flow
    # gate below drops all of them - including ``llm_thinking_chunk``. Parking them
    # separately keeps the translation gate intact, so a foreign event can never
    # synthesize a run lifecycle event or a state snapshot.
    foreign_events: dict[str, Any] = {}
    # RAW mirrors that arrived BEFORE RUN_STARTED, from either source. Released in
    # order right after the run opens: crewai raises some events before the flow
    # starts, and a RAW first event makes @ag-ui/client's verifyEvents throw
    # "First event must be 'RUN_STARTED'".
    pending_raw: list[Any] = []
    conversational_user_id: str | None = None
    conversational_user_id_applied = False
    if conversational_turn is not None and input_data.messages:
        latest_input_message = dump_agui_message(input_data.messages[-1])
        if latest_input_message.get("role") == "user":
            candidate_id = latest_input_message.get("id")
            if isinstance(candidate_id, str):
                conversational_user_id = candidate_id

    def _hold_pending_raw(raw_mirror: Any) -> None:
        """Park a RAW mirror until the run has opened, logging an overflow drop."""
        if len(pending_raw) >= _FOREIGN_EVENT_BUFFER_MAX:
            log_raw_loss(
                "ag-ui-crewai RAW passthrough dropped a pre-RUN_STARTED mirror (hold "
                "buffer full at %d) thread=%s run=%s",
                _FOREIGN_EVENT_BUFFER_MAX,
                input_data.thread_id,
                input_data.run_id,
            )
            return
        pending_raw.append(raw_mirror)

    def _emit_raw(raw_mirror: Any) -> Any:
        """Correlate and encode a RAW mirror for the wire."""
        _stamp_correlation_ids(
            raw_mirror,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )
        return encoder.encode(raw_mirror)

    def _sink(source: Any, event: Any) -> None:
        nonlocal conversational_user_id_applied
        if request_torn_down.is_set() or abandonment.abandoned:
            # Resetting our sink token unregisters us from the REQUEST context
            # only. The conversational worker copied the context at thread start,
            # so it keeps calling this sink for the rest of its turn -- parking
            # into buffers this generator will never read again. Gate on the
            # teardown signal rather than the token, or those buffers grow
            # unbounded; and on teardown rather than abandonment alone, because a
            # turn that finished normally keeps running its tail and is never
            # marked abandoned.
            return
        # CrewAI's conversational runtime reconstructs the pending user turn as
        # a ConversationMessage, whose schema has no ``id`` field. Preserve the
        # AG-UI request id at the synchronous message-added boundary; otherwise
        # every method-finish MESSAGES_SNAPSHOT invents a fresh id and re-anchors
        # the user prompt below any reasoning that already streamed.
        if (
            conversational_user_id is not None
            and not conversational_user_id_applied
            and source is flow_copy
            and getattr(event, "type", None) == "conversation_message_added"
            and getattr(event, "role", None) == "user"
        ):
            state = getattr(source, "state", None)
            messages = (
                getattr(state, "messages", None)
                if state is not None and not isinstance(state, dict)
                else (state or {}).get("messages")
            )
            message_index = getattr(event, "message_index", None)
            if (
                isinstance(messages, list)
                and isinstance(message_index, int)
                and 0 <= message_index < len(messages)
            ):
                stored_message = messages[message_index]
                if isinstance(stored_message, dict):
                    stabilized_message = dict(stored_message)
                else:
                    dump_message = getattr(stored_message, "model_dump", None)
                    stabilized_message = (
                        dump_message(exclude_none=True)
                        if callable(dump_message)
                        else None
                    )
                if isinstance(stabilized_message, dict):
                    stabilized_message["id"] = conversational_user_id
                    messages[message_index] = stabilized_message
                    conversational_user_id_applied = True

        # source is flow_copy isolates the outer run: its own lifecycle/method
        # events and our Bridged* events carry flow_copy as source, while a
        # nested crew.kickoff's own flow's lifecycle/method events leak here
        # with a different source and must stay dropped (no double RUN_STARTED,
        # no mis-nested method). MCP, backend tool (ToolUsage), Crew/Agent
        # lifecycle, and native thinking-chunk events are parked regardless of
        # source because this sink is scoped to the run's context (no cross-run
        # leak); crew/agent events let the translator attribute the hierarchy.
        # crewai's native LLMThinkingChunkEvent (Gemini provider) is emitted with
        # the LLM as source (not flow_copy): park it in raw_events so it is
        # TRANSLATED to REASONING_* -- it therefore never also lands in
        # foreign_events, so RAW passthrough cannot double-emit it. Any other
        # foreign event is parked for RAW passthrough only when opt-in is on
        # (bounded buffer, oldest evicted with a log).
        event_id = getattr(event, "event_id", None)
        if event_id is None:
            return
        if (
            source is flow_copy
            or is_mcp_event(event)
            or is_backend_tool_event(event)
            or is_thinking_event(event)
            or getattr(event, "type", None) in CREW_AGENT_LIFECYCLE_TYPES
        ):
            # Capture EMIT-TIME context (this sink runs synchronously on the
            # flow's timeline) for method finished/failed events: the state
            # snapshot AND the consumed suppression decision. The frame driver
            # translates later, after the flow has run ahead, so both must be
            # captured here or a later method rewrites this method's snapshot or
            # steals its suppression. No-ops for every other event type.
            capture_method_emit_context(event, flow_copy)
            raw_events[event_id] = event
        elif emit_raw_events:
            if len(foreign_events) >= _FOREIGN_EVENT_BUFFER_MAX:
                evicted = next(iter(foreign_events), None)
                if evicted is None:
                    # Only reachable with the cap at 0 (at any positive cap a full
                    # buffer is by definition non-empty), which is a test override
                    # rather than a shipped configuration. Kept so a zero cap
                    # degrades RAW to off instead of raising on ``del ...[None]``.
                    log_raw_loss(
                        "ag-ui-crewai RAW passthrough is disabled by a buffer cap of "
                        "%d thread=%s run=%s",
                        _FOREIGN_EVENT_BUFFER_MAX,
                        input_data.thread_id,
                        input_data.run_id,
                    )
                    return
                del foreign_events[evicted]
                log_raw_loss(
                    "ag-ui-crewai RAW passthrough evicted the oldest parked foreign "
                    "event (buffer full at %d) thread=%s run=%s; its RAW mirror is lost",
                    _FOREIGN_EVENT_BUFFER_MAX,
                    input_data.thread_id,
                    input_data.run_id,
                )
            foreign_events[event_id] = event

    # Predeclared before the ``try`` so the ``finally`` teardown is always safe
    # to reference even if sink registration or ``astream``/``__aiter__`` raises
    # before assignment. ``flow_context`` is set ABOVE and reset in the
    # ``finally`` — mirroring the legacy path's token-then-finally discipline.
    sink_token = None
    session = None
    aiter = None
    resume_read_task = None
    resume_read_cancelled = False
    try:
        try:
            # Register the sink and open the stream INSIDE the ``try`` so a
            # raising ``astream``/``__aiter__`` (a) is caught and mapped through
            # the RUN_ERROR taxonomy below instead of escaping the generator with
            # no terminal event, and (b) never leaks the ``flow_context`` token.
            # Register BEFORE the first ``__anext__``: crewai's astream spawns
            # the flow-running task
            # on first iteration and copies the CURRENT context, so the sink must
            # already be in scope to reach the flow's emits. Guarded so a partial
            # install (no sink API) degrades rather than crashing.
            sink_token = add_stream_sink(_sink) if callable(add_stream_sink) else None
            if resume_feedback is not None:
                # CrewAI has no resume_astream entry point. Its native producer
                # wraps resume_async with the same scoped frames and cancellation
                # used by Flow.astream, without an adapter-owned queue or task.
                state = create_frame_streaming_state([], use_async=True)
                output_holder = []
                session = AsyncStreamSession(async_iterator=create_async_frame_generator(
                    state, lambda: flow_copy.resume_async(resume_feedback), output_holder,
                ))
                output_holder.append(session)
                for event in translator.ensure_run_started():
                    _stamp_correlation_ids(event, thread_id=input_data.thread_id, run_id=input_data.run_id)
                    yield encoder.encode(event)
            elif conversational_turn is None:
                # ``astream`` returns an AsyncStreamSession; iterating it spawns
                # crewai's background kickoff task and streams ordered frames.
                # Filter against astream's own signature so an unsupported kwarg
                # degrades cleanly instead of raising.
                _ckpt = supported_checkpoint_kwargs(
                    flow_copy.astream, checkpoint_kwargs or {}  # type: ignore[attr-defined]
                )
                if checkpoint_kwargs and not _ckpt:
                    # Checkpointing enabled but this flow's astream does not accept
                    # it: warn so the no-op is visible.
                    _LOGGER.warning(
                        "ag-ui-crewai: checkpointing is enabled but flow.astream "
                        "does not accept from_checkpoint; nothing will be persisted "
                        "for this run."
                    )
                session = flow_copy.astream(  # type: ignore[attr-defined]
                    inputs=inputs,
                    **_ckpt,
                )
            else:
                # Reserve the worker slot FIRST, before the flow is touched at
                # all: CrewAI spawns its own thread on the first frame read, and
                # once spawned neither it nor ours can be killed. A rejection
                # here costs one RUN_ERROR; a rejection after the fact costs
                # nothing, because there is nothing left to refuse.
                lease = acquire_conversation_worker(
                    flow_key=conversational_flow_key(flow_copy),
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    signal=abandonment,
                )
                sync_session = None
                try:
                    force_per_turn_trace_finalization(flow_copy)
                    hydrated_inputs = hydrate_conversational_flow(
                        flow_copy,
                        inputs,
                        conversational_turn,
                    )
                    overlay_conversational_persistence(
                        flow_copy,
                        hydrated_inputs,
                        abandonment=abandonment,
                    )
                    sync_session = flow_copy.stream_turn(  # type: ignore[attr-defined]
                        conversational_turn.message,
                        session_id=input_data.thread_id,
                    )
                    # Constructed inside the guard: the adapter is what takes
                    # over releasing the lease, so a constructor that raises
                    # would otherwise leak the slot for the process lifetime.
                    session = SyncStreamSessionAdapter(
                        sync_session,
                        abandonment=abandonment,
                        lease=lease,
                    )
                except BaseException:
                    # No adapter owns the lease OR the session yet: the driver's
                    # ``session`` is still None here, so the teardown aclose()
                    # cannot reach a turn ``stream_turn`` already opened. Close it
                    # first, then give the slot back -- capacity accounting must
                    # not report a slot whose session is still running.
                    _close_orphaned_sync_session(
                        sync_session,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    )
                    lease.release()
                    raise
            aiter = session.__aiter__()
            deadline = (
                time.monotonic() + timeout if timeout is not None else None
            )
            while True:
                # Enforce the wall-clock ceiling per frame read via
                # ``asyncio.wait_for``: on timeout it cancels the in-flight
                # ``__anext__`` AND awaits its unwind before raising, so crewai's
                # in-flight read unwinds cleanly; ``aclose()`` in the ``finally``
                # then cancels the async session or requests a cooperative stop
                # from the conversational sync adapter.
                #
                # Cross-version note (``requires-python`` floor is 3.10):
                # ``wait_for`` internals differ. On 3.12+ it awaits the
                # coroutine inline (no Task wrap, no context copy); on 3.10/3.11
                # it unconditionally does ``fut = ensure_future(fut)``, wrapping
                # ``__anext__`` in a Task and copying the current context per
                # read. The per-read context copy on 3.10/3.11 is HARMLESS here:
                # our ``_sink`` is registered (above) BEFORE this loop, so every
                # per-read context copy inherits it and crewai's
                # ``publish_stream_event`` still reaches it; and both our own and
                # crewai's sink-token ``reset``s happen OUTSIDE the wrapped
                # ``__anext__`` boundary, so no token is reset in a foreign
                # context. Do NOT swap this for a hand-rolled ``ensure_future``
                # + ``asyncio.wait``: that would lose the cancel-and-await-unwind
                # semantics ``wait_for`` gives us on timeout.
                if resume_feedback is not None:
                    # Native resume iteration joins the producer on cancellation.
                    # Supervise its read without awaiting cancellation before
                    # emitting a deadline error. Only this native iterator runs
                    # in a separate task; conversational iterators retain their
                    # owning task/context across yields.
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0:
                        raise _CeilingExceeded(_format_timeout_message(timeout))
                    resume_read_task = asyncio.create_task(aiter.__anext__())
                    done, _ = await asyncio.wait({resume_read_task}, timeout=remaining)
                    if not done:
                        resume_read_task.cancel()
                        resume_read_cancelled = True
                        raise _CeilingExceeded(_format_timeout_message(timeout))
                    try:
                        frame = resume_read_task.result()
                    except StopAsyncIteration:
                        stream_exhausted = True
                        break
                    finally:
                        resume_read_task = None
                elif deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise _CeilingExceeded(_format_timeout_message(timeout))
                    try:
                        frame = await asyncio.wait_for(
                            aiter.__anext__(), timeout=remaining
                        )
                    except StopAsyncIteration:
                        stream_exhausted = True
                        break
                    except (asyncio.TimeoutError, TimeoutError) as te:
                        # ``wait_for``'s own timeout fires only once the
                        # deadline is reached; an upstream ``TimeoutError``
                        # raised by the flow propagates BEFORE that. Use the
                        # wall clock to disambiguate: at/past the deadline =>
                        # our ceiling; earlier => an upstream read timeout that
                        # must NOT masquerade as AGUI_CREWAI_FLOW_TIMEOUT.
                        if time.monotonic() >= deadline:
                            raise _CeilingExceeded(
                                _format_timeout_message(timeout)
                            ) from te
                        raise
                else:
                    try:
                        frame = await aiter.__anext__()
                    except StopAsyncIteration:
                        stream_exhausted = True
                        break

                # Look up the RAW event this frame carries (parked by our sink).
                # Missing => a nested-flow / crewai-internal frame we drop, so
                # the outer run's wire shape stays identical to the legacy path.
                raw_event = raw_events.pop(frame.id, None)
                if raw_event is None:
                    # Not an outer-flow (or MCP) event. With RAW passthrough on, mirror
                    # it if we parked it: crewai's llm / agent / task / tool channels
                    # and nested-flow lifecycle events all land here.
                    foreign_event = foreign_events.pop(frame.id, None)
                    if foreign_event is None:
                        continue
                    raw_mirror = raw_event_for(foreign_event)
                    if raw_mirror is None:
                        continue
                    if not translator.run_started:
                        _hold_pending_raw(raw_mirror)
                        continue
                    yield _emit_raw(raw_mirror)
                    continue

                if emit_raw_events and not is_recognized_event(raw_event):
                    # An OUTER-flow event the translator does not map. Mirrored here
                    # rather than through ``translate`` so the translator keeps one
                    # responsibility, and gated the same way as the foreign path.
                    raw_mirror = raw_event_for(raw_event)
                    if raw_mirror is not None:
                        if translator.run_started:
                            yield _emit_raw(raw_mirror)
                        else:
                            _hold_pending_raw(raw_mirror)

                for event in translator.translate(raw_event):
                    _stamp_correlation_ids(
                        event,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                    )
                    yield encoder.encode(event)
                    if (
                        current_turn_snapshot_pending
                        and event.type == EventType.RUN_STARTED
                    ):
                        initial_messages = MessagesSnapshotEvent(
                            type=EventType.MESSAGES_SNAPSHOT,
                            messages=input_data.messages,
                        )
                        _stamp_correlation_ids(
                            initial_messages,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
                        yield encoder.encode(initial_messages)
                        current_turn_snapshot_pending = False

                if pending_raw and translator.run_started:
                    # The run just opened: flush the mirrors held back so they land
                    # AFTER RUN_STARTED, in arrival order.
                    held, pending_raw = pending_raw, []
                    for raw_mirror in held:
                        yield _emit_raw(raw_mirror)

                if translator.run_finished:
                    # RUN_FINISHED just emitted. Do NOT break-then-aclose(): that
                    # cancels crewai's still-finalizing kickoff task on every
                    # happy-path run. Drain the terminal tail to
                    # natural exhaustion (bounded by the cancel grace) so the run
                    # task completes and the ``finally`` aclose() is a no-op.
                    if resume_feedback is not None:
                        resume_read_task = asyncio.create_task(_drain_frames_after_finish(
                            aiter, thread_id=input_data.thread_id, run_id=input_data.run_id,
                        ))
                        done, _ = await asyncio.wait({resume_read_task}, timeout=_CANCEL_GRACE_SECONDS)
                        if done:
                            stream_exhausted = resume_read_task.result()
                            resume_read_task = None
                        else:
                            resume_read_task.cancel()
                            resume_read_cancelled = True
                    else:
                        stream_exhausted = await _drain_frames_after_finish(
                            aiter,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
                    break

            # Belt-and-braces terminal: the stream can exhaust with the run
            # open but no outer ``flow_finished`` — e.g. the
            # outer method caught a nested-flow error and returned, or a flow
            # paused for human feedback. Emit the missing RUN_FINISHED so the
            # client never sees a run that never ends. The RUN_ERROR paths below
            # are the terminator for the errored case and never reach here.
            #
            # Open the run first whenever RUN_STARTED never went out: a pause
            # captured with no ``flow_started`` frame, or a stream that exhausted
            # before any translatable frame at all. Otherwise finalize() would
            # short-circuit on its run-is-open guard and the request would answer
            # 200 with an empty body, leaving the client's run with no terminal
            # event to end it. Both calls are idempotent, so an already-open run
            # reaches finalize() unchanged.
            for event in (*translator.ensure_run_started(), *translator.finalize()):
                _stamp_correlation_ids(
                    event,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield encoder.encode(event)

        except _HUMAN_FEEDBACK_PENDING_EXC as pending_exc:
            # The pause PROPAGATED out of astream instead of ending the stream
            # cleanly. Seed the pause from the exception context (in case the
            # frames never arrived) and emit the interrupt tail, NOT a
            # RUN_ERROR, which would misreport a paused run as failed. Open the
            # run first: if the pause propagated before a flow_started frame was
            # translated, finalize() would otherwise short-circuit and emit
            # nothing (empty, unresumable stream).
            translator.note_pause_from_context(getattr(pending_exc, "context", None))
            for event in (*translator.ensure_run_started(), *translator.finalize()):
                _stamp_correlation_ids(
                    event,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
                yield encoder.encode(event)
        except ConversationCapacityExceeded as capacity_exc:
            # Declared BEFORE the generic handler so a saturated pool reports
            # saturation, not AGUI_CREWAI_FLOW_ERROR_ConversationCapacityExceeded.
            yield encoder.encode(
                RunErrorEvent(
                    message=(
                        f"thread={input_data.thread_id} run={input_data.run_id}: "
                        f"CrewAI conversational capacity exhausted "
                        f"({capacity_exc.args[0] if capacity_exc.args else ''}); "
                        f"{_conversation_pool_state()}. Raise "
                        f"{MAX_CONVERSATION_WORKERS_ENV_VAR} to admit more "
                        f"concurrent turns, or free slots sooner: "
                        f"{_TURN_BOUND_ADVICE}."
                    ),
                    code="AGUI_CREWAI_CONVERSATION_CAPACITY",
                    **_run_error_extras(input_data),
                )
            )
        except ConversationThreadBusy as busy_exc:
            yield encoder.encode(
                _conversation_thread_busy_error(
                    input_data,
                    busy_exc.args[0] if busy_exc.args else "",
                )
            )
        except _CeilingExceeded as ceiling_exc:
            ceiling_display = f"{timeout:g}s"
            _LOGGER.warning(
                "CrewAI flow exceeded ceiling thread=%s run=%s ceiling=%s detail=%s",
                input_data.thread_id,
                input_data.run_id,
                ceiling_display,
                ceiling_exc.args[0] if ceiling_exc.args else "",
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI flow exceeded ceiling={ceiling_display}"
            )
            for _pending in translator.close_pending():
                yield encoder.encode(_pending)
            for reasoning_frame in _closing_reasoning_frames():
                yield reasoning_frame
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code="AGUI_CREWAI_FLOW_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except (asyncio.TimeoutError, TimeoutError) as upstream_exc:
            # An upstream ``TimeoutError`` bubbled out of the flow (e.g. a
            # LiteLLM/httpx read timeout) — NOT our ceiling. Distinct code so
            # alerting can tell the two apart.
            ceiling_display = (
                "disabled" if timeout is None else f"{timeout:g}s"
            )
            _LOGGER.warning(
                "CrewAI upstream timeout during kickoff thread=%s run=%s "
                "ceiling=%s cause=%s",
                input_data.thread_id,
                input_data.run_id,
                ceiling_display,
                type(upstream_exc).__name__,
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI upstream timeout during kickoff "
                f"(ceiling={ceiling_display} did not fire)"
            )
            for _pending in translator.close_pending():
                yield encoder.encode(_pending)
            for reasoning_frame in _closing_reasoning_frames():
                yield reasoning_frame
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code="AGUI_CREWAI_UPSTREAM_TIMEOUT",
                    **_run_error_extras(input_data),
                )
            )
        except Exception as e:  # pylint: disable=broad-exception-caught
            _LOGGER.exception(
                "CrewAI flow failed thread=%s run=%s cause=%s",
                input_data.thread_id,
                input_data.run_id,
                type(e).__name__,
            )
            message = (
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                f"CrewAI flow failed; see server logs"
            )
            sanitized_name = _sanitize_exception_code(type(e).__name__)
            for _pending in translator.close_pending():
                yield encoder.encode(_pending)
            for reasoning_frame in _closing_reasoning_frames():
                yield reasoning_frame
            yield encoder.encode(
                RunErrorEvent(
                    message=message,
                    code=f"AGUI_CREWAI_FLOW_ERROR_{sanitized_name}",
                    **_run_error_extras(input_data),
                )
            )
    finally:
        # Nothing may park into the request's buffers from here, terminal or not.
        # Set before the clear below so a still-running worker cannot refill them
        # in the window between the clear and its next emit.
        request_torn_down.set()
        # Abandon FIRST, before aclose() and before the sink is unregistered:
        # from this point every other publisher must already be gated. Reached
        # on disconnect, on the AG-UI ceiling, on outer cancellation, and on any
        # early teardown -- everything except a run that terminated.
        #
        # Two ways to terminate, and the RUN_FINISHED one is not optional. A
        # completed conversational turn keeps working after its terminal frame
        # (assistant append, terminal turn handlers, thread join), so the drain
        # routinely times out on a successful run. Treating that as abandonment
        # would drop the turn's persistence writes and refuse the thread's next
        # message. ``run_finished`` covers the pause tail too: ``finalize()``
        # emits RUN_FINISHED with the interrupt outcome.
        try:
            try:
                if not (translator.run_finished or stream_exhausted):
                    abandonment.abandon()
                    if getattr(session, "worker_alive", False):
                        report_conversational_abandonment(
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
            finally:
                # Run aclose() unconditionally (including under outer cancellation)
                # before unregistering the sink and resetting the context var.
                # Async sessions cancel their kickoff task; the conversational sync
                # adapter makes any still-blocked cooperative shutdown observable
                # in its log. In a ``finally`` because the report above reads the
                # registry and logs: a raise there must not cost us the close that
                # hands a never-started worker's pool slot back.
                if resume_feedback is not None:
                    async def close_resume():
                        if resume_read_task is not None:
                            if not resume_read_task.done() and not resume_read_cancelled:
                                resume_read_task.cancel()
                            try:
                                await resume_read_task
                            except (asyncio.CancelledError, StopAsyncIteration):
                                pass
                            except Exception:
                                _LOGGER.debug("CrewAI closing resume read failed", exc_info=True)
                        try:
                            await _aclose_stream_session(session, thread_id=input_data.thread_id, run_id=input_data.run_id)
                        finally:
                            await _aclose_frame_iterator(aiter, thread_id=input_data.thread_id, run_id=input_data.run_id)

                    closing = asyncio.create_task(close_resume())
                    _RESUME_CLOSERS.add(closing)

                    def cancel_slow_close():
                        if not closing.done():
                            _LOGGER.warning(
                                "CrewAI native resume cleanup still running thread=%s run=%s "
                                "after %.3gs; cancelling cleanup",
                                input_data.thread_id, input_data.run_id,
                                _SESSION_CLOSE_TIMEOUT_SECONDS,
                            )
                            # Propagate a second cancellation through the pending
                            # read into a producer blocked in its async finally.
                            closing.cancel()

                    # Keep the deadline independent of the request task: another
                    # disconnect/cancellation must not strand detached cleanup.
                    close_deadline = asyncio.get_running_loop().call_later(
                        _SESSION_CLOSE_TIMEOUT_SECONDS, cancel_slow_close,
                    )

                    def observe_close(task):
                        close_deadline.cancel()
                        _RESUME_CLOSERS.discard(task)
                        if not task.cancelled() and task.exception() is not None:
                            _LOGGER.warning("CrewAI native resume close failed thread=%s run=%s: %s", input_data.thread_id, input_data.run_id, task.exception())
                    closing.add_done_callback(observe_close)
                    done, _ = await asyncio.wait(
                        {closing}, timeout=2 * _SESSION_CLOSE_TIMEOUT_SECONDS,
                    )
                    if done:
                        if not closing.cancelled():
                            closing.result()
                    else:
                        _LOGGER.warning(
                            "CrewAI native resume cleanup ignored cancellation thread=%s run=%s",
                            input_data.thread_id, input_data.run_id,
                        )
                else:
                    try:
                        await _aclose_stream_session(
                            session,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
                    finally:
                        # After the session, because the session-level teardown is what
                        # makes the iterator's own unwind cheap: crewai's async session
                        # has already cancelled its kickoff task, and the conversational
                        # adapter has already asked its worker to stop. In a ``finally``
                        # of its own because the session close deliberately re-raises
                        # CancelledError, and a cancel there IS the disconnect this
                        # close exists for -- as a sequential statement it was skipped
                        # on exactly that path, leaving the adapter's loop and queue
                        # (with every undelivered frame) reachable until the collector.
                        await _aclose_frame_iterator(
                            aiter,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
        finally:
            try:
                if sink_token is not None and callable(reset_stream_sinks):
                    reset_stream_sinks(sink_token)
            finally:
                try:
                    # Request-owned buffers. Dropped here rather than left to GC
                    # because a still-running conversational worker (abandoned or
                    # merely finishing its tail) keeps a reference to this closure
                    # through its copied context, so a parked raw event would
                    # otherwise stay reachable for the rest of the turn.
                    raw_events.clear()
                    foreign_events.clear()
                    pending_raw.clear()
                finally:
                    flow_context.reset(token)


def _run_flow_stream(
    *,
    flow_copy: object,
    encoder: EventEncoder,
    input_data: RunAgentInput,
    inputs: dict,
    timeout: float | None,
    checkpoint_kwargs: dict | None = None,
    hitl_options: HITLOptions | None = None,
    emit_raw_events: bool = False,
    emission_shape: str = DEFAULT_EMISSION_SHAPE,
    conversational_turn: ConversationalTurn | None = None,
):
    """Require native streaming; custom kickoff-only flows are unsupported."""
    if conversational_turn is None and not flow_supports_stream_frames(flow_copy):
        return _reject_unsupported_native_flow(input_data, encoder)
    return _run_flow_frame_stream(
        flow_copy=flow_copy, encoder=encoder, input_data=input_data,
        inputs=inputs, timeout=timeout, checkpoint_kwargs=checkpoint_kwargs,
        hitl_options=hitl_options, emit_raw_events=emit_raw_events,
        emission_shape=emission_shape, conversational_turn=conversational_turn,
    )


async def _reject_unsupported_native_flow(input_data: RunAgentInput, encoder: EventEncoder):
    yield encoder.encode(RunErrorEvent(
        message="CrewAI native streaming is required: install crewai>=1.15.7,<2 "
                "and implement Flow.astream() returning an AsyncStreamSession. "
                "Custom kickoff_async-only flows are no longer supported.",
        code="AGUI_CREWAI_NATIVE_STREAMING_REQUIRED",
        **_run_error_extras(input_data),
    ))


async def _reject_unsupported_resume(input_data: RunAgentInput, encoder: EventEncoder):
    """Emit a single RUN_ERROR for a resume the installed crewai cannot honour.

    A resume request arrived but the async-HITL API is unavailable (crewai too
    old, or a flow that cannot pause/resume). Fail loudly and correlated rather
    than silently starting a fresh run.
    """
    _LOGGER.warning(
        "CrewAI resume requested but async human-feedback is unsupported "
        "thread=%s run=%s (need crewai>=%s + StreamFrame)",
        input_data.thread_id,
        input_data.run_id,
        HITL_ENABLING_VERSIONS["human_feedback"],
    )
    yield encoder.encode(
        RunErrorEvent(
            message=(
                f"thread={input_data.thread_id} run={input_data.run_id}: CrewAI "
                f"resume is unsupported by this deployment; async human-feedback "
                f"needs crewai>={HITL_ENABLING_VERSIONS['human_feedback']} with "
                f"the StreamFrame transport"
            ),
            code="AGUI_CREWAI_RESUME_UNSUPPORTED",
            **_run_error_extras(input_data),
        )
    )


async def _reject_unsupported_conversational_flow(
    input_data: RunAgentInput,
    encoder: EventEncoder,
):
    """Fail loudly when conversational execution was explicitly requested."""
    _LOGGER.warning(
        "CrewAI conversational Flow requested but unavailable thread=%s run=%s",
        input_data.thread_id,
        input_data.run_id,
    )
    yield encoder.encode(
        RunErrorEvent(
            message=(
                f"thread={input_data.thread_id} run={input_data.run_id}: "
                "CrewAI conversational Flow execution is unsupported; the flow "
                "must set conversational=True and expose stream_turn"
            ),
            code="AGUI_CREWAI_CONVERSATIONAL_FLOW_UNSUPPORTED",
            **_run_error_extras(input_data),
        )
    )


async def _run_flow_resume_stream(
    *,
    flow: object,
    encoder: EventEncoder,
    input_data: RunAgentInput,
    timeout: float | None,
    hitl_options: HITLOptions | None = None,
    emit_raw_events: bool = False,
    conversational: bool = False,
    emission_shape: str = DEFAULT_EMISSION_SHAPE,
):
    """Reload a persisted pending flow and resume through the native frame driver.

    CrewAI owns the frame producer task, ordered queue and async cancellation.
    The shared driver preserves state, RAW, tools and terminal error handling.
    """
    thread_id = input_data.thread_id
    run_id = input_data.run_id
    feedback, _interrupt_id = feedback_from_resume(input_data)

    # A resume of a CONVERSATIONAL flow is another run for that conversation, so
    # the same-conversation guard applies to it as much as to a fresh turn: an
    # abandoned worker is still writing this conversation's state and finishes last
    # as often as not. Refused BEFORE ``from_pending`` so the resume never reads the
    # state it would race.
    #
    # This driver also serves REGULAR flows, which share nothing with a
    # conversational turn but a client-chosen ``threadId``. Refusing one of those
    # strands a paused run: a resume is the only way to complete it, and there is no
    # later turn to retry with. So the gate is scoped to the flow AND to
    # conversational mode, not to the thread alone.
    busy_run = (
        abandoned_conversational_run_for_thread(
            thread_id, flow_key=conversational_flow_key(flow)
        )
        if conversational
        else None
    )
    if busy_run is not None:
        _LOGGER.warning(
            "CrewAI resume refused while an abandoned conversational turn holds "
            "the thread thread=%s run=%s holder=%s",
            thread_id,
            run_id,
            busy_run,
        )
        yield encoder.encode(
            _conversation_thread_busy_error(
                input_data,
                conversational_thread_busy_detail(
                    thread_id=thread_id,
                    run_id=busy_run,
                ),
            )
        )
        return

    # Reload the pending flow. ``from_pending`` builds its own instance from the
    # class + crewai persistence; a missing pending state (unknown / already
    # resumed thread) is a client-correlated 4xx-style condition, distinct from
    # an internal failure.
    try:
        resumed_flow = type(flow).from_pending(thread_id)  # type: ignore[attr-defined]
    except ValueError as exc:
        _LOGGER.warning(
            "CrewAI resume found no pending feedback thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            exc,
        )
        yield encoder.encode(
            RunErrorEvent(
                message=(
                    f"thread={thread_id} run={run_id}: no paused CrewAI flow to "
                    f"resume (unknown or already-resumed thread)"
                ),
                code="AGUI_CREWAI_NO_PENDING_FEEDBACK",
                **_run_error_extras(input_data),
            )
        )
        return
    except Exception as exc:  # pylint: disable=broad-exception-caught
        _LOGGER.exception(
            "CrewAI resume reload failed thread=%s run=%s cause=%s",
            thread_id,
            run_id,
            type(exc).__name__,
        )
        yield encoder.encode(
            RunErrorEvent(
                message=(
                    f"thread={thread_id} run={run_id}: CrewAI resume reload "
                    f"failed; see server logs"
                ),
                code=f"AGUI_CREWAI_FLOW_ERROR_{_sanitize_exception_code(type(exc).__name__)}",
                **_run_error_extras(input_data),
            )
        )
        return

    # ``from_pending`` built its own instance for THIS request, so scoping it
    # mutates nothing shared. A resumed run is still one thread's conversation,
    # and its crew writes to memory like any other run.
    apply_thread_memory_scope(resumed_flow, thread_id)

    # The method that paused for feedback emitted neither finished nor failed, so
    # its node-exit suppression flags were never consumed. Clear them on the
    # reloaded flow before resume_async runs (on the flow timeline, before any
    # emit) so a stale predicted-tool / manual-emit flag cannot wrongly suppress
    # the resumed run's first snapshot.
    reset_node_snapshot_suppression(resumed_flow)

    stream = _run_flow_frame_stream(
        flow_copy=resumed_flow, encoder=encoder, input_data=input_data,
        inputs={}, timeout=timeout, hitl_options=hitl_options,
        emit_raw_events=emit_raw_events, resume_feedback=feedback,
        emission_shape=emission_shape,
    )
    try:
        async for event in stream:
            yield event
    finally:
        await stream.aclose()


def add_crewai_flow_fastapi_endpoint(
    app: FastAPI | APIRouter,
    flow: Flow,
    path: str = "/",
    *,
    emit_interrupt_outcome: bool = False,
    enable_legacy_on_interrupt_event: bool = True,
    emit_raw_events: bool | None = None,
    emission_shape: str | None = None,
    conversational: bool = False,
    **kwargs: Any,
):
    """Adds a CrewAI endpoint to the FastAPI app.

    ``emit_raw_events`` opts into RAW passthrough: the crewai events this bridge does
    not map (its llm / agent / task / tool channels, nested-flow lifecycle, internals)
    are mirrored onto AG-UI ``RAW`` events. Off by default; ``None`` reads
    ``AGUI_CREWAI_EMIT_RAW_EVENTS``.

    ``emission_shape`` selects the wire shape for text / tool-call output:
    ``"triples"`` (START/CONTENT/END, the default) or ``"chunks"`` (the previous
    CHUNK form); ``None`` reads ``AGUI_CREWAI_EMISSION_SHAPE``. Both it and
    ``emit_raw_events`` resolve at registration, so a bad value fails once at
    startup rather than per request.

    ``conversational=True`` drives CrewAI's public ``stream_turn`` API and maps
    AG-UI ``thread_id`` to CrewAI ``session_id``. It fails loudly when the
    supplied flow has not opted into CrewAI conversational mode.

    Async human-in-the-loop: when the flow pauses on an ``@human_feedback``
    method whose provider raises ``HumanFeedbackPending`` (see
    :data:`ag_ui_crewai.agui_feedback_provider`), the run terminates with an
    AG-UI interrupt and the next request carrying ``RunAgentInput.resume[]``
    resumes it via ``Flow.from_pending`` + ``resume_async``.

    ``emit_interrupt_outcome`` (default False) opts into the structured
    ``RUN_FINISHED.outcome``. CopilotKit < 1.61.2 breaks on it, so it stays off
    by default and the interrupt is surfaced via the legacy ``on_interrupt``
    CUSTOM event. Disabling ``enable_legacy_on_interrupt_event`` forces the
    outcome on so the interrupt is always surfaced by at least one channel.

    IMPORTANT for CopilotKit >= 1.61.2 (``useInterrupt``): resume works only via
    the structured outcome. The legacy ``on_interrupt`` channel renders the
    interrupt but its ``resolve()`` does not send a ``RunAgentInput.resume[]``
    back, so the run re-kicks off and re-pauses in a loop. Pass
    ``emit_interrupt_outcome=True`` (or ``enable_legacy_on_interrupt_event=False``)
    for those clients.

    ``**kwargs`` are forwarded to ``app.post`` (``name``, ``tags``,
    ``operation_id``, ``dependencies``, ``include_in_schema``, ...).
    """
    hitl_options = HITLOptions(
        emit_interrupt_outcome=emit_interrupt_outcome,
        enable_legacy_on_interrupt_event=enable_legacy_on_interrupt_event,
    )

    # Resolved HERE, not per request: a wrong-typed argument should fail once at
    # startup rather than on every call.
    resolved_emit_raw_events = resolve_emit_raw_events(emit_raw_events)
    resolved_emission_shape = resolve_emission_shape(emission_shape)

    @app.post(path, **kwargs)
    async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
        """Agentic chat endpoint"""

        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        timeout = _flow_timeout_seconds()

        if conversational and not flow_supports_conversational_stream(flow):
            return StreamingResponse(
                _reject_unsupported_conversational_flow(input_data, encoder),
                media_type=encoder.get_content_type(),
            )

        # Resume a paused flow. ``from_pending`` reloads persisted pending state
        # (not a per-request copy), so the resume driver takes the ORIGINAL flow
        # (for its class) rather than a fresh ``_copy_flow``.
        if resume_requested(input_data):
            if not flow_supports_human_feedback(flow):
                return StreamingResponse(
                    _reject_unsupported_resume(input_data, encoder),
                    media_type=encoder.get_content_type(),
                )
            return StreamingResponse(
                _run_flow_resume_stream(
                    flow=flow,
                    encoder=encoder,
                    input_data=input_data,
                    timeout=timeout,
                    hitl_options=hitl_options,
                    emit_raw_events=resolved_emit_raw_events,
                    conversational=conversational,
                    emission_shape=resolved_emission_shape,
                ),
                media_type=encoder.get_content_type(),
            )

        flow_copy = _copy_flow(flow)
        # Copying the flow does NOT isolate crew memory: crewai keeps it in a
        # shared on-disk store namespaced by crew name, so every threadId would
        # otherwise read and write the same namespace. Scope it here, before a
        # run driver is selected, so both drivers are covered.
        apply_thread_memory_scope(flow_copy, input_data.thread_id)

        inputs = crewai_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
            context=input_data.context,
            forwarded_props=input_data.forwarded_props,
        )
        # Keep the thread linkage crewai has always used; checkpointing layers
        # on top and is off unless CREWAI_CHECKPOINT is set.
        inputs["id"] = input_data.thread_id

        checkpoint_kwargs = build_checkpoint_kwargs(flow_copy, input_data)
        conversational_turn = (
            prepare_conversational_turn(input_data.messages)
            if conversational
            else None
        )

        return StreamingResponse(
            _run_flow_stream(
                flow_copy=flow_copy,
                encoder=encoder,
                input_data=input_data,
                inputs=inputs,
                timeout=timeout,
                checkpoint_kwargs=checkpoint_kwargs,
                hitl_options=hitl_options,
                emit_raw_events=resolved_emit_raw_events,
                emission_shape=resolved_emission_shape,
                conversational_turn=conversational_turn,
            ),
            media_type=encoder.get_content_type(),
        )


def add_crewai_crew_fastapi_endpoint(
    app: FastAPI | APIRouter,
    crew: CrewBaseInstance,
    path: str = "/",
    *,
    emit_raw_events: bool | None = None,
    emission_shape: str | None = None,
    **kwargs: Any,
):
    """Adds a CrewAI crew endpoint to the FastAPI app.

    ``crew`` must be a crew wrapper exposing a ``crew()`` factory (see
    :class:`CrewBaseInstance`) — a ``@CrewBase``-decorated instance or an
    equivalent wrapper — NOT a bare :class:`crewai.Crew`. The deferred
    ``ChatWithCrewFlow`` construction calls ``crew.crew()`` and reads the
    crew name via ``_read_crew_name`` (which accepts either a
    ``@CrewBase``'s ``_crew_name`` or a hand-rolled ``.name``).

    ChatWithCrewFlow construction is deferred to first request because the
    constructor calls crew_chat_generate_crew_chat_inputs which makes an LLM
    call. At import time the LLM mock server may not be running yet.

    ``**kwargs`` are forwarded to ``app.post`` (``name``, ``tags``,
    ``operation_id``, ``dependencies``, ``include_in_schema``, ...).
    """
    resolved_emit_raw_events = resolve_emit_raw_events(emit_raw_events)
    resolved_emission_shape = resolve_emission_shape(emission_shape)

    _cached_flow = None
    # Dedicated per-endpoint lock so two concurrent first-requests cannot
    # both call ``ChatWithCrewFlow(crew=crew)`` — which issues a real LLM
    # call — and waste API budget / memory.
    _flow_lock = asyncio.Lock()

    async def _get_flow():
        nonlocal _cached_flow
        if _cached_flow is not None:
            return _cached_flow
        async with _flow_lock:
            if _cached_flow is None:
                _cached_flow = ChatWithCrewFlow(crew=crew)
            return _cached_flow

    @app.post(path, **kwargs)
    async def crew_endpoint(input_data: RunAgentInput, request: Request):
        """Crew chat endpoint with deferred initialization."""
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        # The crew endpoint wraps its crew in a ``ChatWithCrewFlow`` that cannot
        # be rebuilt via ``from_pending`` (its constructor needs the crew), and a
        # crew never pauses for async feedback. Reject a resume directive
        # explicitly rather than silently starting a fresh run.
        if resume_requested(input_data):
            return StreamingResponse(
                _reject_unsupported_resume(input_data, encoder),
                media_type=encoder.get_content_type(),
            )

        flow = await _get_flow()
        flow_copy = _copy_flow(flow)
        # Copying the flow does NOT isolate crew memory: crewai keeps it in a
        # shared on-disk store namespaced by crew name, so every threadId would
        # otherwise read and write the same namespace. Scope it here, before a
        # run driver is selected, so both drivers are covered.
        apply_thread_memory_scope(flow_copy, input_data.thread_id)

        inputs = crewai_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
            context=input_data.context,
            forwarded_props=input_data.forwarded_props,
        )
        # Keep the thread linkage; layer opt-in checkpointing on top.
        inputs["id"] = input_data.thread_id

        checkpoint_kwargs = build_checkpoint_kwargs(flow_copy, input_data)

        timeout = _flow_timeout_seconds()

        return StreamingResponse(
            _run_flow_stream(
                flow_copy=flow_copy,
                encoder=encoder,
                input_data=input_data,
                inputs=inputs,
                timeout=timeout,
                checkpoint_kwargs=checkpoint_kwargs,
                emit_raw_events=resolved_emit_raw_events,
                emission_shape=resolved_emission_shape,
            ),
            media_type=encoder.get_content_type(),
        )


def crewai_prepare_inputs(  # pylint: disable=unused-argument, too-many-arguments
    *,
    state: dict,
    messages: list[Message],
    tools: list[Tool],
    context: list[Context] | None = None,
    forwarded_props: Any = None,
):
    """Default merge state for CrewAI"""
    # ``RunAgentInput.state`` is typed ``Any`` and required, so a client may
    # legally send ``state: null`` or a non-mapping value. The ``{**state}``
    # spread below would raise ``TypeError`` on such input, and because this
    # helper runs in the endpoint body BEFORE the ``StreamingResponse`` is
    # constructed, that crash escapes the RUN_ERROR taxonomy as an uncorrelated
    # 500. Coerce a non-mapping state to an empty dict so the run proceeds
    # instead of dying opaquely.
    if not isinstance(state, dict):
        state = {}

    # Serialize messages, converting multimodal parts to LiteLLM's image_url
    # shape so litellm.acompletion does not fail on them.
    messages = [dump_agui_message(message) for message in messages]

    if len(messages) > 0:
        if "role" in messages[0] and messages[0]["role"] == "system":
            messages = messages[1:]

    actions = [{
        "type": "function",
        "function": {
            **tool.model_dump(),
        }
    } for tool in tools]

    # Thread ``forwardedProps`` into the run.
    #
    # Frontend callers send these keys in camelCase; downstream flow / tool
    # code reads snake_case, so normalize before merging (parity with the
    # LangGraph adapter's ``camel_to_snake`` pass). These are transient
    # per-request streaming hints, so they carry the LOWEST precedence: spread
    # FIRST, so both the agent's persisted ``state`` and the reserved keys
    # below (``messages`` / ``tools`` / ``context`` / ``copilotkit``) win on a
    # name collision. This mirrors the LangGraph adapter, where the run payload
    # is spread AFTER forwarded_props (``{**forwarded_props, **payload_input}``)
    # so a forwarded key can never silently overwrite persisted agent state.
    normalized_forwarded_props: dict = {}
    if isinstance(forwarded_props, dict):
        normalized_forwarded_props = {
            camel_to_snake(k): v for k, v in forwarded_props.items()
        }

    # Thread ``input.context`` into the run so agent code and tools can read it
    # from state. Serialize each entry to a plain dict so the flow
    # state stays JSON-safe and tools can read ``entry["value"]`` directly.
    context_list = [entry.model_dump() for entry in context] if context else []

    new_state = {
        # Lowest precedence first: transient forwarded hints, then persisted
        # state, then the reserved AG-UI keys (spread last, always win).
        **normalized_forwarded_props,
        **state,
        "messages": messages,
        # Expose frontend tools at a top-level ``tools`` key too. crewai has
        # historically only surfaced them under ``copilotkit.actions``; the
        # top-level key gives framework-neutral
        # agent code a stable place to read them (parity with LangGraph's
        # ``ag_ui_state["tools"]``). ``copilotkit.actions`` is kept for
        # backward compatibility.
        "tools": actions,
        "context": context_list,
        "copilotkit": {
            "actions": actions
        }
    }

    # A2UI: route the component-schema context entry and the ``injectA2UITool``
    # runtime flag into the canonical ``state["ag-ui"]`` namespace the a2ui
    # subagent tool reads (matching the LangGraph / Strands adapters). Added
    # ONLY when A2UI is actually in play so non-A2UI runs see no state change.
    inject_flag = (
        forwarded_props.get("injectA2UITool")
        if isinstance(forwarded_props, dict)
        else None
    )
    a2ui_schema_value, a2ui_regular_context = split_a2ui_schema_context(context_list)
    if a2ui_schema_value is not None or inject_flag is not None:
        ag_ui_ns: dict = {"context": a2ui_regular_context}
        if a2ui_schema_value is not None:
            ag_ui_ns["a2ui_schema"] = a2ui_schema_value
            # Route the (large) A2UI component-schema entry into ``ag-ui`` only:
            # drop it from the top-level ``context`` so framework-neutral agent
            # code does not receive the schema blob as if it were user context
            # (and it does not round-trip via STATE_SNAPSHOT twice).
            new_state["context"] = a2ui_regular_context
        if inject_flag is not None:
            ag_ui_ns["inject_a2ui_tool"] = inject_flag
        new_state["ag-ui"] = ag_ui_ns
    else:
        # ``ag-ui`` is an adapter-owned namespace, and it round-trips to the
        # client via STATE_SNAPSHOT. A prior turn's ``inject_a2ui_tool`` /
        # ``a2ui_schema`` echoed back in ``state`` would otherwise survive the
        # ``**state`` spread and silently re-enable injection on a turn the
        # frontend left A2UI off. Own it authoritatively: drop the stale entry
        # when A2UI is not in play this turn.
        new_state.pop("ag-ui", None)

    return new_state
