"""Agent wrapper — an OpenAI Agents SDK Agent that speaks AG-UI."""

from typing import Any, AsyncIterator, Callable

from agents import Agent, RunConfig, Runner

from ag_ui.core import BaseEvent, CustomEvent, RunAgentInput
from .translator import AGUITranslator


class OpenAIAgentsAgent:
    """Wrap an OpenAI Agents SDK Agent so it speaks the AG-UI protocol.

    The wrapper is reusable across requests. Client-declared tools are added to
    a per-request agent clone, and output translation uses fresh per-run state.

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
        """Configure an OpenAI Agents SDK Agent for AG-UI requests.

        Args:
            agent: The OpenAI Agents SDK Agent to serve.
            name: Public name for health/introspection. Defaults to agent.name.
            description: Optional human-readable description.
            translator: Reusable translator. Provide one to customize mapping
                through engine subclasses.
            run_config: Run-wide OpenAI Agents SDK configuration. None uses the
                SDK defaults.
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
        """Translate one AG-UI request, run the agent, and yield AG-UI events.

        Client tools are added to a per-request agent clone. The translator
        handles input and output mapping, lifecycle events, and snapshots.

        Args:
            input: The incoming AG-UI RunAgentInput.

        Yields:
            AG-UI BaseEvent instances, ready to encode.
        """
        translated = self._translator.to_openai(input)

        run_agent = self.agent
        if translated.tools:
            run_agent = self.agent.clone(
                tools=[*self.agent.tools, *translated.tools]
            )

        start_custom_event = self._resolve_custom_event(self._start_custom_event)
        end_custom_event = self._resolve_custom_event(self._end_custom_event)

        result = Runner.run_streamed(
            run_agent,
            input=translated.messages,
            run_config=self._run_config,
            context=translated.context,
        )

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
