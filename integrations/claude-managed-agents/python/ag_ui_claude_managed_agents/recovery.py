"""Reconnect using server-authorized identity and authoritative event history."""

import json
from typing import Any

from ag_ui.core import (
    CustomEvent,
    RawEvent,
    RunErrorEvent,
    RunFinishedEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
)

from .context import attach_context, split_outbound, restore_context
from . import state as shared
from ._util import get, maybe_await
from .turn import _close_stream, _consume, _send_follow_ups
from .text import text_of
from .content import tool_content, plain


def confirmation(event: Any, session_id: str | None = None) -> dict[str, Any]:
    metadata = {
        "id": get(event, "id"),
        "type": get(event, "type"),
        "toolName": get(event, "name"),
        "input": get(event, "input"),
    }
    if session_id:
        metadata["sessionId"] = session_id
    if get(event, "session_thread_id"):
        metadata["sessionThreadId"] = get(event, "session_thread_id")
    if get(event, "mcp_server_name"):
        metadata["mcpServerName"] = get(event, "mcp_server_name")
    return metadata


def finish(input: Any, emit: Any, confirmations: list[dict[str, Any]]) -> None:
    outcome = None
    if confirmations:
        outcome = {
            "type": "interrupt",
            "interrupts": [
                {
                    "id": e["id"],
                    "toolCallId": e["id"],
                    "reason": "tool-approval",
                    "responseSchema": {"type": "string", "enum": ["allow", "deny"]},
                    "metadata": e,
                }
                for e in confirmations
            ],
        }
    emit(
        RunFinishedEvent(
            thread_id=input.thread_id, run_id=input.run_id, outcome=outcome
        )
    )


async def history_list(api: Any, identity: str, **kwargs: Any) -> list[Any]:
    page = await maybe_await(api.list(identity, **kwargs))
    if hasattr(page, "__aiter__"):
        return [event async for event in page]
    if isinstance(page, list):
        return page
    result = list(get(page, "data") or [])
    while getattr(page, "has_next_page", lambda: False)():
        page = await page.get_next_page()
        result.extend(get(page, "data") or [])
    return result


async def track_child_results(
    record: Any, messages: Any, emit: Any, persist: Any
) -> Any:
    """Share durable transcript and live-result tracking across initial and recovered runs."""
    delivered = set(record.delivered_child_result_ids)
    delivered.update(
        get(message, "tool_call_id") or get(message, "toolCallId")
        for message in messages
        if get(message, "role") == "tool"
    )
    record.delivered_child_result_ids = list(delivered)
    await maybe_await(persist())

    def tracked(event):
        if isinstance(event, RawEvent):
            native = event.event
            if (
                not record.session_thread_id
                and get(native, "type") in ("agent.tool_use", "agent.mcp_tool_use")
                and get(native, "session_thread_id")
            ):
                record.child_tool_calls[get(native, "id")] = get(
                    native, "session_thread_id"
                )
        if (
            isinstance(event, ToolCallResultEvent)
            and event.tool_call_id in record.child_tool_calls
        ):
            if event.tool_call_id in delivered:
                return
            delivered.add(event.tool_call_id)
            record.delivered_child_result_ids = list(delivered)
        emit(event)

    return tracked


