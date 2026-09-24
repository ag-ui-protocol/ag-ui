"""Reconcile frontend (proxy) tool results into a Strands ``SessionManager``.

Frontend tools are executed on the client, so server-side the proxy returns a
placeholder ``toolResult`` (``"Forwarded to client"``). The real result only
arrives on the next run inside ``RunAgentInput.messages``, under the same
``toolUseId`` Strands persisted, so this module can find the persisted
placeholder and overwrite it with the real result.

Nothing on that continuation says who executed the call. The adapter therefore
records the id of every frontend call it emits durably on the agent's session
state (see ``AG_UI_FRONTEND_CALL_IDS_STATE_KEY``): membership there is what
tells a client-executed result apart from one Strands produced itself. The ids
are held in recorded order rather than as a bare set, because the size cap
applied at emission evicts the oldest first.
"""

from __future__ import annotations

from typing import Any, Iterable, Literal, Mapping, Tuple

from .client_proxy_tool import PROXY_RESULT_PLACEHOLDER
from .interrupt_checkpoint import parked_tool_results, publish_parked_tool_results

try:
    from strands.session.snapshot_session_manager import (
        SnapshotSessionManager as _SnapshotSessionManager,
    )
except ImportError:  # SDK releases before snapshot sessions (< 1.51)
    _SnapshotSessionManager = None

# Key under which the adapter stores the ids of the frontend tool calls it has
# emitted, as a JSON list on the Strands agent's session state. Namespaced to
# avoid clashing with user-managed state keys.
#
# The stored name predates the identifier unification, and so does the shape it
# may hold: releases before that unification minted their own id per frontend
# call and stored a ``{minted_id: toolUseId}`` mapping. Those minted ids name
# nothing in the persisted history, so a reader that trusted them as provenance
# would conclude there was nothing to correct and replay an uncorrected
# placeholder to the model. The old shape is therefore discarded on read rather
# than translated. Only a frontend call left in flight across the upgrade is
# affected, and what happens to it depends on the checkpoint: an ordinary
# continuation degrades to the legacy path, which forwards the client's answer
# as a synthetic message, while one parked in an active checkpoint cannot be
# resumed at all, because connecting the answer to the persisted placeholder
# needs exactly the translation this adapter no longer performs.
AG_UI_FRONTEND_CALL_IDS_STATE_KEY = "__ag_ui_wire_to_native__"

# Key under which the adapter stores every ``toolUseId`` tool call metadata
# (name, args, input, strands_tool_id) on the Strands agent's session state.
# On a native-interrupt RESUME run Strands does not re-invoke the model for the
# interrupted tool, so no ``current_tool_use`` events fire and the in-run
# ``tool_calls_seen`` dict is empty when the ``toolResult`` arrives. Reading
# from this durable map at that point restores ``tool_name`` (and thus every
# ``tool_behaviors`` gate + the frontend-placeholder skip) for the resumed
# tool. Namespaced to avoid clashing with user-managed state keys.
AG_UI_TOOL_CALL_MAP_STATE_KEY = "__ag_ui_tool_call_map__"


def recorded_frontend_call_ids(agent: Any) -> list[str]:
    """Return the frontend-call ids recorded on *agent*'s session state.

    Both the continuation read and the emission write go through here so they
    cannot disagree about the stored shape: a writer that coerced the legacy
    mapping would persist its keys as a well-formed list, and every later read
    would then trust ids that name nothing.
    """
    stored = agent.state.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY) or ()
    # Accept only the shape this adapter writes. Anything else is either the
    # pre-unification mapping (see the key's definition) or state some other
    # writer left behind; a permissive read turns a stored string into one id
    # per character and a stored number into a TypeError at the write site.
    if not isinstance(stored, (list, tuple)):
        return []
    return [
        call_id
        for call_id in stored
        if isinstance(call_id, str) and call_id.strip()
    ]


