"""Tool adapter for converting AG-UI tools to Claude SDK format."""

import json
from typing import List, Dict, Any, Optional
import logging

try:
    from ag_ui.core import Tool as AGUITool
except ImportError:
    AGUITool = None

try:
    from claude_agent_sdk import SdkMcpTool, create_sdk_mcp_server
except ImportError:
    SdkMcpTool = None
    create_sdk_mcp_server = None

logger = logging.getLogger(__name__)


class ToolAdapter:
    """Adapter for converting AG-UI tools to Claude SDK tool format.
    
    Note: This implementation is based on common Anthropic SDK patterns.
    Adjust based on actual Claude Agent SDK tool format (e.g., SdkMcpTool).
    """
    
    @staticmethod
    def convert_ag_ui_tool_to_claude(ag_ui_tool: AGUITool) -> Any:
        """Convert an AG-UI tool to Claude SDK SdkMcpTool format.
        
        Args:
            ag_ui_tool: AG-UI tool definition
            
        Returns:
            SdkMcpTool instance
            
        Note: For client-side tools (long-running), we create a placeholder handler.
        The actual tool execution is handled by the frontend via AG-UI events.
        For backend tools, implement the actual handler logic.
        """
        if SdkMcpTool is None:
            raise ImportError("claude-agent-sdk is not installed. Install it with: pip install claude-agent-sdk")
        
        # Convert AG-UI parameters (JSON Schema) to Claude format
        parameters = ag_ui_tool.parameters
        
        # Ensure it's a proper object schema
        if not isinstance(parameters, dict):
            parameters = {"type": "object", "properties": {}}
            logger.warning(f"Tool {ag_ui_tool.name} had non-dict parameters, using empty schema")
        
        # For client-side tools (long-running), create a placeholder handler
        # The tool will emit events to frontend, which executes it
        async def placeholder_handler(args: Dict[str, Any]) -> Dict[str, Any]:
            """Placeholder handler for client-side long-running tools.
            
            This handler should not be called for client-side tools.
            The tool execution happens on the frontend via AG-UI events.
            If this is called, it indicates a configuration issue.
            """
            logger.warning(
                f"Placeholder handler called for client-side tool '{ag_ui_tool.name}'. "
                f"This should not happen - tool execution should be handled by frontend."
            )
            return {
                "content": [{
                    "type": "text",
                    "text": "Tool execution handled by frontend"
                }]
            }
        
        # Create SdkMcpTool with placeholder handler
        # Note: The actual tool execution flow:
        # 1. Claude SDK calls tool -> ToolUseBlock emitted
        # 2. EventTranslator converts to AG-UI TOOL_CALL_* events
        # 3. Frontend receives events and executes tool
        # 4. Frontend sends ToolMessage back
        # 5. Tool result processed and sent to Claude SDK
        claude_tool = SdkMcpTool(
            name=ag_ui_tool.name,
            description=ag_ui_tool.description or "",
            input_schema=parameters,
            handler=placeholder_handler
        )
        
        logger.debug(f"Converted AG-UI tool '{ag_ui_tool.name}' to SdkMcpTool (client-side)")
        return claude_tool
    
    @staticmethod
    def convert_ag_ui_tools_to_claude(ag_ui_tools: List[AGUITool]) -> List[Any]:
        """Convert a list of AG-UI tools to Claude SDK format.
        
        Args:
            ag_ui_tools: List of AG-UI tool definitions
            
        Returns:
            List of SdkMcpTool instances
        """
        return [
            ToolAdapter.convert_ag_ui_tool_to_claude(tool)
            for tool in ag_ui_tools
        ]
    
    @staticmethod
    def create_mcp_server_for_tools(
        ag_ui_tools: List[AGUITool],
        server_name: str = "ag_ui_tools",
        server_version: str = "1.0.0"
    ) -> Any:
        """Create an MCP server for AG-UI tools.
        
        Args:
            ag_ui_tools: List of AG-UI tool definitions
            server_name: Name for the MCP server
            server_version: Version for the MCP server
            
        Returns:
            MCP server instance
        """
        if create_sdk_mcp_server is None:
            raise ImportError("claude-agent-sdk is not installed")
        
        claude_tools = ToolAdapter.convert_ag_ui_tools_to_claude(ag_ui_tools)
        
        return create_sdk_mcp_server(
            name=server_name,
            version=server_version,
            tools=claude_tools
        )
    
    @staticmethod
    def is_long_running_tool(ag_ui_tool: AGUITool) -> bool:
        """Check if a tool should be treated as long-running (client-side execution).
        
        Args:
            ag_ui_tool: AG-UI tool definition
            
        Returns:
            True if tool should be executed on client side
        """
        # TODO: Determine logic for long-running tools
        # For now, assume all client-provided tools are long-running
        # Backend tools should be handled separately
        return True
    
    @staticmethod
    def extract_tool_call_id(tool_call: Any) -> Optional[str]:
        """Extract tool call ID from Claude SDK ToolUseBlock.
        
        Args:
            tool_call: Claude SDK ToolUseBlock object
            
        Returns:
            Tool call ID or None
        """
        return getattr(tool_call, 'id', None)
    
    @staticmethod
    def extract_tool_name(tool_call: Any) -> Optional[str]:
        """Extract tool name from Claude SDK ToolUseBlock.
        
        Args:
            tool_call: Claude SDK ToolUseBlock object
            
        Returns:
            Tool name or None
        """
        return getattr(tool_call, 'name', None)
    
    @staticmethod
    def extract_tool_args(tool_call: Any) -> Dict[str, Any]:
        """Extract tool arguments from Claude SDK ToolUseBlock.
        
        Args:
            tool_call: Claude SDK ToolUseBlock object
            
        Returns:
            Dictionary of tool arguments
        """
        return getattr(tool_call, 'input', {}) or {}

