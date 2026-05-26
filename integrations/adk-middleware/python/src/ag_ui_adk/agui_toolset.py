"""AGUIToolset — a frontend-tool placeholder that delegates to ClientProxyToolset.

Why a placeholder + delegation?
-------------------------------
AG-UI integrations declare an ``AGUIToolset`` on their ADK agents at agent-
construction time, before any AG-UI run is in flight. At run-time
:class:`~ag_ui_adk.adk_agent.ADKAgent` knows the actual frontend tools the
client supplied (``input.tools``) and wires up a concrete
:class:`~ag_ui_adk.client_proxy_toolset.ClientProxyToolset` that proxies tool
calls back to the client over the AG-UI stream.

In ADK 1.x the middleware simply replaced the placeholder in
``agent.tools = [..., ClientProxyToolset(...)]`` once it knew the client tools.
That worked because ADK 1.x resolved toolsets lazily — every call to
``runner.run_async`` re-walked ``agent.tools`` and called ``get_tools()`` fresh.

ADK 2.0 (GA 2026-05-19) changed this: ``Runner.__init__`` eagerly walks
``agent.tools`` and caches whatever each toolset returns from ``get_tools()``.
The original "swap the toolset" approach now races the cache — the Runner may
already hold a reference to the placeholder when ``_update_agent_tools_recursive``
replaces it, leaving the LLM with an empty tool list (ag-ui#1389).

Fix: keep the placeholder instance, give it a ``bind()`` method that attaches
a concrete delegate, and have ``get_tools()`` forward to the delegate. Object
identity is preserved end-to-end so ADK 2.0's cache stays valid; the delegate
can be replaced or unbound between runs without invalidating any ADK state.

Compat: this preserves the 1.x behavior 1:1. If ``bind()`` is never called
(misconfiguration), ``get_tools()`` returns ``[]`` instead of raising, so the
LLM sees zero frontend tools rather than blowing up at agent construction
time inside ADK's own toolset-discovery flow. The original
``NotImplementedError`` path is retained for an explicit ``unbind() +
get_tools()`` sequence so misuse is still detectable in tests.
"""

from __future__ import annotations

from typing import List, Optional, TYPE_CHECKING, Union

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset, ToolPredicate
from google.adk.agents.readonly_context import ReadonlyContext

if TYPE_CHECKING:
    from .client_proxy_toolset import ClientProxyToolset


class AGUIToolset(BaseToolset):
    """Frontend-tool placeholder that delegates to a bound ``ClientProxyToolset``.

    Construction-time: declared on the ADK agent with ``tool_filter`` and
    ``tool_name_prefix`` (no client info yet).

    Run-time: :class:`~ag_ui_adk.adk_agent.ADKAgent._start_background_execution`
    builds a :class:`~ag_ui_adk.client_proxy_toolset.ClientProxyToolset` using
    ``input.tools`` and calls :meth:`bind` on this instance.

    The Runner can be created either before or after ``bind()`` — both orders
    work because ``get_tools()`` is delegated rather than memoized.
    """

    def __init__(
        self,
        *,
        tool_filter: Optional[Union[ToolPredicate, List[str]]] = None,
        tool_name_prefix: Optional[str] = None,
    ):
        """Initialize the toolset.

        Args:
            tool_filter: Filter to apply to tools — forwarded to the bound
                ``ClientProxyToolset`` at delegation time.
            tool_name_prefix: Prefix to prepend to tool names — also forwarded
                to the bound delegate.
        """
        # BaseToolset.__init__ initializes the cache attributes
        # (``_use_invocation_cache``, ``_cached_invocation_id``,
        # ``_cached_prefixed_tools``) on both ADK 1.x and 2.0. ADK 2.0's
        # ``llm_agent.py:185`` eagerly reads ``_use_invocation_cache`` and
        # silently drops the toolset when missing — required now that bind()
        # delegation preserves the instance across the run (#1389).
        super().__init__(tool_filter=tool_filter, tool_name_prefix=tool_name_prefix)
        self.tool_filter = tool_filter
        self.tool_name_prefix = tool_name_prefix
        # The bound delegate. Replaced by `bind()` once the run-time
        # ClientProxyToolset is constructed. `None` means no client tools
        # have been wired up yet (legitimate at agent-construction time
        # but a misconfiguration if get_tools() is called and `_unbound_raises`
        # is True).
        self._delegate: Optional["ClientProxyToolset"] = None
        # When True, `get_tools()` without a bound delegate raises (legacy
        # 1.x behavior preserved for explicit-misuse detection). When False
        # (the default), unbound get_tools() returns []. Toggled by tests
        # that want to verify the placeholder is never reached in production.
        self._unbound_raises: bool = False

    def bind(self, delegate: "ClientProxyToolset") -> None:
        """Bind a concrete delegate that ``get_tools()`` will forward to.

        Called by :func:`~ag_ui_adk.adk_agent._update_agent_tools_recursive`
        once the run-time :class:`~ag_ui_adk.client_proxy_toolset.ClientProxyToolset`
        has been constructed from ``input.tools``.

        Subsequent calls overwrite the binding — this is intentional so that
        a single ``AGUIToolset`` instance can be reused across runs with
        different client tool sets (e.g. multi-turn conversations).

        Args:
            delegate: The ``ClientProxyToolset`` that should serve ``get_tools()``
                calls for the lifetime of the current run.
        """
        self._delegate = delegate

    def unbind(self) -> None:
        """Detach the currently-bound delegate.

        Called by ``_run_adk_in_background`` cleanup paths so a stale
        ``ClientProxyToolset`` reference doesn't linger on the placeholder
        between runs. After ``unbind()`` the placeholder reverts to its
        construction-time state — safe to ``bind()`` again next run.
        """
        self._delegate = None

    async def get_tools(
        self,
        readonly_context: Optional[ReadonlyContext] = None,
    ) -> list[BaseTool]:
        """Return tools from the bound delegate, or ``[]`` if unbound.

        This is called by ADK's tool-discovery flow — in 1.x lazily on each
        ``run_async``, in 2.0 eagerly during ``Runner.__init__``. Either way
        the bound delegate forwards the actual tool list.

        Args:
            readonly_context: Context used to filter tools available to the
                agent. Forwarded verbatim to the delegate.

        Returns:
            list[BaseTool]: The delegate's tool list, or ``[]`` if no
            delegate is bound. Raises ``NotImplementedError`` when unbound
            only if ``_unbound_raises`` is set (legacy 1.x parity for tests).
        """
        if self._delegate is None:
            if self._unbound_raises:
                raise NotImplementedError(
                    "AGUIToolset is a placeholder and must be bound to a "
                    "ClientProxyToolset before use (call AGUIToolset.bind(...) "
                    "or wrap the agent with ADKAgent which does it for you)."
                )
            # Construction-time / between-runs: no delegate. Return empty
            # rather than raising — ADK 2.0's eager Runner cache otherwise
            # crashes agent registration. The actual binding happens before
            # the LLM is invoked, so this empty list is never observed by
            # the LLM in production paths.
            return []
        return await self._delegate.get_tools(readonly_context)
