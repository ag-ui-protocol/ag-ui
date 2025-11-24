# src/ag_ui_adk/client_proxy_toolset.py

"""Dynamic toolset creation for client-side tools."""

import asyncio
from typing import List, Optional
import logging

from google.adk.tools import BaseTool
from google.adk.tools.base_toolset import BaseToolset
from google.adk.agents.readonly_context import ReadonlyContext
from ag_ui.core import Tool as AGUITool

from .client_proxy_tool import ClientProxyTool

logger = logging.getLogger(__name__)


class ClientProxyToolset(BaseToolset):
    """Dynamic toolset that creates proxy tools from AG-UI tool definitions.

    This toolset is created for each run based on the tools provided in
    the RunAgentInput, allowing dynamic tool availability per request.
    """

    def __init__(
        self,
        ag_ui_tools: List[AGUITool],
        event_queue: asyncio.Queue
    ):
        """Initialize the client proxy toolset.

        Args:
            ag_ui_tools: List of AG-UI tool definitions
            event_queue: Queue to emit AG-UI events
        """
        super().__init__()
        self.ag_ui_tools = ag_ui_tools
        self.event_queue = event_queue

        logger.info(f"Initialized ClientProxyToolset with {len(ag_ui_tools)} tools (all long-running)")

    async def get_tools(
        self,
        readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        """Get all proxy tools for this toolset.

        Creates fresh ClientProxyTool instances for each AG-UI tool definition
        with the current event queue reference.

        Args:
            readonly_context: Optional context for tool filtering (unused currently)

        Returns:
            List of ClientProxyTool instances
        """
        # Create fresh proxy tools each time to avoid stale queue references
        proxy_tools = []

        for ag_ui_tool in self.ag_ui_tools:
            try:
                proxy_tool = ClientProxyTool(
                    ag_ui_tool=ag_ui_tool,
                    event_queue=self.event_queue
                )
                proxy_tools.append(proxy_tool)
                logger.debug(f"Created proxy tool for '{ag_ui_tool.name}' (long-running)")

            except Exception as e:
                logger.error(f"Failed to create proxy tool for '{ag_ui_tool.name}': {e}")
                # Continue with other tools rather than failing completely

        return proxy_tools

    async def close(self) -> None:
        """Clean up resources held by the toolset."""
        logger.info("Closing ClientProxyToolset")

    def __repr__(self) -> str:
        """String representation of the toolset."""
        tool_names = [tool.name for tool in self.ag_ui_tools]
        return f"ClientProxyToolset(tools={tool_names}, all_long_running=True)"