def _supports_repository_reconciliation(session_manager: Any, agent: Any) -> bool:
    """Return whether the exact public repository rewrite API is available."""
    if session_manager is None:
        return False
    try:
        session_id = session_manager.session_id
        repository = session_manager.session_repository
        agent_id = agent.agent_id
        list_messages = getattr(repository, "list_messages", None)
        update_message = getattr(repository, "update_message", None)
    except Exception:  # noqa: BLE001 - unsafe/missing capability fails closed
        return False
    return (
        isinstance(session_id, str)
        and bool(session_id)
        and isinstance(agent_id, str)
        and bool(agent_id)
        and callable(list_messages)
        and callable(update_message)
    )


def _supports_snapshot_reconciliation(session_manager: Any, agent: Any) -> bool:
    """Return whether *session_manager* persists the whole agent as a snapshot."""
    if _SnapshotSessionManager is None or not isinstance(
        session_manager, _SnapshotSessionManager
    ):
        return False
    try:
        session_id = session_manager.session_id
        agent_id = agent.agent_id
    except Exception:  # noqa: BLE001 - unsafe/missing capability fails closed
        return False
    return (
        isinstance(session_id, str)
        and bool(session_id)
        and isinstance(agent_id, str)
        and bool(agent_id)
    )


def session_reconciliation_kind(
    session_manager: Any, agent: Any
) -> Literal["repository", "snapshot"] | None:
    """Return how a corrected result can reach this session's store, if at all."""
    if _supports_repository_reconciliation(session_manager, agent):
        return "repository"
    if _supports_snapshot_reconciliation(session_manager, agent):
        return "snapshot"
    return None


def prune_corrected_call_ids(
    agent: Any, recorded_call_ids: list[str], corrected_ids: set[str]
) -> None:
    """Drop recorded frontend-call ids whose placeholder is now corrected.

    Order is preserved so the emission-time size cap keeps evicting oldest
    first. Ids left uncorrected stay recorded so a later turn can retry them.
    """
    if not (recorded_call_ids and corrected_ids):
        return
    remaining = [
        call_id for call_id in recorded_call_ids if call_id not in corrected_ids
    ]
    if len(remaining) != len(recorded_call_ids):
        agent.state.set(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, remaining)


async def reconcile_snapshot_tool_results(
    session_manager: Any,
    agent: Any,
    pending_results: Mapping[str, Tuple[str, bool]],
    recorded_call_ids: list[str],
) -> set[str]:
    """Correct placeholder results in the agent and persist them as a snapshot.

    A snapshot holds the whole agent, so the live history and any parked
    interrupt batch are corrected in place, the corrected ids are pruned from
    the recorded frontend-call ids, and only then is ``snapshot_latest``
    written, so the save carries no stale bookkeeping. Under
    ``save_latest_on="trigger"`` nothing is written here: the correction stays
    in memory and persists with whatever the user's trigger saves.

    If the save fails, the corrections and the prune are both undone before
    re-raising, so an unsaved correction is never mistaken for an answered call
    by the caller's fallback or a retry.

    Returns the same set as :func:`reconcile_frontend_tool_results`.
    """
    undo: list[tuple[dict, dict[str, Any]]] = []
    state_before = agent.state.get() or {}
    had_call_ids = AG_UI_FRONTEND_CALL_IDS_STATE_KEY in state_before
    call_ids_before = state_before.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY)
    try:
        corrected = _correct_live_agent(agent, pending_results, undo=undo)
        prune_corrected_call_ids(agent, recorded_call_ids, corrected)
        pruned = (
            agent.state.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY) != call_ids_before
        )
        if (undo or pruned) and _snapshot_saves_latest_between_triggers(
            session_manager
        ):
            await session_manager.save_snapshot(agent, is_latest=True)
    except BaseException:
        for tool_result, original in reversed(undo):
            for key in ("content", "status"):
                if key in original:
                    tool_result[key] = original[key]
                else:
                    tool_result.pop(key, None)
        if had_call_ids:
            agent.state.set(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, call_ids_before)
        elif AG_UI_FRONTEND_CALL_IDS_STATE_KEY in (agent.state.get() or {}):
            agent.state.delete(AG_UI_FRONTEND_CALL_IDS_STATE_KEY)
        raise
    return corrected


