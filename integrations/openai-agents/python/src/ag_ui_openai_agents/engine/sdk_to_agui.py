"""Outbound translator: OpenAI Agents SDK events → AG-UI BaseEvent.

Same layered shape as AGUIToSDKTranslator, just the other direction.
Stateful per run — it tracks open text / tool-call / reasoning windows so
AG-UI always sees strict START → CONTENT → END triplets. Make a fresh one
per run; don't share across runs.

Run-envelope events (RUN_STARTED / RUN_FINISHED / RUN_ERROR,
STATE_SNAPSHOT / STATE_DELTA, MESSAGES_SNAPSHOT) are the run loop's job
— the translator only translates.
"""

from __future__ import annotations

import logging
from typing import Any, Sequence

from agents import (
    HandoffCallItem,
    HandoffOutputItem,
    ItemHelpers,
    MCPApprovalRequestItem,
    MCPApprovalResponseItem,
    MessageOutputItem,
    ReasoningItem,
    RunItem,
    ToolCallItem,
    ToolCallOutputItem,
)
from agents.items import MCPListToolsItem  # not re-exported at package top level
from agents.models.fake_id import FAKE_RESPONSES_ID

from ag_ui.core import (
    AssistantMessage,
    BaseEvent,
    CustomEvent,
    EventType,
    FunctionCall,
    Message,
    MessagesSnapshotEvent,
    ReasoningEncryptedValueEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunAgentInput,
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
)
from .helpers import (
    coerce_to_str,
    new_message_id,
    new_reasoning_id,
    new_tool_call_id,
    new_tool_result_id,
    read_attr,
)
from .stream_types import (
    HOSTED_TOOL_CALL_TYPES,
    RawResponseEventType,
    SDKItemType,
    SDKStreamEventType,
)

logger = logging.getLogger(__name__)


