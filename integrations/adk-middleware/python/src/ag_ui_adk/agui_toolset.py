import logging
from typing import List, Optional, Union

from google.adk.tools.base_tool import BaseTool
from google.adk.tools.base_toolset import BaseToolset, ToolPredicate
from google.adk.agents.readonly_context import ReadonlyContext

logger = logging.getLogger(__name__)


class AGUIToolset(BaseToolset):
    """Delegating toolset for AG-UI frontend tool integration.

    Before ``bind()`` is called, ``get_tools()`` returns an empty list so
    that early callers (e.g. ADK 2.0 Runner, which resolves tools during
    ``__init__``) do not crash.  Once a ``ClientProxyToolset`` is bound
    via ``bind()``, all subsequent ``get_tools()`` calls delegate to it,
    ensuring frontend tools are available regardless of when the Runner
    cached this toolset reference.
    """

    def __init__(
        self,
        *,
        tool_filter: Optional[Union[ToolPredicate, List[str]]] = None,
        tool_name_prefix: Optional[str] = None,
    ):
        """Initialize the toolset.

        Args:
            tool_filter: Filter to apply to tools.
            tool_name_prefix: Prefix prepended to tool names returned by the toolset.
        """
        self.tool_filter = tool_filter
        self.tool_name_prefix = tool_name_prefix
        self._delegate: Optional["BaseToolset"] = None

    def bind(self, delegate: "BaseToolset") -> None:
        """Bind a concrete toolset to delegate ``get_tools()`` calls to.

        This is called by ``_update_agent_tools_recursive`` once the
        ``ClientProxyToolset`` is available for the current execution.

        Args:
            delegate: The ``ClientProxyToolset`` to delegate to.
        """
        self._delegate = delegate

    async def get_tools(
        self,
        readonly_context: Optional[ReadonlyContext] = None,
    ) -> list[BaseTool]:
        """Return tools from the bound delegate, or an empty list if unbound.

        Args:
            readonly_context: Context used to filter tools available to the
                agent. Forwarded to the delegate when bound.

        Returns:
            list[BaseTool]: Tools from the delegate, or ``[]`` before binding.
        """
        if self._delegate is not None:
            return await self._delegate.get_tools(readonly_context)
        logger.debug("AGUIToolset.get_tools() called before bind(); returning empty list")
        return []

    async def close(self) -> None:
        """Close the delegate toolset if one is bound."""
        if self._delegate is not None:
            await self._delegate.close()