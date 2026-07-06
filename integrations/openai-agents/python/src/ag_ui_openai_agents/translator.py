"""
Streaming facade — the package's main translator.

:class:`AGUITranslator` pairs with ``Runner.run_streamed`` and exposes
exactly two public methods, one per direction:

    ``to_sdk(run_input)``           AG-UI ``RunAgentInput`` → SDK-ready bundle
    ``to_agui(stream_events)``      SDK event stream → live AG-UI event stream

All translation logic lives in the engine layer (:mod:`.engine`); this
class only orchestrates it. Window bookkeeping
and the final flush happen inside the ``to_agui`` iterator — callers never
see ``finalize``.

The facade is stateless and reusable: each ``to_agui`` call creates the
fresh stateful engine that run needs. Pass engine subclasses via
``inbound_cls`` / ``outbound_cls`` to customize one mapping without forking
(design rule 4).

Lifecycle events (``RUN_STARTED``/``RUN_FINISHED``/``RUN_ERROR``),
``STATE_SNAPSHOT`` and session persistence stay in the caller's run loop
(design rule 2) — see ``examples/server.py``.

Non-streaming runs (``Runner.run`` / ``run_sync``): use
:class:`~ag_ui_openai_agents.AGUINonStreamingTranslator`.
"""

from __future__ import annotations

from typing import Any, AsyncIterable, AsyncIterator

from ag_ui.core import BaseEvent, RunAgentInput

from .engine.agui_to_sdk import AGUIToSDKTranslator
from .engine.sdk_to_agui import SDKToAGUITranslator
from .engine.types import TranslatedInput


class AGUITranslator:
    """
    Main translator — pairs with ``Runner.run_streamed``.

    ::

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
        """AG-UI ``RunAgentInput`` → SDK-ready bundle (items, tools, state...).

        The bundle's ``tools`` holds :class:`agents.FunctionTool` proxies for
        the client-declared tools — merge them with the agent's static tools
        (``agent.clone(tools=[*agent.tools, *bundle.tools])``).
        """
        bundle = self._inbound.translate(run_input)
        if run_input.tools:
            bundle = bundle.model_copy(
                update={"tools": self._inbound.translate_tools(run_input.tools)}
            )
        return bundle

    async def to_agui(self, stream_events: AsyncIterable[Any]) -> AsyncIterator[BaseEvent]:
        """SDK event stream → live AG-UI event stream.

        Feed ``result.stream_events()`` from ``Runner.run_streamed``. A fresh
        stateful engine handles this run's windows; when the stream ends the
        engine flush runs automatically — any still-open text / tool-call /
        reasoning window is closed before the iterator finishes.
        """
        outbound = self._outbound_cls()
        async for sdk_event in stream_events:
            for event in outbound.translate(sdk_event):
                yield event
        for event in outbound.finalize():
            yield event
