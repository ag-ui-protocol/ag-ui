"""Outbound translator: OpenAI Agents SDK events → AG-UI ``BaseEvent``.

Layered API (each tier is callable on its own — they build on each other),
mirroring :class:`~.agui_to_sdk.AGUIToSDKTranslator`:

    Tier 1 — One-shot:
        translate(sdk_event)              → list[BaseEvent]  (dispatcher)
        finalize()                        → list[BaseEvent]  (flush open windows)

    Tier 2 — Bulk / per event family:
        translate_items(items)            → list[BaseEvent]  (non-streaming runs)
        translate_raw_response_event(e)   → list[BaseEvent]
        translate_run_item_event(e)       → list[BaseEvent]
        translate_agent_updated_event(e)  → list[BaseEvent]

    Tier 3a — Raw Responses deltas (per raw ``type``):
        translate_output_item_added / translate_output_item_done
        translate_text_delta / translate_refusal_delta / translate_text_done
        translate_function_call_arguments_delta
        translate_reasoning_delta / translate_reasoning_part_done

    Tier 3b — Single run item (per SDK type):
        translate_item(item)              → list[BaseEvent]  (dispatcher)
            translate_message_output_item
            translate_tool_call_item
            translate_tool_call_output_item
            translate_reasoning_item
            translate_handoff_call_item
            translate_handoff_output_item
            translate_mcp_approval_request_item
            translate_mcp_list_tools_item
            translate_mcp_approval_response_item

    Tier 4 — Internal helpers (underscore-prefixed).

The translator is **stateful per run** — it tracks open text / tool-call /
reasoning windows so AG-UI always sees strict ``START → CONTENT → END``
triplets. Instantiate a fresh one per AG-UI run; never share across runs.

Works with every SDK execution mode:

    Streaming (async)::

        translator = SDKToAGUITranslator()
        result = Runner.run_streamed(agent, input=items)
        async for sdk_event in result.stream_events():
            for event in translator.translate(sdk_event):
                yield event
        for event in translator.finalize():
            yield event

    Non-streaming (async or sync)::

        result = await Runner.run(agent, input=items)   # or Runner.run_sync(...)
        for event in SDKToAGUITranslator().translate_items(result.new_items):
            yield event

Run-envelope events (``RUN_STARTED`` / ``RUN_FINISHED`` / ``RUN_ERROR``,
``STATE_SNAPSHOT`` / ``STATE_DELTA``, ``MESSAGES_SNAPSHOT``) are the run
loop's job — the translator only translates.
"""

from __future__ import annotations

import logging
from typing import Any

from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    EventType,
    ReasoningEncryptedValueEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
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

