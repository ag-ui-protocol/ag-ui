"""Agent wrapper — an OpenAI Agents SDK Agent that speaks AG-UI.

Wrap a plain SDK Agent, get one run(RunAgentInput) yielding AG-UI events,
ready for add_openai_agents_fastapi_endpoint.
"""

from __future__ import annotations

from typing import AsyncIterator, Callable

from agents import Agent, RunConfig, Runner
from ag_ui.core import BaseEvent, CustomEvent, RunAgentInput

from .translator import AGUITranslator


class OpenAIAgentsAgent:
    """Wrap an OpenAI Agents SDK Agent so it speaks the AG-UI protocol.

    One instance per server process is fine. The wrapper holds no per-request
    state: an SDK Agent is a config template that Runner.run_streamed never
    mutates, and AGUITranslator is stateless on the inbound side and spins up a
    fresh outbound engine per to_agui call. Client-declared tools arriving on a
    request are merged onto a per-request agent.clone(), so concurrent requests
    never see each other's tools.

    Example:
        from agents import Agent
        from ag_ui_openai_agents import OpenAIAgentsAgent

        sdk_agent = Agent(name="assistant", instructions="You are helpful.")
        agent = OpenAIAgentsAgent(sdk_agent)

        async for event in agent.run(run_input):
            ...
    """

    def __init__(
        self,
        agent: Agent,
        *,
        name: str | None = None,
        description: str = "",
        translator: AGUITranslator | None = None,
        run_config: RunConfig | None = None,
        build_start_custom_event: Callable[[], CustomEvent] | None = None,
        build_end_custom_event: Callable[[], CustomEvent] | None = None,
    ) -> None:
        """Wrap an SDK Agent.

        Args:
            agent: The OpenAI Agents SDK Agent to serve.
            name: Public name for health/introspection. Defaults to agent.name.
            description: Optional human-readable description.
            translator: An AGUITranslator to reuse. Defaults to a fresh one;
                pass your own to inject engine subclasses (per-mapping overrides).
            run_config: Passed straight to Runner.run_streamed on every run —
                the place to set a non-OpenAI model provider (e.g. LiteLLM) or
                run-wide model settings. None uses the SDK defaults (native OpenAI).
            build_start_custom_event: Lazily builds a CUSTOM event emitted after
                RUN_STARTED for each run.
            build_end_custom_event: Lazily builds a CUSTOM event emitted before
                the terminal lifecycle event for each run.
        """
        self.agent = agent
        self.name = name or agent.name
        self.description = description
        self._translator = translator or AGUITranslator()
        self._run_config = run_config
        self._build_start_custom_event = build_start_custom_event
        self._build_end_custom_event = build_end_custom_event

    async def run(self, input: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """Run the agent for one AG-UI request and yield AG-UI events.

        Orchestration only — the translator does the mapping. to_sdk turns the
        request into SDK input items plus FunctionTool proxies for any
        client-declared tools; those proxies are merged onto a per-request
        clone so the static agent stays untouched. to_agui wraps the SDK stream
        with the lifecycle events (RUN_STARTED/FINISHED/ERROR), the STATE and
        MESSAGES snapshots, and the flush — nothing to hand-roll here.

        Args:
            input: The incoming AG-UI RunAgentInput.

        Yields:
            AG-UI BaseEvent instances, ready to encode.
        """
        translated = self._translator.to_sdk(input)

        agent = self.agent
        if translated.tools:
            agent = agent.clone(tools=[*self.agent.tools, *translated.tools])

        result = Runner.run_streamed(
            agent,
            input=translated.messages,
            run_config=self._run_config,
            context=translated.context,
        )

        to_agui_kwargs = {}
        if self._build_start_custom_event is not None:
            to_agui_kwargs["start_custom_event"] = self._build_start_custom_event()
        if self._build_end_custom_event is not None:
            to_agui_kwargs["end_custom_event"] = self._build_end_custom_event()

        async for event in self._translator.to_agui(result, input, **to_agui_kwargs):
            yield event
