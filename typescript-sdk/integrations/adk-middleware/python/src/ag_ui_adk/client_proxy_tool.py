# src/ag_ui_adk/client_proxy_tool.py

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



class ClientProxyTool(BaseTool):
    """A proxy tool that bridges AG-UI protocol tools to ADK.

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
        """Create FunctionDeclaration from AG-UI tool parameters.

        We override this instead of delegating to the wrapped tool because
        the ADK's automatic function calling has difficulty parsing our
        dynamically created function signature without proper type annotations.
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
            None for long-running tools (client handles execution)
        """
        # Store args and context for proxy function access
        self._current_args = args
        self._current_tool_context = tool_context

        # Delegate to the wrapped long-running tool
        return await self._long_running_tool.run_async(args=args, tool_context=tool_context)

    async def _execute_proxy_tool(self, args: Dict[str, Any], tool_context: Any) -> Any:
        """Execute the proxy tool logic - emit events and return None.

        Args:
            args: Tool arguments from ADK
            tool_context: ADK tool context

        Returns:
            None for long-running tools
        """
        logger.debug(f"Proxy tool execution: {self.ag_ui_tool.name}")
        logger.debug(f"Arguments received: {args}")
        logger.debug(f"Tool context type: {type(tool_context)}")

        # Extract ADK-generated function call ID if available
        adk_function_call_id = None
        if tool_context and hasattr(tool_context, 'function_call_id'):
            adk_function_call_id = tool_context.function_call_id
            logger.debug(f"Using ADK function_call_id: {adk_function_call_id}")

        # Use ADK ID if available, otherwise fall back to generated ID
        tool_call_id = adk_function_call_id or f"call_{uuid.uuid4().hex[:8]}"
        if not adk_function_call_id:
            logger.warning(f"ADK function_call_id not available, generated: {tool_call_id}")

        try:
            # Emit TOOL_CALL_START event
            start_event = ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=self.ag_ui_tool.name
            )
            await self.event_queue.put(start_event)
            logger.debug(f"Emitted TOOL_CALL_START for {tool_call_id}")

            # Emit TOOL_CALL_ARGS event
            args_json = json.dumps(args)
            args_event = ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta=args_json
            )
            await self.event_queue.put(args_event)
            logger.debug(f"Emitted TOOL_CALL_ARGS for {tool_call_id}")

            # Emit TOOL_CALL_END event
            end_event = ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            )
            await self.event_queue.put(end_event)
            logger.debug(f"Emitted TOOL_CALL_END for {tool_call_id}")

            # Return None for long-running tools - client handles the actual execution
            logger.debug(f"Returning None for long-running tool {tool_call_id}")
            return None

        except Exception as e:
            logger.error(f"Error in proxy tool execution for {tool_call_id}: {e}")
            raise

    def __repr__(self) -> str:
        """String representation of the proxy tool."""
        return f"ClientProxyTool(name='{self.name}', ag_ui_tool='{self.ag_ui_tool.name}')"