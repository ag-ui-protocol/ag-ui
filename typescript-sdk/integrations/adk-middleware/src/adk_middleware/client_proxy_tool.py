# src/adk_middleware/client_proxy_tool.py

"""Client-side proxy tool implementation for AG-UI protocol tools."""

import asyncio
import json
import uuid
from typing import Dict, Any, Optional
import logging

from google.adk.tools import BaseTool
from google.genai import types
from ag_ui.core import Tool as AGUITool, EventType
from ag_ui.core import (
    ToolCallStartEvent, 
    ToolCallArgsEvent, 
    ToolCallEndEvent
)

logger = logging.getLogger(__name__)


class ClientProxyTool(BaseTool):
    """Proxy tool that bridges AG-UI tools to ADK tools.
    
    This tool appears as a normal ADK tool to the agent, but when executed,
    it emits AG-UI protocol events and waits for the client to execute
    the actual tool and return results.
    """
    
    def __init__(
        self,
        ag_ui_tool: AGUITool,
        event_queue: asyncio.Queue,
        tool_futures: Dict[str, asyncio.Future],
        timeout_seconds: int = 300  # 5 minute default timeout
    ):
        """Initialize the client proxy tool.
        
        Args:
            ag_ui_tool: The AG-UI tool definition
            event_queue: Queue to emit AG-UI events
            tool_futures: Dictionary to store tool execution futures
            timeout_seconds: Timeout for tool execution
        """
        # Initialize BaseTool with name and description
        super().__init__(
            name=ag_ui_tool.name,
            description=ag_ui_tool.description,
            is_long_running=False  # Could be made configurable
        )
        
        self.ag_ui_tool = ag_ui_tool
        self.event_queue = event_queue
        self.tool_futures = tool_futures
        self.timeout_seconds = timeout_seconds
    
    def _get_declaration(self) -> Optional[types.FunctionDeclaration]:
        """Convert AG-UI tool parameters to ADK FunctionDeclaration.
        
        Returns:
            FunctionDeclaration for this tool
        """
        # Convert AG-UI parameters (JSON Schema) to ADK format
        parameters = self.ag_ui_tool.parameters
        
        # Ensure it's a proper object schema
        if not isinstance(parameters, dict):
            parameters = {"type": "object", "properties": {}}
        
        # Create FunctionDeclaration
        return types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema.model_validate(parameters)
        )
    
    async def run_async(
        self, 
        *, 
        args: Dict[str, Any], 
        tool_context: Any
    ) -> Any:
        """Execute the tool by emitting events and waiting for client response.
        
        This method:
        1. Generates a unique tool_call_id
        2. Emits TOOL_CALL_START event
        3. Emits TOOL_CALL_ARGS event with the arguments
        4. Emits TOOL_CALL_END event
        5. Creates a Future and waits for the result
        6. Returns the result or raises timeout error
        
        Args:
            args: The arguments for the tool call
            tool_context: The ADK tool context
            
        Returns:
            The result from the client-side tool execution
            
        Raises:
            asyncio.TimeoutError: If tool execution times out
            Exception: If tool execution fails
        """
        tool_call_id = str(uuid.uuid4())
        
        logger.info(f"Executing client proxy tool '{self.name}' with id {tool_call_id}")
        
        try:
            # Emit TOOL_CALL_START event
            await self.event_queue.put(
                ToolCallStartEvent(
                    type=EventType.TOOL_CALL_START,
                    tool_call_id=tool_call_id,
                    tool_call_name=self.name,
                    parent_message_id=None  # Could be enhanced to track message
                )
            )
            
            # Emit TOOL_CALL_ARGS event
            # Convert args to JSON string for AG-UI protocol
            args_json = json.dumps(args)
            await self.event_queue.put(
                ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=tool_call_id,
                    delta=args_json
                )
            )
            
            # Emit TOOL_CALL_END event
            await self.event_queue.put(
                ToolCallEndEvent(
                    type=EventType.TOOL_CALL_END,
                    tool_call_id=tool_call_id
                )
            )
            
            # Create a Future to wait for the result
            future = asyncio.Future()
            self.tool_futures[tool_call_id] = future
            
            # Wait for the result with timeout
            try:
                result = await asyncio.wait_for(
                    future, 
                    timeout=self.timeout_seconds
                )
                logger.info(f"Tool '{self.name}' completed successfully")
                return result
                
            except asyncio.TimeoutError:
                logger.error(f"Tool '{self.name}' timed out after {self.timeout_seconds}s")
                # Clean up the future
                self.tool_futures.pop(tool_call_id, None)
                raise TimeoutError(
                    f"Client tool '{self.name}' execution timed out after "
                    f"{self.timeout_seconds} seconds"
                )
                
        except Exception as e:
            logger.error(f"Error executing tool '{self.name}': {e}")
            # Clean up on any error
            self.tool_futures.pop(tool_call_id, None)
            raise
    
    def __repr__(self) -> str:
        """String representation of the proxy tool."""
        return f"ClientProxyTool(name='{self.name}', description='{self.description}')"