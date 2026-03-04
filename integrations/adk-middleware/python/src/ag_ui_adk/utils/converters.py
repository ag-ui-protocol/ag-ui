# src/utils/converters.py

"""Conversion utilities between AG-UI and ADK formats."""

from typing import List, Dict, Any, Optional, Tuple, Union
import json
import base64
import binascii
import logging

from ag_ui.core import (
    Message, UserMessage, AssistantMessage, SystemMessage, ToolMessage,
    ToolCall, FunctionCall, TextInputContent, BinaryInputContent, InputContent
)
from google.adk.events import Event as ADKEvent
from google.genai import types

logger = logging.getLogger(__name__)

def _get_text_value(item: Union[dict, TextInputContent]) -> Optional[str]:
    """Get text value from dict or TextInputContent."""
    if isinstance(item, TextInputContent):
        return item.text
    else:
        return item.get("text")

def _get_binary_attributes(item: Union[dict, BinaryInputContent]) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    """Get binary attributes (data, mime_type, url, id) from dict or BinaryInputContent."""
    if isinstance(item, BinaryInputContent):
        return (
            item.data,
            item.mime_type,
            item.url,
            item.id,
        )
    else:
        return (
            item.get("data"),
            item.get("mimeType") or item.get("mime_type"),
            item.get("url"),
            item.get("id")
        )

def _to_binary_part(data: Optional[str], mime_type: Optional[str], url: Optional[str], binary_id: Optional[str]) -> Optional[types.Part]:
    """Create a types.Part from binary data."""
    # currently, only data is supported
    if not data:
        logger.warning(
            "BinaryInputContent: data is required; ignoring item without data."
        )
        return None
    
    if url or binary_id:
        logger.warning(
            "BinaryInputContent: only data is supported; ignoring url/id fields."
        )
        return None

    if not mime_type:
        logger.warning("BinaryInputContent: missing mimeType; ignoring.")
        return None

    try:
        decoded = base64.b64decode(data, validate=True)
        return types.Part(
            inline_data=types.Blob(
                mime_type=mime_type,
                data=decoded,
            )
        )
    except (binascii.Error, ValueError) as e:
        logger.warning("Failed to base64 decode BinaryInputContent.data: %s", e)
        return None

def _to_text_part(text: Optional[str]) -> Optional[types.Part]:
    """Create a types.Part from text."""
    if not text:
        return None
    return types.Part(text=text)

def _is_text_content(item: Union[dict, InputContent]) -> bool:
    is_text_dict = isinstance(item, dict) and item.get("type") == "text"
    is_text_input_content = isinstance(item, TextInputContent)
    return is_text_dict or is_text_input_content

def _is_binary_content(item: Union[dict, InputContent]) -> bool:
    is_binary_dict = isinstance(item, dict) and item.get("type") == "binary"
    is_binary_input_content = isinstance(item, BinaryInputContent)
    return is_binary_dict or is_binary_input_content

def convert_message_content_to_parts(content: Optional[Union[str, List[Any]]]) -> List[types.Part]:
    """Convert AG-UI message content into google.genai types.Part list.

    Supports:
    - str -> [Part(text=...)]
    - List[InputContent] -> text parts + binary parts (inline_data only; data/base64 only)
    - List[dict] -> dict-shaped text/binary items (data/base64 only)
    """
    if content is None:
        return []

    if isinstance(content, str):
        return [types.Part(text=content)] if content else []

    parts: List[types.Part] = []
    for item in content:
        if _is_text_content(item):
            text_value = _get_text_value(item)
            part = _to_text_part(text_value)
            if part:
                parts.append(part)
        elif _is_binary_content(item):
            data, mime_type, url, binary_id = _get_binary_attributes(item)
            part = _to_binary_part(data, mime_type, url, binary_id)
            if part:
                parts.append(part)
        else:
            item_type_name = item.get("type") if isinstance(item, dict) else type(item).__name__
            logger.debug("Ignoring unknown multimodal content item: %s", item_type_name)
    return parts


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
                parts = convert_message_content_to_parts(message.content)
                if parts:
                    event.content = types.Content(
                        role=message.role,
                        parts=parts
                    )

            elif isinstance(message, AssistantMessage):
                parts = []

                # Add text content if present
                if message.content:
                    parts.extend(convert_message_content_to_parts(message.content))
                
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
    """Extract all text from ADK Content object."""
    if not content or not content.parts:
        return ""

    text_parts = []
    for part in content.parts:
        if part.text:
            text_parts.append(part.text)

    return "\n".join(text_parts)


def flatten_message_content(content: Any) -> str:
    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        text_parts = [part.text for part in content if isinstance(part, TextInputContent) and part.text]
        return "\n".join(text_parts)

    return str(content)


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
