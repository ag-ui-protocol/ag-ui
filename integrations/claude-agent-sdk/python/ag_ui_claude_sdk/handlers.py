"""
Event handlers for Claude SDK stream processing.

Breaks down stream processing into focused handler functions.
"""

import json
import logging
import uuid
from typing import AsyncIterator, Any, Dict, Optional

from ag_ui.core import (
    EventType,
    BaseEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    StateSnapshotEvent,
    CustomEvent,
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ThinkingStartEvent,
    ThinkingEndEvent,
)

from .config import STATE_MANAGEMENT_TOOL_NAME, STATE_MANAGEMENT_TOOL_FULL_NAME
from .utils import strip_mcp_prefix

logger = logging.getLogger(__name__)


async def handle_tool_use_block(
    block: Any,
    message: Any,
    thread_id: str,
    run_id: str,
    current_state: Optional[Any],
) -> tuple[Optional[Any], AsyncIterator[BaseEvent]]:
    """
    Handle ToolUseBlock from Claude SDK.
    
    Intercepts state management tool calls and emits STATE_SNAPSHOT.
    For regular tools, emits TOOL_CALL_START/ARGS events.
    
    Args:
        block: ToolUseBlock from Claude SDK
        message: Parent message containing the block
        thread_id: Thread identifier
        run_id: Run identifier
        current_state: Current state for state management tools
        
    Returns:
        Tuple of (updated_state, event_generator)
    """
    tool_name = getattr(block, 'name', '') or 'unknown'
    tool_input = getattr(block, 'input', {}) or {}
    tool_id = getattr(block, 'id', None) or str(uuid.uuid4())
    parent_tool_use_id = getattr(message, 'parent_tool_use_id', None)
    
    # Strip MCP prefix for client matching (same as streaming path)
    tool_display_name = strip_mcp_prefix(tool_name)
    if tool_display_name != tool_name:
        logger.debug(f"Stripped MCP prefix in handler: {tool_name} -> {tool_display_name}")
    
    logger.debug(f"ToolUseBlock detected: {tool_name}")
    
    async def event_gen():
        nonlocal current_state
        
        # Intercept state management tool calls (check both prefixed and unprefixed names)
        if tool_name in (STATE_MANAGEMENT_TOOL_NAME, STATE_MANAGEMENT_TOOL_FULL_NAME):
            logger.debug("Intercepting ag_ui_update_state tool call")
            
            # Extract state updates from tool input
            state_updates = tool_input.get("state_updates", {})
            
            # Parse if it's a JSON string
            if isinstance(state_updates, str):
                try:
                    state_updates = json.loads(state_updates)
                    logger.debug("Parsed state_updates from JSON string")
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse state_updates JSON: {e}")
                    state_updates = {}
            
            # Update current state
            if isinstance(current_state, dict) and isinstance(state_updates, dict):
                current_state = {**current_state, **state_updates}
            else:
                current_state = state_updates
            
            # Emit STATE_SNAPSHOT with updated state
            yield StateSnapshotEvent(
                type=EventType.STATE_SNAPSHOT,
                snapshot=current_state
            )
            
            logger.debug(f"Emitted STATE_SNAPSHOT with updated state")
            return  # Skip normal tool call events
        
        # Regular tool handling for non-state tools
        yield ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_id,
            tool_call_name=tool_display_name,  # Use unprefixed name
            parent_message_id=parent_tool_use_id,
        )
        
        if tool_input:
            args_json = json.dumps(tool_input)
            yield ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                thread_id=thread_id,
                run_id=run_id,
                tool_call_id=tool_id,
                delta=args_json,
            )
    
    return current_state, event_gen()


