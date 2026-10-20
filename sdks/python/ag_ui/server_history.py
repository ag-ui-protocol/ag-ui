"""
Helpers for agents that own the conversation history on the server.

By default an AG-UI client resends the whole conversation in
``RunAgentInput.messages`` on every run. An agent that persists the thread
itself does not need that, and should not trust it: client-sent history is
untrusted input that can carry forged assistant or system turns. In
server-managed history mode:

* the agent advertises the mode in its capabilities
  (:func:`server_managed_history_capabilities`);
* the client uploads only the messages the server has not confirmed yet, and
  names the last confirmed message in
  ``forwardedProps["ag-ui:historyCursor"]`` (:func:`get_history_cursor`);
* the server filters the upload against its own store
  (:func:`accept_client_messages`) and builds model context from the store,
  never from ``RunAgentInput.messages``;
* when the server does not know the thread or the cursor, it ends the run
  with ``RUN_ERROR`` and code ``HISTORY_UNAVAILABLE``
  (:func:`history_unavailable_event`). The client then forgets what it
  considered confirmed and retries once with its full history. A strict
  server may answer that retry by starting a fresh thread rather than
  trusting resent history; that is server policy.

This is a prototype for ag-ui-protocol/ag-ui#2186. The 1.0 schema has no
``StateCapabilities.serverManagedHistory`` field yet, so the capability is
advertised under ``AgentCapabilities.custom``.

Everything here is pure: no I/O, no framework dependency, deterministic.
"""

from __future__ import annotations

from typing import Any, Collection, List, Optional, Sequence, Set, TypeVar

from ag_ui.core.capabilities import AgentCapabilities
from ag_ui.core.events import RunErrorEvent
from ag_ui.core.types import AssistantMessage, Message, RunAgentInput, ToolMessage, UserMessage

_M = TypeVar("_M", UserMessage, ToolMessage)

__all__ = [
    "HISTORY_UNAVAILABLE",
    "HISTORY_CURSOR_KEY",
    "SERVER_MANAGED_HISTORY_CAPABILITY",
    "HistoryUnavailableError",
    "server_managed_history_capabilities",
    "history_unavailable_event",
    "get_history_cursor",
    "find_pending_tool_call_ids",
    "accept_client_messages",
]

HISTORY_UNAVAILABLE = "HISTORY_UNAVAILABLE"
"""``RUN_ERROR.code`` telling the client to retry once with its full history."""

HISTORY_CURSOR_KEY = "ag-ui:historyCursor"
"""``forwardedProps`` key holding the id of the last message the client saw confirmed."""

SERVER_MANAGED_HISTORY_CAPABILITY = "serverManagedHistory"
"""Key under ``AgentCapabilities.custom`` that advertises server-managed history."""

_DEFAULT_UNAVAILABLE_MESSAGE = (
    "The server has no history for this thread at the given cursor. "
    "Retry with the full message history."
)


class HistoryUnavailableError(Exception):
    """
    The server cannot continue the thread from what the client sent.

    Raised when the client names a history cursor the server does not have
    (unknown thread, expired or truncated history, or a forged id). Catch it
    at the run boundary and emit :meth:`to_event` as the run's terminal event.
    """

    def __init__(self, message: str = _DEFAULT_UNAVAILABLE_MESSAGE, *, cursor: Optional[str] = None) -> None:
        super().__init__(message)
        self.message = message
        self.cursor = cursor

    def to_event(self) -> RunErrorEvent:
        """Build the ``RUN_ERROR`` event that reports this error to the client."""
        return history_unavailable_event(self.message)


def server_managed_history_capabilities(base: Optional[AgentCapabilities] = None) -> AgentCapabilities:
    """
    Return capabilities that advertise server-managed history.

    Sets ``custom["serverManagedHistory"] = True``, keeping every other field
    and custom key of ``base``. ``base`` itself is not modified.
    """
    if base is None:
        return AgentCapabilities(custom={SERVER_MANAGED_HISTORY_CAPABILITY: True})
    result = base.model_copy(deep=True)
    result.custom = {**(result.custom or {}), SERVER_MANAGED_HISTORY_CAPABILITY: True}
    return result


def history_unavailable_event(message: str = _DEFAULT_UNAVAILABLE_MESSAGE) -> RunErrorEvent:
    """Build a ``RUN_ERROR`` event with code ``HISTORY_UNAVAILABLE``."""
    return RunErrorEvent(message=message, code=HISTORY_UNAVAILABLE)


