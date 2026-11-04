"""Translate between AG-UI requests and OpenAI Agents SDK streams."""

import inspect
from typing import Any, AsyncIterator

from agents.result import RunResultStreaming
from agents.stream_events import StreamEvent

from ag_ui.core import (
    PROTOCOL_VERSION,
    TokenUsage,
    BaseEvent,
    CustomEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedCancelledOutcome,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
    RunStartedEvent,
    StateSnapshotEvent,
)
from .engine.agui_to_openai import AGUIToOpenAITranslator
from .engine.openai_to_agui import OpenAIToAGUITranslator
from .engine.types import ClientToolPending, TranslatedInput
from .interrupts import (
    ResumedInput,
    UnresumableApprovalError,
    approval_interrupts,
    unresumable_approvals,
)
from .state import SharedState


class AGUITranslator:
    """Connect an existing streamed OpenAI Agents SDK run to AG-UI.

    Example:
        translator = AGUITranslator()
        translated_input = translator.to_openai(run_input)
        result = Runner.run_streamed(agent, input=translated_input.messages)
        async for event in translator.to_agui(result, run_input):
            ...  # encode or send the AG-UI event

    The translator does not own the SDK agent, server, or session storage.
    See the README for the complete API reference and integration patterns.
    """

    def __init__(
        self,
        *,
        inbound_cls: type[AGUIToOpenAITranslator] = AGUIToOpenAITranslator,
        outbound_cls: type[OpenAIToAGUITranslator] = OpenAIToAGUITranslator,
    ) -> None:
        """Create a translator; engine classes are advanced mapping override points.

        The inbound translator is reused because request translation is stateless.
        A new outbound translator is created per run because it tracks that
        stream's open text, tool, reasoning, and step windows.

        Args:
            inbound_cls: Request-to-SDK translator class.
            outbound_cls: SDK-stream-to-AG-UI translator class, created per run.
        """
        self._inbound = inbound_cls()
        self._outbound_cls = outbound_cls

    def to_openai(self, run_input: RunAgentInput) -> TranslatedInput:
        """Translate an AG-UI request into OpenAI Agents SDK input and passthrough data.

        The inbound translator performs the complete request conversion,
        including client-owned tool proxies.

        Args:
            run_input: The incoming AG-UI RunAgentInput.

        Returns:
            SDK-ready messages, client-tool proxies, and request passthrough fields.
        """
        return self._inbound.translate(run_input)

    def translate_context(self, items: Any) -> str:
        """Render AG-UI context items as "description: value" lines.

        Args:
            items: ``RunAgentInput.context`` (or ``TranslatedInput.context``).

        Returns:
            The lines, or an empty string when there is nothing to show.
        """
        return self._inbound.translate_context(items or [])

    async def to_agui(
        self,
        events: RunResultStreaming | AsyncIterator[StreamEvent],
        run_input: RunAgentInput,
        *,
        start_custom_event: CustomEvent | None = None,
        initial_state: Any = None,
        final_state: Any = None,
        emit_messages_snapshot: bool = True,
        end_custom_event: CustomEvent | None = None,
        emit_run_error: bool = True,
        run_error_message: str | None = None,
        resumed: ResumedInput | None = None,
        shared_state: SharedState | None = None,
    ) -> AsyncIterator[BaseEvent]:
        """Translate an SDK event stream into ordered AG-UI events.

        The translator supplies the lifecycle and snapshot events; the outbound
        engine translates streamed text, tool, reasoning, and step events.

            1. RUN_STARTED                    — always first
            2. start_custom_event (optional)  — if provided
            3. STATE_SNAPSHOT (initial, optional)
               resumed tool results (optional)
               … STATE_SNAPSHOT for each shared_state change, in between …
               … streamed STEP/TEXT/TOOL/REASONING events …
            4. Finalize open stream windows
            5. STATE_SNAPSHOT (final, optional)
            6. MESSAGES_SNAPSHOT (optional)
            7. end_custom_event (optional)
            8. RUN_FINISHED                   — always last; RUN_ERROR on failure

        RUN_FINISHED carries the run's outcome and token usage. The outcome is
        ``cancelled`` when the SDK run was cancelled (``result.cancel()``);
        ``interrupt`` when it paused on tools marked ``needs_approval``, with
        one interrupt per paused call (see ``interrupts``); and otherwise
        ``success``, naming in ``pending_tool_call_ids`` the client tool calls
        the run left for the application to answer. Cancellation and
        interrupts are read from ``events`` when it is the
        ``RunResultStreaming``; a bare iterator always reports success. Usage has one
        entry per model, summed over the run's model calls, plus one entry
        without a model for calls the stream did not show (sub-agents run as
        tools); RUN_ERROR carries the usage accrued before the failure.

        Ordinary errors close open stream windows, yield ``RUN_ERROR`` by
        default, and re-raise. Cancellation only stops an owned SDK run.

        Args:
            events: A ``RunResultStreaming`` or its ``stream_events()`` iterator.
            run_input: The request supplying lifecycle IDs and message history.
            start_custom_event: ``CustomEvent`` emitted after ``RUN_STARTED``.
                Its value may be static or a zero-argument sync/async factory.
            initial_state: Optional source for the first snapshot. Static value
                or zero-argument sync/async factory.
            final_state: Optional source for the final snapshot. Static value or
                zero-argument sync/async factory, resolved after the stream so it
                can observe changes the run made.
            emit_messages_snapshot: Append ``MESSAGES_SNAPSHOT`` before finishing.
            end_custom_event: ``CustomEvent`` emitted before ``RUN_FINISHED``.
                Its value may be static or a zero-argument sync/async factory
                resolved just before emission.
            emit_run_error: Emit ``RUN_ERROR`` before re-raising an ordinary
                error.
            run_error_message: Safe fixed ``RUN_ERROR`` message; defaults to ``str(exc)``.
            resumed: What ``resume_tool_calls`` returned for this request. Its
                TOOL_CALL_RESULT events are emitted ahead of the streamed
                events, and the usage of the tools it ran is counted.
            shared_state: The run's ``SharedState``. Each change a tool makes is
                streamed as a STATE_SNAPSHOT before the next translated event,
                so it precedes the tool's result. Start the SDK run inside
                ``use_shared_state(shared_state)`` so tools can reach it.

        Yields:
            AG-UI events ready to encode or send.

        Raises:
            TypeError: A custom event is not a CustomEvent instance.
        """
        lifecycle_completed = False
        outbound = self._outbound_cls()
        try:
            # 1. RUN_STARTED — always first
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=run_input.thread_id,
                run_id=run_input.run_id,
                parent_run_id=run_input.parent_run_id,
                protocol_version=PROTOCOL_VERSION,
            )

            # 2. start_custom_event (optional)
            if start_custom_event is not None:
                yield await self._resolve_custom_event(start_custom_event)

            # 3. STATE_SNAPSHOT (initial) — resolve now ({} emits, None skips)
            if initial_state is not None:
                snapshot = await self._resolve_lifecycle_value(initial_state)
                if snapshot is not None:
                    yield StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=snapshot,
                    )

            for event in _state_changes(shared_state):
                yield event
            for event in resumed.tool_results if resumed is not None else ():
                yield event

            # Accept either the SDK result or an iterator already obtained from it.
            stream_events = (
                events.stream_events()
                if isinstance(events, RunResultStreaming)
                else events
            )
            try:
                # Streamed STEP / TEXT / TOOL / REASONING events.
                async for openai_event in stream_events:
                    for event in _state_changes(shared_state):
                        yield event
                    for event in outbound.translate(openai_event):
                        yield event
            except ClientToolPending:
                # Client-owned tools complete through the shared path below.
                pass

            # 4. Close any text, tool, reasoning, or step window still open.
            for event in outbound.finalize():
                yield event
            for event in _state_changes(shared_state):
                yield event
            # 5. STATE_SNAPSHOT (final, optional) — resolved after the stream.
            if final_state is not None:
                snapshot = await self._resolve_lifecycle_value(final_state)
                if snapshot is not None:
                    yield StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=snapshot,
                    )
            # 6. MESSAGES_SNAPSHOT (optional)
            if emit_messages_snapshot:
                yield outbound.build_messages_snapshot(run_input)
            # 7. end_custom_event (optional) — resolved just before emitting.
            if end_custom_event is not None:
                yield await self._resolve_custom_event(end_custom_event)

            # 8. RUN_FINISHED — always last
            run_finished_event = RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=run_input.thread_id,
                run_id=run_input.run_id,
                outcome=_outcome(events, outbound, run_input),
                usage=_run_usage(events, outbound, resumed),
            )
            # Set before yield because a consumer may close at the terminal event.
            lifecycle_completed = True
            yield run_finished_event
        except Exception as exc:
            for event in outbound.finalize():
                yield event
            # A tool may have changed state before the failure; the client
            # keeps sending its state back, so it must not stay stale.
            for event in _state_changes(shared_state):
                yield event
            if emit_run_error:
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    # Only None means "use str(exc)"; an explicit "" is a
                    # deliberate (empty) message and must be honored verbatim.
                    message=run_error_message if run_error_message is not None else str(exc),
                    usage=_run_usage(events, outbound, resumed),
                )
            raise
        finally:
            # Cancel an owned SDK result if AG-UI consumption stops early;
            # callers retain ownership when they pass a bare iterator.
            if not lifecycle_completed and isinstance(events, RunResultStreaming):
                events.cancel()

    async def _resolve_custom_event(
        self,
        event: CustomEvent,
    ) -> CustomEvent:
        """Return a custom event with its value resolved."""
        if not isinstance(event, CustomEvent):
            raise TypeError(
                f"custom event must be a CustomEvent, got {type(event).__name__}"
            )
        value = await self._resolve_lifecycle_value(event.value)
        return event.model_copy(update={"value": value})

    @staticmethod
    async def _resolve_lifecycle_value(source: Any) -> Any:
        """Resolve a static value or a synchronous/asynchronous factory."""
        value = source() if callable(source) else source
        if inspect.isawaitable(value):
            value = await value
        return value


