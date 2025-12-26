"""Event translator for converting Claude SDK responses to AG-UI protocol events."""

import json
import uuid
from typing import AsyncGenerator, Optional, Dict, Any, List
import logging

try:
    from ag_ui.core import (
        BaseEvent, EventType,
        TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
        ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
        ToolCallResultEvent, StateSnapshotEvent, StateDeltaEvent,
        CustomEvent
    )
except ImportError:
    pass

# Claude SDK imports
try:
    from claude_agent_sdk import (
        Message,
        AssistantMessage,
        UserMessage,
        SystemMessage,
        ResultMessage,
        TextBlock,
        ToolUseBlock,
        ToolResultBlock,
        ThinkingBlock,
    )
except ImportError:
    # Type checking fallback
    Message = None
    AssistantMessage = None
    TextBlock = None
    ToolUseBlock = None
    ToolResultBlock = None
    ThinkingBlock = None

logger = logging.getLogger(__name__)


class EventTranslator:
    """Translates Claude SDK responses to AG-UI protocol events.
    
    This class handles the conversion between Claude SDK responses and AG-UI events,
    managing streaming sequences and maintaining event consistency.
    
    Note: This implementation is based on common Anthropic SDK patterns.
    Actual API may vary - adjust based on Claude Agent SDK documentation.
    """
    
    def __init__(self):
        """Initialize the event translator."""
        # Track tool call IDs for consistency
        self._active_tool_calls: Dict[str, str] = {}
        # Track streaming message state
        self._streaming_message_id: Optional[str] = None
        self._is_streaming: bool = False
        self._current_stream_text: str = ""
        self._last_streamed_text: Optional[str] = None
        self._last_streamed_run_id: Optional[str] = None
        self.long_running_tool_ids: List[str] = []
    
    async def translate_claude_message(
        self,
        claude_message: Message,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate a Claude SDK Message to AG-UI protocol events.
        
        Args:
            claude_message: The Claude SDK Message object
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Yields:
            One or more AG-UI protocol events
        """
        try:
            # Handle different message types
            # Use hasattr to check for content attribute (AssistantMessage) or subtype (ResultMessage)
            # This works with both real types and Mock objects
            if hasattr(claude_message, 'content') and claude_message.content is not None:
                # Treat as AssistantMessage
                async for event in self._translate_assistant_message(
                    claude_message, thread_id, run_id
                ):
                    yield event
            elif hasattr(claude_message, 'subtype') or (AssistantMessage is not None and isinstance(claude_message, ResultMessage)):
                # ResultMessage indicates completion or error
                # Close any active streaming message
                async for event in self.force_close_streaming_message():
                    yield event
                
                # Check subtype for success/error
                subtype = getattr(claude_message, 'subtype', None)
                if subtype == 'error':
                    # Handle error - should already be handled by agent
                    logger.warning(f"Received error result: {claude_message}")
            # UserMessage, SystemMessage are typically input, not output
            # They don't need translation to AG-UI events
            
        except Exception as e:
            logger.error(f"Error translating Claude message: {e}", exc_info=True)
    
    async def _translate_assistant_message(
        self,
        message: AssistantMessage,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate AssistantMessage content blocks to AG-UI events."""
        if not hasattr(message, 'content') or not message.content:
            return
        
        # Process each content block
        # Use hasattr checks to support both real types and Mock objects
        for block in message.content:
            if hasattr(block, 'text'):
                # TextBlock has 'text' attribute
                async for event in self._translate_text_block(block, thread_id, run_id):
                    yield event
            elif hasattr(block, 'id') and hasattr(block, 'name') and hasattr(block, 'input'):
                # ToolUseBlock has 'id', 'name', and 'input' attributes
                async for event in self._translate_tool_use_block(block):
                    yield event
            elif hasattr(block, 'tool_use_id') or (hasattr(block, 'id') and hasattr(block, 'content') and not hasattr(block, 'text')):
                # ToolResultBlock has 'tool_use_id' or 'id' with 'content' but no 'text'
                async for event in self._translate_tool_result_block(block):
                    yield event
            elif isinstance(block, ThinkingBlock) if ThinkingBlock else False:
                # Thinking blocks can be translated to thinking events if needed
                # For now, we'll skip them or convert to text
                logger.debug(f"Received ThinkingBlock: {block}")
    
    async def _translate_text_block(
        self,
        block: TextBlock,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate TextBlock to AG-UI text message events."""
        text = getattr(block, 'text', '') or ''
        if not text:
            return
        
        # Check if this is a complete message or streaming chunk
        # Claude SDK streams TextBlocks, so we treat each as a content chunk
        if not self._is_streaming:
            # Start new message
            self._streaming_message_id = str(uuid.uuid4())
            self._is_streaming = True
            self._current_stream_text = ""
            
            yield TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=self._streaming_message_id,
                role="assistant"
            )
        
        # Add text content
        self._current_stream_text += text
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=self._streaming_message_id,
            delta=text
        )
    
    async def _translate_tool_use_block(
        self,
        block: ToolUseBlock
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate ToolUseBlock to AG-UI tool call events."""
        # Close any active text stream before tool calls
        async for event in self.force_close_streaming_message():
            yield event
        
        tool_call_id = getattr(block, 'id', None) or str(uuid.uuid4())
        tool_name = getattr(block, 'name', 'unknown')
        tool_input = getattr(block, 'input', {})
        
        # Check if this is a long-running tool
        # This depends on tool configuration - for now, assume client tools are LRO
        is_long_running = True  # TODO: Determine from tool configuration
        
        if is_long_running:
            self.long_running_tool_ids.append(tool_call_id)
        
        self._active_tool_calls[tool_call_id] = tool_call_id
        
        yield ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=tool_call_id,
            tool_call_name=tool_name,
            parent_message_id=None
        )
        
        if tool_input:
            args_str = json.dumps(tool_input) if isinstance(tool_input, dict) else str(tool_input)
            yield ToolCallArgsEvent(
                type=EventType.TOOL_CALL_ARGS,
                tool_call_id=tool_call_id,
                delta=args_str
            )
        
        yield ToolCallEndEvent(
            type=EventType.TOOL_CALL_END,
            tool_call_id=tool_call_id
        )
        
        self._active_tool_calls.pop(tool_call_id, None)
    
    async def _translate_tool_result_block(
        self,
        block: ToolResultBlock
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate ToolResultBlock to AG-UI tool result events."""
        tool_call_id = getattr(block, 'tool_use_id', None) or getattr(block, 'id', None)
        
        if not tool_call_id:
            logger.warning("ToolResultBlock missing tool_call_id")
            return
        
        # Skip long-running tools (handled by frontend)
        if tool_call_id in self.long_running_tool_ids:
            logger.debug(f"Skipping ToolCallResultEvent for long-running tool: {tool_call_id}")
            return
        
        # Extract content from tool result
        content = getattr(block, 'content', None)
        is_error = getattr(block, 'is_error', False)
        
        # Convert content to string
        if isinstance(content, list):
            # Content is list of content blocks
            content_str = json.dumps([self._extract_text_from_block(cb) for cb in content])
        elif isinstance(content, str):
            content_str = content
        else:
            content_str = json.dumps(content) if content else ""
        
        if is_error:
            # Mark as error in content
            content_str = json.dumps({"error": True, "content": content_str})
        
        yield ToolCallResultEvent(
            message_id=str(uuid.uuid4()),
            type=EventType.TOOL_CALL_RESULT,
            tool_call_id=tool_call_id,
            content=content_str
        )
    
    def _extract_text_from_block(self, block: Any) -> str:
        """Extract text from a content block."""
        if isinstance(block, dict):
            return block.get('text', '') or block.get('content', '')
        elif hasattr(block, 'text'):
            return block.text
        elif hasattr(block, 'content'):
            return block.content
        else:
            return str(block)
    
    
    def _create_state_delta_event(
        self,
        state_delta: Dict[str, Any],
        thread_id: str,
        run_id: str
    ) -> StateDeltaEvent:
        """Create a state delta event from state changes."""
        # Convert to JSON Patch format (RFC 6902)
        patches = []
        for key, value in state_delta.items():
            patches.append({
                "op": "add",
                "path": f"/{key}",
                "value": value
            })
        
        return StateDeltaEvent(
            type=EventType.STATE_DELTA,
            delta=patches
        )
    
    async def force_close_streaming_message(self) -> AsyncGenerator[BaseEvent, None]:
        """Force close any open streaming message."""
        if self._is_streaming and self._streaming_message_id:
            logger.warning(f"Force-closing unterminated streaming message: {self._streaming_message_id}")
            yield TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._streaming_message_id
            )
            self._reset_streaming_state()
    
    def _reset_streaming_state(self):
        """Reset streaming state."""
        if self._current_stream_text:
            self._last_streamed_text = self._current_stream_text
        self._current_stream_text = ""
        self._streaming_message_id = None
        self._is_streaming = False
    
    def reset(self):
        """Reset the translator state."""
        self._active_tool_calls.clear()
        self._reset_streaming_state()
        self._last_streamed_text = None
        self._last_streamed_run_id = None
        self.long_running_tool_ids.clear()
        logger.debug("Reset EventTranslator state")