async def recover_turn(
    agent: Any, record: Any, key: str, input: Any, emit: Any
) -> None:
    events_api = agent.client.beta.sessions.events
    api = events_api
    identity = record.session_id
    kwargs = {}
    if record.session_thread_id:
        api = agent.client.beta.sessions.threads.events
        identity = record.session_thread_id
        kwargs = {"session_id": record.session_id}
    stream = None
    try:
        stream = await api.stream(identity, **kwargs)
        history = await history_list(api, identity, **kwargs)
        await shared.discover_primary(agent.client, record, history)
        shared.restore(history, record, emit)
        for event in history:
            if (
                not record.session_thread_id
                and get(event, "type") in ("agent.tool_use", "agent.mcp_tool_use")
                and get(event, "session_thread_id")
            ):
                record.child_tool_calls[get(event, "id")] = get(
                    event, "session_thread_id"
                )
        emit = await track_child_results(
            record, input.messages, emit, lambda: agent.store.set(key, record)
        )

        async def reconcile_children():
            await recover_child_results(
                agent.client, record, emit, lambda: agent.store.set(key, record)
            )
            await maybe_await(agent.store.set(key, record))

        seen = {get(event, "id") for event in history if get(event, "id")}
        pending = {}
        latest_status = None
        for event in history:
            kind = get(event, "type")
            if kind == "system.message":
                restore_context(get(event, "content"), record)
            event_id = get(event, "id")
            if kind in ("session.status_terminated", "session.deleted") or (
                record.session_thread_id and kind == "session.thread_status_terminated"
            ):
                record.ended = True
            if kind in ("session.status_idle", "session.status_running") or (
                record.session_thread_id
                and kind
                in ("session.thread_status_idle", "session.thread_status_running")
            ):
                latest_status = event
                if get(get(event, "stop_reason"), "type") == "end_turn":
                    pending.clear()
            if kind == "agent.custom_tool_use" or (
                kind in ("agent.tool_use", "agent.mcp_tool_use")
                and get(event, "evaluated_permission") == "ask"
            ):
                pending[event_id] = event
            if kind in (
                "user.custom_tool_result",
                "user.tool_confirmation",
                "agent.tool_result",
                "agent.mcp_tool_result",
                "user.tool_result",
            ):
                answered = (
                    get(event, "custom_tool_use_id")
                    or get(event, "tool_use_id")
                    or get(event, "mcp_tool_use_id")
                )
                pending.pop(answered, None)
        if record.ended:
            await maybe_await(agent.store.set(key, record))
            emit(
                RunErrorEvent(
                    message="The managed session has terminated.", code="session_ended"
                )
            )
            return
        # The latest requires_action is authoritative even if permission was omitted.
        stop = get(latest_status, "stop_reason")
        blocking = (
            set(get(stop, "event_ids") or [])
            if get(stop, "type") == "requires_action"
            else set()
        )
        answered_ids = {
            get(e, "tool_use_id")
            or get(e, "custom_tool_use_id")
            or get(e, "mcp_tool_use_id")
            for e in history
            if get(e, "type")
            in (
                "user.custom_tool_result",
                "user.tool_confirmation",
                "agent.tool_result",
                "agent.mcp_tool_result",
                "user.tool_result",
            )
        }
        for event in history:
            if get(event, "id") in blocking - answered_ids and get(event, "type") in (
                "agent.custom_tool_use",
                "agent.tool_use",
                "agent.mcp_tool_use",
            ):
                pending[get(event, "id")] = event
        if blocking - answered_ids - pending.keys():
            emit(
                RunErrorEvent(
                    message="Pending request details are unavailable in session history.",
                    code="pending_request_unavailable",
                )
            )
            return
        # Validate the entire caller resume before any internally recovered result
        # can resume native execution. Persist the reconstructed pending identities.
        record.pending_client_tool_use_ids = [
            id for id, event in pending.items() if get(event, "type") == "agent.custom_tool_use"
        ]
        record.pending_confirmations = [
            confirmation(event, record.session_id)
            for event in pending.values()
            if get(event, "type") != "agent.custom_tool_use"
        ]
        await maybe_await(agent.store.set(key, record))
        resumes = getattr(input, "resume", None) or []
        native_ids = {e["id"] for e in record.pending_confirmations}
        resolved = set()
        answers = []
        for entry in resumes:
            id = get(entry, "interrupt_id") or get(entry, "interruptId")
            status, payload = get(entry, "status"), get(entry, "payload")
            if (
                id not in native_ids
                or id in resolved
                or status not in ("resolved", "cancelled")
                or (status == "resolved" and payload not in ("allow", "deny"))
            ):
                emit(
                    RunErrorEvent(
                        message="The approval response is invalid or does not match a pending request.",
                        code="invalid_resume",
                    )
                )
                return
            resolved.add(id)
            answers.append(
                {
                    "type": "user.tool_confirmation",
                    "tool_use_id": id,
                    "result": "deny" if status == "cancelled" else payload,
                }
            )
        recovered_state_results = []
        # Reserved writes parked during disconnect remain server-owned.
        for pending_id, event in list(pending.items()):
            if get(event, "name") != shared.NAME or get(event, "type") != "agent.custom_tool_use":
                continue
            tool = agent._state_backend_tools(record, key, emit)[shared.NAME]
            if not await maybe_await(tool.accepts_event(event)):
                continue
            is_error = False
            try:
                text = await maybe_await(tool.handler(get(event, "input")))
            except ValueError as exc:
                text, is_error = str(exc), True
            # Computing a state result has no external effects. Deliver required
            # context atomically with this genuine result before it resumes inference.
            state_result_batch = [{"type": "user.custom_tool_result", "custom_tool_use_id": pending_id, "is_error": is_error, "content": [{"type": "text", "text": text}]}]
            recovered_context = attach_context(state_result_batch, input.context, record)
            await events_api.send(record.session_id, events=state_result_batch)
            if recovered_context:
                recovered_context.acknowledge(record, results=True)
                await maybe_await(agent.store.set(key, record))
            if not is_error:
                await maybe_await(tool.on_committed(text))
            recovered_state_results.append((event, ToolCallResultEvent(message_id=f"result_{pending_id}", tool_call_id=pending_id, content=text, role="tool")))
            pending.pop(pending_id)
            answered_ids.add(pending_id)
        record.pending_client_tool_use_ids = [
            id for id, e in pending.items() if get(e, "type") == "agent.custom_tool_use"
        ]
        record.pending_confirmations = [
            confirmation(e, record.session_id)
            for e in pending.values()
            if get(e, "type") != "agent.custom_tool_use"
        ]
        await maybe_await(agent.store.set(key, record))
        emit(
            CustomEvent(
                name="managed_agents.session",
                value={
                    "sessionId": record.session_id,
                    "threadId": input.thread_id,
                    "sessionThreadId": record.session_thread_id,
                    "resumed": True,
                },
            )
        )

        async def persist_event(event):
            if get(event, "id") and get(event, "type") not in (
                "event_start",
                "event_delta",
            ):
                record.last_event_id = get(event, "id")
                await maybe_await(agent.store.set(key, record))

        client_tools = agent._client_tools(input.tools or [])

        def tool_name(event):
            name = get(event, "name") or "tool"
            return (
                client_tools.get(name, name)
                if get(event, "type") == "agent.custom_tool_use"
                else name
            )

        replayed_call_ids = {
            get(call, "id")
            for message in input.messages
            if get(message, "role") == "assistant"
            for call in (get(message, "tool_calls") or get(message, "toolCalls") or [])
            if get(call, "id")
        }
        # Imported history is already displayed unless the trusted binding supplied
        # a cursor. Stored cursors recover output produced while no client watched.
        if record.last_event_id or not record.adopted:
            cursor_index = next(
                (
                    i
                    for i, e in enumerate(history)
                    if get(e, "id") == record.last_event_id
                ),
                -1,
            )
            if record.last_event_id and cursor_index < 0:
                emit(
                    RunErrorEvent(
                        message="The saved event cursor is unavailable in session history.",
                        code="history_cursor_unavailable",
                    )
                )
                return
            missed = history[cursor_index + 1 :]
            known_messages = {
                get(message, "id"): get(message, "content")
                for message in input.messages
                if get(message, "role") == "assistant"
            }
            replay_text = {}
            for event in missed:
                if get(event, "type") != "agent.message":
                    continue
                event_id = get(event, "id")
                content = text_of(get(event, "content"))
                existing = known_messages.get(event_id)
                if isinstance(existing, str):
                    if not content.startswith(existing):
                        emit(
                            RunErrorEvent(
                                message="Saved native text conflicts with the existing message.",
                                code="history_content_conflict",
                            )
                        )
                        return
                    content = content[len(existing) :]
                replay_text[event_id] = content
            for event in missed:
                emit(RawEvent(event=plain(event), source="claude-managed-agents"))

            async def replay():
                for event in missed:
                    kind = get(event, "type")
                    if kind in (
                        "agent.custom_tool_use",
                        "agent.tool_use",
                        "agent.mcp_tool_use",
                    ):
                        event_id = get(event, "id")
                        if event_id in replayed_call_ids:
                            continue
                        replayed_call_ids.add(event_id)
                        emit(
                            ToolCallStartEvent(
                                tool_call_id=event_id,
                                tool_call_name=tool_name(event),
                            )
                        )
                        emit(
                            ToolCallArgsEvent(
                                tool_call_id=event_id,
                                delta=json.dumps(get(event, "input") or {}),
                            )
                        )
                        emit(ToolCallEndEvent(tool_call_id=event_id))
                    elif kind == "user.custom_tool_result":
                        call_id = get(event, "custom_tool_use_id")
                        emit(
                            ToolCallResultEvent(
                                message_id=get(event, "id") or f"result_{call_id}",
                                tool_call_id=call_id,
                                content=tool_content(get(event, "content"), get(event, "is_error") is True),
                                role="tool",
                            )
                        )
                    elif kind == "agent.message":
                        content = replay_text[get(event, "id")]
                        if content:
                            yield {
                                "id": get(event, "id"),
                                "type": "agent.message",
                                "content": [{"type": "text", "text": content}],
                            }
                    elif kind in (
                        "agent.thinking",
                        "agent.tool_result",
                        "agent.mcp_tool_result",
                    ):
                        yield event
                yield {
                    "type": "session.status_idle",
                    "stop_reason": {"type": "end_turn"},
                }

            await _consume(
                client=agent.client,
                session_id=record.session_id,
                stream=replay(),
                client_tools={},
                backend_tools={},
                tool_confirmation=None,
                # Original RAW envelopes were emitted above. Replay can synthesize
                # text suffixes, so do not record those as additional native evidence.
                emit=lambda event: (
                    emit(event) if not isinstance(event, RawEvent) else None
                ),
            )
        for call, result in recovered_state_results:
            call_id = result.tool_call_id
            if call_id not in replayed_call_ids:
                replayed_call_ids.add(call_id)
                emit(ToolCallStartEvent(tool_call_id=call_id, tool_call_name=shared.NAME))
                emit(ToolCallArgsEvent(tool_call_id=call_id, delta=json.dumps(get(call, "input") or {})))
                emit(ToolCallEndEvent(tool_call_id=call_id))
            emit(result)
        if history:
            await persist_event(history[-1])

        outbound = agent._outbound_events(record, input.messages)
        followups = [e for e in outbound.events if e["type"] == "user.message"]
        if followups and record.session_thread_id:
            emit(
                RunErrorEvent(
                    message="User follow-up messages cannot target a child session thread.",
                    code="unsupported_child_followup",
                )
            )
            return
        answers.extend(e for e in outbound.events if e["type"] != "user.message")
        remaining = {
            id: e
            for id, e in pending.items()
            if id not in resolved
            and id not in {a.get("custom_tool_use_id") for a in answers}
        }
        if not record.adopted and followups and not pending:
            await agent._sync_client_tools(record, input.tools or [])
        if record.adopted and followups and not pending and not record.session_thread_id:
            await shared.ensure_catalog(agent, record)
        sends = answers + ([] if remaining else followups)
        state_delivery = shared.attach(sends, input.state, record)
        context_delivery = attach_context(sends, input.context, record)
        answers, followups = split_outbound(sends)
        if answers:
            await events_api.send(record.session_id, events=answers)
            if state_delivery and state_delivery[1]:
                shared.apply(record, state_delivery[0], emit)
            if context_delivery:
                context_delivery.acknowledge(record, results=True)
        record.pending_client_tool_use_ids = [id for id in outbound.still_parked]
        record.pending_confirmations = [
            e for e in record.pending_confirmations if e["id"] not in resolved
        ]
        await maybe_await(agent.store.set(key, record))
        if remaining:
            for id, event in remaining.items():
                if id in replayed_call_ids:
                    continue
                emit(
                    ToolCallStartEvent(tool_call_id=id, tool_call_name=tool_name(event))
                )
                emit(
                    ToolCallArgsEvent(
                        tool_call_id=id, delta=json.dumps(get(event, "input") or {})
                    )
                )
                emit(ToolCallEndEvent(tool_call_id=id))
            await reconcile_children()
            finish(input, emit, record.pending_confirmations)
            return
        if followups:
            await _send_follow_ups(agent.client, record.session_id, followups)
            if state_delivery and not state_delivery[1]:
                shared.apply(record, state_delivery[0], emit)
            if context_delivery:
                context_delivery.acknowledge(record, results=False)
            record.last_user_message_id = outbound.last_user_message_id
            await maybe_await(agent.store.set(key, record))
        elif not answers and not recovered_state_results and get(latest_status, "type") in (
            "session.status_idle",
            "session.thread_status_idle",
        ):
            await reconcile_children()
            finish(input, emit, [])
            return

        async def deduped():
            async for event in stream:
                id = get(event, "id")
                if id and id in seen:
                    continue
                if id:
                    seen.add(id)
                kind = get(event, "type")
                if record.session_thread_id and kind == "session.thread_status_idle":
                    event = {
                        "type": "session.status_idle",
                        "id": id,
                        "stop_reason": get(event, "stop_reason"),
                    }
                elif (
                    record.session_thread_id
                    and kind == "session.thread_status_terminated"
                ):
                    event = {"type": "session.status_terminated", "id": id}
                yield event

        async def park(id):
            record.pending_client_tool_use_ids.append(id)
            await maybe_await(agent.store.set(key, record))

        outcome = await _consume(
            client=agent.client,
            session_id=record.session_id,
            stream=deduped(),
            client_tools=agent._client_tools(input.tools or []),
            backend_tools=agent._state_backend_tools(record, key, emit),
            tool_confirmation=None,
            recovering=True,
            # Native idle events can have been buffered before our result send.
            # Both history and this successful batch establish acknowledged IDs.
            acknowledged_tool_use_ids=[
                *[id for id in answered_ids if id],
                *[
                    answer.get("custom_tool_use_id") or answer["tool_use_id"]
                    for answer in answers
                    if answer["type"] != "system.message"
                ],
            ],
            emit=emit,
            on_client_park=park,
            on_error=agent.on_error,
            on_event=persist_event,
        )
        record.pending_confirmations = outcome.confirmations
        await agent._record_outcome(key, record, outcome)
        await maybe_await(agent.store.set(key, record))
        if outcome.status != "errored":
            await reconcile_children()
            finish(input, emit, outcome.confirmations)
    except Exception as exc:
        if getattr(exc, "status_code", None) in (403, 404, 410):
            emit(
                RunErrorEvent(
                    message="The managed session is unavailable or inaccessible.",
                    code="session_unavailable",
                )
            )
        else:
            raise
    finally:
        if stream is not None:
            await _close_stream(stream)