from .helpers import (
    coerce_to_str,
    new_message_id,
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
    """Translate OpenAI Agents SDK outputs into AG-UI :class:`BaseEvent` objects.

    Wire ids are reused, never invented — with one caveat: some model backends
    stamp every item with the SDK's ``FAKE_RESPONSES_ID`` placeholder instead
    of a real id. Windows are therefore keyed by real item
    id when available and by the raw event's ``output_index`` otherwise, and
    placeholder ids are replaced with generated ones so AG-UI clients never see
    two different messages sharing an id.

    The pattern is "lazy open, eager close": a ``*_START`` is emitted when the
    first signal for a window arrives (``output_item.added`` or, defensively,
    a bare delta), and ``*_END`` fires on the first close signal —
    ``output_item.done``, the run-item commit, or :meth:`finalize`, whichever
    comes first. Run items double as the full emission path for non-streaming
    runs: when no window was ever opened for an item, its run-item translator
    emits the complete triplet from the finished item.
    """

    def __init__(self) -> None:
        # Open windows, keyed by real item id or ``__idx_<output_index>``.
        # Values are the ids already emitted in the *_START events.
        self._open_texts: dict[str, str] = {}          # key → message_id
        self._open_tool_calls: dict[str, str] = {}     # key → tool_call_id
        self._open_reasonings: dict[str, str] = {}     # key → phase message_id
        self._open_reasoning_parts: dict[str, str] = {}  # key → part message_id
        # Close bookkeeping — lets run items tell "close me" (streamed) apart
        # from "emit me whole" (non-streamed) even with placeholder ids.
        self._closed_text_ids: list[str] = []
        self._closed_reasoning_ids: list[str] = []
        self._seen_call_ids: set[str] = set()
        self._emitted_encrypted_keys: set[str] = set()
        self._reasoning_part_seq: dict[str, int] = {}
        # key → phase id, never popped — encrypted values can arrive after the
        # phase was already force-closed and still need the right entity_id.
        self._reasoning_phase_ids: dict[str, str] = {}
        self._current_step: str | None = None

    # ─────────────────────────────────────────────────────────────────────
    # TIER 1 — One-shot entry points
    # ─────────────────────────────────────────────────────────────────────

    def translate(self, sdk_event: Any) -> list[BaseEvent]:
        """Dispatch one SDK :class:`StreamEvent` to the right family translator.

        Returns a **list** because one SDK event can produce several AG-UI
        events (e.g. an ``output_item.added`` that force-opens a window).
        Unknown event types translate to ``[]`` with a debug log.
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
        """Emit pending ``*_END`` markers when the SDK stream terminates.

        Always call this after the stream ends — even on error — so the AG-UI
        client never sees a window that opened but never closed.
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

    # ─────────────────────────────────────────────────────────────────────
    # TIER 2 — Bulk collection + per event family
    # ─────────────────────────────────────────────────────────────────────

    def translate_items(self, items: list[RunItem]) -> list[BaseEvent]:
        """Translate a finished run's items (non-streaming mode).

        Feed ``result.new_items`` from ``Runner.run`` / ``Runner.run_sync``.
        Each item emits its complete AG-UI sequence (full triplets — no
        windows stay open), so no :meth:`finalize` call is needed after.
        """
        events: list[BaseEvent] = []
        for item in items:
            events.extend(self.translate_item(item))
        return events

    def translate_raw_response_event(self, event: Any) -> list[BaseEvent]:
        """Handle a ``RawResponsesStreamEvent`` (token-level Responses deltas)."""
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
        # response.created / .completed / content_part bookkeeping / audio — no
        # AG-UI equivalent at this layer.
        return []

    def translate_run_item_event(self, event: Any) -> list[BaseEvent]:
        """Handle a ``RunItemStreamEvent`` (semantic commit signals)."""
        item = read_attr(event, "item")
        if item is None:
            return []
        return self.translate_item(item)

    def translate_agent_updated_event(self, event: Any) -> list[BaseEvent]:
        """``AgentUpdatedStreamEvent`` → ``STEP_FINISHED`` (prev) + ``STEP_STARTED``.

        Each agent (including the first, and each handoff target) is surfaced
        as an AG-UI step named after the agent.
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
    # TIER 3a — Raw Responses deltas (per raw ``type``)
    # ─────────────────────────────────────────────────────────────────────

    def translate_output_item_added(self, data: Any) -> list[BaseEvent]:
        """``response.output_item.added`` → open the matching AG-UI window.

        * ``message``       → ``TEXT_MESSAGE_START``
        * ``function_call`` → ``TOOL_CALL_START``
        * ``reasoning``     → ``REASONING_START``
        * hosted tool calls → ``TOOL_CALL_START`` (tool name = item type)
        """
        item = read_attr(data, "item")
        item_type = read_attr(item, "type")
        item_id = read_attr(item, "id")
        key = self._window_key(item_id, read_attr(data, "output_index"))

        if item_type == SDKItemType.MESSAGE:
            return self._open_text(key, self._resolve_id(item_id, new_message_id))
        if item_type == SDKItemType.FUNCTION_CALL:
            call_id = read_attr(item, "call_id") or self._resolve_id(item_id, new_tool_call_id)
            name = read_attr(item, "name") or ""
            return self._open_tool_call(key, call_id, name)
        if item_type == SDKItemType.REASONING:
            return self._open_reasoning(key, self._resolve_id(item_id, new_message_id))
        if item_type in HOSTED_TOOL_CALL_TYPES:
            call_id = self._resolve_id(item_id, new_tool_call_id)
            return self._open_tool_call(key, call_id, item_type)
        return []

    def translate_output_item_done(self, data: Any) -> list[BaseEvent]:
        """``response.output_item.done`` → close the matching AG-UI window.

        For reasoning items this also emits ``REASONING_ENCRYPTED_VALUE``
        (subtype ``"message"``) when the finished item carries
        ``encrypted_content``.
        """
        item = read_attr(data, "item")
        item_type = read_attr(item, "type")
        key = self._window_key(read_attr(item, "id"), read_attr(data, "output_index"))

        if item_type == SDKItemType.MESSAGE:
            return self._close_text(key)
        if item_type == SDKItemType.FUNCTION_CALL or item_type in HOSTED_TOOL_CALL_TYPES:
            return self._close_tool_call(key)
        if item_type == SDKItemType.REASONING:
            events = self._emit_encrypted_value(key, item)
            events.extend(self._close_reasoning(key))
            return events
        return []

    def translate_text_delta(self, data: Any) -> list[BaseEvent]:
        """``response.output_text.delta`` → ``TEXT_MESSAGE_CONTENT`` (lazy start)."""
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._emit_text_content(key, read_attr(data, "delta") or "")

    def translate_text_done(self, data: Any) -> list[BaseEvent]:
        """``response.output_text.done`` → early ``TEXT_MESSAGE_END``.

        Some model backends skip ``output_item.done``; this closes the
        window on the text-level done signal instead. Idempotent — closing an
        already-closed window is a no-op.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._close_text(key)

    def translate_refusal_delta(self, data: Any) -> list[BaseEvent]:
        """``response.refusal.delta`` → ``TEXT_MESSAGE_CONTENT``.

        Refusal text is user-visible assistant output, so it streams into the
        same text window as regular content.
        """
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._emit_text_content(key, read_attr(data, "delta") or "")

    def translate_function_call_arguments_delta(self, data: Any) -> list[BaseEvent]:
        """``response.function_call_arguments.delta`` → ``TOOL_CALL_ARGS``."""
        delta = read_attr(data, "delta") or ""
        if not delta:
            return []
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        events: list[BaseEvent] = []
        if key not in self._open_tool_calls:
            # Defensive lazy open — provider skipped output_item.added.
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
        """Reasoning deltas → ``REASONING_MESSAGE_CONTENT`` (lazy part start).

        Covers both sources — ``response.reasoning_summary_text.delta``
        (hosted models: model-written summaries) and
        ``response.reasoning_text.delta`` (open-weight models: full chain of
        thought). Whichever arrives streams; each part becomes its own
        ``REASONING_MESSAGE_*`` window inside one ``REASONING_START/END``
        phase, matching the other AG-UI integrations.
        """
        delta = read_attr(data, "delta") or ""
        if not delta:
            return []
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        events: list[BaseEvent] = []
        if key not in self._open_reasonings:
            events.extend(self._open_reasoning(key, new_message_id()))
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
        """Summary-part / reasoning-text done → ``REASONING_MESSAGE_END``."""
        key = self._window_key(read_attr(data, "item_id"), read_attr(data, "output_index"))
        return self._close_reasoning_part(key)

    # ─────────────────────────────────────────────────────────────────────
    # TIER 3b — Single run item (dispatcher + per-type)
    # ─────────────────────────────────────────────────────────────────────

    def translate_item(self, item: RunItem) -> list[BaseEvent]:
        """Dispatch one SDK :class:`RunItem` to the right per-type translator.

        During streaming these act as safety-net closers (raw events already
        streamed the content); for non-streaming runs they emit the item's
        full AG-UI sequence.
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
        logger.debug("Unknown SDK run item type: %s", type(item).__name__)
        return []

    def translate_message_output_item(self, item: MessageOutputItem) -> list[BaseEvent]:
        """Assistant message commit → close its window, or emit the full triplet.

        Streamed: the raw deltas already carried the text — just close.
        Non-streamed: emit ``TEXT_MESSAGE_START/CONTENT/END`` from the finished
        item, using the SDK's own :class:`ItemHelpers` extractors (text first,
        refusal as fallback — both are user-visible).
        """
        raw = item.raw_item
        raw_id = read_attr(raw, "id")
        action, key = self._reconcile(raw_id, self._open_texts, self._closed_text_ids)
        if action == "close":
            return self._close_text(key)
        if action == "skip":
            return []
        text = ItemHelpers.extract_text(raw) or ItemHelpers.extract_refusal(raw) or ""
        message_id = self._resolve_id(raw_id, new_message_id)
        events = self._open_text(message_id, message_id)
        if text:
            events.append(
                TextMessageContentEvent(
                    type=EventType.TEXT_MESSAGE_CONTENT,
                    message_id=message_id,
                    delta=text,
                )
            )
        events.extend(self._close_text(message_id))
        return events
    def translate_tool_call_item(self, item: ToolCallItem) -> list[BaseEvent]:
        """Tool call commit → close its window, or emit ``START/[ARGS]/END``.

        Reconciled by ``call_id`` (present and real regardless of backend),
        using the SDK's built-in :attr:`ToolCallItem.call_id` /
        :attr:`ToolCallItem.tool_name` properties where available —
        ``getattr`` fallbacks because :class:`HandoffCallItem` routes through
        here too and lacks them.
        """
        raw = item.raw_item
        call_id = (
            getattr(item, "call_id", None)
            or read_attr(raw, "call_id")
            or self._resolve_id(read_attr(raw, "id"), new_tool_call_id)
        )
        for key, open_call_id in self._open_tool_calls.items():
            if open_call_id == call_id:
                return self._close_tool_call(key)
        if call_id in self._seen_call_ids:
            return []
        name = (
            getattr(item, "tool_name", None)
            or read_attr(raw, "name")
            or read_attr(raw, "type")
            or ""
        )
        arguments = read_attr(raw, "arguments") or ""
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
        return events

    def translate_tool_call_output_item(self, item: ToolCallOutputItem) -> list[BaseEvent]:
        """Tool result → ``TOOL_CALL_RESULT``."""
        call_id = item.call_id
        if not call_id:
            logger.debug("Tool output without call_id; skipping TOOL_CALL_RESULT")
            return []
        return [
            ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=new_tool_result_id(),
                tool_call_id=call_id,
                content=coerce_to_str(item.output),
            )
        ]

    def translate_reasoning_item(self, item: ReasoningItem) -> list[BaseEvent]:
        """Reasoning commit → close its phase, or emit the full sequence.

        Non-streamed emission walks the finished ``ResponseReasoningItem``:
        one ``REASONING_MESSAGE_*`` window per summary/content entry, then
        ``REASONING_ENCRYPTED_VALUE`` (when present), then ``REASONING_END``.
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
        phase_id = self._resolve_id(raw_id, new_message_id)
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
        """Handoff request → surfaced as a tool call (it *is* a function call).

        The same underlying item also arrives through the raw-event path, so
        the call-id reconciliation in :meth:`translate_tool_call_item`
        prevents a duplicate ``TOOL_CALL_START``.
        """
        return self.translate_tool_call_item(item)  # type: ignore[arg-type]

    def translate_handoff_output_item(self, item: HandoffOutputItem) -> list[BaseEvent]:
        """Handoff completion → ``TOOL_CALL_RESULT``."""
        raw = item.raw_item
        call_id = read_attr(raw, "call_id")
        if not call_id:
            logger.debug("Handoff output without call_id; skipping TOOL_CALL_RESULT")
            return []
        target = read_attr(item.target_agent, "name") or ""
        output = read_attr(raw, "output") or f"Handed off to {target}"
        return [
            ToolCallResultEvent(
                type=EventType.TOOL_CALL_RESULT,
                message_id=new_tool_result_id(),
                tool_call_id=call_id,
                content=coerce_to_str(output),
            )
        ]

    def translate_mcp_approval_request_item(
        self,
        item: MCPApprovalRequestItem,
    ) -> list[BaseEvent]:
        """MCP approval request → ``CUSTOM`` event (``name="mcp_approval_request"``).

        AG-UI has no native approval shape yet; forwarding the raw request
        lets a frontend implement approval UI without protocol changes.
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
        """MCP tool listing → dropped (server-side bookkeeping). Overridable."""
        logger.debug("Dropping MCPListToolsItem id=%s", read_attr(item.raw_item, "id"))
        return []

    def translate_mcp_approval_response_item(
        self,
        item: MCPApprovalResponseItem,
    ) -> list[BaseEvent]:
        """MCP approval response → dropped (echo of client input). Overridable."""
        logger.debug("Dropping MCPApprovalResponseItem")
        return []

    # ─────────────────────────────────────────────────────────────────────
    # TIER 4 — Internal helpers: id handling
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _is_real_id(item_id: Any) -> bool:
        """True when the id is usable on the wire (not empty, not a placeholder).

        Some model backends stamp every item with the SDK's
        ``FAKE_RESPONSES_ID`` sentinel — sharing it across AG-UI events would
        collide every message of the run. Checked against the SDK's own
        constant, so it's a no-op (always real) on native OpenAI and correct
        for any other backend without a provider-specific branch.
        """
        return bool(item_id) and item_id != FAKE_RESPONSES_ID

    @classmethod
    def _resolve_id(cls, item_id: Any, generate: Any) -> str:
        """Return the id if real, else a freshly generated one."""
        return item_id if cls._is_real_id(item_id) else generate()

    @classmethod
    def _window_key(cls, item_id: Any, output_index: Any) -> str:
        """Stable window key for correlating raw events of one output item.

        Real item ids win; placeholder ids fall back to the stream position
        (``output_index``), which the Responses API guarantees is unique per
        item within a response.
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

        Returns ``("close", key)`` when a streamed window is still open,
        ``("skip", None)`` when the item was already fully streamed and
        closed, or ``("new", None)`` when nothing was streamed (non-streaming
        run) and the item must be emitted whole.

        With a real id the match is exact. With a placeholder id run items
        arrive in stream order, so the oldest open window (or one queued
        closed id) is consumed instead.
        """
        if self._is_real_id(raw_id):
            if raw_id in open_windows:
                return ("close", raw_id)
            if raw_id in closed_ids:
                return ("skip", None)
            return ("new", None)
        if open_windows:
            return ("close", next(iter(open_windows)))
        if closed_ids:
            closed_ids.pop(0)
            return ("skip", None)
        return ("new", None)

    # ─────────────────────────────────────────────────────────────────────
    # TIER 4 — Internal helpers: window management
    # ─────────────────────────────────────────────────────────────────────

    def _open_text(self, key: str, message_id: str) -> list[BaseEvent]:
        if key in self._open_texts:
            return []
        # The model has moved on to producing output — any reasoning phase is
        # over, even if the provider's reasoning done-event is still in flight
        # (some backends deliver it late).
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
            events.extend(self._open_text(key, new_message_id()))
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
        # First part reuses the phase id (round-trip friendly); later parts
        # get a stable derived suffix.
        phase_id = self._open_reasonings.get(key, key)
        message_id = phase_id if seq == 0 else f"{phase_id}/{seq}"
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
        """Emit ``REASONING_ENCRYPTED_VALUE`` once per reasoning item, if present."""
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


__all__ = ["SDKToAGUITranslator"]
