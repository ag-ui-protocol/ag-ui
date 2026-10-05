"""``AntigravityAgent`` -- the AG-UI entry point for Google Antigravity.

    RunAgentInput ──> AntigravityAgent.run() ──> Conversation.receive_steps()
          │                     │                          │
          │              EventTranslator                   │
          │                     │                          │
    BaseEvent[]  <──── translate + bridge events <───── Step[]

The run loop is deliberately small: the Antigravity stream is already ordered,
so translation is a ``for step in receive_steps()`` loop in a try/except. What
this class actually owns is the AG-UI contract around that loop -- exactly one
RUN_STARTED, exactly one terminal event (RUN_FINISHED *or* RUN_ERROR, never
FINISHED after ERROR), and the interleaving of bridge events emitted by parked
hooks and frontend tools.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import os
import tempfile
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional, Sequence

from ag_ui.core import (
    BaseEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunStartedEvent,
)
from google.antigravity import (
    Agent,
    CapabilitiesConfig,
    LocalAgentConfig,
    LocalOpenAIAgentConfig,
)
from google.antigravity import types as ag_types
from google.antigravity.models import DEFAULT_IMAGE_GENERATION_MODEL, DEFAULT_MODEL

from .builtin_tools import get_app_context, get_shared_state
from .event_translator import EventTranslator, step_failure
from .harness_pool import HarnessPool, HarnessProcessDied, to_pooled
from .session_manager import SessionLimitExceeded, SessionManager, tool_signature
from .ui_bridge import UIBridge

logger = logging.getLogger(__name__)

# The AG-UI protocol version this adapter speaks, declared on every RUN_STARTED.
# It is this producer's own version, never an echo of the input's: the pair is
# the whole negotiation, so a consumer sees a downgrade as soon as it happens.
PROTOCOL_VERSION = "1.0"


def _is_harness_lost(exc: BaseException) -> bool:
    """True when the failure means this conversation's harness process is gone.

    A conversation is pinned to one process for its whole life -- the pool has
    no migration path -- so a transport failure is terminal for the session,
    not for the run. Left in place it fails every later run on the thread, and
    can hang one on a socket nobody will answer, which holds `session.lock` and
    makes the session unsweepable as well.

    Deliberately broad: a false positive costs one process boot and a cold
    resume, which restores the history anyway, while a false negative wedges
    the thread for the lifetime of the server. Model and tool errors do not
    match, and must not -- the session is healthy after those.
    """
    seen = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, (HarnessProcessDied, ConnectionError, EOFError)):
            return True
        module = type(exc).__module__.split(".")[0]
        if module == "websockets":
            return True
        exc = exc.__cause__ or exc.__context__
    return False


class _ResumableOpenAIConfig(LocalOpenAIAgentConfig):
    """Restores ``session_continuation_mode`` on the OpenAI-compatible path.

    ``LocalAgentConfig.create_strategy`` forwards the field to the connection
    strategy, but ``LocalOpenAIAgentConfig.create_strategy`` in
    google-antigravity 0.1.8 does not, which silently disables cold resume.
    Setting it on the constructed strategy restores parity; drop this subclass
    once the SDK forwards the field itself.
    """

    def create_strategy(self, *, tool_runner: Any, hook_runner: Any):
        strategy = super().create_strategy(
            tool_runner=tool_runner, hook_runner=hook_runner
        )
        if not hasattr(strategy, "_session_continuation_mode"):
            raise RuntimeError(
                "google-antigravity changed its connection strategy: "
                "_session_continuation_mode is gone, so cold resume would "
                "silently stop working. Check whether "
                "LocalOpenAIAgentConfig.create_strategy now forwards the field "
                "itself and drop _ResumableOpenAIConfig if so."
            )
        strategy._session_continuation_mode = self.session_continuation_mode
        return strategy


class _PooledLocalAgentConfig(LocalAgentConfig):
    """Native path, sharing a harness process via ``HarnessPool``.

    ``create_strategy`` is the SDK's documented seam for choosing how a backend
    is reached, and ``ConnectionStrategy`` is where process management belongs,
    so pooling is selected here and nowhere else. ``Agent`` is untouched.
    """

    harness_pool: HarnessPool

    def create_strategy(self, *, tool_runner: Any, hook_runner: Any):
        return to_pooled(
            super().create_strategy(
                tool_runner=tool_runner, hook_runner=hook_runner
            ),
            pool=self.harness_pool,
        )


class _PooledResumableOpenAIConfig(_ResumableOpenAIConfig):
    """OpenAI-compatible path, sharing a harness process.

    Composes with ``_ResumableOpenAIConfig`` rather than duplicating it: the
    superclass restores ``session_continuation_mode`` first, then the strategy
    is wrapped so it takes its process from the pool.
    """

    harness_pool: HarnessPool

    def create_strategy(self, *, tool_runner: Any, hook_runner: Any):
        return to_pooled(
            super().create_strategy(
                tool_runner=tool_runner, hook_runner=hook_runner
            ),
            pool=self.harness_pool,
        )


class AntigravityAgent:
    """Wraps a Google Antigravity agent for the AG-UI protocol."""

    def __init__(
        self,
        *,
        model: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        endpoint: Optional[ag_types.ModelEndpoint] = None,
        system_instructions: Optional[str] = None,
        capabilities: Optional[CapabilitiesConfig] = None,
        tools: Optional[Sequence[Callable[..., Any]]] = None,
        mcp_servers: Optional[List[Any]] = None,
        subagents: Optional[List[Any]] = None,
        workspaces: Optional[List[str]] = None,
        save_dir: Optional[str] = None,
        response_schema: Optional[Any] = None,
        # AG-UI behaviour
        enable_frontend_tools: bool = True,
        enable_ask_question: bool = True,
        tool_approval: bool = False,
        auto_approve_tools: Optional[Sequence[str]] = None,
        structured_output_as: str = "state",
        emit_builtin_tool_calls: bool = True,
        deduplicate_tool_calls: bool = True,
        experimental_app_context: bool = False,
        experimental_app_state: bool = False,
        max_tool_calls_per_turn: Optional[int] = None,
        # Session policy
        session_timeout_seconds: int = 1800,
        parked_timeout_seconds: int = 7200,
        max_sessions: int = 50,
        session_manager: Optional[SessionManager] = None,
        # Harness process pooling
        max_conversations_per_process: int = 8,
        harness_idle_grace_seconds: float = 30.0,
        harness_pool: Optional[HarnessPool] = None,
    ):
        """Creates the adapter.

        Args:
          model: Model id. Defaults to the SDK's Gemini default unless
            ``base_url`` selects the OpenAI-compatible path.
          base_url: Root of an OpenAI-compatible server. Note the harness
            appends ``/v1/chat/completions`` itself, so pass the ROOT
            (``http://host:port``), not ``.../v1``.
          api_key: Gemini API key for the native path. Ignored when
            ``base_url`` is set -- the harness' OpenAI path carries no key
            field, so authenticate at the endpoint instead.
          endpoint: Where the native path sends its model calls, as the SDK's
            ``GeminiAPIEndpoint`` or ``VertexEndpoint``. Use it to reach a
            Gemini-compatible server other than Google's, such as a mock or a
            gateway: ``GeminiAPIEndpoint(base_url=..., http_headers=...)``.
            Both the text model and the image model are pinned to it, so no
            model call escapes to the default endpoint. Cannot be combined with
            ``base_url``.
          tool_approval: Route every non-frontend tool call through an AG-UI
            approval interrupt. Also satisfies the SDK's mandatory safety guard.
          structured_output_as: ``"state"`` (STATE_SNAPSHOT) or ``"custom"``.
          max_conversations_per_process: How many conversations share one Go
            harness process. Antigravity configures tools, model, capabilities
            and ``workspaces`` per *conversation* (over the WebSocket) and only
            ``save_dir``/``env`` per *process*, so sharing is safe and costs
            ~1 MB per extra idle conversation instead of ~95 MB. The default is
            chosen for blast radius -- one dead process takes every conversation
            on it -- not for memory. Set to 1 for one process per thread.
          experimental_app_context: Experimental, off by default. Give the
            model a silent ``get_app_context`` tool that returns the run's
            ``RunAgentInput.context``. Antigravity fixes the instructions per
            session, so without it per-run context from ``useAgentContext``
            does not reach the model. The model has to call the tool, so say
            when in the system instructions.
          experimental_app_state: Experimental, off by default. Give the model
            a silent ``get_shared_state`` tool that returns the session's
            shared state, including edits the user made in the UI. A tool of
            your own with the same name, or a client tool, takes precedence
            over either built-in.
          deduplicate_tool_calls: Dispatch a frontend tool to the client at most
            once per Antigravity turn. An identical repeat is answered from the
            cached result; a repeat with different arguments gets a plain
            statement of what already ran. On by default because the harness
            backgrounds slow custom tools and the model then re-issues them,
            which would run a side-effecting action twice. Turn off if a tool is
            genuinely meant to run more than once within one turn.
          max_tool_calls_per_turn: Upper bound on the tool calls one
            Antigravity turn may make -- custom, frontend and built-in tools
            alike. The call past the limit is denied and the turn is halted;
            a run reading the turn ends with RUN_ERROR, code
            ``MAX_TOOL_CALLS_EXCEEDED``, and the next run on the thread starts
            from a rebuilt session that keeps the history. Enforced in a
            pre-tool-call hook, so it holds while no client is connected: a
            turn keeps running after a disconnect, for a later resume, and
            this is what bounds one that never stops calling tools. Off
            (``None``) by default.
        """
        if endpoint is not None and base_url is not None:
            raise ValueError(
                "Pass either base_url (OpenAI-compatible path) or endpoint "
                "(native Gemini path), not both."
            )
        self._model = model
        self._base_url = base_url
        self._api_key = api_key
        self._endpoint = endpoint
        self._system_instructions = system_instructions
        self._capabilities = capabilities
        self._static_tools = list(tools or [])
        self._experimental_app_context = experimental_app_context
        self._experimental_app_state = experimental_app_state
        self._mcp_servers = list(mcp_servers or [])
        self._subagents = list(subagents or [])
        self._workspaces = list(workspaces) if workspaces else [os.getcwd()]
        self._save_dir = save_dir
        self._response_schema = response_schema

        self._enable_frontend_tools = enable_frontend_tools
        self._enable_ask_question = enable_ask_question
        self._tool_approval = tool_approval
        self._auto_approve = set(auto_approve_tools or [])
        if structured_output_as not in ("state", "custom"):
            raise ValueError(
                "structured_output_as must be 'state' or 'custom', got "
                f"{structured_output_as!r}"
            )
        self._structured_output_as = structured_output_as
        if max_tool_calls_per_turn is not None and (
            isinstance(max_tool_calls_per_turn, bool)
            or not isinstance(max_tool_calls_per_turn, int)
            or max_tool_calls_per_turn < 1
        ):
            raise ValueError(
                "max_tool_calls_per_turn must be a positive integer or None, "
                f"got {max_tool_calls_per_turn!r}"
            )
        self._max_tool_calls_per_turn = max_tool_calls_per_turn
        self._emit_builtin_tool_calls = emit_builtin_tool_calls
        self._deduplicate_tool_calls = deduplicate_tool_calls

        self._sessions = session_manager or SessionManager(
            session_timeout_seconds=session_timeout_seconds,
            parked_timeout_seconds=parked_timeout_seconds,
            max_sessions=max_sessions,
        )
        # Owned unless injected, and torn down by close() in that case only.
        self._owns_pool = harness_pool is None
        self._pool = harness_pool or HarnessPool(
            max_conversations_per_process=max_conversations_per_process,
            idle_grace_seconds=harness_idle_grace_seconds,
        )

    @property
    def session_manager(self) -> SessionManager:
        return self._sessions

    @property
    def harness_pool(self) -> HarnessPool:
        return self._pool

    def _resolved_save_dir(self) -> str:
        """One save directory for every session this adapter creates.

        Left to itself the SDK calls ``tempfile.mkdtemp()`` per *config*, so
        each session would get a fresh directory. That breaks two things:

        * cold resume, which reconstructs a conversation from
          ``conversation_id`` + ``save_dir`` -- against a brand-new empty
          directory the harness has nothing to restore;
        * pooling, since ``save_dir`` is fixed at process start and is part of
          the pool's partition key, so a per-session directory means a process
          per session.

        Created lazily so an adapter that never runs leaves no directory behind.
        """
        if self._save_dir is None:
            self._save_dir = tempfile.mkdtemp(prefix="ag_ui_antigravity_")
            logger.info(
                "No save_dir given; this adapter's sessions will share %s",
                self._save_dir,
            )
        return self._save_dir

    def builtin_enabled(self, tool: "ag_types.BuiltinTools") -> bool:
        """True when ``tool`` survives this agent's ``CapabilitiesConfig``.

        The config is an allow/deny list over the harness' built-ins, so a
        capability advertised without consulting it can be a lie.
        """
        capabilities = self._capabilities
        if capabilities is None:
            return True  # SDK default: every built-in enabled.
        if capabilities.enabled_tools is not None:
            return tool in capabilities.enabled_tools
        if capabilities.disabled_tools is not None:
            return tool not in capabilities.disabled_tools
        return True

    @property
    def ask_question_reachable(self) -> bool:
        """True when the model can actually raise an ``ask_question`` interrupt.

        The hook is only half the story: the harness gates the built-in behind
        ``CapabilitiesConfig``, so an ``enabled_tools`` allowlist that omits
        ``ask_question`` (or a ``disabled_tools`` list naming it) makes the
        registered hook unreachable.
        """
        return self._enable_ask_question and self.builtin_enabled(
            ag_types.BuiltinTools.ASK_QUESTION
        )

    async def close(self) -> None:
        # Sessions first: each one disconnects its conversation and returns its
        # slot, so the pool has nothing live left to tear down.
        try:
            await self._sessions.stop()
        finally:
            if self._owns_pool:
                await self._pool.shutdown()

    # ------------------------------------------------------------------
    # Config construction
    # ------------------------------------------------------------------

    def _build_agent(
        self,
        bridge: UIBridge,
        input_data: RunAgentInput,
        previous_conversation_id: Optional[str],
    ) -> Agent:
        # Wrapped so each call emits TOOL_CALL_START/ARGS/END and, crucially,
        # a TOOL_CALL_RESULT: the harness reports a custom tool as a single
        # ACTIVE step and never reports its return value, so the step stream
        # alone would leave the client's tool card spinning forever.
        tools: List[Any] = bridge.build_server_tools(self._static_tools)
        if self._enable_frontend_tools and input_data.tools:
            tools.extend(bridge.build_frontend_tools(list(input_data.tools)))
        tools.extend(
            bridge.build_server_tools(self._read_tools(input_data), silent=True)
        )

        hooks: List[Any] = []
        if self._max_tool_calls_per_turn is not None:
            # First: the first denial wins, so an over-budget call is refused
            # without the approval hook prompting the user for it.
            hooks.append(
                bridge.build_tool_budget_hook(self._max_tool_calls_per_turn)
            )
            hooks.append(bridge.build_turn_start_hook())
        if self._enable_ask_question:
            hooks.append(bridge.build_interaction_hook())
        if self._tool_approval:
            hooks.append(
                bridge.build_tool_approval_hook(auto_approve=self._auto_approve)
            )

        capabilities = self._capabilities or CapabilitiesConfig(
            enable_subagents=bool(self._subagents)
        )

        common: Dict[str, Any] = {
            "system_instructions": self._system_instructions,
            "capabilities": capabilities,
            "tools": tools,
            "hooks": hooks,
            "mcp_servers": self._mcp_servers,
            "subagents": self._subagents,
            "workspaces": self._workspaces,
            "save_dir": self._resolved_save_dir(),
            "response_schema": self._response_schema,
        }
        if previous_conversation_id:
            common["conversation_id"] = previous_conversation_id
            common["session_continuation_mode"] = (
                ag_types.SessionContinuationMode.CREATE_OR_RESUME
            )
        # The SDK refuses to start when write tools or MCP servers are enabled
        # without either a policy or a decide hook. The approval hook counts;
        # otherwise fall back to the SDK's default confirm policy behaviour by
        # allowing everything explicitly (the server operator opted in by
        # enabling those capabilities).
        if not self._tool_approval:
            from google.antigravity.hooks import policy

            common["policies"] = [policy.allow_all()]

        common = {k: v for k, v in common.items() if v is not None}

        if self._base_url:
            return Agent(
                _PooledResumableOpenAIConfig(
                    model=self._model,
                    base_url=self._base_url,
                    harness_pool=self._pool,
                    **common,
                )
            )
        config_kwargs = dict(common)
        if self._endpoint is not None:
            # Explicit targets for both model types: the SDK fills any missing
            # type with a default target on Google's endpoint, which would
            # send image calls elsewhere and demand a GEMINI_API_KEY.
            endpoint = self._endpoint
            if self._api_key and isinstance(endpoint, ag_types.GeminiAPIEndpoint):
                if endpoint.api_key is None:
                    endpoint = endpoint.model_copy(update={"api_key": self._api_key})
            config_kwargs["models"] = [
                ag_types.ModelTarget(
                    name=self._model or DEFAULT_MODEL,
                    types=[ag_types.ModelType.TEXT],
                    endpoint=endpoint,
                ),
                ag_types.ModelTarget(
                    name=DEFAULT_IMAGE_GENERATION_MODEL,
                    types=[ag_types.ModelType.IMAGE],
                    endpoint=endpoint,
                ),
            ]
        else:
            if self._model:
                config_kwargs["model"] = self._model
            if self._api_key:
                config_kwargs["api_key"] = self._api_key
        return Agent(
            _PooledLocalAgentConfig(harness_pool=self._pool, **config_kwargs)
        )

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------

    async def run(
        self, input_data: RunAgentInput
    ) -> AsyncGenerator[BaseEvent, None]:
        """Executes one AG-UI run and yields protocol events."""
        thread_id = input_data.thread_id
        run_id = input_data.run_id
        _warn_on_newer_protocol(getattr(input_data, "protocol_version", None))

        yield RunStartedEvent(
            type="RUN_STARTED",
            thread_id=thread_id,
            run_id=run_id,
            protocol_version=PROTOCOL_VERSION,
        )

        terminal_sent = False
        # Bound before the try: the harness-lost check in the handler
        # below runs even when get_or_create itself is what failed.
        session: Optional[Any] = None
        try:
            self._sessions.start()
            signature = tool_signature(list(input_data.tools or []))
            # A run queued on the lock behind one that halted or lost the
            # session would otherwise reuse the dead conversation; fetching the
            # session again after acquiring the lock gets the rebuilt one.
            for _ in range(3):
                session = await self._sessions.get_or_create(
                    thread_id,
                    signature=signature,
                    factory=lambda bridge, prev: self._build_agent(
                        bridge, input_data, prev
                    ),
                    bridge_factory=lambda: UIBridge(
                        deduplicate_tool_calls=self._deduplicate_tool_calls
                    ),
                )
                await session.lock.acquire()
                if not (session.halted or session.harness_lost):
                    break
                session.lock.release()
            else:
                raise RuntimeError(
                    f"No usable Antigravity session for thread {thread_id}."
                )

            try:
                session.touch()
                session.bridge.on_tool_budget_exhausted(
                    lambda: _halt_for_tool_budget(session, thread_id)
                )
                async for event in self._run_locked(session, input_data):
                    if event.type in ("RUN_FINISHED", "RUN_ERROR"):
                        terminal_sent = True
                    yield event
                session.touch()
            finally:
                session.lock.release()

        except SessionLimitExceeded as exc:
            if not terminal_sent:
                terminal_sent = True
                yield RunErrorEvent(
                    type="RUN_ERROR", message=str(exc), code="SESSION_LIMIT"
                )
        except ag_types.AntigravityCancelledError as exc:
            if not terminal_sent:
                terminal_sent = True
                if session is not None and session.bridge.tool_budget_exhausted:
                    # Surfaced here when the halt lands while send() drains the
                    # previous turn, before _run_locked's own handler.
                    yield _tool_budget_error(self._max_tool_calls_per_turn)
                else:
                    yield RunErrorEvent(
                        type="RUN_ERROR",
                        # Keep the specific reason, matching the in-loop
                        # handler: "the session was closed" and "the client
                        # disconnected" are different operationally.
                        message=str(exc) or "The run was cancelled.",
                        code="CANCELLED",
                    )
        except Exception as exc:  # broad: any failure must reach the client
            if (
                session is not None
                and session.bridge.tool_budget_exhausted
                and not terminal_sent
            ):
                terminal_sent = True
                yield _tool_budget_error(self._max_tool_calls_per_turn)
                return
            logger.exception("Antigravity run failed")
            # A transport failure can surface here rather than inside
            # _run_locked -- `conversation.send()` runs before that try block --
            # so the session has to be marked here too, or the next run reuses
            # a conversation whose process is gone and hangs on it.
            if session is not None and _is_harness_lost(exc):
                session.harness_lost = True
                logger.warning(
                    "Harness lost for thread %s (%s); the session will be "
                    "rebuilt on the next run.",
                    thread_id,
                    type(exc).__name__,
                )
            if not terminal_sent:
                terminal_sent = True
                yield RunErrorEvent(
                    type="RUN_ERROR",
                    message=f"{type(exc).__name__}: {exc}",
                    code="AGENT_ERROR",
                )

        if not terminal_sent:
            yield RunFinishedEvent(
                type="RUN_FINISHED", thread_id=thread_id, run_id=run_id
            )

    def _read_tools(self, input_data: RunAgentInput) -> List[Callable[..., Any]]:
        """The built-in read tools this agent exposes, minus any name clashes."""
        taken = {getattr(t, "__name__", None) for t in self._static_tools}
        if self._enable_frontend_tools:
            taken.update(t.name for t in input_data.tools or [])
        wanted = []
        if self._experimental_app_context:
            wanted.append(get_app_context)
        if self._experimental_app_state:
            wanted.append(get_shared_state)
        return [t for t in wanted if t.__name__ not in taken]

    async def _run_locked(
        self, session, input_data: RunAgentInput
    ) -> AsyncGenerator[BaseEvent, None]:
        bridge: UIBridge = session.bridge
        bridge.adopt_client_state(input_data.state)
        bridge.adopt_client_context(input_data.context)

        # ---- resolve anything the client answered since the last run ----
        resumed = self._apply_client_answers(bridge, input_data)
        bridge.forget_resolved()

        # A resumption can also carry a new user message -- the client flushes
        # the tool result and whatever the user typed in one POST -- so this is
        # not gated on `resumed`.
        prompt, prompt_id = self._extract_prompt(input_data, session)
        if prompt is not None and not resumed:
            # A genuinely new user turn. Anything still parked belongs to the
            # previous turn and the user has moved on without answering it:
            # release it, or the harness stays blocked on our coroutine, this
            # run reads nothing (see _steps_with_bridge), and the session is
            # pinned in memory forever because `is_parked` never clears.
            if bridge.has_pending:
                logger.info(
                    "New user message on thread %s while %d request(s) were "
                    "parked; abandoning them.",
                    input_data.thread_id,
                    len(bridge.pending_ids()),
                )
                bridge.abandon_pending()
            # A harness failure can land while a run is parked; reset_stream
            # recovers it. Continuing would send this prompt onto a dead
            # conversation and report the result as a success.
            stale_failure = await session.reset_stream()
            session.raise_if_closed()
            if stale_failure is not None:
                yield _stale_failure_error(stale_failure)
                return
            session.raise_if_closed()
            await session.conversation.send(prompt)
            # Recorded only now: marking it before the send means a failed send
            # (or the stale-failure early return above) makes the client's
            # retry look already-delivered, and the message is swallowed.
            session.forwarded_prompts.add(prompt_id)
        elif prompt is not None:
            # Resumption that also carries new user text: the parked coroutine
            # was already resolved above, so the turn's stream is kept and the
            # message is added to it. Kept, not reset -- but a harness failure
            # that landed while parked still has to be checked for first. Sent
            # blind, the text went onto a dead conversation and was recorded as
            # forwarded, so the run errored *and* the client's retry found
            # nothing left to send.
            stale_failure = session.stale_failure()
            if stale_failure is not None:
                # The harness is gone, so anything still parked on it can never
                # be answered; release it or `is_parked` pins the session.
                bridge.abandon_pending()
                await session.reset_stream()
                yield _stale_failure_error(stale_failure)
                return
            session.raise_if_closed()
            await session.conversation.send(prompt)
            session.forwarded_prompts.add(prompt_id)
        elif not resumed:
            # Nothing to say and nothing to resume.
            for event in bridge.drain():
                yield event
            return

        # The translator carries per-turn state (message ids, which steps are
        # already finished), so it is created with the turn and retired with it.
        if session.translator is None:
            session.translator = EventTranslator(
                structured_output_as=self._structured_output_as,
                emit_builtin_tool_calls=self._emit_builtin_tool_calls,
            )
            for name in bridge.frontend_tool_names | bridge.server_tool_names:
                session.translator.suppress_tool(name)
        translator = session.translator

        # ---- consume the Antigravity stream ----
        error: Optional[BaseException] = None
        cancelled = False
        try:
            async for step in self._steps_with_bridge(session, bridge):
                # The lock guard in SessionManager._expired is what protects an
                # in-flight run; this keeps `last_activity` honest for the
                # moment the lock is released, so a turn that streamed for
                # longer than the idle timeout is not swept immediately after.
                session.touch()
                failure = step_failure(step)
                if failure is not None:
                    raise ag_types.AntigravityExecutionError(failure)
                async for event in translator.translate(step):
                    yield event
                for event in bridge.drain():
                    yield event
        except ag_types.AntigravityCancelledError as exc:
            # Same terminal event as the outer handler at run(): a cancellation
            # is not a successful run, and reporting it as one here while the
            # outer path reports RUN_ERROR made the outcome depend on where it
            # happened to surface.
            error = exc
            cancelled = True
            # Not necessarily the client: a forced SessionManager.close()/stop()
            # reaches here through the same exception.
            logger.info("Antigravity run cancelled: %s", exc)
        except Exception as exc:
            error = exc

        # Whatever ends a turn that ran out of budget is reported as that: the
        # denied call usually arrives first, as a failed step, before the halt.
        over_budget = (
            error is not None or cancelled
        ) and bridge.tool_budget_exhausted
        if error is not None or cancelled:
            # The turn died or was cancelled. Release anything parked before
            # retiring the stream: a request left pending keeps `is_parked`
            # true, and the idle sweeper never reclaims the session or its
            # subprocess. Cancellation needs this just as much as failure --
            # it used to skip it and pin the harness for the process lifetime.
            bridge.abandon_pending()
            if error is not None and _is_harness_lost(error):
                # Do not reuse this session: mark it so the next run on this
                # thread rebuilds via cold resume instead of talking to a
                # process that no longer exists.
                session.harness_lost = True
                logger.warning(
                    "Harness lost for thread %s (%s); the session will be "
                    "rebuilt on the next run.",
                    input_data.thread_id,
                    type(error).__name__,
                )
            await session.reset_stream()

        async for event in translator.close():
            yield event
        for event in bridge.drain():
            yield event

        if over_budget:
            yield _tool_budget_error(self._max_tool_calls_per_turn)
            return
        if error is not None:
            yield RunErrorEvent(
                type="RUN_ERROR",
                message=(
                    # Keep the specific reason -- "the session was closed" and
                    # "the client disconnected" are different operationally.
                    (str(error) or "The run was cancelled.")
                    if cancelled
                    else f"{type(error).__name__}: {error}"
                ),
                code="CANCELLED" if cancelled else "AGENT_ERROR",
            )
            return

        # ---- terminal event: interrupt or success ----
        interrupts = bridge.pending_interrupts()
        if interrupts:
            yield RunFinishedEvent(
                type="RUN_FINISHED",
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
                outcome=RunFinishedInterruptOutcome(
                    type="interrupt", interrupts=interrupts
                ),
            )
            return

        yield RunFinishedEvent(
            type="RUN_FINISHED",
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

    async def _steps_with_bridge(self, session, bridge: UIBridge):
        """Yields Antigravity steps, ending the run while a request is parked.

        When a frontend tool or hook parks, the harness goes quiet -- it is
        waiting on our coroutine, which is waiting on the client. Blocking on
        ``receive_steps()`` would hang the SSE response forever, so the run
        returns and the parked coroutine stays alive for the next one.

        One Antigravity turn can therefore span several AG-UI runs. The
        iterator and any in-flight ``__anext__()`` are stashed on the session
        and picked back up on the next run: starting a fresh ``receive_steps()``
        instead makes the harness re-deliver the steps of the turn already in
        progress, so the same tool call is replayed to the client on every run
        and the conversation never converges.
        """
        if session.step_iter is None:
            session.step_iter = session.conversation.receive_steps().__aiter__()

        while True:
            # Checked every iteration, not just on entry: `yield step` below
            # suspends in the SSE writer awaiting the socket, and a forced close
            # landing there sets `step_iter = None`. Resuming would then raise
            # AttributeError and report a deliberate shutdown as an agent bug.
            session.raise_if_closed()
            # Resume the future the previous run left mid-flight, if any.
            next_step = session.pending_step
            if next_step is None:
                next_step = asyncio.ensure_future(session.step_iter.__anext__())
            session.pending_step = next_step

            parked = asyncio.ensure_future(_wait_until_parked(bridge))
            try:
                await asyncio.wait(
                    {next_step, parked}, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                parked.cancel()

            if next_step.done():
                session.pending_step = None
                if next_step.cancelled():
                    # Somebody else cancelled the future we stashed on the
                    # session -- a forced SessionManager.close()/stop(), or
                    # AntigravityAgent.close(), landing while this run holds the
                    # lock. Calling .result() would raise a bare CancelledError,
                    # and that is a BaseException: it escapes both this method's
                    # caller and endpoint._stream, so the client would get no
                    # terminal event at all. Convert it to the SDK's cancelled
                    # error, which the run loop already maps to
                    # RUN_ERROR/code="CANCELLED".
                    #
                    # A cancellation of this run's OWN task is unaffected: that
                    # raises out of the `asyncio.wait` above, never reaching here.
                    raise ag_types.AntigravityCancelledError(
                        "The Antigravity session was closed while the run was "
                        "in progress."
                    )
                try:
                    step = next_step.result()
                except StopAsyncIteration:
                    # The turn is over; the next one needs a fresh iterator.
                    await session.reset_stream()
                    return
                yield step
                continue

            # Parked. Leave `next_step` pending on the session -- cancelling it
            # would discard the step the harness is mid-way through delivering.
            logger.debug(
                "Run parked with %d pending request(s)", len(bridge.pending_ids())
            )
            return

    # ------------------------------------------------------------------
    # Client input
    # ------------------------------------------------------------------

    def _apply_client_answers(
        self, bridge: UIBridge, input_data: RunAgentInput
    ) -> bool:
        """Resolves parked futures from this run's input. Returns True if any."""
        resolved = False

        for entry in input_data.resume or []:
            if bridge.resolve_interrupt(
                entry.interrupt_id, entry.payload, entry.status == "cancelled"
            ):
                resolved = True
            else:
                # A resume for an id we never issued (or already released) means
                # client and server disagree about the run's state. Staying
                # silent lets the caller believe the answer landed.
                logger.warning(
                    "Ignoring resume for unknown interrupt %s on thread %s",
                    entry.interrupt_id,
                    input_data.thread_id,
                )

        if self._apply_forwarded_command(bridge, input_data):
            resolved = True

        # Frontend tool results arrive as ToolMessages carrying the tool_call_id
        # we minted when the tool parked.
        for message in reversed(list(input_data.messages or [])):
            if getattr(message, "role", None) != "tool":
                continue
            tool_call_id = getattr(message, "tool_call_id", None)
            if not tool_call_id:
                continue
            content = _tool_result_value(getattr(message, "content", ""))
            if bridge.resolve_tool_call(tool_call_id, content):
                resolved = True
            else:
                # Clients legitimately resend whole transcripts, so old
                # ToolMessages are expected; log at debug for diagnosis only.
                logger.debug(
                    "No parked request for tool_call_id %s", tool_call_id
                )

        return resolved

    def _apply_forwarded_command(
        self, bridge: UIBridge, input_data: RunAgentInput
    ) -> bool:
        """Resolves an interrupt answered through ``forwardedProps.command``.

        AG-UI's own channel for this is ``RunAgentInput.resume``, and clients
        like the dojo use it. CopilotKit Channels does not: its run loop
        re-enters an interrupted run with

            agent.runAgent({ forwardedProps: { command: resume } })

        so the answer arrives as a bare value under ``forwarded_props.command``
        with no interrupt id attached -- the channel run loop tracks a single
        outstanding interrupt per thread and does not need one. Reading only
        ``resume`` leaves that answer on the floor and the tool parked forever,
        which surfaces as a bot that has silently gone quiet.

        Correlation, in order:

        * an explicit id in the payload, for a client that sends one;
        * otherwise the single parked *interrupt*, which is the channels case.
          A parked frontend tool does not count: its answer is a ToolMessage,
          and a command standing in for it would hand the model the user's
          reply as the tool's return value;
        * otherwise nothing -- guessing between several would resolve the wrong
          one, and a warning is recoverable where a wrong answer is not.
        """
        forwarded = getattr(input_data, "forwarded_props", None) or {}
        if not isinstance(forwarded, dict) or "command" not in forwarded:
            return False
        command = forwarded["command"]

        interrupt_id: Optional[str] = None
        payload: Any = command
        cancelled = False
        if isinstance(command, dict):
            for key in ("interruptId", "interrupt_id"):
                candidate = command.get(key)
                if isinstance(candidate, str) and candidate:
                    interrupt_id = candidate
                    # A wrapper carrying the id usually carries the answer
                    # beside it; fall back to the whole object when it does not.
                    payload = command.get("payload", command)
                    break
            cancelled = command.get("status") == "cancelled"

        if interrupt_id is None:
            pending = bridge.pending_interrupt_ids()
            if len(pending) == 1:
                interrupt_id = next(iter(pending))
            elif not pending:
                logger.warning(
                    "forwardedProps.command arrived on thread %s with no "
                    "interrupt parked; ignoring it.",
                    input_data.thread_id,
                )
                return False
            else:
                logger.warning(
                    "forwardedProps.command arrived on thread %s with %d parked "
                    "interrupts and no interrupt id, so it cannot be matched to "
                    "one; ignoring it.",
                    input_data.thread_id,
                    len(pending),
                )
                return False

        if bridge.resolve_interrupt(interrupt_id, payload, cancelled):
            return True
        logger.warning(
            "Ignoring forwardedProps.command for unknown interrupt %s on "
            "thread %s",
            interrupt_id,
            input_data.thread_id,
        )
        return False

    def _extract_prompt(self, input_data: RunAgentInput, session) -> tuple:
        """Returns ``(prompt, message_id)`` for the newest unforwarded user turn.

        The prompt is a string, or a list of strings and SDK media when the
        message carries attachments (see ``_message_prompt``).

        Antigravity owns the conversation history in-process while the AG-UI
        client resends the whole transcript every run, so each user message
        must reach the harness exactly once. Identity is the only reliable
        test: inferring it from position -- "after the last ToolMessage" --
        misreads a tool result left over from an earlier turn and replays that
        turn's prompt, and misses new text on a run resumed purely by a
        `resume` entry.
        """
        for message in reversed(list(input_data.messages or [])):
            if getattr(message, "role", None) != "user":
                continue
            message_id = getattr(message, "id", None)
            if message_id in session.forwarded_prompts:
                # Everything before this was forwarded on an earlier run.
                return (None, None)
            prompt = _message_prompt(getattr(message, "content", None))
            if prompt:
                return (prompt, message_id)
        return (None, None)


def _tool_budget_error(limit: Optional[int]) -> RunErrorEvent:
    return RunErrorEvent(
        type="RUN_ERROR",
        message=(
            f"The turn was stopped after {limit} tool calls "
            "(max_tool_calls_per_turn)."
        ),
        code="MAX_TOOL_CALLS_EXCEEDED",
    )


async def _halt_for_tool_budget(session, thread_id: str) -> None:
    """Halts a turn that ran out of tool calls; called from the budget hook.

    The halt makes the harness close the conversation's connection, so the
    session is marked for a rebuild (via cold resume, which keeps the history)
    before anything else can try to use it.
    """
    session.halted = True
    logger.warning(
        "Thread %s ran out of tool calls (max_tool_calls_per_turn); halting "
        "the turn.",
        thread_id,
    )
    await _cancel_turn(session, thread_id)


async def _cancel_turn(session, thread_id: str) -> None:
    """Asks the harness to stop the current turn; never raises."""
    try:
        await session.conversation.cancel()
    except Exception:
        # The session is already marked halted either way. A failed cancel
        # means the harness may still be working, so log it loudly.
        logger.warning(
            "Could not cancel the Antigravity turn on thread %s", thread_id,
            exc_info=True,
        )


def _stale_failure_error(failure: BaseException) -> RunErrorEvent:
    """The terminal event for a harness failure that landed while parked."""
    return RunErrorEvent(
        type="RUN_ERROR",
        message=(
            f"The Antigravity session failed while awaiting your reply: "
            f"{type(failure).__name__}: {failure}"
        ),
        code="AGENT_ERROR",
    )


def _warn_on_newer_protocol(declared: Optional[str]) -> None:
    """Warns when a consumer declares a protocol this adapter does not speak.

    The run is served either way. A newer minor of the 1.x line is serveable by
    construction, and a declaration the adapter cannot read is handled like a
    newer one: proceed, and say so.
    """
    if not declared:
        return
    try:
        declared_parts = tuple(int(part) for part in declared.split("."))
        ours = tuple(int(part) for part in PROTOCOL_VERSION.split("."))
    except ValueError:
        logger.warning(
            "Consumer declared an unreadable AG-UI protocol version %r; "
            "serving the run as %s.",
            declared,
            PROTOCOL_VERSION,
        )
        return
    if declared_parts > ours:
        logger.warning(
            "Consumer declared AG-UI protocol %s, newer than this adapter's %s; "
            "serving the run as %s.",
            declared,
            PROTOCOL_VERSION,
            PROTOCOL_VERSION,
        )


def _tool_result_value(content: Any) -> Any:
    """The value a frontend tool returns to the model, from a ToolMessage.

    AG-UI 1.0 lets ``ToolMessage.content`` be a list of content parts as well
    as a string. The harness hands the value to the model as the tool's
    result, so a list of part objects would reach it as their repr. Text parts
    are joined; a string passes through unchanged, whitespace included.
    """
    if isinstance(content, list):
        return "\n".join(
            part.text
            for part in content
            if isinstance(getattr(part, "text", None), str)
        )
    return content


_MEDIA_PART_TYPES = {"image", "document", "audio", "video"}


def _message_prompt(content: Any) -> Any:
    """Maps AG-UI message content onto what ``conversation.send()`` accepts.

    ``UserMessage.content`` is a string or a list of typed parts. Text-only
    content stays a plain string. Image, document, audio and video parts whose
    bytes travel inline (a ``data`` source, or a ``data:`` URL) become the
    SDK's media objects, in order, alongside the text. The harness cannot fetch
    anything itself, so a remote URL, a provider file reference, or a MIME type
    the SDK rejects is replaced by a short note: dropping it silently would
    leave the model answering as if nothing had been attached.
    """
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: List[Any] = []
    has_media = False
    for part in content:
        kind = getattr(part, "type", None)
        text = getattr(part, "text", None)
        if isinstance(text, str):
            if text.strip():
                parts.append(text.strip())
            continue
        if kind not in _MEDIA_PART_TYPES:
            continue
        media, note = _media_from_part(part, kind)
        if media is not None:
            parts.append(media)
            has_media = True
        else:
            parts.append(note)
    if not has_media:
        return "\n".join(parts)
    return parts


def _media_from_part(part: Any, kind: str) -> tuple:
    """Returns ``(media, None)`` for a forwardable part, else ``(None, note)``."""
    source = getattr(part, "source", None)
    metadata = getattr(part, "metadata", None) or {}
    filename = metadata.get("filename") if isinstance(metadata, dict) else None
    label = f"Attached {kind}" + (f" {filename!r}" if filename else "")
    source_type = getattr(source, "type", None)
    value = getattr(source, "value", None) or ""
    mime_type = getattr(source, "mime_type", None)
    try:
        if source_type == "data":
            data = base64.b64decode(value, validate=False)
        elif source_type == "url" and value.startswith("data:"):
            header, _, encoded = value.partition(",")
            mime_type = mime_type or header[len("data:"):].split(";")[0]
            if ";base64" not in header:
                raise ValueError("only base64 data: URLs are supported")
            data = base64.b64decode(encoded, validate=False)
        else:
            return None, (
                f"[{label} was not forwarded: only inline attachments reach "
                "this agent.]"
            )
        if not mime_type:
            raise ValueError("the attachment has no MIME type")
        return ag_types.from_bytes(data, mime_type, description=filename), None
    except (ValueError, binascii.Error) as exc:
        logger.warning("Dropping the %s: %s", label.lower(), exc)
        return None, f"[{label} could not be read: {exc}]"


async def _wait_until_parked(bridge: UIBridge) -> None:
    """Completes once the bridge has an unresolved parked request."""
    while not bridge.has_pending:
        await asyncio.sleep(0.02)
