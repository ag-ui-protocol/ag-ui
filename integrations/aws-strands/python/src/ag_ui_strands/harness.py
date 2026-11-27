"""The Strands harness as an AG-UI agent.

``strands_harness.create_harness()`` returns a plain ``strands.Agent`` with the
harness assembled on it: the shell and file tools, delegation to subagents,
context management, memory, skills and approvals. ``StrandsAgent`` cannot serve
one. It treats the agent it is given as a template and builds each thread's
agent from the settings it can read back, and most of what the harness
assembles cannot be read back or belongs to the agent it was assembled on, so a
thread would get the harness's tools without the managers behind them.

``StrandsHarnessAgent`` builds a whole harness per thread instead, by calling
``create_harness`` once for each ``thread_id``. Everything after that is
``StrandsAgent``: the event translation, frontend tools, interrupts, session
reconciliation and the endpoint are the same code.

    from ag_ui_strands import StrandsHarnessAgent, create_strands_app

    agent = StrandsHarnessAgent(
        name="harness",
        harness={"model": "bedrock/global.anthropic.claude-opus-5-5"},
    )
    app = create_strands_app(agent, path="/")

Needs the ``strands-harness`` package (``pip install strands-harness``), which is
not a dependency of this one: it requires a newer ``strands-agents`` than this
package's own floor.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional, Union

from ag_ui.core import RunAgentInput
from strands import Agent as StrandsAgentCore
from strands.session import SessionManager

from .agent import StrandsAgent, _shut_down_agent, _ThreadAgentBuildError
from .client_proxy_tool import _is_proxy
from .config import StrandsAgentConfig, maybe_await
from .template_tools import THREAD_TEMPLATE_TOOLS_ATTR

logger = logging.getLogger(__name__)

HarnessOptions = Mapping[str, Any]
"""Keyword arguments for ``strands_harness.create_harness``."""

HarnessOptionsProvider = Callable[
    [RunAgentInput],
    Union[Optional[HarnessOptions], Awaitable[Optional[HarnessOptions]]],
]
"""Returns the ``create_harness`` options for the thread a request starts.

