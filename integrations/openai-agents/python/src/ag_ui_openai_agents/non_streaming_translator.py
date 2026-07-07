"""Non-streaming translator.

AGUINonStreamingTranslator pairs with Runner.run / Runner.run_sync,
exposing to_sdk(run_input) and to_agui(result). Stateless and reusable.
Output is still a valid AG-UI event sequence, just produced in one shot
after the run finishes (no token-level text, no mid-tool STATE_DELTA).
For live output use the main AGUITranslator.
"""

from __future__ import annotations

from agents.items import RunItem
from agents.result import RunResult
from ag_ui.core import BaseEvent, RunAgentInput

from .engine.agui_to_sdk import AGUIToSDKTranslator
from .engine.sdk_to_agui import SDKToAGUITranslator
from .engine.types import TranslatedInput


class AGUINonStreamingTranslator:
    """Pairs with Runner.run / Runner.run_sync.

    Example:
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

    def to_agui(self, result: RunResult | list[RunItem]) -> list[BaseEvent]:
        """Translate a finished SDK run into a complete AG-UI event sequence.

        Accepts a RunResult (its new_items are read) or a plain
        list[RunItem]. Every item emits full triplets — no windows stay
        open, so there is nothing to finalize.

        Args:
            result: A RunResult from Runner.run/run_sync, or a list of
                RunItem.

        Returns:
            The complete list of AG-UI BaseEvent instances for the run.
        """
        items: list[RunItem] = (
            result if isinstance(result, list) else list(result.new_items)
        )
        return self._outbound_cls().translate_items(items)