async def handle_tool_result_block(
    block: Any,
    thread_id: str,
    run_id: str,
    parent_tool_use_id: Optional[str] = None,
) -> AsyncIterator[BaseEvent]:
    """
    Handle ToolResultBlock from Claude SDK.
    
    Emits TOOL_CALL_END and TOOL_CALL_RESULT events.
    Nested tool results (with parent_tool_use_id) are also emitted - they represent
    sub-agent calls (e.g., Task calling WebSearch).
    
    Args:
        block: ToolResultBlock from Claude SDK
        thread_id: Thread identifier
        run_id: Run identifier
        parent_tool_use_id: Parent tool ID if this is a nested result
        
    Yields:
        AG-UI tool result events
    """
    tool_use_id = getattr(block, 'tool_use_id', None)
    content = getattr(block, 'content', None)
    is_error = getattr(block, 'is_error', None)
    
    # Parse tool result content for frontend rendering
    # Claude SDK tools return: [{"type": "text", "text": "{json_data}"}]
    # Frontend expects just the parsed json_data
    result_str = ""
    if content is not None:
        try:
            # If content is a list of content blocks (Claude SDK format)
            if isinstance(content, list) and len(content) > 0:
                first_block = content[0]
                if isinstance(first_block, dict) and first_block.get("type") == "text":
                    # Extract the text content
                    text_content = first_block.get("text", "")
                    # Try to parse as JSON (tools often return JSON strings)
                    try:
                        parsed_json = json.loads(text_content)
                        # Use the parsed JSON directly so frontend can access fields
                        result_str = json.dumps(parsed_json)
                    except (json.JSONDecodeError, ValueError):
                        # Not JSON, use as-is
                        result_str = text_content
                else:
                    # Fallback: stringify the whole content
                    result_str = json.dumps(content)
            else:
                # Fallback: stringify as-is
                result_str = json.dumps(content)
        except (TypeError, ValueError):
            result_str = str(content)
    
    if tool_use_id:
        # Emit ToolCallEnd to signal completion
        yield ToolCallEndEvent(
            type=EventType.TOOL_CALL_END,
            thread_id=thread_id,
            run_id=run_id,
            tool_call_id=tool_use_id,
        )
        
        # Emit ToolCallResult with the actual result content
        result_message_id = f"{tool_use_id}-result"
        yield ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            thread_id=thread_id,
            run_id=run_id,
            message_id=result_message_id,
            tool_call_id=tool_use_id,
            content=result_str,
            role="tool",
        )


async def handle_thinking_block(
    block: Any,
    thread_id: str,
    run_id: str,
) -> AsyncIterator[BaseEvent]:
    """
    Handle ThinkingBlock from Claude SDK.
    
    Emits THINKING_TEXT_MESSAGE events and optional signature custom event.
    
    Args:
        block: ThinkingBlock from Claude SDK
        thread_id: Thread identifier
        run_id: Run identifier
        
    Yields:
        AG-UI thinking events
    """
    thinking_text = getattr(block, 'thinking', '')
    signature = getattr(block, 'signature', '')
    
    # Emit proper ThinkingTextMessage events for thinking blocks
    if thinking_text:
        # Emit THINKING_START/END wrappers (like LangGraph pattern)
        yield ThinkingStartEvent(
            type=EventType.THINKING_START,
        )
        yield ThinkingTextMessageStartEvent(
            type=EventType.THINKING_TEXT_MESSAGE_START,
        )
        yield ThinkingTextMessageContentEvent(
            type=EventType.THINKING_TEXT_MESSAGE_CONTENT,
            delta=thinking_text,
        )
        yield ThinkingTextMessageEndEvent(
            type=EventType.THINKING_TEXT_MESSAGE_END,
        )
        yield ThinkingEndEvent(
            type=EventType.THINKING_END,
        )
    
    # Also emit signature as custom event if present
    if signature:
        yield CustomEvent(
            type=EventType.CUSTOM,
            thread_id=thread_id,
            run_id=run_id,
            name="thinking_signature",
            value={"signature": signature},
        )


def emit_system_message_events(
    thread_id: str, 
    run_id: str, 
    message: str
) -> list[BaseEvent]:
    """
    Create system message events.
    
    Args:
        thread_id: Thread identifier
        run_id: Run identifier
        message: System message text
        
    Returns:
        List of events to yield
    """
    msg_id = str(uuid.uuid4())
    return [
        TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            thread_id=thread_id,
            run_id=run_id,
            message_id=msg_id,
            role="system",
        ),
        TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            thread_id=thread_id,
            run_id=run_id,
            message_id=msg_id,
            delta=message,
        ),
        TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            thread_id=thread_id,
            run_id=run_id,
            message_id=msg_id,
        ),
    ]