Called once per ``thread_id`` with the ``RunAgentInput`` that created the
thread. May be async.
"""

HarnessFactory = Callable[..., StrandsAgentCore]
"""``create_harness``, or anything with its shape: options in, an ``Agent`` out."""


def _import_create_harness() -> HarnessFactory:
    try:
        from strands_harness import create_harness
    except ImportError as exc:
        raise ImportError(
            "StrandsHarnessAgent needs the strands-harness package. Install it "
            "with: pip install strands-harness"
        ) from exc
    return create_harness


def _refuse_options_shared_between_threads(options: HarnessOptions) -> None:
    """Refuse fixed options that would give every thread the same conversation.

    A mapping is applied to every thread as it stands, so anything in it that
    names or holds one conversation's state would be shared by all of them. A
    callable is asked per thread and can answer with that thread's own.

    A ``MemoryManager`` is deliberately not refused: memory is the one store
    that is meant to outlast a conversation.
    """
    per_thread = "Pass a callable as `harness` and return this thread's own from it."
    if options.get("session_manager") is not None:
        raise ValueError(
            "`session_manager` in fixed harness options would make every "
            "thread write to one session. Use "
            "StrandsAgentConfig.session_manager_provider, which is asked per "
            "thread."
        )
    session = options.get("session")
    if isinstance(session, SessionManager) or (
        isinstance(session, Mapping) and session.get("id")
    ):
        raise ValueError(
            "`session` in fixed harness options names one session, which every "
            f"thread would then share. {per_thread}"
        )
    context_manager = options.get("context_manager")
    if context_manager is not None and not isinstance(
        context_manager, (str, bool, Mapping)
    ):
        raise ValueError(
            "A context manager instance in fixed harness options would be "
            "shared by every thread, along with what it has offloaded and "
            f"summarized. {per_thread}"
        )
    if options.get("conversation_manager") is not None:
        raise ValueError(
            "A conversation manager in fixed harness options would be shared "
            "by every thread, along with its trimming counters and summaries. "
            f"{per_thread}"
        )


def _asking_about_the_harnesss_own_tools(interventions: Any) -> list:
    """The harness's ``interventions``, each kept from deciding about a client's tool.

    Resolved with the harness's own ``resolve_interventions`` first, so a preset
    name (``"ask"``, ``"smart"``) or a policy is the handler it stands for.
    Imported here: the SDK's interventions are newer than this package's floor.
    """
    from strands.interventions import InterventionHandler, Proceed
    from strands_harness import resolve_interventions

    class _OwnToolsOnly(InterventionHandler):
        """Hands every call on to ``inner`` except a call to a client's tool.

        A wrapper, not a subclass: it has to work for whichever handler the
        option resolved to. The SDK calls only the lifecycle methods a class
        overrides, so all of them are here, and anything else the handler
        carries (what the adapter reads to recognise an approval gate) is
        looked up on ``inner``.
        """

        def __init__(self, inner: Any) -> None:
            self._inner = inner

        def __getattr__(self, attribute: str) -> Any:
            return getattr(self._inner, attribute)

        @property
        def name(self) -> str:
            return self._inner.name

        @property
        def on_error(self) -> Any:
            return self._inner.on_error

        def before_invocation(self, event: Any, **kwargs: Any) -> Any:
            return self._inner.before_invocation(event, **kwargs)

        def before_tool_call(self, event: Any, **kwargs: Any) -> Any:
            if _is_proxy(getattr(event, "selected_tool", None)):
                return Proceed()
            return self._inner.before_tool_call(event, **kwargs)

        def after_tool_call(self, event: Any, **kwargs: Any) -> Any:
            return self._inner.after_tool_call(event, **kwargs)

        def before_model_call(self, event: Any, **kwargs: Any) -> Any:
            return self._inner.before_model_call(event, **kwargs)

        def after_model_call(self, event: Any, **kwargs: Any) -> Any:
            return self._inner.after_model_call(event, **kwargs)

    return [_OwnToolsOnly(handler) for handler in resolve_interventions(interventions)]


class StrandsHarnessAgent(StrandsAgent):
    """A Strands harness, built per thread, served over AG-UI.

    Args:
        name: The agent's AG-UI name.
        harness: Options for ``create_harness``: a mapping applied to every
            thread, or a callable that returns the options for the thread a
            request starts (see ``HarnessOptionsProvider``). Omitted, every
            thread gets the harness's defaults.
        description: The agent's AG-UI description.
        config: The same ``StrandsAgentConfig`` ``StrandsAgent`` takes.
            ``thread_agent_kwargs`` is the one field that does not apply:
            there is no template to add to, and the per-thread options are what
            ``harness`` returns.
        hooks: Hook providers for every thread's agent, ahead of any in the
            harness options. The harness hands hooks to its subagents too.
        plugins: SDK plugins for every thread's agent, ahead of any in the
            harness options.
        agents_by_thread: As for ``StrandsAgent``.
        gate_client_tools: Whether the harness's ``interventions`` decide about
            the tools a client sends with a run, as they do about the harness's
            own. ``True`` is the harness's behaviour: ``interventions="ask"``
            asks before every call. ``False`` lets a client's tool go straight
            to the client, for a client that asks about its own tools itself.
        create_harness: What builds a thread's agent. Defaults to
            ``strands_harness.create_harness``.

    What the adapter decides for a thread, over the options:

    - **Sessions.** With ``config.session_manager_provider`` the thread's agent
      is built on the manager it returns. Without one, and with no ``session``
      in the options, the harness's file sessions are switched off: a thread's
      conversation lives on its cached agent and the client replays it after a
      restart, as with ``StrandsAgent``. To keep the harness's own sessions,
      return ``{"session": {"id": ...}}`` for the thread from a ``harness``
      callable.
    - **Hooks and plugins.** The ones given here, and the adapter's own, go in
      front of the ones in the options.

    Everything else is the harness's default unless the options say otherwise.
    That includes memory, which is on and is one store for every thread this
    process serves: point ``memory`` somewhere per user, or turn it off, where
    threads belong to different people.
    """

    _clones_template = False

    def __init__(
        self,
        name: str,
        harness: Union[HarnessOptions, HarnessOptionsProvider, None] = None,
        *,
        description: str = "",
        config: Optional[StrandsAgentConfig] = None,
        hooks: Optional[list] = None,
        plugins: Optional[list] = None,
        agents_by_thread: Optional[Dict[str, Any]] = None,
        create_harness: Optional[HarnessFactory] = None,
        gate_client_tools: bool = True,
    ) -> None:
        if harness is not None and not callable(harness):
            if not isinstance(harness, Mapping):
                raise TypeError(
                    "`harness` must be a mapping of create_harness options or a "
                    f"callable returning one; got {type(harness).__name__}."
                )
            _refuse_options_shared_between_threads(harness)
        if config is not None and config.thread_agent_kwargs is not None:
            raise ValueError(
                "thread_agent_kwargs adds to the agent StrandsAgent clones from "
                "its template, and a harness is not cloned. Return the thread's "
                "options from a `harness` callable instead; create_harness "
                "passes any Agent keyword through."
            )
        self._harness_options = harness
        self._gate_client_tools = gate_client_tools
        self._create_harness = create_harness or _import_create_harness()
        super().__init__(
            agent=None,  # type: ignore[arg-type]  # no template: see _clones_template
            name=name,
            description=description,
            config=config,
            hooks=hooks,
            plugins=plugins,
            agents_by_thread=agents_by_thread,
        )

    async def _build_thread_agent(
        self, input_data: RunAgentInput, session_manager: Any
    ) -> StrandsAgentCore:
        try:
            options: Any = self._harness_options
            if callable(options):
                options = await maybe_await(options(input_data))
            if options is not None and not isinstance(options, Mapping):
                raise TypeError(
                    "expected a mapping of create_harness options, got "
                    f"{type(options).__name__}"
                )
            options = dict(options or {})
        except Exception as e:  # noqa: BLE001 - surfaced as RUN_ERROR
            logger.error("harness options failed: %s", e, exc_info=True)
            raise _ThreadAgentBuildError(
                f"Failed to build per-thread agent kwargs: {e}",
                "THREAD_AGENT_KWARGS_ERROR",
            ) from e

        # Omitted when empty, for the reason StrandsAgent omits them: an empty
        # list is a value a later SDK could read as "none of the defaults".
        hooks = [*self._hooks, *(options.pop("hooks", None) or [])]
        if hooks:
            options["hooks"] = hooks
        plugins = [*self._plugins, *(options.pop("plugins", None) or [])]
        if plugins:
            options["plugins"] = plugins

        if session_manager is not None:
            # An explicit SDK value beats the harness's ``session`` sugar, and
            # this one is the thread's own.
            options["session_manager"] = session_manager
            options.pop("session", None)
        elif "session" not in options and "session_manager" not in options:
            # The harness's default is a file session under a random id, which
            # nothing could ever resume: one stray directory per thread.
            options["session"] = False

        try:
            if not self._gate_client_tools and options.get("interventions"):
                options["interventions"] = _asking_about_the_harnesss_own_tools(
                    options["interventions"]
                )
            agent = self._create_harness(**options)
            if not isinstance(agent, StrandsAgentCore):
                raise TypeError(
                    "create_harness returned "
                    f"{type(agent).__name__}, not a strands Agent"
                )
        except Exception as e:  # noqa: BLE001 - surfaced as RUN_ERROR
            logger.error("create_harness failed: %s", e, exc_info=True)
            raise _ThreadAgentBuildError(
                f"Failed to build per-thread agent: {e}",
                "THREAD_AGENT_BUILD_ERROR",
            ) from e

        # What ``template_tools_provider`` chooses among for this thread: the
        # tools this agent was built with, before the client's are added.
        setattr(
            agent,
            THREAD_TEMPLATE_TOOLS_ATTR,
            list(agent.tool_registry.registry.values()),
        )
        return agent

    async def shutdown(self) -> None:
        """Shut down every thread's agent, and forget them.

        A harness agent holds work that outlives a run: memory it has not yet
        written, MCP connections, background tasks. Call this where the
        process stops serving, for example in a FastAPI lifespan. A thread
        asked for afterwards is built again.
        """
        threads = list(self._agents_by_thread)
        for agent in [self._forget_thread(thread_id) for thread_id in threads]:
            await _shut_down_agent(agent)
