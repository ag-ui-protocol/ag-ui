# src/adk_middleware/client_proxy_tool.py

"""Client-side proxy tool implementation for AG-UI protocol tools."""

import asyncio
import json
import uuid
import inspect
from typing import Dict, Any, Optional, Callable, List
import logging

from google.adk.tools import FunctionTool, LongRunningFunctionTool
from google.genai import types
from ag_ui.core import Tool as AGUITool, EventType
from ag_ui.core import (
    ToolCallStartEvent, 
    ToolCallArgsEvent, 
    ToolCallEndEvent
)

logger = logging.getLogger(__name__)


def create_proxy_function(
    ag_ui_tool: AGUITool,
    event_queue: asyncio.Queue,
    tool_futures: Dict[str, asyncio.Future],
    timeout_seconds: float = 300.0,
    is_long_running: bool = True,
    tool_names: Optional[Dict[str, str]] = None
) -> Callable:
    """Create a proxy function that bridges AG-UI tools to ADK function calls.
    
    This function dynamically creates a function with the proper signature based on
    the AG-UI tool's parameters, allowing the ADK FunctionTool to properly inspect
    and validate the function signature.
    
    Args:
        ag_ui_tool: The AG-UI tool specification
        event_queue: Queue for emitting events back to the client
        tool_futures: Dictionary to store tool execution futures
        timeout_seconds: Timeout for tool execution (only applies to blocking tools)
        is_long_running: If True, returns immediately with tool_call_id; if False, waits for result
        tool_names: Optional dict to store tool names for long-running tools
        
    Returns:
        A function that can be used with ADK FunctionTool or LongRunningFunctionTool
    """
    # Extract parameter names from AG-UI tool parameters
    param_names = _extract_parameter_names(ag_ui_tool.parameters)
    
    # Create the function dynamically with proper signature
    return _create_dynamic_function(
        ag_ui_tool=ag_ui_tool,
        param_names=param_names,
        event_queue=event_queue,
        tool_futures=tool_futures,
        timeout_seconds=timeout_seconds,
        is_long_running=is_long_running,
        tool_names=tool_names
    )


def _extract_parameter_names(parameters: Dict[str, Any]) -> List[str]:
    """Extract parameter names from AG-UI tool parameters (JSON Schema).
    
    Args:
        parameters: The parameters dict from AG-UI tool
        
    Returns:
        List of parameter names
    """
    if not isinstance(parameters, dict):
        return []
    
    properties = parameters.get("properties", {})
    if not isinstance(properties, dict):
        return []
    
    return list(properties.keys())


def _create_dynamic_function(
    ag_ui_tool: AGUITool,
    param_names: List[str],
    event_queue: asyncio.Queue,
    tool_futures: Dict[str, asyncio.Future],
    timeout_seconds: float,
    is_long_running: bool,
    tool_names: Optional[Dict[str, str]] = None
) -> Callable:
    """Create a dynamic function with the specified parameter names.
    
    Args:
        ag_ui_tool: The AG-UI tool specification
        param_names: List of parameter names to include in function signature
        event_queue: Queue for emitting events back to the client
        tool_futures: Dictionary to store tool execution futures
        timeout_seconds: Timeout for tool execution
        is_long_running: Whether this is a long-running tool
        tool_names: Optional dict to store tool names for long-running tools
        
    Returns:
        Dynamically created async function
    """
    # Create parameters for the dynamic function signature
    parameters = []
    for param_name in param_names:
        # Create parameters as keyword-only with no default (required)
        param = inspect.Parameter(
            param_name,
            inspect.Parameter.KEYWORD_ONLY,
            default=inspect.Parameter.empty
        )
        parameters.append(param)
    
    # Create the signature
    sig = inspect.Signature(parameters)
    
    async def proxy_function_impl(**kwargs) -> Any:
        """Proxy function that handles the AG-UI tool execution."""
        # Generate a unique tool call ID
        tool_call_id = f"adk-{uuid.uuid4()}"
        
        logger.info(f"Executing proxy function for '{ag_ui_tool.name}' with id {tool_call_id}")
        
        # Emit TOOL_CALL_START event
        await event_queue.put(
            ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=ag_ui_tool.name
            )
        )
        
        # Emit TOOL_CALL_ARGS event
        args_json = json.dumps(kwargs)
        await event_queue.put(
            ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta=args_json
            )
        )
        
        # Emit TOOL_CALL_END event
        await event_queue.put(
            ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            )
        )
        
        # Create a Future to wait for the result
        future = asyncio.Future()
        tool_futures[tool_call_id] = future
        
        # Store tool name for long-running tools (needed for FunctionResponse later)
        if is_long_running and tool_names is not None:
            tool_names[tool_call_id] = ag_ui_tool.name
        
        # Handle long-running vs blocking behavior
        if is_long_running:
            # For long-running tools, return immediately with tool_call_id
            logger.info(f"Long-running tool '{ag_ui_tool.name}' returning immediately with id {tool_call_id}")
            return tool_call_id
        else:
            # For blocking tools, wait for the result with timeout
            try:
                result = await asyncio.wait_for(future, timeout=timeout_seconds)
                logger.info(f"Blocking tool '{ag_ui_tool.name}' completed successfully")
                return result
            except asyncio.TimeoutError:
                logger.error(f"Blocking tool '{ag_ui_tool.name}' timed out after {timeout_seconds}s")
                # Clean up the future
                tool_futures.pop(tool_call_id, None)
                raise TimeoutError(
                    f"Tool '{ag_ui_tool.name}' execution timed out after "
                    f"{timeout_seconds} seconds"
                )
            except Exception as e:
                logger.error(f"Blocking tool '{ag_ui_tool.name}' failed: {e}")
                # Clean up the future
                tool_futures.pop(tool_call_id, None)
                raise
    
    # Create a wrapper function with the proper signature
    async def proxy_function(*args, **kwargs):
        """Wrapper function with proper signature for ADK inspection."""
        # Convert args and kwargs back to a kwargs dict for the implementation
        bound_args = sig.bind(*args, **kwargs)
        bound_args.apply_defaults()
        return await proxy_function_impl(**bound_args.arguments)
    
    # Set the signature on the wrapper function
    proxy_function.__signature__ = sig
    
    return proxy_function


