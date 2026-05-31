"""AGUIToolset — a placeholder that ``ADKAgent`` replaces per run.

AG-UI integrations declare an ``AGUIToolset`` on their ADK agents at agent-
construction time, before any AG-UI run is in flight. At run-time
:class:`~ag_ui_adk.adk_agent.ADKAgent` knows the actual frontend tools the
client supplied (``input.tools``) and substitutes a concrete
:class:`~ag_ui_adk.client_proxy_toolset.ClientProxyToolset` for this placeholder
in the *per-run copy* of the agent tree
(``ADKAgent._start_background_execution._update_agent_tools_recursive``).

The substitution happens on a per-run shallow copy whose ``tools`` list is its
own, so every concurrent run gets its own ``ClientProxyToolset`` (its own
``input.tools`` and ``event_queue``); the construction-time placeholder is never
mutated and never shared across runs. (An earlier ``bind()``-delegation design
stored the per-run toolset on this shared instance and was not concurrency-safe;
per-run replacement restores isolation. ADK 2.0 GA reads ``agent.tools`` fresh
per invocation, so the replacement is picked up.)

If ``get_tools()`` is called on the placeholder itself, the substitution did not
happen (a misconfiguration — e.g. the agent was run without being wrapped by
``ADKAgent``), so it raises rather than silently exposing zero tools.
"""

from __future__ import annotations

from typing import List, Optional, Union

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset, ToolPredicate
from google.adk.agents.readonly_context import ReadonlyContext


class AGUIToolset(BaseToolset):
    """Frontend-tool placeholder, replaced per-run by a ``ClientProxyToolset``.

    Construction-time: declared on the ADK agent with ``tool_filter`` and
    ``tool_name_prefix`` (no client info yet). Run-time:
    :meth:`~ag_ui_adk.adk_agent.ADKAgent._start_background_execution` swaps it for
    a :class:`~ag_ui_adk.client_proxy_toolset.ClientProxyToolset` built from
    ``input.tools`` in the per-run agent copy.
    """

    def __init__(
        self,
        *,
        tool_filter: Optional[Union[ToolPredicate, List[str]]] = None,
        tool_name_prefix: Optional[str] = None,
    ):
        """Initialize the toolset.

        Args:
            tool_filter: Filter to apply to tools — forwarded to the per-run
                ``ClientProxyToolset`` at substitution time.
            tool_name_prefix: Prefix to prepend to tool names — also forwarded
                to the per-run ``ClientProxyToolset``.
        """
        # BaseToolset.__init__ initializes ADK 2.0's toolset cache attributes
        # (``_use_invocation_cache`` et al.). A no-op on ADK 1.x. Kept so the
        # placeholder is a well-formed BaseToolset even though it is normally
        # replaced before ADK ever resolves it.
        super().__init__(tool_filter=tool_filter, tool_name_prefix=tool_name_prefix)
        self.tool_filter = tool_filter
        self.tool_name_prefix = tool_name_prefix

    async def get_tools(
        self,
        readonly_context: Optional[ReadonlyContext] = None,
    ) -> list[BaseTool]:
        """Placeholders are replaced before use; reaching this is a misconfiguration.

        Raises:
            NotImplementedError: always — the run-time ``ClientProxyToolset``
            substitution in ``ADKAgent`` did not happen (e.g. the agent was run
            without being wrapped by ``ADKAgent``).
        """
        raise NotImplementedError(
            "AGUIToolset is a placeholder and must be replaced with a "
            "ClientProxyToolset before use (wrap the agent with ADKAgent, which "
            "does this per run)."
        )
