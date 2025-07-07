# src/adk_middleware/client_proxy_toolset.py

"""Dynamic toolset creation for client-side tools."""

import asyncio
from typing import List, Dict, Optional
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
        event_queue: asyncio.Queue,
        tool_futures: Dict[str, asyncio.Future],
        tool_timeout_seconds: int = 300
    ):
        """Initialize the client proxy toolset.
        
        Args:
            ag_ui_tools: List of AG-UI tool definitions
            event_queue: Queue to emit AG-UI events
            tool_futures: Dictionary to store tool execution futures
            tool_timeout_seconds: Timeout for individual tool execution
        """
        super().__init__()
        self.ag_ui_tools = ag_ui_tools
        self.event_queue = event_queue
        self.tool_futures = tool_futures
        self.tool_timeout_seconds = tool_timeout_seconds
        
        # Cache of created proxy tools
        self._proxy_tools: Optional[List[BaseTool]] = None
        
        logger.info(f"Initialized ClientProxyToolset with {len(ag_ui_tools)} tools")
    
    async def get_tools(
        self,
        readonly_context: Optional[ReadonlyContext] = None
    ) -> List[BaseTool]:
        """Get all proxy tools for this toolset.
        
        Creates ClientProxyTool instances for each AG-UI tool definition
        on first call, then returns cached instances.
        
        Args:
            readonly_context: Optional context for tool filtering (unused currently)
            
        Returns:
            List of ClientProxyTool instances
        """
        # Create proxy tools on first access
        if self._proxy_tools is None:
            self._proxy_tools = []
            
            for ag_ui_tool in self.ag_ui_tools:
                try:
                    proxy_tool = ClientProxyTool(
                        ag_ui_tool=ag_ui_tool,
                        event_queue=self.event_queue,
                        tool_futures=self.tool_futures,
                        timeout_seconds=self.tool_timeout_seconds
                    )
                    self._proxy_tools.append(proxy_tool)
                    logger.debug(f"Created proxy tool for '{ag_ui_tool.name}'")
                    
                except Exception as e:
                    logger.error(f"Failed to create proxy tool for '{ag_ui_tool.name}': {e}")
                    # Continue with other tools rather than failing completely
        
        return self._proxy_tools
    
    async def close(self) -> None:
        """Clean up resources held by the toolset.
        
        This cancels any pending tool executions.
        """
        logger.info("Closing ClientProxyToolset")
        
        # Cancel any pending tool futures
        for tool_call_id, future in self.tool_futures.items():
            if not future.done():
                logger.warning(f"Cancelling pending tool execution: {tool_call_id}")
                future.cancel()
        
        # Clear the futures dict
        self.tool_futures.clear()
        
        # Clear cached tools
        self._proxy_tools = None
    
    def __repr__(self) -> str:
        """String representation of the toolset."""
        tool_names = [tool.name for tool in self.ag_ui_tools]
        return f"ClientProxyToolset(tools={tool_names})"