def _outcome(
    events: RunResultStreaming | AsyncIterator[StreamEvent],
    outbound: OpenAIToAGUITranslator,
    run_input: RunAgentInput,
) -> RunFinishedCancelledOutcome | RunFinishedInterruptOutcome | RunFinishedSuccessOutcome:
    """Why the run ended, for RUN_FINISHED."""
    if isinstance(events, RunResultStreaming):
        if _was_cancelled(events):
            return RunFinishedCancelledOutcome(type="cancelled")
        # getattr: SDKs older than tool approvals have no interruptions field.
        items = list(getattr(events, "interruptions", None) or [])
        unresumable = unresumable_approvals(items, outbound.tool_call_ids()) if items else []
        if unresumable:
            # An interrupt nothing can answer would leave the client waiting.
            raise UnresumableApprovalError(
                f"The run paused for approval of {', '.join(unresumable)}, which cannot be "
                "resumed from the conversation: only function tools this run called can be. "
                "Tools inside an agent used as a tool (gate the agent tool itself with "
                "as_tool(..., needs_approval=True)) and built-in tools such as shell or "
                "apply_patch cannot."
            )
        interrupts = approval_interrupts(items)
        if interrupts:
            return RunFinishedInterruptOutcome(type="interrupt", interrupts=interrupts)
    client_tools = {tool.name for tool in run_input.tools or []}
    pending = outbound.unanswered_tool_calls(client_tools)
    return RunFinishedSuccessOutcome(type="success", pending_tool_call_ids=pending or None)


