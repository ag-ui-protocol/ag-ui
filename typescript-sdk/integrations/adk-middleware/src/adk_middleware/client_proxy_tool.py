# src/adk_middleware/client_proxy_tool.py

"""Client-side proxy tool implementation for AG-UI protocol tools."""

import asyncio
import json
import uuid
import inspect
from typing import Any, Optional, List, Dict
import logging

from google.adk.tools import BaseTool, LongRunningFunctionTool
from google.genai import types
from ag_ui.core import Tool as AGUITool, EventType
from ag_ui.core import (
    ToolCallStartEvent, 
    ToolCallArgsEvent, 
    ToolCallEndEvent
)

logger = logging.getLogger(__name__)

# Set up debug logging
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)


class ClientProxyTool(BaseTool):
    """Proxy tool that bridges AG-UI tools to ADK tools.
    
    This tool appears as a normal ADK tool to the agent, but when executed,
    it emits AG-UI protocol events and waits for the client to execute
    the actual tool and return results.
    
    Internally wraps LongRunningFunctionTool for proper ADK behavior.
    """
    
    def __init__(
        self,
        ag_ui_tool: AGUITool,
        event_queue: asyncio.Queue
    ):
        """Initialize the client proxy tool.
        
        Args:
            ag_ui_tool: The AG-UI tool definition
            event_queue: Queue to emit AG-UI events
        """
        # Initialize BaseTool with name and description
        # All client-side tools are long-running for architectural simplicity
        super().__init__(
            name=ag_ui_tool.name,
            description=ag_ui_tool.description,
            is_long_running=True
        )
        
        self.ag_ui_tool = ag_ui_tool
        self.event_queue = event_queue
        
        # Create dynamic function with proper parameter signatures for ADK inspection
        # This allows ADK to extract parameters from user requests correctly
        sig_params = []
        
        # Extract parameters from AG-UI tool schema
        parameters = ag_ui_tool.parameters
        if isinstance(parameters, dict) and 'properties' in parameters:
            for param_name in parameters['properties'].keys():
                # Create parameter with proper type annotation
                sig_params.append(
                    inspect.Parameter(
                        param_name,
                        inspect.Parameter.KEYWORD_ONLY,
                        default=None,
                        annotation=Any
                    )
                )
        
        # Create the async function that will be wrapped by LongRunningFunctionTool
        async def proxy_tool_func(**kwargs) -> Any:
            # Access the original args and tool_context that were stored in run_async
            original_args = getattr(self, '_current_args', kwargs)
            original_tool_context = getattr(self, '_current_tool_context', None)
            return await self._execute_proxy_tool(original_args, original_tool_context)
        
        # Set the function name, docstring, and signature to match the AG-UI tool
        proxy_tool_func.__name__ = ag_ui_tool.name
        proxy_tool_func.__doc__ = ag_ui_tool.description
        
        # Create new signature with extracted parameters
        if sig_params:
            proxy_tool_func.__signature__ = inspect.Signature(sig_params)
        
        # Create the internal LongRunningFunctionTool for proper behavior
        self._long_running_tool = LongRunningFunctionTool(proxy_tool_func)
    
    def _get_declaration(self) -> Optional[types.FunctionDeclaration]:
        """Convert AG-UI tool parameters to ADK FunctionDeclaration.
        
        Returns:
            FunctionDeclaration for this tool
        """
        logger.debug(f"_get_declaration called for {self.name}")
        logger.debug(f"AG-UI tool parameters: {self.ag_ui_tool.parameters}")
        
        # Convert AG-UI parameters (JSON Schema) to ADK format
        parameters = self.ag_ui_tool.parameters
        
        # Ensure it's a proper object schema
        if not isinstance(parameters, dict):
            parameters = {"type": "object", "properties": {}}
            logger.warning(f"Tool {self.name} had non-dict parameters, using empty schema")
        
        # Create FunctionDeclaration
        function_declaration = types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=types.Schema.model_validate(parameters)
        )
        logger.debug(f"Created FunctionDeclaration for {self.name}: {function_declaration}")
        return function_declaration
    
    async def run_async(
        self, 
        *, 
        args: dict[str, Any], 
        tool_context: Any
    ) -> Any:
        """Execute the tool by delegating to the internal LongRunningFunctionTool.
        
        Args:
            args: The arguments for the tool call
            tool_context: The ADK tool context
            
        Returns:
            None (all client-side tools are long-running)
            
        Raises:
            Exception: If event emission fails
        """
        # Store the context temporarily so the wrapped function can access it
        self._current_args = args
        self._current_tool_context = tool_context
        
        try:
            # Delegate to the internal LongRunningFunctionTool for proper behavior
            result = await self._long_running_tool.run_async(args=args, tool_context=tool_context)
            return result
        finally:
            # Clean up the temporary context
            self._current_args = None
            self._current_tool_context = None
    
    async def _execute_proxy_tool(
        self, 
        args: dict[str, Any], 
        tool_context: Any
    ) -> Any:
        """Execute the tool by emitting events for client-side handling.
        
        This method:
        1. Generates a unique tool_call_id
        2. Emits TOOL_CALL_START event
        3. Emits TOOL_CALL_ARGS event with the arguments
        4. Emits TOOL_CALL_END event
        5. Returns None immediately (long-running behavior)
        
        Args:
            args: The arguments for the tool call
            tool_context: The ADK tool context
            
        Returns:
            None (all client-side tools are long-running)
            
        Raises:
            Exception: If event emission fails
        """
        # Try to get the function call ID from ADK tool context
        tool_call_id = None
        if tool_context and hasattr(tool_context, 'function_call_id'):
            potential_id = tool_context.function_call_id
            if isinstance(potential_id, str) and potential_id:
                tool_call_id = potential_id
        elif tool_context and hasattr(tool_context, 'id'):
            potential_id = tool_context.id
            if isinstance(potential_id, str) and potential_id:
                tool_call_id = potential_id
        
        # Fallback to UUID if we can't get the ADK ID
        if not tool_call_id:
            tool_call_id = str(uuid.uuid4())
            logger.debug(f"No function call ID from ADK context, using generated UUID: {tool_call_id}")
        else:
            logger.info(f"Using ADK function call ID: {tool_call_id}")
        
        logger.info(f"Executing client proxy tool '{self.name}' with id {tool_call_id}")
        logger.debug(f"Tool arguments received: {args}")
        
        try:
            # Emit TOOL_CALL_START event
            start_event = ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=self.name,
                parent_message_id=None  # Could be enhanced to track message
            )
            logger.debug(f"Emitting TOOL_CALL_START for {tool_call_id} (queue size before: {self.event_queue.qsize()}, queue ID: {id(self.event_queue)})")
            await self.event_queue.put(start_event)
            logger.debug(f"TOOL_CALL_START queued for {tool_call_id} (queue size after: {self.event_queue.qsize()})")
            
            # Emit TOOL_CALL_ARGS event
            # Convert args to JSON string for AG-UI protocol
            args_json = json.dumps(args)
            args_event = ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta=args_json
            )
            logger.debug(f"Emitting TOOL_CALL_ARGS for {tool_call_id} (queue size before: {self.event_queue.qsize()})")
            await self.event_queue.put(args_event)
            logger.debug(f"TOOL_CALL_ARGS queued for {tool_call_id} (queue size after: {self.event_queue.qsize()})")
            
            # Emit TOOL_CALL_END event
            end_event = ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            )
            logger.debug(f"Emitting TOOL_CALL_END for {tool_call_id} (queue size before: {self.event_queue.qsize()})")
            await self.event_queue.put(end_event)
            logger.debug(f"TOOL_CALL_END queued for {tool_call_id} (queue size after: {self.event_queue.qsize()})")
            
            # Return None immediately - all client tools are long-running
            # Client will handle tool execution and provide results via separate request
            logger.info(f"Tool '{self.name}' events emitted, returning None (long-running)")
            return None
                
        except Exception as e:
            logger.error(f"Error executing tool '{self.name}': {e}")
            raise
    
    def __repr__(self) -> str:
        """String representation of the proxy tool."""
        return f"ClientProxyTool(name='{self.name}', description='{self.description}', long_running=True)"