def _snapshot_saves_latest_between_triggers(session_manager: Any) -> bool:
    """Whether the manager writes ``snapshot_latest`` outside its trigger.

    The SDK keeps the constructor's ``save_latest_on`` on ``_save_latest_on``
    (``"message"``, ``"invocation"`` or ``"trigger"``).
    """
    return getattr(session_manager, "_save_latest_on", "invocation") != "trigger"


def reconcile_frontend_tool_results(
    session_manager: Any,
    agent: Any,
    pending_results: Mapping[str, Tuple[str, bool]],
) -> set[str]:
    """Overwrite persisted placeholder ``toolResult`` blocks with real results.

    ``pending_results`` MUST be keyed by the ``toolUseId`` Strands persisted,
    which for a frontend call is also the id the client answers under.

    Args:
        session_manager: A Strands ``RepositorySessionManager`` (exposes
            ``session_id`` and ``session_repository``).
        agent: The Strands agent (exposes ``agent_id``).
        pending_results: Map of ``toolUseId`` -> ``(real result text,
            is_error)``.

    Returns:
        The set of ``toolUseId``s whose pending result was already present or
        whose placeholder was corrected in any reconciliation surface.
    """
    session_id = session_manager.session_id
    agent_id = agent.agent_id
    repository = session_manager.session_repository

    corrected: set[str] = set()
    for session_message in repository.list_messages(session_id, agent_id):
        mutated: set[str] = set()
        matched = _correct_message(
            session_message.message, pending_results, mutated_ids=mutated
        )
        if mutated:
            repository.update_message(session_id, agent_id, session_message)
        corrected |= matched

    return corrected | _correct_live_agent(agent, pending_results)


def _correct_live_agent(
    agent: Any,
    pending_results: Mapping[str, Tuple[str, bool]],
    *,
    undo: list | None = None,
) -> set[str]:
    """Correct the agent's live history and any parked interrupt batch.

    The live history is what a same-process continuation (and
    ``stream_async(None)``) reads. Once an interrupt is active, failure to
    correct its parked results must reach the adapter so it can stop before
    Strands consumes the checkpoint.
    """
    corrected: set[str] = set()
    for message in getattr(agent, "messages", None) or []:
        corrected |= _correct_message(message, pending_results, undo=undo)

    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is not None and getattr(interrupt_state, "activated", False):
        tool_results = parked_tool_results(interrupt_state)
        if tool_results:
            mutated: set[str] = set()
            corrected |= _correct_all_tools(
                tool_results, pending_results, mutated_ids=mutated, undo=undo
            )
            if mutated:
                # The edit above already reaches the run in flight. This is
                # what makes it reach the next process: see the writer's own
                # note on the session manager's version check.
                publish_parked_tool_results(interrupt_state, tool_results)
    return corrected


def has_placeholder_results(messages: Iterable[Any], only_ids: Any = None) -> bool:
    """Return True if a matching ``toolResult`` is still the proxy stub.

    Used to gate the continuation stream: it is only safe to replay the native
    history to the model (``stream_async(None)``) when no relevant ``"Forwarded
    to client"`` placeholder remains to be fed to it.

    Args:
        messages: The native Strands history to scan.
        only_ids: If given, restrict the scan to ``toolResult`` blocks whose
            ``toolUseId`` is in this set — so stale placeholders from prior
            turns (e.g. intentionally-uncorrected void calls) don't count.
    """
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            tool_result = block.get("toolResult")
            if not isinstance(tool_result, dict):
                continue
            if only_ids is not None and tool_result.get("toolUseId") not in only_ids:
                continue
            if _is_placeholder(tool_result.get("content")):
                return True
    return False


