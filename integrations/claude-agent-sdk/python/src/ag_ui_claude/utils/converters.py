"""Conversion utilities between AG-UI and Claude SDK formats."""

from typing import List, Dict, Any, Optional
import json
import logging

from ag_ui.core import (
    Message, UserMessage, AssistantMessage, SystemMessage, ToolMessage,
    ToolCall, FunctionCall
)

logger = logging.getLogger(__name__)


def convert_ag_ui_messages_to_claude(messages: List[Message]) -> List[Dict[str, Any]]:
    """Convert AG-UI messages to Claude SDK message format.
    
    Args:
        messages: List of AG-UI messages
        
    Returns:
        List of Claude SDK message dictionaries
        
    TODO: Adjust based on actual Claude SDK message format.
    Example format might be:
    [
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."},
        {"role": "tool", "tool_call_id": "...", "content": "..."}
    ]
    """
    claude_messages = []
    
    for message in messages:
        try:
            role = message.role
            
            if isinstance(message, (UserMessage, SystemMessage)):
                claude_messages.append({
                    "role": role,
                    "content": message.content or ""
                })
            
            elif isinstance(message, AssistantMessage):
                content_parts = []
                
                # Add text content if present
                if message.content:
                    content_parts.append({
                        "type": "text",
                        "text": message.content
                    })
                
                # Add tool calls if present
                if message.tool_calls:
                    for tool_call in message.tool_calls:
                        content_parts.append({
                            "type": "tool_use",
                            "id": tool_call.id,
                            "name": tool_call.function.name,
                            "input": json.loads(tool_call.function.arguments) if isinstance(tool_call.function.arguments, str) else tool_call.function.arguments
                        })
                
                claude_messages.append({
                    "role": "assistant",
                    "content": content_parts if content_parts else [{"type": "text", "text": ""}]
                })
            
            elif isinstance(message, ToolMessage):
                claude_messages.append({
                    "role": "tool",
                    "tool_call_id": message.tool_call_id,
                    "content": message.content or ""
                })
            
        except Exception as e:
            logger.error(f"Error converting message {getattr(message, 'id', 'unknown')}: {e}")
            continue
    
    return claude_messages


def convert_claude_message_to_ag_ui(claude_message: Dict[str, Any]) -> Optional[Message]:
    """Convert a Claude SDK message to an AG-UI message.
    
    Args:
        claude_message: Claude SDK message dictionary
        
    Returns:
        AG-UI message or None if not convertible
        
    TODO: Adjust based on actual Claude SDK message format.
    """
    try:
        role = claude_message.get("role")
        content = claude_message.get("content", "")
        
        if role == "user":
            # Handle string or array content
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = " ".join(
                    item.get("text", "") if isinstance(item, dict) else str(item)
                    for item in content
                )
            else:
                text = str(content)
            
            return UserMessage(
                id=claude_message.get("id"),
                role="user",
                content=text
            )
        
        elif role == "assistant":
            # Extract text and tool calls
            text_parts = []
            tool_calls = []
            
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        if part.get("type") == "text":
                            text_parts.append(part.get("text", ""))
                        elif part.get("type") == "tool_use":
                            tool_calls.append(ToolCall(
                                id=part.get("id"),
                                type="function",
                                function=FunctionCall(
                                    name=part.get("name", ""),
                                    arguments=json.dumps(part.get("input", {}))
                                )
                            ))
            elif isinstance(content, str):
                text_parts.append(content)
            
            return AssistantMessage(
                id=claude_message.get("id"),
                role="assistant",
                content="\n".join(text_parts) if text_parts else None,
                tool_calls=tool_calls if tool_calls else None
            )
        
        elif role == "tool":
            return ToolMessage(
                id=claude_message.get("id"),
                role="tool",
                tool_call_id=claude_message.get("tool_call_id"),
                content=claude_message.get("content", "")
            )
        
    except Exception as e:
        logger.error(f"Error converting Claude message: {e}")
    
    return None


def convert_state_to_json_patch(state_delta: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert a state delta to JSON Patch format (RFC 6902).
    
    Args:
        state_delta: Dictionary of state changes
        
    Returns:
        List of JSON Patch operations
    """
    patches = []
    
    for key, value in state_delta.items():
        if value is None:
            patches.append({
                "op": "remove",
                "path": f"/{key}"
            })
        else:
            patches.append({
                "op": "add",
                "path": f"/{key}",
                "value": value
            })
    
    return patches


def create_error_message(error: Exception, context: str = "") -> str:
    """Create a user-friendly error message.
    
    Args:
        error: The exception
        context: Additional context about where the error occurred
        
    Returns:
        Formatted error message
    """
    error_type = type(error).__name__
    error_msg = str(error)
    
    if context:
        return f"{context}: {error_type} - {error_msg}"
    else:
        return f"{error_type}: {error_msg}"

