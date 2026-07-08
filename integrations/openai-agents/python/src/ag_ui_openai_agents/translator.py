"""Streaming translator — the package's main API.

AGUITranslator pairs with Runner.run_streamed, exposing
to_sdk(run_input) and to_agui(events). Stateless and reusable —
each to_agui call creates the fresh stateful engine that run needs.
Lifecycle events (RUN_STARTED / RUN_FINISHED / RUN_ERROR) and session
persistence are the caller's job, not the translator's. MESSAGES_SNAPSHOT
is the one exception: to_agui appends it by default (see to_agui).
"""

from __future__ import annotations

from typing import AsyncIterator, Sequence

from agents.result import RunResultStreaming
from agents.stream_events import StreamEvent
from ag_ui.core import BaseEvent, Message, RunAgentInput

from .engine.agui_to_sdk import AGUIToSDKTranslator
from .engine.sdk_to_agui import SDKToAGUITranslator
from .engine.types import TranslatedInput


class AGUITranslator:
    """Main translator — pairs with Runner.run_streamed.

    Example:
        translator = AGUITranslator()
        bundle = translator.to_sdk(run_input)
        result = Runner.run_streamed(agent, input=bundle.messages, ...)
        async for event in translator.to_agui(result):
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
        *,
        run_input: RunAgentInput | Sequence[Message] | None = None,
        emit_messages_snapshot: bool = True,
    ) -> AsyncIterator[BaseEvent]:
        """Translate an SDK event stream into a live AG-UI event stream.

        Feed the result from Runner.run_streamed, or result.stream_events().
        A fresh stateful engine handles this run's windows; when the stream
        ends the engine flush runs automatically — any still-open text /
        tool-call / reasoning window is closed before the iterator finishes.

        By default the last event yielded is a MESSAGES_SNAPSHOT: run_input's
        messages, untouched, plus this run's messages — collected by the
        engine as it streamed (see SDKToAGUITranslator.build_messages_snapshot),
        each under the same id its streamed event used, so the two can never
        diverge. Requires both run_input and emit_messages_snapshot=True;
        pass emit_messages_snapshot=False to opt out (e.g. you already emit
        your own), or simply omit run_input if you have no prior history to
        attach — either way no snapshot is appended. Works the same whether
        events is the RunResultStreaming object or a bare stream_events()
        iterator — the snapshot is built from engine state, not
        result.new_items.

        Note:
            run_input.messages passes through to the snapshot as-is. If it
            carries messages your client should not see echoed back — a
            system prompt sent as history instead of via
            agent.instructions, for example — filter them out before
            calling to_agui:

                filtered = [m for m in run_input.messages if m.role != "system"]
                async for event in translator.to_agui(
                    result, run_input=filtered
                ):
                    ...

        Args:
            events: The SDK RunResultStreaming object, or the async
                iterator returned by its stream_events() method.
            run_input: The RunAgentInput (or its messages) this run
                started from, for the snapshot's prior-history half.
                Required (together with emit_messages_snapshot=True) for
                the snapshot to be appended.
            emit_messages_snapshot: Whether to append a MESSAGES_SNAPSHOT
                after the stream ends. Defaults to True.

        Yields:
            AG-UI BaseEvent instances, ready to encode.
        """
        stream_events = (
            events.stream_events()
            if isinstance(events, RunResultStreaming)
            else events
        )
        outbound = self._outbound_cls()
        async for sdk_event in stream_events:
            for event in outbound.translate(sdk_event):
                yield event
        for event in outbound.finalize():
            yield event
        if run_input and emit_messages_snapshot:
            yield outbound.build_messages_snapshot(run_input)
