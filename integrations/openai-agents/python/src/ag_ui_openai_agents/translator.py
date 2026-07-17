"""Translate between AG-UI requests and OpenAI Agents SDK streams."""

import asyncio
import inspect
from typing import Any, AsyncIterator

from agents.result import RunResultStreaming
from agents.stream_events import StreamEvent

from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
)
from .engine.agui_to_openai import AGUIToOpenAITranslator
from .engine.openai_to_agui import OpenAIToAGUITranslator
from .engine.types import ClientToolPending, TranslatedInput


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
    ) -> AsyncIterator[BaseEvent]:
        """Translate an SDK event stream into ordered AG-UI events.

        The translator supplies the lifecycle and snapshot events; the outbound
        engine translates streamed text, tool, reasoning, and step events.

            1. RUN_STARTED                    — always first
            2. start_custom_event (optional)  — if provided
            3. STATE_SNAPSHOT (initial, optional)
               … streamed STEP/TEXT/TOOL/REASONING events …
            4. Finalize open stream windows
            5. STATE_SNAPSHOT (final, optional)
            6. MESSAGES_SNAPSHOT (optional)
            7. end_custom_event (optional)
            8. RUN_FINISHED                   — always last; RUN_ERROR on failure

        Errors yield ``RUN_ERROR`` by default, then the original exception is
        re-raised. See the README for state, snapshots, and error details.

        Args:
            events: A ``RunResultStreaming`` or its ``stream_events()`` iterator.
            run_input: The request supplying lifecycle IDs and message history.
            start_custom_event: ``CustomEvent`` emitted after ``RUN_STARTED``.
            initial_state: Optional static, sync, or async source for the first snapshot.
            final_state: Optional static, sync, or async source for the final snapshot.
            emit_messages_snapshot: Append ``MESSAGES_SNAPSHOT`` before finishing.
            end_custom_event: ``CustomEvent`` emitted before ``RUN_FINISHED``.
            emit_run_error: Emit ``RUN_ERROR`` before re-raising a stream error.
            run_error_message: Safe fixed ``RUN_ERROR`` message; defaults to ``str(exc)``.

        Yields:
            AG-UI events ready to encode or send.

        Raises:
            TypeError: start_custom_event or end_custom_event was given but
                is not a CustomEvent instance.
        """
        lifecycle_completed = False
        try:
            # The SDK run is already active, so validation stays in cleanup scope.
            if start_custom_event is not None and not isinstance(start_custom_event, CustomEvent):
                raise TypeError(f"start_custom_event must be a CustomEvent, got {type(start_custom_event).__name__}")
            if end_custom_event is not None and not isinstance(end_custom_event, CustomEvent):
                raise TypeError(f"end_custom_event must be a CustomEvent, got {type(end_custom_event).__name__}")

            # 1. RUN_STARTED — always first
            yield RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=run_input.thread_id,
                run_id=run_input.run_id,
                # Read defensively — older RunAgentInput versions lack the field.
                parent_run_id=getattr(run_input, "parent_run_id", None),
            )

            # 2. start_custom_event (optional)
            if start_custom_event is not None:
                yield start_custom_event

            # 3. STATE_SNAPSHOT (initial) — resolve now ({} emits, None skips)
            if initial_state is not None:
                snapshot = await self._resolve_state_snapshot(initial_state)
                if snapshot is not None:
                    yield StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=snapshot,
                    )

            # Accept either the SDK result or an iterator already obtained from it.
            stream_events = (
                events.stream_events()
                if isinstance(events, RunResultStreaming)
                else events
            )
            outbound = self._outbound_cls()
            try:
                # Streamed STEP / TEXT / TOOL / REASONING events.
                async for openai_event in stream_events:
                    for event in outbound.translate(openai_event):
                        yield event
                # 4. Close any text, tool, reasoning, or step window still open.
                for event in outbound.finalize():
                    yield event
                # 5. STATE_SNAPSHOT (final, optional)
                if final_state is not None:
                    snapshot = await self._resolve_state_snapshot(final_state)
                    if snapshot is not None:
                        yield StateSnapshotEvent(
                            type=EventType.STATE_SNAPSHOT,
                            snapshot=snapshot,
                        )
                # 6. MESSAGES_SNAPSHOT (optional)
                if emit_messages_snapshot:
                    yield outbound.build_messages_snapshot(run_input)
            except ClientToolPending:
                # A client-owned tool ends this server run cleanly; its call
                # events have already streamed to the frontend. Finish with
                # steps 4–6.
                # 4. Close any text, tool, reasoning, or step window still open.
                for event in outbound.finalize():
                    yield event
                # 5. STATE_SNAPSHOT (final, optional)
                if final_state is not None:
                    snapshot = await self._resolve_state_snapshot(final_state)
                    if snapshot is not None:
                        yield StateSnapshotEvent(
                            type=EventType.STATE_SNAPSHOT,
                            snapshot=snapshot,
                        )
                # 6. MESSAGES_SNAPSHOT (optional)
                if emit_messages_snapshot:
                    yield outbound.build_messages_snapshot(run_input)
            except (Exception, asyncio.CancelledError) as exc:
                # CancelledError is not an Exception; both paths must close open
                # protocol windows before emitting the terminal error.
                for event in outbound.finalize():
                    yield event
                if emit_run_error:
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=run_error_message or str(exc),
                    )
                raise

            # 7. end_custom_event (optional)
            if end_custom_event is not None:
                yield end_custom_event

            # 8. RUN_FINISHED — always last
            run_finished_event = RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=run_input.thread_id,
                run_id=run_input.run_id,
            )
            # Set before yield because a consumer may close at the terminal event.
            lifecycle_completed = True
            yield run_finished_event
        finally:
            # Cancel an owned SDK result if AG-UI consumption stops early;
            # callers retain ownership when they pass a bare iterator.
            if not lifecycle_completed and isinstance(events, RunResultStreaming):
                events.cancel()

    async def _resolve_state_snapshot(self, state: Any) -> Any:
        """Resolve a static, synchronous, or asynchronous state source."""
        value = state() if callable(state) else state
        if inspect.isawaitable(value):
            value = await value
        return value