def get_history_cursor(run_input: RunAgentInput) -> Optional[str]:
    """
    Read the history cursor from ``run_input.forwarded_props``.

    ``forwardedProps`` may be any JSON value, so anything other than an
    object whose ``"ag-ui:historyCursor"`` entry is a non-empty string yields
    ``None`` (no cursor) instead of raising.
    """
    props: Any = run_input.forwarded_props
    if not isinstance(props, dict):
        return None
    cursor = props.get(HISTORY_CURSOR_KEY)
    if isinstance(cursor, str) and cursor:
        return cursor
    return None


def find_pending_tool_call_ids(stored: Sequence[Message]) -> Set[str]:
    """
    Return ids of tool calls in ``stored`` that have no stored result yet.

    This is the default set of calls a client may answer with a ``tool``
    message. It cannot tell frontend tools (and human-in-the-loop approvals)
    from tools the server executes itself. A server whose own tool results
    can be missing from the store, for example after a run failed mid-call,
    should pass ``pending_tool_call_ids`` to :func:`accept_client_messages`
    explicitly, listing only calls the client is meant to answer.
    """
    called: Set[str] = set()
    answered: Set[str] = set()
    for message in stored:
        if isinstance(message, AssistantMessage):
            called.update(call.id for call in message.tool_calls or ())
        elif isinstance(message, ToolMessage):
            answered.add(message.tool_call_id)
    return called - answered


def accept_client_messages(
    stored: Sequence[Message],
    incoming: Sequence[Message],
    *,
    pending_tool_call_ids: Optional[Collection[str]] = None,
    cursor: Optional[str] = None,
) -> List[Message]:
    """
    Select the client-sent messages the server should append to its store.

    Applies the recommended trust rules for server-managed history:

    * a message whose id is already stored is ignored; stored messages are
      never overwritten;
    * ``user`` messages are accepted;
    * a ``tool`` message is accepted only if it answers a pending tool call,
      and only the first answer to each call is accepted;
    * ``assistant``, ``system``, ``developer``, ``activity`` and
      ``reasoning`` messages, and orphan ``tool`` messages, are dropped;
    * a repeated id within ``incoming`` is accepted once.

    Accepted messages are returned as sanitized copies: ``encrypted_value``,
    ``subagent_run_id`` and any unknown top-level fields are removed, since
    they would otherwise let a client plant provider artefacts or subagent
    attribution in the store. ``content``, ``name``, ``metadata`` and (for
    tool messages) ``error`` are kept as sent.

    Accepted tool results are placed before accepted user messages, so a
    result keeps directly following the assistant turn that called the tool
    (model providers reject a tool call followed by a user turn). Within each
    group the client's order is kept.

    Things this function deliberately does not do:

    * It does not require ``cursor`` to be the newest stored message. A
      client may legitimately lag behind, for example when a run failed after
      the server persisted output the client never confirmed.
    * It does not rebuild history. On the full-history retry after
      ``HISTORY_UNAVAILABLE`` with an empty store, only the user messages
      survive. Whether to continue with them or start a fresh thread is
      server policy.
    * It does not namespace message ids. Ids are chosen by the client, so the
      server should give its own messages ids a client cannot predict
      (for example random UUIDs).

    Args:
        stored: The thread as the server has persisted it, in order.
        incoming: ``RunAgentInput.messages`` from the client.
        pending_tool_call_ids: Tool call ids the client may answer. Defaults
            to :func:`find_pending_tool_call_ids` of ``stored``.
        cursor: The client's history cursor (see :func:`get_history_cursor`).
            When given, it must be the id of a stored message.

    Returns:
        Sanitized copies of the accepted new messages, ordered as described
        above.

    Raises:
        HistoryUnavailableError: ``cursor`` is given but is not the id of a
            stored message (including when ``stored`` is empty).
    """
    stored_ids = {message.id for message in stored}
    if cursor is not None and cursor not in stored_ids:
        raise HistoryUnavailableError(cursor=cursor)

    if pending_tool_call_ids is None:
        pending = find_pending_tool_call_ids(stored)
    else:
        pending = set(pending_tool_call_ids)

    seen_ids = set(stored_ids)
    tool_results: List[Message] = []
    user_messages: List[Message] = []
    for message in incoming:
        if message.id in seen_ids:
            continue
        if isinstance(message, UserMessage):
            user_messages.append(_sanitize(message))
        elif isinstance(message, ToolMessage) and message.tool_call_id in pending:
            pending.discard(message.tool_call_id)
            tool_results.append(_sanitize(message))
        else:
            continue
        seen_ids.add(message.id)
    return tool_results + user_messages


_UNTRUSTED_FIELDS = frozenset({"encrypted_value", "subagent_run_id"})


def _sanitize(message: _M) -> _M:
    """Copy ``message`` keeping only declared fields a client may set."""
    model = type(message)
    data = {
        name: getattr(message, name)
        for name in model.model_fields
        if name not in _UNTRUSTED_FIELDS
    }
    return model.model_validate(data)