def _run_usage(
    events: RunResultStreaming | AsyncIterator[StreamEvent],
    outbound: OpenAIToAGUITranslator,
    resumed: ResumedInput | None = None,
) -> list[TokenUsage] | None:
    """Token usage for RUN_FINISHED / RUN_ERROR.

    The streamed responses give one entry per model. Calls the stream never
    shows are added as one entry without a model: those of sub-agents run as
    tools (whatever the SDK's own run total holds beyond the streamed
    entries) and those of tools run while resuming approvals, before the SDK
    run started.
    """
    entries = list(outbound.usage() or [])
    unlabelled: dict[str, int] = {}
    wrapper = getattr(events, "context_wrapper", None) if isinstance(events, RunResultStreaming) else None
    for field, value in _usage_counts(getattr(wrapper, "usage", None)).items():
        beyond = value - sum(getattr(entry, field) or 0 for entry in entries)
        if beyond > 0:
            unlabelled[field] = beyond
    for field, value in _usage_counts(resumed.usage if resumed else None).items():
        unlabelled[field] = unlabelled.get(field, 0) + value
    if unlabelled.get("input_tokens") or unlabelled.get("output_tokens"):
        input_tokens = unlabelled.get("input_tokens", 0)
        output_tokens = unlabelled.get("output_tokens", 0)
        counts = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            # Parts never exceed their totals.
            "cached_input_tokens": min(unlabelled.get("cached_input_tokens", 0), input_tokens),
            "reasoning_tokens": min(unlabelled.get("reasoning_tokens", 0), output_tokens),
        }
        entries.append(TokenUsage(**{key: value for key, value in counts.items() if value}))
    return entries or None


def _usage_counts(usage: Any) -> dict[str, int]:
    """The counts of an SDK ``Usage``, by AG-UI field name; only real numbers."""
    if usage is None:
        return {}
    counts = {
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
        "cached_input_tokens": getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", None),
        "reasoning_tokens": getattr(getattr(usage, "output_tokens_details", None), "reasoning_tokens", None),
    }
    return {
        field: value
        for field, value in counts.items()
        if isinstance(value, int) and not isinstance(value, bool)
    }


def _state_changes(shared_state: SharedState | None) -> list[BaseEvent]:
    """The STATE_SNAPSHOTs queued since the last call."""
    return list(shared_state.drain()) if shared_state is not None else []


def _was_cancelled(result: RunResultStreaming) -> bool:
    """Whether ``result.cancel()`` stopped the run, in either mode.

    The SDK records the mode only on a private field and has no public way to
    ask; ``tests/engine/test_types_drift.py`` pins the field so that a change
    in the SDK fails CI instead of turning cancelled runs into successes.
    """
    return getattr(result, "_cancel_mode", "none") in ("immediate", "after_turn")
