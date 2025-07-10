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
        tool_timeout_seconds: int = 300,
        is_long_running: bool = True,
        tool_long_running_config: Optional[Dict[str, bool]] = None,
        tool_names: Optional[Dict[str, str]] = None
    ):
        """Initialize the client proxy toolset.
        
        Args:
            ag_ui_tools: List of AG-UI tool definitions
            event_queue: Queue to emit AG-UI events
            tool_futures: Dictionary to store tool execution futures
            tool_timeout_seconds: Timeout for individual tool execution
            is_long_running: Default long-running mode for all tools
            tool_long_running_config: Optional per-tool long-running configuration.
                                    Maps tool names to is_long_running values.
                                    Overrides default for specific tools.
                                    Example: {"calculator": False, "email": True}
            tool_names: Optional dict to store tool names for long-running tools
        """
        super().__init__()
        self.ag_ui_tools = ag_ui_tools
        self.event_queue = event_queue
        self.tool_futures = tool_futures
        self.tool_timeout_seconds = tool_timeout_seconds
        self.is_long_running = is_long_running
        self.tool_long_running_config = tool_long_running_config or {}
        self.tool_names = tool_names
        
        # Cache of created proxy tools
        self._proxy_tools: Optional[List[BaseTool]] = None
        
        logger.info(f"Initialized ClientProxyToolset with {len(ag_ui_tools)} tools, default is_long_running={is_long_running}")
    
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
                    # Determine is_long_running for this specific tool
                    # Check if tool has specific config, otherwise use default
                    tool_is_long_running = self.tool_long_running_config.get(
                        ag_ui_tool.name, 
                        self.is_long_running
                    )
                    
                    proxy_tool = ClientProxyTool(
                        ag_ui_tool=ag_ui_tool,
                        event_queue=self.event_queue,
                        tool_futures=self.tool_futures,
                        timeout_seconds=self.tool_timeout_seconds,
                        is_long_running=tool_is_long_running,
                        tool_names=self.tool_names
                    )
                    self._proxy_tools.append(proxy_tool)
                    logger.debug(f"Created proxy tool for '{ag_ui_tool.name}' (is_long_running={tool_is_long_running})")
                    
                except Exception as e:
                    logger.error(f"Failed to create proxy tool for '{ag_ui_tool.name}': {e}")
                    # Continue with other tools rather than failing completely
        
        return self._proxy_tools
    
    async def close(self) -> None:
        """Clean up resources held by the toolset.
        
        Cancels any pending tool futures and clears the toolset cache.
        This is called when execution completes to ensure proper cleanup.
        
        Note: Long-running tools don't create futures (fire-and-forget), so this
        only affects blocking tools that may still be waiting for results.
        """
        logger.info("Closing ClientProxyToolset")
        
        # Cancel any pending futures (blocking tools that didn't complete)
        pending_count = 0
        for tool_call_id, future in list(self.tool_futures.items()):
            if not future.done():
                logger.debug(f"Cancelling pending tool future during close: {tool_call_id}")
                future.cancel()
                pending_count += 1
        
        # Clear the futures dictionary
        self.tool_futures.clear()
        
        if pending_count > 0:
            logger.debug(f"Cancelled {pending_count} pending tool futures during toolset close")
        
        # Clear cached tools
        self._proxy_tools = None
    
    def __repr__(self) -> str:
        """String representation of the toolset."""
        tool_names = [tool.name for tool in self.ag_ui_tools]
        config_summary = f"default_long_running={self.is_long_running}"
        if self.tool_long_running_config:
            config_summary += f", overrides={self.tool_long_running_config}"
        return f"ClientProxyToolset(tools={tool_names}, {config_summary})"