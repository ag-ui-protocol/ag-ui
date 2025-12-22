# src/utils/converters.py

"""Conversion utilities between AG-UI and ADK formats."""

from typing import List, Dict, Any, Optional
import json
import base64
import binascii
import logging

from ag_ui.core import (
    Message, UserMessage, AssistantMessage, SystemMessage, ToolMessage,
    ToolCall, FunctionCall, TextInputContent, BinaryInputContent
)
from google.adk.events import Event as ADKEvent
from google.genai import types

logger = logging.getLogger(__name__)


def convert_message_content_to_parts(content: Any) -> List[types.Part]:
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

    if isinstance(content, list):
        parts: List[types.Part] = []
        for item in content:
            # dict-shaped content (e.g., raw JSON payloads)
            if isinstance(item, dict):
                item_type = item.get("type")

                if item_type == "text":
                    text = item.get("text")
                    if isinstance(text, str) and text:
                        parts.append(types.Part(text=text))
                    continue

                if item_type == "binary":
                    # data-only policy
                    data = item.get("data")
                    mime_type = item.get("mimeType") or item.get("mime_type")

                    if item.get("url") or item.get("id"):
                        logger.warning(
                            "BinaryInputContent: only data is supported; ignoring url/id fields."
                        )

                    if not data:
                        logger.warning(
                            "BinaryInputContent: data-only supported; ignoring item without data."
                        )
                        continue
                    if not mime_type:
                        logger.warning("BinaryInputContent: missing mimeType; ignoring.")
                        continue

                    try:
                        decoded = base64.b64decode(data, validate=False)
                    except (binascii.Error, ValueError) as e:
                        logger.warning("Failed to base64 decode BinaryInputContent.data: %s", e)
                        continue

                    parts.append(
                        types.Part(
                            inline_data=types.Blob(
                                mime_type=mime_type,
                                data=decoded,
                            )
                        )
                    )
                    continue

                logger.debug("Ignoring unknown multimodal content dict item: %s", item_type)
                continue

            if isinstance(item, TextInputContent):
                if item.text:
                    parts.append(types.Part(text=item.text))
                continue

            if isinstance(item, BinaryInputContent):
                mime_type = getattr(item, "mime_type", None)
                data = getattr(item, "data", None)
                url = getattr(item, "url", None)
                binary_id = getattr(item, "id", None)

                # data-only policy
                if url or binary_id:
                    logger.warning(
                        "BinaryInputContent: only data is supported; ignoring url/id fields."
                    )

                if not data:
                    logger.warning(
                        "BinaryInputContent: data-only supported; ignoring item without data."
                    )
                    continue
                if not mime_type:
                    logger.warning("BinaryInputContent: missing mimeType; ignoring.")
                    continue

                try:
                    decoded = base64.b64decode(data, validate=False)
                    parts.append(
                        types.Part(
                            inline_data=types.Blob(
                                mime_type=mime_type,
                                data=decoded,
                            )
                        )
                    )
                except (binascii.Error, ValueError) as e:
                    logger.warning("Failed to base64 decode BinaryInputContent.data: %s", e)
                continue

            logger.debug("Ignoring unknown multimodal content item: %s", type(item).__name__)

        return parts

    return [types.Part(text=str(content))]


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