def create_client_proxy_tool(
    ag_ui_tool: AGUITool,
    event_queue: asyncio.Queue,
    tool_futures: Dict[str, asyncio.Future],
    is_long_running: bool = True,
    timeout_seconds: float = 300.0,
    tool_names: Optional[Dict[str, str]] = None
) -> FunctionTool:
    """Create a client proxy tool using proper ADK tool classes.
    
    Args:
        ag_ui_tool: The AG-UI tool specification
        event_queue: Queue for emitting events back to the client
        tool_futures: Dictionary to store tool execution futures
        is_long_running: Whether this tool should be long-running
        timeout_seconds: Timeout for tool execution
        tool_names: Optional dict to store tool names for long-running tools
        
    Returns:
        Either a FunctionTool or LongRunningFunctionTool (which extends FunctionTool)
    """
    proxy_function = create_proxy_function(
        ag_ui_tool=ag_ui_tool,
        event_queue=event_queue,
        tool_futures=tool_futures,
        timeout_seconds=timeout_seconds,
        is_long_running=is_long_running,
        tool_names=tool_names
    )
    
    # Set the function metadata for ADK to extract
    proxy_function.__name__ = ag_ui_tool.name
    proxy_function.__doc__ = ag_ui_tool.description
    
    if is_long_running:
        logger.info(f"Creating LongRunningFunctionTool for '{ag_ui_tool.name}'")
        return LongRunningFunctionTool(proxy_function)
    else:
        logger.info(f"Creating FunctionTool for '{ag_ui_tool.name}'")
        return FunctionTool(proxy_function)




from google.adk.tools import BaseTool

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
        timeout_seconds: int = 300,  # 5 minute default timeout
        is_long_running=True,
        tool_names: Optional[Dict[str, str]] = None
    ):
        """Initialize the client proxy tool.
        
        Args:
            ag_ui_tool: The AG-UI tool definition
            event_queue: Queue to emit AG-UI events
            tool_futures: Dictionary to store tool execution futures
            timeout_seconds: Timeout for tool execution
            is_long_running: If True, no timeout is applied
            tool_names: Optional dict to store tool names for long-running tools
        """
        # Initialize BaseTool parent class
        super().__init__(
            name=ag_ui_tool.name,
            description=ag_ui_tool.description,
            is_long_running=is_long_running
        )
        
        self.ag_ui_tool = ag_ui_tool
        self.event_queue = event_queue
        self.tool_futures = tool_futures
        self.timeout_seconds = timeout_seconds
        
        # Create the proxy function and set its metadata
        proxy_function = create_proxy_function(
            ag_ui_tool=ag_ui_tool,
            event_queue=event_queue,
            tool_futures=tool_futures,
            timeout_seconds=timeout_seconds,
            is_long_running=is_long_running,
            tool_names=tool_names
        )
        
        # Set the function metadata for ADK to extract
        proxy_function.__name__ = ag_ui_tool.name
        proxy_function.__doc__ = ag_ui_tool.description
        
        # Create the wrapped ADK tool instance
        if is_long_running:
            self._wrapped_tool = LongRunningFunctionTool(proxy_function)
        else:
            self._wrapped_tool = FunctionTool(proxy_function)
    
    @property
    def name(self) -> str:
        """Get the tool name from the wrapped tool (uses FunctionTool's extraction logic)."""
        return self._wrapped_tool.name
    
    @name.setter
    def name(self, value: str):
        """Setter for name - does nothing since name comes from wrapped tool."""
        pass
    
    @property
    def description(self) -> str:
        """Get the tool description from the wrapped tool (uses FunctionTool's extraction logic)."""
        return self._wrapped_tool.description
    
    @description.setter
    def description(self, value: str):
        """Setter for description - does nothing since description comes from wrapped tool."""
        pass
    
    def _get_declaration(self) -> Optional[types.FunctionDeclaration]:
        """Create FunctionDeclaration from AG-UI tool parameters.
        
        We override this instead of delegating to the wrapped tool because
        the ADK's automatic function calling has difficulty parsing our
        dynamically created function signature without proper type annotations.
        """
        # Convert AG-UI parameters (JSON Schema) to ADK format
        parameters = self.ag_ui_tool.parameters
        
        # Debug: Show the raw parameters
        print(f"🔍 TOOL PARAMS DEBUG: Tool '{self.ag_ui_tool.name}' parameters: {parameters}")
        print(f"🔍 TOOL PARAMS DEBUG: Parameters type: {type(parameters)}")
        
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
        """Delegate to wrapped ADK tool, which will call our proxy_function with all the middleware logic.
        
        Args:
            args: The arguments for the tool call
            tool_context: The ADK tool context
            
        Returns:
            The result from the client-side tool execution (via proxy_function)
        """
        return await self._wrapped_tool.run_async(args=args, tool_context=tool_context)
    
    def __repr__(self) -> str:
        """String representation of the proxy tool."""
        return f"ClientProxyTool(name='{self.name}', description='{self.description}', is_long_running={self.is_long_running})"