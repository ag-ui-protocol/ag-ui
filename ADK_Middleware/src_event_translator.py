# src/event_translator.py

"""Event translator for converting ADK events to AG-UI protocol events."""

from typing import AsyncGenerator, Optional, Dict, Any
import logging
import uuid

from ag_ui.core import (
    BaseEvent, EventType,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    TextMessageChunkEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    ToolCallChunkEvent,
    StateSnapshotEvent, StateDeltaEvent,
    MessagesSnapshotEvent,
    CustomEvent,
    Message, AssistantMessage, UserMessage, ToolMessage
)

from google.adk.events import Event as ADKEvent

logger = logging.getLogger(__name__)


class EventTranslator:
    """Translates Google ADK events to AG-UI protocol events.
    
    This class handles the conversion between the two event systems,
    managing streaming sequences and maintaining event consistency.
    """
    
    def __init__(self):
        """Initialize the event translator."""
        # Track message IDs for streaming sequences
        self._active_messages: Dict[str, str] = {}  # ADK event ID -> AG-UI message ID
        self._active_tool_calls: Dict[str, str] = {}  # Tool call ID -> Tool call ID (for consistency)
    
    async def translate(
        self, 
        adk_event: ADKEvent,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate an ADK event to AG-UI protocol events.
        
        Args:
            adk_event: The ADK event to translate
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Yields:
            One or more AG-UI protocol events
        """
        try:
            # Skip user events (already in the conversation)
            if adk_event.author == "user":
                return
            
            # Handle text content
            if adk_event.content and adk_event.content.parts:
                async for event in self._translate_text_content(
                    adk_event, thread_id, run_id
                ):
                    yield event
            
            # Handle function calls
            function_calls = adk_event.get_function_calls()
            if function_calls:
                async for event in self._translate_function_calls(
                    adk_event, function_calls, thread_id, run_id
                ):
                    yield event
            
            # Handle function responses
            function_responses = adk_event.get_function_responses()
            if function_responses:
                # Function responses are typically handled by the agent internally
                # We don't need to emit them as AG-UI events
                pass
            
            # Handle state changes
            if adk_event.actions and adk_event.actions.state_delta:
                yield self._create_state_delta_event(
                    adk_event.actions.state_delta, thread_id, run_id
                )
            
            # Handle custom events or metadata
            if hasattr(adk_event, 'custom_data') and adk_event.custom_data:
                yield CustomEvent(
                    type=EventType.CUSTOM,
                    name="adk_metadata",
                    value=adk_event.custom_data
                )
                
        except Exception as e:
            logger.error(f"Error translating ADK event: {e}", exc_info=True)
            # Don't yield error events here - let the caller handle errors
    
    async def _translate_text_content(
        self,
        adk_event: ADKEvent,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate text content from ADK event to AG-UI text message events.
        
        Args:
            adk_event: The ADK event containing text content
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Yields:
            Text message events (START, CONTENT, END)
        """
        # Extract text from all parts
        text_parts = []
        for part in adk_event.content.parts:
            if part.text:
                text_parts.append(part.text)
        
        if not text_parts:
            return
        
        # Determine if this is a streaming event or complete message
        is_streaming = adk_event.partial
        
        if is_streaming:
            # Handle streaming sequence
            if adk_event.id not in self._active_messages:
                # Start of a new message
                message_id = str(uuid.uuid4())
                self._active_messages[adk_event.id] = message_id
                
                yield TextMessageStartEvent(
                    type=EventType.TEXT_MESSAGE_START,
                    message_id=message_id,
                    role="assistant"
                )
            else:
                message_id = self._active_messages[adk_event.id]
            
            # Emit content
            for text in text_parts:
                if text:  # Don't emit empty content
                    yield TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=message_id,
                        delta=text
                    )
            
            # Check if this is the final chunk
            if not adk_event.partial or adk_event.is_final_response():
                yield TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END,
                    message_id=message_id
                )
                # Clean up tracking
                self._active_messages.pop(adk_event.id, None)
        else:
            # Complete message - emit as a single chunk event
            message_id = str(uuid.uuid4())
            combined_text = "\n".join(text_parts)
            
            yield TextMessageChunkEvent(
                type=EventType.TEXT_MESSAGE_CHUNK,
                message_id=message_id,
                role="assistant",
                delta=combined_text
            )
    
    async def _translate_function_calls(
        self,
        adk_event: ADKEvent,
        function_calls: list,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate function calls from ADK event to AG-UI tool call events.
        
        Args:
            adk_event: The ADK event containing function calls
            function_calls: List of function calls from the event
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Yields:
            Tool call events (START, ARGS, END)
        """
        parent_message_id = self._active_messages.get(adk_event.id)
        
        for func_call in function_calls:
            tool_call_id = getattr(func_call, 'id', str(uuid.uuid4()))
            
            # Track the tool call
            self._active_tool_calls[tool_call_id] = tool_call_id
            
            # Emit TOOL_CALL_START
            yield ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=func_call.name,
                parent_message_id=parent_message_id
            )
            
            # Emit TOOL_CALL_ARGS if we have arguments
            if hasattr(func_call, 'args') and func_call.args:
                # Convert args to string (JSON format)
                import json
                args_str = json.dumps(func_call.args) if isinstance(func_call.args, dict) else str(func_call.args)
                
                yield ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=tool_call_id,
                    delta=args_str
                )
            
            # Emit TOOL_CALL_END
            yield ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            )
            
            # Clean up tracking
            self._active_tool_calls.pop(tool_call_id, None)
    
    def _create_state_delta_event(
        self,
        state_delta: Dict[str, Any],
        thread_id: str,
        run_id: str
    ) -> StateDeltaEvent:
        """Create a state delta event from ADK state changes.
        
        Args:
            state_delta: The state changes from ADK
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID
            
        Returns:
            A StateDeltaEvent
        """
        # Convert to JSON Patch format (RFC 6902)
        # For now, we'll use a simple "replace" operation for each key
        patches = []
        for key, value in state_delta.items():
            patches.append({
                "op": "replace",
                "path": f"/{key}",
                "value": value
            })
        
        return StateDeltaEvent(
            type=EventType.STATE_DELTA,
            delta=patches
        )
    
    def reset(self):
        """Reset the translator state.
        
        This should be called between different conversation runs
        to ensure clean state.
        """
        self._active_messages.clear()
        self._active_tool_calls.clear()
        logger.debug("Reset EventTranslator state")