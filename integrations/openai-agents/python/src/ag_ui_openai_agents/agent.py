"""Agent wrapper — an OpenAI Agents SDK Agent that speaks AG-UI."""

import copy
import inspect
import logging
from contextlib import aclosing
from typing import Any, AsyncIterator

from agents import Agent, RunConfig, RunContextWrapper, Runner

from ag_ui.core import BaseEvent, CustomEvent, RunAgentInput
from .approvals import ApprovalSigner, ConsumedTokens, default_approval_signer
from .interrupts import _mcp_tools, resume_tool_calls
from .state import SharedState, use_shared_state
from .translator import AGUITranslator

logger = logging.getLogger(__name__)

# Sentinel: distinguishes "caller passed context=None" (a real SDK context of
# None) from "caller said nothing" (fall back to the AG-UI context list).
_UNSET_CONTEXT: Any = object()


class OpenAIAgentsAgent:
    """Wrap an OpenAI Agents SDK Agent so it speaks the AG-UI protocol.

    The wrapper is reusable across requests. Non-conflicting client tools are
    added to a per-request agent clone, and output uses fresh per-run state.

    Tools marked ``needs_approval`` work with no extra code: a paused call
    ends the run with an AG-UI interrupt, and the next request's ``resume``
    entry approves or rejects it (see ``interrupts``). The server signs each
    paused call, so only calls it paused can run (see ``approvals``).

    The request's AG-UI context is added to the agent's instructions, and its
    state is the run's ``SharedState``: tools read and change it through
    ``shared_state()``, and each change streams as a STATE_SNAPSHOT.

    This shortcut hides the run loop. Use ``AGUITranslator`` directly when
    application logic needs access to ``RunResultStreaming``.

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
        context: Any = _UNSET_CONTEXT,
        start_custom_event: CustomEvent | None = None,
        initial_state: Any = None,
        final_state: Any = None,
        emit_messages_snapshot: bool = True,
        end_custom_event: CustomEvent | None = None,
        emit_run_error: bool = True,
        run_error_message: str | None = None,
        context_in_instructions: bool = True,
        approvals: ApprovalSigner | None = None,
        consumed_tokens: ConsumedTokens | None = None,
        approval_scope: str | None = None,
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
            context: The SDK run context (``TContext``) handed to tools, hooks,
                and dynamic instructions via ``RunContextWrapper.context``. When
                omitted, the AG-UI request's ambient ``context`` list is passed
                through instead. Provide this when the wrapped agent's tools
                expect an application-specific context object.
            start_custom_event: CustomEvent emitted after RUN_STARTED. Its value
                may be static or a zero-argument sync/async factory.
            initial_state: Passed to AGUITranslator.to_agui unchanged.
            final_state: Passed to AGUITranslator.to_agui unchanged.
            emit_messages_snapshot: Whether to emit MESSAGES_SNAPSHOT before
                RUN_FINISHED. Defaults to True.
            end_custom_event: CustomEvent emitted before the terminal event.
                Its value may be static or a zero-argument sync/async factory.
                Use the translator directly when its value needs the run result.
            emit_run_error: Whether to emit RUN_ERROR for ordinary lifecycle
                errors.
                Defaults to True.
            run_error_message: Fixed RUN_ERROR message. None sends str(exc).
            context_in_instructions: Append the request's AG-UI context to the
                agent's instructions, as "description: value" lines, so the
                model sees what the page shared. Defaults to True.
            approvals: Signs the tool calls a run pauses for approval and
                verifies them on resume. Give every worker the same secret.
                Defaults to ``default_approval_signer()``, whose secret comes
                from ``AG_UI_OPENAI_AGENTS_APPROVAL_SECRET`` (or is random per
                process).
            consumed_tokens: Where the default signer records decided
                approvals, so each runs once. Defaults to process memory,
                which does not stop a replay that reaches another worker or
                comes after a restart: with several workers, pass a store they
                share (see ``ConsumedTokens``). With ``approvals``, pass the
                store to ``ApprovalSigner(consumed=...)`` instead.
            approval_scope: The scope this agent's approval tokens are bound
                to: a token runs a call only on an agent with the same scope.
                Defaults to the scope of ``approvals`` when it has one, else
                ``name``. Give every worker serving this agent the same scope,
                and give agents that share the secret and a name, but not
                their tools, different ones.

        Raises:
            ValueError: Both ``approvals`` and ``consumed_tokens`` were given.
        """
        if approvals is not None and consumed_tokens is not None:
            raise ValueError(
                "Pass consumed_tokens to ApprovalSigner(consumed=...) when you pass approvals."
            )
        self.agent = agent
        self.name = name or agent.name
        self.description = description
        self._translator = translator or AGUITranslator()
        self._run_config = run_config
        self._context = context
        self._start_custom_event = start_custom_event
        self._initial_state = initial_state
        self._final_state = final_state
        self._emit_messages_snapshot = emit_messages_snapshot
        self._end_custom_event = end_custom_event
        self._emit_run_error = emit_run_error
        self._run_error_message = run_error_message
        self._context_in_instructions = context_in_instructions
        self._own_signer = approvals is not None
        self._approval_scope = approval_scope
        self._signer = (
            default_approval_signer(consumed=consumed_tokens) if consumed_tokens is not None else approvals
        )
        self._approvals: ApprovalSigner | None = None

    def with_consumed_tokens(self, consumed_tokens: ConsumedTokens) -> "OpenAIAgentsAgent":
        """A copy of this agent whose default signer records decided approvals in ``consumed_tokens``.

        Raises:
            ValueError: This agent was given its own ``approvals`` signer.
        """
        if self._own_signer:
            raise ValueError(
                "Pass consumed_tokens to ApprovalSigner(consumed=...) when you pass approvals."
            )
        clone = copy.copy(self)
        clone._signer = default_approval_signer(consumed=consumed_tokens)
        clone._approvals = None
        return clone

    @property
    def approvals(self) -> ApprovalSigner:
        """The signer this agent pauses and resumes approvals with.

        Without ``approvals`` or ``consumed_tokens`` this is
        ``default_approval_signer()``, made on first use; it logs a warning
        when its decided approvals are kept per process. It is bound to this
        agent's ``approval_scope``.
        """
        if self._approvals is None:
            signer = self._signer if self._signer is not None else default_approval_signer()
            scope = self._approval_scope
            if scope is None:
                scope = signer.scope or self.name
            self._approvals = signer.scoped(scope)
        return self._approvals

    async def run_streamed(self, input: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """Translate one AG-UI request, run the agent, and yield AG-UI events.

        Client tools are added to a per-request agent clone. The translator
        handles input and output mapping, lifecycle events, and snapshots.
        Tool calls the history left open (a paused approval answered by a
        ``resume`` entry, or an unfinished call) are answered before the model
        runs. An approval the request did not decide stays open: the run
        answers the rest and ends with its interrupt again, without calling
        the model. The request's state is the run's ``SharedState`` (see
        ``state``).

        Args:
            input: The incoming AG-UI RunAgentInput.

        Yields:
            AG-UI BaseEvent instances, ready to encode.
        """
        # Fall back to the AG-UI ambient context; normalize an empty list to
        # None so a context-less request matches the SDK's own default (None),
        # not [] — agents that branch on `ctx.context is None` rely on this.
        context = (
            self._context
            if self._context is not _UNSET_CONTEXT
            else (list(input.context or []) or None)
        )
        state = SharedState(input.state)
        lifecycle = dict(
            start_custom_event=self._start_custom_event,
            initial_state=self._initial_state,
            final_state=self._final_state,
            emit_messages_snapshot=self._emit_messages_snapshot,
            end_custom_event=self._end_custom_event,
            emit_run_error=self._emit_run_error,
            run_error_message=self._run_error_message,
            shared_state=state,
            approvals=self.approvals,
        )
        try:
            with use_shared_state(state):
                resumed = await resume_tool_calls(
                    self.agent,
                    input,
                    context=context,
                    run_config=self._run_config,
                    approvals=self.approvals,
                )
        except Exception as exc:
            # A tool that failed while resuming fails the run the way a tool
            # failing in the run does: RUN_STARTED, the state changes it made,
            # then RUN_ERROR (to_agui re-raises for the server's logs).
            async def failure():
                raise exc
                yield  # pragma: no cover — makes this an async generator

            async with aclosing(self._translator.to_agui(failure(), input, **lifecycle)) as events:
                async for event in events:
                    yield event
            return
        input = resumed.run_input
        if resumed.open_interrupts:
            # An approval nobody decided stays open: answer what the request
            # did decide and ask again, without calling the model.
            async with aclosing(
                self._translator.to_agui(None, input, resumed=resumed, **lifecycle)
            ) as events:
                async for event in events:
                    yield event
            return
        translated = self._translator.to_openai(input)

        run_agent = self.agent
        if translated.tools:
            # MCP server tools are listed at run time, not kept in agent.tools;
            # the SDK resolves a name to the last tool with it, so a client tool
            # of the same name would replace the server's.
            server_tool_names = {
                name
                # strict: an unknown inventory is not an empty one.
                for tool in [*self.agent.tools, *await _mcp_tools(self.agent, context, strict=True)]
                if (name := getattr(tool, "name", None)) is not None
            }
            client_tools = []
            seen_client_names: set[str] = set()
            for tool in translated.tools:
                if tool.name in server_tool_names:
                    logger.warning(
                        "Ignoring client tool %r because a server tool already uses this name",
                        tool.name,
                    )
                    continue
                if tool.name in seen_client_names:
                    logger.warning(
                        "Ignoring duplicate client tool %r; the SDK cannot resolve two tools with one name",
                        tool.name,
                    )
                    continue
                seen_client_names.add(tool.name)
                client_tools.append(tool)

            if client_tools:
                run_agent = self.agent.clone(
                    tools=[*self.agent.tools, *client_tools]
                )

        if self._context_in_instructions:
            context_text = self._translator.translate_context(translated.context)
            if context_text:
                run_agent = _with_context(run_agent, context_text)

        # The SDK run starts its task here, so its tools see this state.
        with use_shared_state(state):
            result = Runner.run_streamed(
                run_agent,
                input=translated.messages,
                run_config=self._run_config,
                context=context,
            )

        # Closed explicitly: when the consumer stops early, to_agui must cancel
        # the SDK run before this generator finishes closing, not at some later
        # garbage collection.
        async with aclosing(
            self._translator.to_agui(result, input, resumed=resumed, **lifecycle)
        ) as events:
            async for event in events:
                yield event


def _with_context(agent: Agent, context_text: str) -> Agent:
    """A clone of ``agent`` whose instructions end with the AG-UI context."""
    original = agent.instructions
    block = f"Context from the application:\n{context_text}"

    async def instructions(run_context: RunContextWrapper[Any], current: Agent) -> str:
        base = original
        if callable(base):
            base = base(run_context, current)
            if inspect.isawaitable(base):
                base = await base
        return f"{base}\n\n{block}" if base else block

    return agent.clone(instructions=instructions)
