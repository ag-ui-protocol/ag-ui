"""Streaming translator — the package's main API.

AGUITranslator pairs with Runner.run_streamed, exposing
to_sdk(run_input) and to_agui(events, run_input). Stateless and reusable —
each to_agui call creates the fresh stateful engine that run needs.
to_agui always wraps the run with RUN_STARTED / RUN_FINISHED / RUN_ERROR —
not optional, every caller needs them, and thread_id/run_id come straight
off run_input. MESSAGES_SNAPSHOT is appended too, by default (see to_agui).
Session persistence is still the caller's job.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from agents.result import RunResultStreaming
from agents.stream_events import StreamEvent
from ag_ui.core import (
    BaseEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)

from .engine.agui_to_sdk import AGUIToSDKTranslator
from .engine.sdk_to_agui import SDKToAGUITranslator
from .engine.types import TranslatedInput


class AGUITranslator:
    """Main translator — pairs with Runner.run_streamed.

    Example:
        translator = AGUITranslator()
        bundle = translator.to_sdk(run_input)
        result = Runner.run_streamed(agent, input=bundle.messages, ...)
        async for event in translator.to_agui(result, run_input):
            ...  # AG-UI BaseEvent, ready to encode
    """

    def __init__(
        self,
        *,
        inbound_cls: type[AGUIToSDKTranslator] = AGUIToSDKTranslator,
        outbound_cls: type[SDKToAGUITranslator] = SDKToAGUITranslator,
    ) -> None:
        self._inbound = inbound_cls()
        self._outbound_cls = outbound_cls

    def to_sdk(self, run_input: RunAgentInput) -> TranslatedInput:
        """Translate an AG-UI RunAgentInput into an SDK-ready bundle.

        The bundle's tools field holds agents.FunctionTool proxies for the
        client-declared tools — merge them with the agent's static tools
        (agent.clone(tools=[*agent.tools, *bundle.tools])).

        Args:
            run_input: The incoming AG-UI RunAgentInput.

        Returns:
            TranslatedInput with items, tools, and passthrough state.
        """
        bundle = self._inbound.translate(run_input)
        if run_input.tools:
            bundle = bundle.model_copy(
                update={"tools": self._inbound.translate_tools(run_input.tools)}
            )
        return bundle

    async def to_agui(
        self,
        events: RunResultStreaming | AsyncIterator[StreamEvent],
        run_input: RunAgentInput,
        *,
        emit_messages_snapshot: bool = True,
        emit_run_error: bool = True,
        run_error_message: str | None = None,
    ) -> AsyncIterator[BaseEvent]:
        """Translate an SDK event stream into a live AG-UI event stream.

        Feed the result from Runner.run_streamed, or result.stream_events().
        A fresh stateful engine handles this run's windows; when the stream
        ends the engine flush runs automatically — any still-open text /
        tool-call / reasoning window is closed before the iterator finishes.

        The first event yielded is always RUN_STARTED and the last is
        always RUN_FINISHED (or RUN_ERROR, if the stream raises — the
        error event is yielded and then the exception re-raised; this
        includes asyncio.CancelledError from a mid-stream timeout or
        dropped connection, not just ordinary exceptions). RUN_STARTED /
        RUN_FINISHED are not optional; thread_id/run_id come straight off
        run_input.

        On error, the RUN_ERROR event carries str(exc) by default — pass
        run_error_message to send a fixed string instead (e.g. a generic
        "Agent run failed" so raw exception text never reaches the client).
        The exception is re-raised regardless, so the caller's own logging
        still sees the real one. Pass emit_run_error=False only if you
        signal the terminal error yourself in an outer handler — otherwise
        a raise with no RUN_ERROR leaves the client watching the stream
        just stop.

        Just before RUN_FINISHED, a MESSAGES_SNAPSHOT is appended by
        default: run_input.messages, untouched, plus this run's messages —
        collected by the engine as it streamed (see
        SDKToAGUITranslator.build_messages_snapshot), each under the same
        id its streamed event used, so the two can never diverge. Pass
        emit_messages_snapshot=False to opt out (e.g. you assemble your
        own). Works the same whether events is the RunResultStreaming
        object or a bare stream_events() iterator — the snapshot is built
        from engine state, not result.new_items.

        Note:
            run_input.messages passes through to the snapshot as-is. If it
            carries messages your client should not see echoed back — a
            system prompt sent as history instead of via
            agent.instructions, for example — filter them out before
            calling to_agui:

                filtered = run_input.model_copy(
                    update={"messages": [m for m in run_input.messages if m.role != "system"]}
                )
                async for event in translator.to_agui(result, filtered):
                    ...

        Args:
            events: The SDK RunResultStreaming object, or the async
                iterator returned by its stream_events() method.
            run_input: The RunAgentInput this run started from — supplies
                thread_id/run_id for the lifecycle events and, unless
                emit_messages_snapshot=False, the snapshot's prior-history
                half.
            emit_messages_snapshot: Whether to append a MESSAGES_SNAPSHOT
                just before RUN_FINISHED. Defaults to True.
            emit_run_error: Whether to yield a RUN_ERROR event when the
                stream raises, before re-raising. Defaults to True; set
                False only if you emit your own terminal error event.
            run_error_message: The RUN_ERROR message. Defaults to None, which
                sends str(exc); set a fixed string to keep raw exception
                text off the wire.

        Yields:
            AG-UI BaseEvent instances, ready to encode.
        """
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=run_input.thread_id,
            run_id=run_input.run_id,
        )

        stream_events = (
            events.stream_events()
            if isinstance(events, RunResultStreaming)
            else events
        )
        outbound = self._outbound_cls()
        try:
            async for sdk_event in stream_events:
                for event in outbound.translate(sdk_event):
                    yield event
            for event in outbound.finalize():
                yield event
            if emit_messages_snapshot:
                yield outbound.build_messages_snapshot(run_input)
        except (Exception, asyncio.CancelledError) as exc:
            # asyncio.CancelledError is BaseException, not Exception (3.8+) —
            # a mid-stream cancellation (timeout, dropped connection) would
            # otherwise skip this handler entirely and the client would see
            # the stream just stop, with no RUN_ERROR and no RUN_FINISHED.
            if emit_run_error:
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=run_error_message or str(exc),
                )
            raise

        yield RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=run_input.thread_id,
            run_id=run_input.run_id,
        )
