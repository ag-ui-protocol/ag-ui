"""Agent wrapper — an OpenAI Agents SDK Agent that speaks AG-UI.

Wrap a plain SDK Agent, get one run_streamed(RunAgentInput) yielding AG-UI events,
ready for add_openai_agents_fastapi_endpoint.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Callable

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

        async for event in agent.run_streamed(run_input):
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
        start_custom_event: CustomEvent | Callable[[], CustomEvent] | None = None,
        initial_state: Any = None,
        final_state: Any = None,
        emit_messages_snapshot: bool = True,
        end_custom_event: CustomEvent | Callable[[], CustomEvent] | None = None,
        emit_run_error: bool = True,
        run_error_message: str | None = None,
    ) -> None:
        """Wrap OpenAI Agents SDK Agent.

        Args:
            agent: The OpenAI Agents SDK Agent to serve.
            name: Public name for health/introspection. Defaults to agent.name.
            description: Optional human-readable description.
            translator: An AGUITranslator to reuse. Defaults to a fresh one;
                pass your own to inject engine subclasses (per-mapping overrides).
            run_config: Passed straight to Runner.run_streamed on every run —
                the place to set a non-OpenAI model provider (e.g. LiteLLM) or
                run-wide model settings. None uses the SDK defaults (native OpenAI).
            start_custom_event: A CustomEvent, or a zero-argument factory that
                builds one per run, emitted after RUN_STARTED.
            initial_state: Passed to AGUITranslator.to_agui. Accepts the same
                static, synchronous, or asynchronous state sources.
            final_state: Passed to AGUITranslator.to_agui. Accepts the same
                static, synchronous, or asynchronous state sources.
            emit_messages_snapshot: Whether to emit MESSAGES_SNAPSHOT before
                RUN_FINISHED. Defaults to True.
            end_custom_event: A CustomEvent, or a zero-argument factory that
                builds one per run, emitted before the terminal lifecycle event.
            emit_run_error: Whether to emit RUN_ERROR when streaming fails.
                Defaults to True.
            run_error_message: Fixed RUN_ERROR message. None sends str(exc).
        """
        self.agent = agent
        self.name = name or agent.name
        self.description = description
        self._translator = translator or AGUITranslator()
        self._run_config = run_config
        self._start_custom_event = start_custom_event
        self._initial_state = initial_state
        self._final_state = final_state
        self._emit_messages_snapshot = emit_messages_snapshot
        self._end_custom_event = end_custom_event
        self._emit_run_error = emit_run_error
        self._run_error_message = run_error_message

    async def run_streamed(self, input: RunAgentInput) -> AsyncIterator[BaseEvent]:
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

        start_custom_event = self._resolve_custom_event(self._start_custom_event)
        end_custom_event = self._resolve_custom_event(self._end_custom_event)

        async for event in self._translator.to_agui(
            result,
            input,
            start_custom_event=start_custom_event,
            initial_state=self._initial_state,
            final_state=self._final_state,
            emit_messages_snapshot=self._emit_messages_snapshot,
            end_custom_event=end_custom_event,
            emit_run_error=self._emit_run_error,
            run_error_message=self._run_error_message,
        ):
            yield event

    @staticmethod
    def _resolve_custom_event(
        source: CustomEvent | Callable[[], CustomEvent] | None,
    ) -> CustomEvent | None:
        """Resolve a fixed custom event or a per-run event factory."""
        return source() if callable(source) else source
