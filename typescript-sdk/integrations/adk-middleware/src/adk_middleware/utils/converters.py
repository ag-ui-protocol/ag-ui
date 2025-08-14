# src/utils/converters.py

"""Conversion utilities between AG-UI and ADK formats."""

from typing import List, Dict, Any, Optional
import json
import logging

from ag_ui.core import (
    Message, UserMessage, AssistantMessage, SystemMessage, ToolMessage,
    ToolCall, FunctionCall
)
from google.adk.events import Event as ADKEvent
from google.genai import types

logger = logging.getLogger(__name__)


def convert_ag_ui_messages_to_adk(messages: List[Message]) -> List[ADKEvent]:
    """Convert AG-UI messages to ADK events.
    
    Args:
        messages: List of AG-UI messages
        
    Returns:
        List of ADK events
    """
    adk_events = []
    
    for message in messages:
        try:
            # Create base event
            event = ADKEvent(
                id=message.id,
                author=message.role,
                content=None
            )
            
            # Convert content based on message type
            if isinstance(message, (UserMessage, SystemMessage)):
                if message.content:
                    event.content = types.Content(
                        role=message.role,
                        parts=[types.Part(text=message.content)]
                    )
            
            elif isinstance(message, AssistantMessage):
                parts = []
                
                # Add text content if present
                if message.content:
                    parts.append(types.Part(text=message.content))
                
                # Add tool calls if present
                if message.tool_calls:
                    for tool_call in message.tool_calls:
                        parts.append(types.Part(
                            function_call=types.FunctionCall(
                                name=tool_call.function.name,
                                args=json.loads(tool_call.function.arguments) if isinstance(tool_call.function.arguments, str) else tool_call.function.arguments,
                                id=tool_call.id
                            )
                        ))
                
                if parts:
                    event.content = types.Content(
                        role="model",  # ADK uses "model" for assistant
                        parts=parts
                    )
            
            elif isinstance(message, ToolMessage):
                # Tool messages become function responses
                event.content = types.Content(
                    role="function",
                    parts=[types.Part(
                        function_response=types.FunctionResponse(
                            name=message.tool_call_id, 
                            response={"result": message.content} if isinstance(message.content, str) else message.content,
                            id=message.tool_call_id
                        )
                    )]
                )
            
            adk_events.append(event)
            
        except Exception as e:
            logger.error(f"Error converting message {message.id}: {e}")
            continue
    
    return adk_events


def convert_adk_event_to_ag_ui_message(event: ADKEvent) -> Optional[Message]:
    """Convert an ADK event to an AG-UI message.
    
    Args:
        event: ADK event
        
    Returns:
        AG-UI message or None if not convertible
    """
    try:
        # Skip events without content
        if not event.content or not event.content.parts:
            return None
        
        # Determine message type based on author/role
        if event.author == "user":
            # Extract text content
            text_parts = [part.text for part in event.content.parts if part.text]
            if text_parts:
                return UserMessage(
                    id=event.id,
                    role="user",
                    content="\n".join(text_parts)
                )
        
        else:  # Assistant/model response
            # Extract text and tool calls
            text_parts = []
            tool_calls = []
            
            for part in event.content.parts:
                if part.text:
                    text_parts.append(part.text)
                elif part.function_call:
                    tool_calls.append(ToolCall(
                        id=getattr(part.function_call, 'id', event.id),
                        type="function",
                        function=FunctionCall(
                            name=part.function_call.name,
                            arguments=json.dumps(part.function_call.args) if hasattr(part.function_call, 'args') else "{}"
                        )
                    ))
            
            return AssistantMessage(
                id=event.id,
                role="assistant",
                content="\n".join(text_parts) if text_parts else None,
                tool_calls=tool_calls if tool_calls else None
            )
        
    except Exception as e:
        logger.error(f"Error converting ADK event {event.id}: {e}")
    
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
        # Determine operation type
        if value is None:
            # Remove operation
            patches.append({
                "op": "remove",
                "path": f"/{key}"
            })
        else:
            # Add/replace operation
            # We use "replace" as it works for both existing and new keys
            patches.append({
                "op": "replace",
                "path": f"/{key}",
                "value": value
            })
    
    return patches


def convert_json_patch_to_state(patches: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Convert JSON Patch operations to a state delta dictionary.
    
    Args:
        patches: List of JSON Patch operations
        
    Returns:
        Dictionary of state changes
    """
    state_delta = {}
    
    for patch in patches:
        op = patch.get("op")
        path = patch.get("path", "")
        
        # Extract key from path (remove leading slash)
        key = path.lstrip("/")
        
        if op == "remove":
            state_delta[key] = None
        elif op in ["add", "replace"]:
            state_delta[key] = patch.get("value")
        # Ignore other operations for now (copy, move, test)
    
    return state_delta


def extract_text_from_content(content: types.Content) -> str:
    """Extract all text from ADK Content object.
    
    Args:
        content: ADK Content object
        
    Returns:
        Combined text from all text parts
    """
    if not content or not content.parts:
        return ""
    
    text_parts = []
    for part in content.parts:
        if part.text:
            text_parts.append(part.text)
    
    return "\n".join(text_parts)


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