async def recover_child_results(
    client: Any, record: Any, emit: Any, persist: Any = None
) -> None:
    """Recover canonical results only from a child proven by native root history."""
    if record.session_thread_id:
        return
    delivered = set(record.delivered_child_result_ids)
    threads = {
        thread for id, thread in record.child_tool_calls.items() if id not in delivered
    }
    for thread in sorted(threads):
        history = await history_list(
            client.beta.sessions.threads.events, thread, session_id=record.session_id
        )
        for event in history:
            kind = get(event, "type")
            call_id = (
                get(event, "tool_use_id")
                if kind == "agent.tool_result"
                else get(event, "mcp_tool_use_id")
                if kind == "agent.mcp_tool_result"
                else None
            )
            if (
                not call_id
                or record.child_tool_calls.get(call_id) != thread
                or call_id in delivered
                or get(event, "session_thread_id") not in (None, thread)
            ):
                continue
            native = {**plain(event), "session_thread_id": thread}
            emit(RawEvent(event=native, source="claude-managed-agents"))
            emit(
                ToolCallResultEvent(
                    message_id=get(event, "id"),
                    tool_call_id=call_id,
                    content=tool_content(get(event, "content"), get(event, "is_error") is True),
                    role="tool",
                )
            )
            delivered.add(call_id)
            if persist is not None:
                await maybe_await(persist())
