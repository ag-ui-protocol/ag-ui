"""Streaming translator — the package's main API.

AGUITranslator pairs with Runner.run_streamed, exposing
to_sdk(run_input) and to_agui(events). Stateless and reusable —
each to_agui call creates the fresh stateful engine that run needs.
Lifecycle events (RUN_STARTED / RUN_FINISHED / RUN_ERROR) and session
persistence are the caller's job, not the translator's.
"""

from __future__ import annotations

from typing import AsyncIterator

from agents.result import RunResultStreaming
from agents.stream_events import StreamEvent
from ag_ui.core import BaseEvent, RunAgentInput

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
        self, events: RunResultStreaming | AsyncIterator[StreamEvent]
    ) -> AsyncIterator[BaseEvent]:
        """Translate an SDK event stream into a live AG-UI event stream.

        Feed the result from Runner.run_streamed, or result.stream_events().
        A fresh stateful engine handles this run's windows; when the stream
        ends the engine flush runs automatically — any still-open text /
        tool-call / reasoning window is closed before the iterator finishes.

        Args:
            events: The SDK RunResultStreaming object, or the async
                iterator returned by its stream_events() method.

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