class SDKToAGUITranslator:
    """Translate OpenAI Agents SDK outputs into AG-UI BaseEvent objects.

    Wire ids are reused, never invented — with one caveat: some model
    backends stamp every item with the SDK's FAKE_RESPONSES_ID
    placeholder instead of a real id. Windows are therefore keyed by
    real item id when available and by the raw event's output_index
    otherwise, and placeholder ids are replaced with generated ones so
    AG-UI clients never see two different messages sharing an id.

    The pattern is "lazy open, eager close": a *_START is emitted when
    the first signal for a window arrives (output_item.added or,
    defensively, a bare delta), and *_END fires on the first close
    signal — output_item.done, the run-item commit, or finalize(),
    whichever comes first. Run items double as a full emission path:
    when no window was ever opened for an item (some backends never
    stream raw deltas for it), its run-item translator emits the
    complete triplet from the finished item.
    """

    def __init__(self) -> None:
        # What's currently open. Key is the real item id when we have one,
        # otherwise __idx_<output_index>. Value is the id we already sent in
        # the matching *_START event, so we can pair the END to it.
        self._open_texts: dict[str, str] = {}          # key -> message_id
        # A message item that was announced (output_item.added) but whose
        # TEXT_MESSAGE_START we're holding back until a real delta arrives.
        # Value is the id the START will carry once (if) it opens. Lets a
        # text-less item — a pure tool-call turn on some providers — pass
        # through without an empty text window bracketing the tool call.
        self._pending_text_ids: dict[str, str] = {}    # key -> deferred message_id
        self._open_tool_calls: dict[str, str] = {}     # key -> tool_call_id
        self._open_reasonings: dict[str, str] = {}     # key -> phase message_id
        self._open_reasoning_parts: dict[str, str] = {}  # key -> part message_id
        # When a run item shows up, we need to know if we already streamed and
        # closed it (nothing to do) or if no deltas ever arrived for it and we
        # have to emit it whole. These track what's been closed so we can tell.
        self._closed_text_ids: list[str] = []
        self._closed_reasoning_ids: list[str] = []
        self._seen_call_ids: set[str] = set()
        self._emitted_encrypted_keys: set[str] = set()
        self._reasoning_part_seq: dict[str, int] = {}
        # Never cleared: an encrypted value can land after we've already closed
        # the reasoning phase, and we still need the original id to attach it to.
        self._reasoning_phase_ids: dict[str, str] = {}
        self._current_step: str | None = None
        # AG-UI Messages for the end-of-run MESSAGES_SNAPSHOT, built inline as
        # each item resolves its id here — never a second pass over new_items,
        # so a snapshot message's id can never diverge from its streamed one.
        # Reasoning items are intentionally never appended (see
        # translate_reasoning_item).
        self._snapshot_messages: list[Message] = []

    # ─────────────────────────────────────────────────────────────────────
    # TIER 1 — One-shot entry points
    # ─────────────────────────────────────────────────────────────────────

    def translate(self, sdk_event: Any) -> list[BaseEvent]:
        """Dispatch one SDK StreamEvent to the right family translator.

        Returns a list because one SDK event can produce several AG-UI
        events (e.g. an output_item.added that force-opens a window).
        Unknown event types translate to [] with a debug log.

        Args:
            sdk_event: One event from result.stream_events().

        Returns:
            Zero or more translated AG-UI events.
        """
        event_type = read_attr(sdk_event, "type")
        if event_type == SDKStreamEventType.RAW_RESPONSE:
            return self.translate_raw_response_event(sdk_event)
        if event_type == SDKStreamEventType.RUN_ITEM:
            return self.translate_run_item_event(sdk_event)
        if event_type == SDKStreamEventType.AGENT_UPDATED:
            return self.translate_agent_updated_event(sdk_event)
        logger.debug("Unknown SDK stream event type: %s", event_type)
        return []

    def finalize(self) -> list[BaseEvent]:
        """Emit pending *_END markers when the SDK stream terminates.

        Always call this after the stream ends — even on error — so the
        AG-UI client never sees a window that opened but never closed.

        Returns:
            Closing events for any windows still open.
        """
        events: list[BaseEvent] = []
        for key in list(self._open_texts):
            events.extend(self._close_text(key))
        for key in list(self._open_tool_calls):
            events.extend(self._close_tool_call(key))
        for key in list(self._open_reasonings):
            events.extend(self._close_reasoning(key))
        if self._current_step is not None:
            events.append(
                StepFinishedEvent(
                    type=EventType.STEP_FINISHED,
                    step_name=self._current_step,
                )
            )
            self._current_step = None
        return events

    def build_messages_snapshot(
        self,
        run_input: RunAgentInput | Sequence[Message] | None = None,
    ) -> MessagesSnapshotEvent:
        """Build the end-of-run MESSAGES_SNAPSHOT event.

        The snapshot is the full conversation as the client should know
        it: the run's prior messages passed through untouched (they keep
        the ids the client already renders, so its id-keyed merge updates
        in place instead of duplicating), followed by this run's messages
        — collected here as the stream ran (see _record_* below), each
        under the exact id its streamed event used. Same id, one
        resolution: a snapshot message can never disagree with its
        streamed counterpart, even on backends that stamp placeholder ids
        (Chat Completions, LiteLLM) instead of real ones.

        Prior history comes from run_input.messages, not
        result.to_input_list(): Responses-API input items carry no id slot
        for user/system messages, so round-tripping prior turns through
        them would mint fresh ids and duplicate every bubble on the
        client. Filter run_input first if it carries anything the client
        should not see echoed back (e.g. a system prompt sent as history).

        Args:
            run_input: The run's RunAgentInput, a plain message list, or
                None when there is no prior history to prepend.

        Returns:
            A MESSAGES_SNAPSHOT event ready to encode.
        """
        if run_input is None:
            prior: list[Message] = []
        elif isinstance(run_input, RunAgentInput):
            prior = list(run_input.messages or [])
        else:
            prior = list(run_input)
        return MessagesSnapshotEvent(
            type=EventType.MESSAGES_SNAPSHOT,
            messages=[*prior, *self._snapshot_messages],
        )

    # ─────────────────────────────────────────────────────────────────────
    # TIER 2 — Bulk collection + per event family
    # ─────────────────────────────────────────────────────────────────────

    def translate_raw_response_event(self, event: Any) -> list[BaseEvent]:
        """Handle a RawResponsesStreamEvent (token-level Responses deltas).

        Args:
            event: The SDK's RawResponsesStreamEvent.

        Returns:
            Zero or more translated AG-UI events.
        """
        data = read_attr(event, "data")
        if data is None:
            return []
        kind = read_attr(data, "type")
        if kind == RawResponseEventType.OUTPUT_ITEM_ADDED:
            return self.translate_output_item_added(data)
        if kind == RawResponseEventType.OUTPUT_ITEM_DONE:
            return self.translate_output_item_done(data)
        if kind == RawResponseEventType.TEXT_DELTA:
            return self.translate_text_delta(data)
        if kind == RawResponseEventType.TEXT_DONE:
            return self.translate_text_done(data)
        if kind == RawResponseEventType.REFUSAL_DELTA:
            return self.translate_refusal_delta(data)
        if kind == RawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA:
            return self.translate_function_call_arguments_delta(data)
        if kind in (
            RawResponseEventType.REASONING_SUMMARY_DELTA,
            RawResponseEventType.REASONING_TEXT_DELTA,
        ):
            return self.translate_reasoning_delta(data)
        if kind in (
            RawResponseEventType.REASONING_SUMMARY_PART_DONE,
            RawResponseEventType.REASONING_TEXT_DONE,
        ):
            return self.translate_reasoning_part_done(data)
        # Everything else (response.created/.completed, content_part chatter,
        # audio) has nothing to show on the AG-UI side, so we drop it.
        return []

    def translate_run_item_event(self, event: Any) -> list[BaseEvent]:
        """Handle a RunItemStreamEvent (semantic commit signals).

        Args:
            event: The SDK's RunItemStreamEvent.

        Returns:
            Zero or more translated AG-UI events.
        """
        item = read_attr(event, "item")
        if item is None:
            return []
        return self.translate_item(item)

    def translate_agent_updated_event(self, event: Any) -> list[BaseEvent]:
        """Translate an AgentUpdatedStreamEvent into STEP_FINISHED + STEP_STARTED.

        Each agent (including the first, and each handoff target) is
        surfaced as an AG-UI step named after the agent.

        Args:
            event: The SDK's AgentUpdatedStreamEvent.

        Returns:
            STEP_FINISHED for the previous step (if any) followed by
            STEP_STARTED for the new one.
        """
        new_agent = read_attr(event, "new_agent")
        step_name = read_attr(new_agent, "name") or "agent"
        events: list[BaseEvent] = []
        if self._current_step is not None:
            events.append(
                StepFinishedEvent(
                    type=EventType.STEP_FINISHED,
                    step_name=self._current_step,
                )
            )
        self._current_step = step_name
        events.append(
            StepStartedEvent(type=EventType.STEP_STARTED, step_name=step_name)
        )
        return events

    # ─────────────────────────────────────────────────────────────────────
    # TIER 3a — Raw Responses deltas (per raw type)
    # ─────────────────────────────────────────────────────────────────────

    def translate_output_item_added(self, data: Any) -> list[BaseEvent]:
        """Translate response.output_item.added by opening the matching AG-UI window.

        message opens TEXT_MESSAGE_START, function_call opens
        TOOL_CALL_START, reasoning opens REASONING_START, and hosted
        tool calls open TOOL_CALL_START with the tool name set to the
        item type.

        Args:
            data: The raw output_item.added payload.

        Returns:
            The opening event(s) for the window, if any.
        """
        item = read_attr(data, "item")
        item_type = read_attr(item, "type")
        item_id = read_attr(item, "id")
        key = self._window_key(item_id, read_attr(data, "output_index"))

        if item_type == SDKItemType.MESSAGE:
            # Defer TEXT_MESSAGE_START until a real delta actually arrives.
            # Some providers (LiteLLM's chat-completions adapter, for one)
            # emit a message item even on a turn that ends up being a pure
            # tool call with no spoken text — opening the window here would
            # leave an empty TEXT_MESSAGE_START/END pair wrapping the tool
            # call on the wire. Remember the real id so the lazy open still
            # uses it. Output has begun, though, so close any open reasoning
            # now (some backends send reasoning-done late) — that must not
            # wait for the deferred text.
            self._pending_text_ids[key] = self._resolve_id(item_id, new_message_id)
            return self._close_all_reasonings()
        if item_type == SDKItemType.FUNCTION_CALL:
            call_id = read_attr(item, "call_id") or self._resolve_id(item_id, new_tool_call_id)
            name = read_attr(item, "name") or ""
            return self._open_tool_call(key, call_id, name)
        if item_type == SDKItemType.REASONING:
            return self._open_reasoning(key, self._resolve_id(item_id, new_reasoning_id))
        if item_type in HOSTED_TOOL_CALL_TYPES:
            call_id = self._resolve_id(item_id, new_tool_call_id)
            return self._open_tool_call(key, call_id, item_type)
        return []

    def translate_output_item_done(self, data: Any) -> list[BaseEvent]:
        """Translate response.output_item.done by closing the matching AG-UI window.

        For reasoning items this also emits REASONING_ENCRYPTED_VALUE
        (subtype "message") when the finished item carries
        encrypted_content.

        Args:
            data: The raw output_item.done payload.

        Returns:
            The closing event(s) for the window, if any.
        """
        item = read_attr(data, "item")
        item_type = read_attr(item, "type")
        key = self._window_key(read_attr(item, "id"), read_attr(data, "output_index"))

        if item_type == SDKItemType.MESSAGE:
            # Drop a deferred-but-never-opened window: no delta ever arrived,
            # so there's nothing on the wire to close and no empty window to
            # emit. If a delta did arrive the pending entry is already gone
            # and this pop is a no-op; _close_text then closes the real one.
            self._pending_text_ids.pop(key, None)
            return self._close_text(key)
        if item_type == SDKItemType.FUNCTION_CALL or item_type in HOSTED_TOOL_CALL_TYPES:
            return self._close_tool_call(key)
        if item_type == SDKItemType.REASONING:
            events = self._emit_encrypted_value(key, item)
            events.extend(self._close_reasoning(key))
            return events
        return []

    def translate_text_delta(self, data: Any) -> list[BaseEvent]:
        """Translate response.output_text.delta into TEXT_MESSAGE_CONTENT (lazy start).

        Args:
            data: The raw output_text.delta payload.

        Returns:
            Content event(s), opening the window first if needed.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._emit_text_content(key, read_attr(data, "delta") or "")

    def translate_text_done(self, data: Any) -> list[BaseEvent]:
        """Translate response.output_text.done into an early TEXT_MESSAGE_END.

        Some model backends skip output_item.done; this closes the
        window on the text-level done signal instead. Idempotent —
        closing an already-closed window is a no-op.

        Args:
            data: The raw output_text.done payload.

        Returns:
            The closing event, or [] if already closed.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        # A text-level done with no delta ever seen: drop the deferred window
        # the same way output_item.done does, so it never opens empty.
        self._pending_text_ids.pop(key, None)
        return self._close_text(key)

    def translate_refusal_delta(self, data: Any) -> list[BaseEvent]:
        """Translate response.refusal.delta into TEXT_MESSAGE_CONTENT.

        Refusal text is user-visible assistant output, so it streams
        into the same text window as regular content.

        Args:
            data: The raw refusal.delta payload.

        Returns:
            Content event(s), opening the window first if needed.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._emit_text_content(key, read_attr(data, "delta") or "")

    def translate_function_call_arguments_delta(self, data: Any) -> list[BaseEvent]:
        """Translate response.function_call_arguments.delta into TOOL_CALL_ARGS.

        Args:
            data: The raw function_call_arguments.delta payload.

        Returns:
            Args event(s), opening the window first if needed.
        """
        delta = read_attr(data, "delta") or ""
        if not delta:
            return []
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        events: list[BaseEvent] = []
        if key not in self._open_tool_calls:
            # Some providers jump straight to args without an output_item.added,
            # so open the call here if we haven't already.
            events.extend(self._open_tool_call(key, new_tool_call_id(), ""))
        events.append(
            ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=self._open_tool_calls[key],
                delta=delta,
            )
        )
        return events

    def translate_reasoning_delta(self, data: Any) -> list[BaseEvent]:
        """Translate reasoning deltas into REASONING_MESSAGE_CONTENT (lazy part start).

        Covers both sources — response.reasoning_summary_text.delta
        (hosted models: model-written summaries) and
        response.reasoning_text.delta (open-weight models: full chain
        of thought). Whichever arrives streams; each part becomes its
        own REASONING_MESSAGE_* window inside one REASONING_START/END
        phase, matching the other AG-UI integrations.

        Args:
            data: The raw reasoning delta payload.

        Returns:
            Content event(s), opening the phase/part first if needed.
        """
        delta = read_attr(data, "delta") or ""
        if not delta:
            return []
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        events: list[BaseEvent] = []
        if key not in self._open_reasonings:
            events.extend(self._open_reasoning(key, new_reasoning_id()))
        if key not in self._open_reasoning_parts:
            events.extend(self._open_reasoning_part(key))
        events.append(
            ReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT,
                message_id=self._open_reasoning_parts[key],
                delta=delta,
            )
        )
        return events

    def translate_reasoning_part_done(self, data: Any) -> list[BaseEvent]:
        """Translate a summary-part / reasoning-text done signal into REASONING_MESSAGE_END.

        Args:
            data: The raw part-done payload.

        Returns:
            The closing event, or [] if already closed.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._close_reasoning_part(key)

    # ─────────────────────────────────────────────────────────────────────
    # TIER 3b — Single run item (dispatcher + per-type)
    # ─────────────────────────────────────────────────────────────────────

    def translate_item(self, item: RunItem) -> list[BaseEvent]:
        """Dispatch one SDK RunItem to the right per-type translator.

        Usually these act as safety-net closers (raw events already
        streamed the content); when no deltas were ever streamed for the
        item, they emit its full AG-UI sequence instead.

        Args:
            item: A finished SDK RunItem.

        Returns:
            Zero or more translated AG-UI events.
        """
        if isinstance(item, MessageOutputItem):
            return self.translate_message_output_item(item)
        if isinstance(item, HandoffCallItem):
            return self.translate_handoff_call_item(item)
        if isinstance(item, HandoffOutputItem):
            return self.translate_handoff_output_item(item)
        if isinstance(item, ToolCallItem):
            return self.translate_tool_call_item(item)
        if isinstance(item, ToolCallOutputItem):
            return self.translate_tool_call_output_item(item)
        if isinstance(item, ReasoningItem):
            return self.translate_reasoning_item(item)
        if isinstance(item, MCPApprovalRequestItem):
            return self.translate_mcp_approval_request_item(item)
        if isinstance(item, MCPListToolsItem):
            return self.translate_mcp_list_tools_item(item)
        if isinstance(item, MCPApprovalResponseItem):
            return self.translate_mcp_approval_response_item(item)
        logger.warning("Unknown SDK run item type: %s", type(item).__name__)
        return []

    def translate_message_output_item(self, item: MessageOutputItem) -> list[BaseEvent]:
        """Handle an assistant message commit by closing its window or emitting the full triplet.

        Streamed: the raw deltas already carried the text — just close.
        No deltas seen: emit TEXT_MESSAGE_START/CONTENT/END from the
        finished item, using the SDK's own ItemHelpers extractors (text
        first, refusal as fallback — both are user-visible).

        Args:
            item: The finished MessageOutputItem.

        Returns:
            Closing event, or the full START/CONTENT/END triplet.
        """
        raw = item.raw_item
        raw_id = read_attr(raw, "id")
        text = ItemHelpers.extract_text(raw) or ItemHelpers.extract_refusal(raw) or ""
        action, key = self._reconcile(raw_id, self._open_texts, self._closed_text_ids)
        if action == "close":
            # key is still open at this point — read its id before _close_text pops it.
            message_id = self._open_texts[key]
            events = self._close_text(key)
            self._record_text(message_id, text)
            return events
        if action == "skip":
            # Already closed via a raw event before this commit arrived —
            # no BaseEvents to emit, but the snapshot still needs this
            # message, under the exact id that earlier close already used.
            self._record_text(key, text)
            return []
        # "new": nothing was ever streamed for this item. A real id also
        # supersedes any deferred window we were holding for it.
        self._pending_text_ids.pop(raw_id, None)
        if not text:
            # An empty assistant commit — emit no window (START+END with no
            # content is exactly the empty-bubble artifact) and keep it out of
            # the snapshot.
            return []
        message_id = self._resolve_id(raw_id, new_message_id)
        events = self._open_text(message_id, message_id)
        events.append(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=message_id,
                delta=text,
            )
        )
        events.extend(self._close_text(message_id))
        self._record_text(message_id, text)
        return events

    def translate_tool_call_item(self, item: ToolCallItem) -> list[BaseEvent]:
        """Handle a tool call commit by closing its window or emitting START/[ARGS]/END.

        Reconciled by call_id (present and real regardless of backend),
        using the SDK's built-in ToolCallItem.call_id / .tool_name
        properties where available — getattr fallbacks because
        HandoffCallItem routes through here too and lacks them.

        Args:
            item: The finished ToolCallItem (or a HandoffCallItem).

        Returns:
            Closing event, or the full START/[ARGS]/END sequence.
        """
        raw = item.raw_item
        call_id = (
            getattr(item, "call_id", None)
            or read_attr(raw, "call_id")
            or self._resolve_id(read_attr(raw, "id"), new_tool_call_id)
        )
        name = (
            getattr(item, "tool_name", None)
            or read_attr(raw, "name")
            or read_attr(raw, "type")
            or ""
        )
        arguments = read_attr(raw, "arguments") or ""
        for key, open_call_id in self._open_tool_calls.items():
            if open_call_id == call_id:
                events = self._close_tool_call(key)
                self._record_tool_call(call_id, name, arguments)
                return events
        if call_id in self._seen_call_ids:
            # Already closed via a raw event before this commit arrived —
            # no BaseEvents to emit, but the snapshot still needs this call.
            self._record_tool_call(call_id, name, arguments)
            return []
        events = self._open_tool_call(call_id, call_id, name)
        if arguments:
            events.append(
                ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=call_id,
                    delta=arguments,
                )
            )
        events.extend(self._close_tool_call(call_id))
        self._record_tool_call(call_id, name, arguments)
        return events

    def translate_tool_call_output_item(self, item: ToolCallOutputItem) -> list[BaseEvent]:
        """Translate a tool result into TOOL_CALL_RESULT.

        Args:
            item: The finished ToolCallOutputItem.

        Returns:
            A single TOOL_CALL_RESULT event, or [] if call_id is missing.
        """
        call_id = item.call_id
        if not call_id:
            logger.debug("Tool output without call_id; skipping TOOL_CALL_RESULT")
            return []
        content = coerce_to_str(item.output)
        result_id = self._record_result(call_id, content)
        return [
            ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=result_id,
                tool_call_id=call_id,
                content=content,
            )
        ]

    def translate_reasoning_item(self, item: ReasoningItem) -> list[BaseEvent]:
        """Handle a reasoning commit by closing its phase or emitting the full sequence.

        Non-streamed emission walks the finished ResponseReasoningItem:
        one REASONING_MESSAGE_* window per summary/content entry, then
        REASONING_ENCRYPTED_VALUE (when present), then REASONING_END.

        Args:
            item: The finished ReasoningItem.

        Returns:
            Closing event(s), or the full reasoning sequence.
        """
        raw = item.raw_item
        raw_id = read_attr(raw, "id")
        action, key = self._reconcile(raw_id, self._open_reasonings, self._closed_reasoning_ids)
        if action == "close":
            events = self._emit_encrypted_value(key, raw)
            events.extend(self._close_reasoning(key))
            return events
        if action == "skip":
            return []
        phase_id = self._resolve_id(raw_id, new_reasoning_id)
        events = self._open_reasoning(phase_id, phase_id)
        parts = [read_attr(entry, "text") for entry in (read_attr(raw, "summary") or [])]
        parts += [read_attr(entry, "text") for entry in (read_attr(raw, "content") or [])]
        for text in parts:
            if not text:
                continue
            events.extend(self._open_reasoning_part(phase_id))
            events.append(
                ReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=self._open_reasoning_parts[phase_id],
                    delta=text,
                )
            )
            events.extend(self._close_reasoning_part(phase_id))
        events.extend(self._emit_encrypted_value(phase_id, raw))
        events.extend(self._close_reasoning(phase_id))
        return events

    def translate_handoff_call_item(self, item: HandoffCallItem) -> list[BaseEvent]:
        """Surface a handoff request as a tool call (it is a function call).

        The same underlying item also arrives through the raw-event
        path, so the call-id reconciliation in translate_tool_call_item
        prevents a duplicate TOOL_CALL_START.

        Args:
            item: The finished HandoffCallItem.

        Returns:
            Closing event, or the full START/[ARGS]/END sequence.
        """
        return self.translate_tool_call_item(item)  # type: ignore[arg-type]

    def translate_handoff_output_item(self, item: HandoffOutputItem) -> list[BaseEvent]:
        """Translate a handoff completion into TOOL_CALL_RESULT.

        Args:
            item: The finished HandoffOutputItem.

        Returns:
            A single TOOL_CALL_RESULT event, or [] if call_id is missing.
        """
        raw = item.raw_item
        call_id = read_attr(raw, "call_id")
        if not call_id:
            logger.debug("Handoff output without call_id; skipping TOOL_CALL_RESULT")
            return []
        target = read_attr(item.target_agent, "name") or ""
        output = read_attr(raw, "output") or f"Handed off to {target}"
        content = coerce_to_str(output)
        result_id = self._record_result(call_id, content)
        return [
            ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=result_id,
                tool_call_id=call_id,
                content=content,
            )
        ]

    def translate_mcp_approval_request_item(
        self,
        item: MCPApprovalRequestItem,
    ) -> list[BaseEvent]:
        """Translate an MCP approval request into a CUSTOM event (name="mcp_approval_request").

        AG-UI has no native approval shape yet; forwarding the raw
        request lets a frontend implement approval UI without protocol
        changes.

        Args:
            item: The finished MCPApprovalRequestItem.

        Returns:
            A single CUSTOM event carrying the raw request.
        """
        raw = item.raw_item
        value = raw.model_dump() if hasattr(raw, "model_dump") else raw
        return [
            CustomEvent(
                type=EventType.CUSTOM,
                name="mcp_approval_request",
                value=value,
            )
        ]

    def translate_mcp_list_tools_item(self, item: MCPListToolsItem) -> list[BaseEvent]:
        """Drop an MCP tool listing item (server-side bookkeeping). Overridable.

        Args:
            item: The finished MCPListToolsItem.

        Returns:
            Always [].
        """
        logger.debug("Dropping MCPListToolsItem id=%s", read_attr(item.raw_item, "id"))
        return []

    def translate_mcp_approval_response_item(
        self,
        item: MCPApprovalResponseItem,
    ) -> list[BaseEvent]:
        """Drop an MCP approval response item (echo of client input). Overridable.

        Args:
            item: The finished MCPApprovalResponseItem.

        Returns:
            Always [].
        """
        logger.debug("Dropping MCPApprovalResponseItem")
        return []

    # ─────────────────────────────────────────────────────────────────────
    # TIER 4 — Internal helpers: id handling
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _is_real_id(item_id: Any) -> bool:
        """Check whether an id is usable on the wire (not empty, not a placeholder).

        Some model backends stamp every item with the SDK's
        FAKE_RESPONSES_ID sentinel — sharing it across AG-UI events
        would collide every message of the run. Checked against the
        SDK's own constant, so it's a no-op (always real) on native
        OpenAI and correct for any other backend without a
        provider-specific branch.

        Args:
            item_id: The item's wire id, or None.

        Returns:
            True if the id is real and usable.
        """
        return bool(item_id) and item_id != FAKE_RESPONSES_ID

    @classmethod
    def _resolve_id(cls, item_id: Any, generate: Any) -> str:
        """Return the id if real, else a freshly generated one.

        Args:
            item_id: The item's wire id, or None.
            generate: A zero-arg callable producing a fresh id.

        Returns:
            The real id, or a freshly generated one.
        """
        return item_id if cls._is_real_id(item_id) else generate()

    @classmethod
    def _window_key(cls, item_id: Any, output_index: Any) -> str:
        """Compute a stable window key for correlating raw events of one output item.

        Real item ids win; placeholder ids fall back to the stream
        position (output_index), which the Responses API guarantees is
        unique per item within a response.

        Args:
            item_id: The item's wire id, or None.
            output_index: The item's position in the response.

        Returns:
            A stable key for this item's window.
        """
        if cls._is_real_id(item_id):
            return item_id
        return f"__idx_{output_index}"

    def _reconcile(
        self,
        raw_id: Any,
        open_windows: dict[str, str],
        closed_ids: list[str],
    ) -> tuple[str, str | None]:
        """Match a run-item commit against streamed window state.

        With a real id the match is exact. With a placeholder id run
        items arrive in stream order, so the oldest open window (or one
        queued closed id) is consumed instead.

        Args:
            raw_id: The run item's raw wire id, or None.
            open_windows: Currently open windows for this category.
            closed_ids: Ids already closed via streaming, oldest first.

        Returns:
            ("close", key) when a streamed window is still open,
            ("skip", resolved_id) when the item was already fully
            streamed and closed — resolved_id is the id that streamed
            close already used, so the caller can still record a
            snapshot message under it (real id: raw_id itself, since
            it's known directly; placeholder id: the queued closed id),
            or ("new", None) when nothing was streamed for the item and
            it must be emitted whole.
        """
        if self._is_real_id(raw_id):
            if raw_id in open_windows:
                return ("close", raw_id)
            if raw_id in closed_ids:
                return ("skip", raw_id)
            return ("new", None)
        if open_windows:
            return ("close", next(iter(open_windows)))
        if closed_ids:
            resolved_id = closed_ids.pop(0)
            return ("skip", resolved_id)
        return ("new", None)

    # ─────────────────────────────────────────────────────────────────────
    # TIER 4 — Internal helpers: window management
    # ─────────────────────────────────────────────────────────────────────

    def _open_text(self, key: str, message_id: str) -> list[BaseEvent]:
        if key in self._open_texts:
            return []
        # Once real output starts, the model is done thinking. Close any open
        # reasoning now instead of waiting for the done-event — some backends
        # send it late, and we don't want reasoning bleeding into the answer.
        events = self._close_all_reasonings()
        self._open_texts[key] = message_id
        events.append(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=message_id,
                role="assistant",
            )
        )
        return events

    def _emit_text_content(self, key: str, delta: str) -> list[BaseEvent]:
        if not delta:
            return []
        events: list[BaseEvent] = []
        if key not in self._open_texts:
            # First real delta for a deferred item opens the window now, under
            # the id output_item.added reserved (falling back to a fresh id if
            # the deltas arrived with no added first).
            events.extend(
                self._open_text(key, self._pending_text_ids.pop(key, None) or new_message_id())
            )
        events.append(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=self._open_texts[key],
                delta=delta,
            )
        )
        return events

    def _close_text(self, key: str) -> list[BaseEvent]:
        message_id = self._open_texts.pop(key, None)
        if message_id is None:
            return []
        self._closed_text_ids.append(message_id)
        return [
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=message_id,
            )
        ]

    def _open_tool_call(self, key: str, call_id: str, name: str) -> list[BaseEvent]:
        if key in self._open_tool_calls:
            return []
        events = self._close_all_reasonings()  # see _open_text
        self._open_tool_calls[key] = call_id
        self._seen_call_ids.add(call_id)
        events.append(
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=call_id,
                tool_call_name=name,
            )
        )
        return events

    def _close_tool_call(self, key: str) -> list[BaseEvent]:
        call_id = self._open_tool_calls.pop(key, None)
        if call_id is None:
            return []
        return [
            ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=call_id,
            )
        ]

    def _open_reasoning(self, key: str, phase_id: str) -> list[BaseEvent]:
        if key in self._open_reasonings:
            return []
        self._open_reasonings[key] = phase_id
        self._reasoning_phase_ids[key] = phase_id
        return [
            ReasoningStartEvent(
                type=EventType.REASONING_START,
                message_id=phase_id,
            )
        ]

    def _open_reasoning_part(self, key: str) -> list[BaseEvent]:
        if key in self._open_reasoning_parts:
            return []
        seq = self._reasoning_part_seq.get(key, 0)
        self._reasoning_part_seq[key] = seq + 1
        # The first part just reuses the phase id (keeps round-trips clean);
        # extra parts get a -1, -2, ... suffix. Wire ids never contain a
        # hyphen, so anything with one is clearly something we made up.
        phase_id = self._open_reasonings.get(key, key)
        message_id = phase_id if seq == 0 else f"{phase_id}-{seq}"
        self._open_reasoning_parts[key] = message_id
        return [
            ReasoningMessageStartEvent(
                type=EventType.REASONING_MESSAGE_START,
                message_id=message_id,
                role="reasoning",
            )
        ]

    def _close_reasoning_part(self, key: str) -> list[BaseEvent]:
        message_id = self._open_reasoning_parts.pop(key, None)
        if message_id is None:
            return []
        return [
            ReasoningMessageEndEvent(
                type=EventType.REASONING_MESSAGE_END,
                message_id=message_id,
            )
        ]

    def _close_reasoning(self, key: str) -> list[BaseEvent]:
        phase_id = self._open_reasonings.pop(key, None)
        if phase_id is None:
            return []
        events = self._close_reasoning_part(key)
        self._closed_reasoning_ids.append(phase_id)
        events.append(
            ReasoningEndEvent(
                type=EventType.REASONING_END,
                message_id=phase_id,
            )
        )
        return events

    def _close_all_reasonings(self) -> list[BaseEvent]:
        events: list[BaseEvent] = []
        for key in list(self._open_reasonings):
            events.extend(self._close_reasoning(key))
        return events

    def _emit_encrypted_value(self, key: str, item: Any) -> list[BaseEvent]:
        """Emit REASONING_ENCRYPTED_VALUE once per reasoning item, if present.

        Args:
            key: The reasoning item's window key.
            item: The raw reasoning item.

        Returns:
            A single REASONING_ENCRYPTED_VALUE event, or [] if absent
            or already emitted.
        """
        encrypted = read_attr(item, "encrypted_content")
        if not encrypted or key in self._emitted_encrypted_keys:
            return []
        self._emitted_encrypted_keys.add(key)
        entity_id = self._reasoning_phase_ids.get(key, key)
        return [
            ReasoningEncryptedValueEvent(
                type=EventType.REASONING_ENCRYPTED_VALUE,
                subtype="message",
                entity_id=entity_id,
                encrypted_value=encrypted,
            )
        ]

    # ─────────────────────────────────────────────────────────────────────
    # TIER 4 — Internal helpers: snapshot message builders
    # ─────────────────────────────────────────────────────────────────────
    #
    # One per streamed item, appended as the item commits — always with the
    # id its streamed event already used, so build_messages_snapshot's output
    # lines up with the stream. Reasoning is deliberately not recorded: the
    # streamed reasoning bubbles survive the client merge on their own, and
    # plaintext reasoning cannot be round-tripped back into an OpenAI run.

    def _record_text(self, message_id: str, text: str) -> None:
        self._snapshot_messages.append(
            AssistantMessage(id=message_id, role="assistant", content=text)
        )

    def _record_tool_call(self, call_id: str, name: str, arguments: str) -> None:
        # The streamed TOOL_CALL_START carried no parent message id, so the
        # client keyed the bubble by the tool call id — mirror that here.
        self._snapshot_messages.append(
            AssistantMessage(
                id=call_id,
                role="assistant",
                tool_calls=[
                    ToolCall(
                        id=call_id,
                        type="function",
                        function=FunctionCall(name=name, arguments=arguments),
                    )
                ],
            )
        )

    def _record_result(self, call_id: str, content: str) -> str:
        # Returns the derived result id so the caller reuses the same value
        # for its TOOL_CALL_RESULT event — snapshot and stream stay in sync.
        result_id = new_tool_result_id(call_id)
        self._snapshot_messages.append(
            ToolMessage(
                id=result_id, role="tool", tool_call_id=call_id, content=content
            )
        )
        return result_id


__all__ = ["SDKToAGUITranslator"]