def active_proxy_placeholder_ids(agent: Any) -> set[str]:
    """Return ids for exact proxy placeholders parked by an active checkpoint."""
    interrupt_state = getattr(agent, "_interrupt_state", None)
    if interrupt_state is None or not getattr(interrupt_state, "activated", False):
        return set()
    tool_results = parked_tool_results(interrupt_state)
    if tool_results is None:
        return set()

    return {
        tool_result["toolUseId"]
        for tool_result in tool_results
        if isinstance(tool_result, dict)
        and set(tool_result) == {"toolUseId", "status", "content"}
        and isinstance(tool_result["toolUseId"], str)
        and bool(tool_result["toolUseId"].strip())
        and tool_result["status"] == "success"
        and tool_result["content"] == [{"text": PROXY_RESULT_PLACEHOLDER}]
    }


def _correct_single_tool(
    tool_result,
    pending_results: Mapping[str, Tuple[str, bool]],
    *,
    mutated_ids: set[str] | None = None,
    undo: list | None = None,
) -> str | None:
    """Reconcile a matching ToolResult dict and return its tool_use_id.

    ``undo``, when given, collects ``(tool_result, original)`` before each
    rewrite, where ``original`` holds only the ``content``/``status`` keys the
    block actually had, so a caller can put back its exact shape.
    """
    if not isinstance(tool_result, dict):
        return None

    tool_use_id = tool_result.get("toolUseId")
    if tool_use_id not in pending_results:
        return None

    text, is_error = pending_results[tool_use_id]
    expected_content = [{"text": text}]
    expected_status = "error" if is_error else "success"
    if (
        tool_result.get("status") == expected_status
        and tool_result.get("content") == expected_content
    ):
        return tool_use_id
    if _is_placeholder(tool_result.get("content")):
        if undo is not None:
            undo.append(
                (
                    tool_result,
                    {
                        key: tool_result[key]
                        for key in ("content", "status")
                        if key in tool_result
                    },
                )
            )
        tool_result["content"] = expected_content
        tool_result["status"] = expected_status
        if mutated_ids is not None:
            mutated_ids.add(tool_use_id)
        return tool_use_id


def _correct_all_tools(
    tool_results,
    pending_results: Mapping[str, Tuple[str, bool]],
    *,
    mutated_ids: set[str] | None = None,
    undo: list | None = None,
) -> set[str]:
    """Reconcile matching ToolResult dicts in *tool_results* in place.

    Returns every id that is now carrying its real result. ``mutated_ids``, when
    given, collects the narrower set this call actually rewrote, so a caller can
    tell "corrected here" from "already correct" and skip republishing a batch
    nothing changed.
    """
    changed: set[str] = set()
    for tool_result in tool_results:
        tool_use_id = _correct_single_tool(
            tool_result, pending_results, mutated_ids=mutated_ids, undo=undo
        )
        if tool_use_id:
            changed.add(tool_use_id)
    return changed


def _correct_message(
    message: Any,
    pending_results: Mapping[str, Tuple[str, bool]],
    *,
    mutated_ids: set[str] | None = None,
    undo: list | None = None,
) -> set[str]:
    """Reconcile matching ``toolResult`` blocks in *message* in place.

    Both the text and the status are rewritten: the placeholder was written by
    the proxy tool with a hardcoded ``"success"`` (see ``client_proxy_tool``),
    so leaving the status alone would assert a failed frontend tool to the
    model as a success.

    Returns the set of ``toolUseId``s whose block was already real or corrected.
    """
    if not isinstance(message, dict):
        return set()
    changed: set[str] = set()
    for block in message.get("content") or []:
        if not isinstance(block, dict):
            continue
        tool_result = block.get("toolResult")
        tool_use_id = _correct_single_tool(
            tool_result, pending_results, mutated_ids=mutated_ids, undo=undo
        )
        if tool_use_id:
            changed.add(tool_use_id)
    return changed


def _is_placeholder(content: Any) -> bool:
    """Return True if *content* is the proxy's ``"Forwarded to client"`` stub."""
    if not isinstance(content, list):
        return False
    return any(
        isinstance(block, dict) and block.get("text") == PROXY_RESULT_PLACEHOLDER
        for block in content
    )
