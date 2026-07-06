"""Streaming translator — the package's main API.

AGUITranslator pairs with Runner.run_streamed, exposing only
to_sdk(run_input) and to_agui(stream_events). Stateless and reusable —
each to_agui call creates the fresh stateful engine that run needs.
Lifecycle events (RUN_STARTED / RUN_FINISHED / RUN_ERROR) and session
persistence are the caller's job, not the translator's.

Non-streaming runs (Runner.run / run_sync): use AGUINonStreamingTranslator.
"""

from __future__ import annotations

from typing import Any, AsyncIterable, AsyncIterator

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
        async for event in translator.to_agui(result.stream_events()):
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

    async def to_agui(self, stream_events: AsyncIterable[Any]) -> AsyncIterator[BaseEvent]:
        """Translate an SDK event stream into a live AG-UI event stream.

        Feed result.stream_events() from Runner.run_streamed. A fresh
        stateful engine handles this run's windows; when the stream ends
        the engine flush runs automatically — any still-open text /
        tool-call / reasoning window is closed before the iterator finishes.

        Args:
            stream_events: The SDK's async stream_events() iterator.

        Yields:
            AG-UI BaseEvent instances, ready to encode.
        """
        outbound = self._outbound_cls()
        async for sdk_event in stream_events:
            for event in outbound.translate(sdk_event):
                yield event
        for event in outbound.finalize():
            yield event
