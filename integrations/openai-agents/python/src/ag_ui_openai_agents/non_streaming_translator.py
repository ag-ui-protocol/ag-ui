"""
Non-streaming facade.

:class:`AGUINonStreamingTranslator` pairs with ``Runner.run`` /
``Runner.run_sync`` and exposes exactly two public methods, one per
direction:

    ``to_sdk(run_input)``   AG-UI ``RunAgentInput`` → SDK-ready bundle
    ``to_agui(result)``     finished SDK run → complete AG-UI event list

All translation logic lives in the engine layer (:mod:`.engine`); this
class only orchestrates it. Stateless and
reusable — the engine instance a call needs is created inside it. Pass
engine subclasses via ``inbound_cls`` / ``outbound_cls`` to customize one
mapping without forking (design rule 4).

The output is still a valid AG-UI event sequence — "non-streaming" only
means it is produced in one shot after the run finishes, so there is no
token-level text and no mid-tool ``STATE_DELTA``. For live output use the
main :class:`~ag_ui_openai_agents.AGUITranslator`.
"""

from __future__ import annotations

from typing import Any

from agents.items import RunItem
from ag_ui.core import BaseEvent, RunAgentInput

from .engine.agui_to_sdk import AGUIToSDKTranslator
from .engine.sdk_to_agui import SDKToAGUITranslator
from .engine.types import TranslatedInput


class AGUINonStreamingTranslator:
    """
    Pairs with ``Runner.run`` / ``Runner.run_sync``.

    ::

        translator = AGUINonStreamingTranslator()
        bundle = translator.to_sdk(run_input)
        result = await Runner.run(agent, input=bundle.messages, ...)
        events = translator.to_agui(result)   # complete AG-UI sequence
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

    def to_agui(self, result: Any) -> list[BaseEvent]:
        """Finished SDK run → complete AG-UI event sequence.

        Accepts a ``RunResult`` (its ``new_items`` are read) or a plain
        ``list[RunItem]``. Every item emits full triplets — no windows stay
        open, so there is nothing to finalize.
        """
        items: list[RunItem] = (
            result if isinstance(result, list) else list(result.new_items)
        )
        return self._outbound_cls().translate_items(items)
