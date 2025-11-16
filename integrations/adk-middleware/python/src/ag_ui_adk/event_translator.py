# src/event_translator.py

"""Event translator for converting ADK events to AG-UI protocol events."""

import dataclasses
from collections.abc import Iterable, Mapping
from typing import AsyncGenerator, Optional, Dict, Any , List
import uuid

from google.genai import types

from ag_ui.core import (
    BaseEvent, EventType,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    ToolCallResultEvent, StateSnapshotEvent, StateDeltaEvent,
    CustomEvent
)
import json
from google.adk.events import Event as ADKEvent

import logging
logger = logging.getLogger(__name__)

def _coerce_tool_response(value: Any, _visited: Optional[set[int]] = None) -> Any:
    """Recursively convert arbitrary tool responses into JSON-serializable structures."""

    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    if isinstance(value, (bytes, bytearray, memoryview)):
        try:
            return value.decode()  # type: ignore[union-attr]
        except Exception:
            return list(value)

    if _visited is None:
        _visited = set()

    obj_id = id(value)
    if obj_id in _visited:
        return str(value)

    _visited.add(obj_id)
    try:
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            return {
                field.name: _coerce_tool_response(getattr(value, field.name), _visited)
                for field in dataclasses.fields(value)
            }

        if hasattr(value, "_asdict") and callable(getattr(value, "_asdict")):
            try:
                return {
                    str(k): _coerce_tool_response(v, _visited)
                    for k, v in value._asdict().items()  # type: ignore[attr-defined]
                }
            except Exception:
                pass

        for method_name in ("model_dump", "to_dict"):
            method = getattr(value, method_name, None)
            if callable(method):
                try:
                    dumped = method()
                except TypeError:
                    try:
                        dumped = method(exclude_none=False)
                    except Exception:
                        continue
                except Exception:
                    continue

                return _coerce_tool_response(dumped, _visited)

        if isinstance(value, Mapping):
            return {
                str(k): _coerce_tool_response(v, _visited)
                for k, v in value.items()
            }

        if isinstance(value, (list, tuple, set, frozenset)):
            return [_coerce_tool_response(item, _visited) for item in value]

        if isinstance(value, Iterable):
            try:
                return [_coerce_tool_response(item, _visited) for item in list(value)]
            except TypeError:
                pass

        try:
            obj_vars = vars(value)
        except TypeError:
            obj_vars = None

        if obj_vars:
            coerced = {
                key: _coerce_tool_response(val, _visited)
                for key, val in obj_vars.items()
                if not key.startswith("_")
            }
            if coerced:
                return coerced

        return str(value)
    finally:
        _visited.discard(obj_id)

def _serialize_tool_response(response: Any) -> str:
    """Serialize a tool response into a JSON string."""

    try:
        coerced = _coerce_tool_response(response)
        return json.dumps(coerced, ensure_ascii=False)
    except Exception as exc:
        logger.warning("Failed to coerce tool response to JSON: %s", exc, exc_info=True)
        try:
            return json.dumps(str(response), ensure_ascii=False)
        except Exception:
            logger.warning("Failed to stringify tool response; returning empty string.")
            return json.dumps("", ensure_ascii=False)

class EventTranslator:
    """Translates Google ADK events to AG-UI protocol events.
    
    This class handles the conversion between the two event systems,
    managing streaming sequences and maintaining event consistency.
    """
    
    def __init__(self):
        """Initialize the event translator."""
        # Track tool call IDs for consistency 
        self._active_tool_calls: Dict[str, str] = {}  # Tool call ID -> Tool call ID (for consistency)
        # Track streaming message state
        self._streaming_message_id: Optional[str] = None  # Current streaming message ID
        self._is_streaming: bool = False  # Whether we're currently streaming a message
        self._current_stream_text: str = ""  # Accumulates text for the active stream
        self._last_streamed_text: Optional[str] = None  # Snapshot of most recently streamed text
        self._last_streamed_run_id: Optional[str] = None  # Run identifier for the last streamed text
        self.long_running_tool_ids: List[str] = []  # Track the long running tool IDs
    
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
            # Check ADK streaming state using proper methods
            is_partial = getattr(adk_event, 'partial', False)
            turn_complete = getattr(adk_event, 'turn_complete', False)
            
            # Check if this is the final response (contains complete message - skip to avoid duplication)
            is_final_response = False
            if hasattr(adk_event, 'is_final_response') and callable(adk_event.is_final_response):
                is_final_response = adk_event.is_final_response()
            elif hasattr(adk_event, 'is_final_response'):
                is_final_response = adk_event.is_final_response
            
            # Determine action based on ADK streaming pattern
            should_send_end = turn_complete and not is_partial

            # Skip user events (already in the conversation)
            if hasattr(adk_event, 'author') and adk_event.author == "user":
                logger.debug("Skipping user event")
                return
            
            # Handle text content
            # --- THIS IS THE RESTORED LINE ---
            if adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts:
                async for event in self._translate_text_content(
                    adk_event, thread_id, run_id
                ):
                    yield event
            
            # call _translate_function_calls function to yield Tool Events
            if hasattr(adk_event, 'get_function_calls'):               
                function_calls = adk_event.get_function_calls()
                if function_calls:
                    # Filter out long-running tool calls; those are handled by translate_lro_function_calls
                    try:
                        lro_ids = set(getattr(adk_event, 'long_running_tool_ids', []) or [])
                    except Exception:
                        lro_ids = set()

                    non_lro_calls = [fc for fc in function_calls if getattr(fc, 'id', None) not in lro_ids]

                    if non_lro_calls:
                        logger.debug(f"ADK function calls detected (non-LRO): {len(non_lro_calls)} of {len(function_calls)} total")
                        # CRITICAL FIX: End any active text message stream before starting tool calls
                        # Per AG-UI protocol: TEXT_MESSAGE_END must be sent before TOOL_CALL_START
                        async for event in self.force_close_streaming_message():
                            yield event
                        
                        # Yield only non-LRO function call events
                        async for event in self._translate_function_calls(non_lro_calls):
                            yield event
                        
            # Handle function responses and yield the tool response event
            # this is essential for scenerios when user has to render function response at frontend
            if hasattr(adk_event, 'get_function_responses'):
                function_responses = adk_event.get_function_responses()
                if function_responses:
                    # Function responses should be emmitted to frontend so it can render the response as well
                    async for event in self._translate_function_response(function_responses):
                        yield event
                    
            
            # Handle state changes
            if hasattr(adk_event, 'actions') and adk_event.actions:
                if hasattr(adk_event.actions, 'state_delta') and adk_event.actions.state_delta:
                    yield self._create_state_delta_event(
                        adk_event.actions.state_delta, thread_id, run_id
                    )

                if hasattr(adk_event.actions, 'state_snapshot'):
                    state_snapshot = adk_event.actions.state_snapshot
                    if state_snapshot is not None:
                        yield self._create_state_snapshot_event(state_snapshot)
                
            
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
        
        # Check for is_final_response *before* checking for text.
        # An empty final response is a valid stream-closing signal.
        is_final_response = False
        if hasattr(adk_event, 'is_final_response') and callable(adk_event.is_final_response):
            is_final_response = adk_event.is_final_response()
        elif hasattr(adk_event, 'is_final_response'):
            is_final_response = adk_event.is_final_response
        
        # Extract text from all parts
        text_parts = []
        # The check for adk_event.content.parts happens in the main translate method
        for part in adk_event.content.parts:
            if part.text: # Note: part.text == "" is False
                text_parts.append(part.text)
        
        # If no text AND it's not a final response, we can safely skip.
        # Otherwise, we must continue to process the final_response signal.
        if not text_parts and not is_final_response:
            return

        combined_text = "".join(text_parts)

        # Use proper ADK streaming detection (handle None values)
        is_partial = getattr(adk_event, 'partial', False)
        turn_complete = getattr(adk_event, 'turn_complete', False)
        
        # (is_final_response is already calculated above)
        
        # Handle None values: if a turn is complete or a final chunk arrives, end streaming
        has_finish_reason = bool(getattr(adk_event, 'finish_reason', None))
        should_send_end = (
            (turn_complete and not is_partial)
            or (is_final_response and not is_partial)
            or (has_finish_reason and self._is_streaming)
        )

        if is_final_response:
            # This is the final, complete message event.

            # Case 1: A stream is actively running. We must close it.
            if self._is_streaming and self._streaming_message_id:
                logger.info("⏭️ Final response event received. Closing active stream.")
                
                if self._current_stream_text:
                    # Save the complete streamed text for de-duplication
                    self._last_streamed_text = self._current_stream_text
                    self._last_streamed_run_id = run_id
                self._current_stream_text = ""

                end_event = TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END,
                    message_id=self._streaming_message_id
                )
                yield end_event

                self._streaming_message_id = None
                self._is_streaming = False
                logger.info("🏁 Streaming completed via final response")
                return # We are done.

            # Case 2: No stream is active. 
            # This event contains the *entire* message.
            # We must send it, *unless* it's a duplicate of a stream that *just* finished.
            
            # Check for duplicates from a *previous* stream in this *same run*.
            is_duplicate = (
                self._last_streamed_run_id == run_id and
                self._last_streamed_text is not None and
                combined_text == self._last_streamed_text
            )

            if is_duplicate:
                logger.info(
                    "⏭️ Skipping final response event (duplicate content detected from finished stream)"
                )
            else:
                # Not a duplicate, or no previous stream. Send the full message.
                logger.info(
                    f"⏩ Delivering complete non-streamed message or final content event_id={adk_event.id}"
                )
                message_events = [
                    TextMessageStartEvent(
                        type=EventType.TEXT_MESSAGE_START,
                        message_id=adk_event.id, # Use event ID for non-streamed
                        role="assistant",
                    ),
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=adk_event.id,
                        delta=combined_text,
                    ),
                    TextMessageEndEvent(
                        type=EventType.TEXT_MESSAGE_END,
                        message_id=adk_event.id,
                    ),
                ]
                for msg in message_events:
                    yield msg

            # Clean up state regardless, as this is the end of the line for text.
            self._current_stream_text = ""
            self._last_streamed_text = None
            self._last_streamed_run_id = None
            return

        
        # Handle streaming logic (if not is_final_response)
        if not self._is_streaming:
            # Start of new message - emit START event
            self._streaming_message_id = str(uuid.uuid4())
            self._is_streaming = True
            self._current_stream_text = ""

            start_event = TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=self._streaming_message_id,
                role="assistant"
            )
            yield start_event
        
        # Always emit content (unless empty)
        if combined_text:
            self._current_stream_text += combined_text
            content_event = TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=self._streaming_message_id,
                delta=combined_text
            )
            yield content_event
        
        # If turn is complete and not partial, emit END event
        if should_send_end:
            end_event = TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._streaming_message_id
            )
            yield end_event

            # Reset streaming state
            if self._current_stream_text:
                self._last_streamed_text = self._current_stream_text
                self._last_streamed_run_id = run_id
            self._current_stream_text = ""
            self._streaming_message_id = None
            self._is_streaming = False
            logger.info("🏁 Streaming completed, state reset")
    
    async def translate_lro_function_calls(self,adk_event: ADKEvent)-> AsyncGenerator[BaseEvent, None]:
        """Translate long running function calls from ADK event to AG-UI tool call events.

        Args:
            adk_event: The ADK event containing function calls

        Yields:
            Tool call events (START, ARGS, END)
        """

        long_running_function_call = None
        if adk_event.content and adk_event.content.parts:
            for i, part in enumerate(adk_event.content.parts):
                if part.function_call:
                    if not long_running_function_call and part.function_call.id in (
                        adk_event.long_running_tool_ids or []
                    ):
                        long_running_function_call = part.function_call
                        self.long_running_tool_ids.append(long_running_function_call.id)
                        yield ToolCallStartEvent(
                            type=EventType.TOOL_CALL_START,
                            tool_call_id=long_running_function_call.id,
                            tool_call_name=long_running_function_call.name,
                            parent_message_id=None
                        )
                        if hasattr(long_running_function_call, 'args') and long_running_function_call.args:
                            # Convert args to string (JSON format)
                            import json
                            args_str = json.dumps(long_running_function_call.args) if isinstance(long_running_function_call.args, dict) else str(long_running_function_call.args)
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=long_running_function_call.id,
                                delta=args_str
                            )
                        
                        # Emit TOOL_CALL_END
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=long_running_function_call.id
                        )

                        # Clean up tracking
                        self._active_tool_calls.pop(long_running_function_call.id, None)
    
    async def _translate_function_calls(
        self,
        function_calls: list[types.FunctionCall],
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
        # Since we're not tracking streaming messages, use None for parent message
        parent_message_id = None

        for func_call in function_calls:
            tool_call_id = getattr(func_call, 'id', str(uuid.uuid4()))

            # Check if this tool call ID already exists
            if tool_call_id in self._active_tool_calls:
                logger.warning(f"⚠️  DUPLICATE TOOL CALL! Tool call ID {tool_call_id} (name: {func_call.name}) already exists in active calls!")

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

    

    async def _translate_function_response(
        self,
        function_response: list[types.FunctionResponse],
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate function calls from ADK event to AG-UI tool call events.
        
        Args:
            adk_event: The ADK event containing function calls
            function_response: List of function response from the event
            
        Yields:
            Tool result events (only for tool_call_ids not in long_running_tool_ids)
        """
        
        for func_response in function_response:
            
            tool_call_id = getattr(func_response, 'id', str(uuid.uuid4()))
            # Only emit ToolCallResultEvent for tool_call_ids which are not long_running_tool
            # this is because long running tools are handle by the frontend
            if tool_call_id not in self.long_running_tool_ids:
                yield ToolCallResultEvent(
                    message_id=str(uuid.uuid4()),
                    type=EventType.TOOL_CALL_RESULT,
                    tool_call_id=tool_call_id,
                    content=_serialize_tool_response(func_response.response)
                )
            else:
                logger.debug(f"Skipping ToolCallResultEvent for long-running tool: {tool_call_id}")
  
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
        # Use "add" operation which works for both new and existing paths
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
    
    def _create_state_snapshot_event(
        self,
        state_snapshot: Dict[str, Any],
    ) -> StateSnapshotEvent:
        """Create a state snapshot event from ADK state changes.
        
        Args:
            state_snapshot: The state changes from ADK
            
        Returns:
            A StateSnapshotEvent
        """
 
        return StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot=state_snapshot
        )
    
    async def force_close_streaming_message(self) -> AsyncGenerator[BaseEvent, None]:
        """Force close any open streaming message.
        
        This should be called before ending a run to ensure proper message termination.
        
        Yields:
            TEXT_MESSAGE_END event if there was an open streaming message
        """
        if self._is_streaming and self._streaming_message_id:
            logger.warning(f"🚨 Force-closing unterminated streaming message: {self._streaming_message_id}")

            end_event = TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=self._streaming_message_id
            )
            yield end_event

            # Reset streaming state
            self._current_stream_text = ""
            self._streaming_message_id = None
            self._is_streaming = False
            logger.info("🔄 Streaming state reset after force-close")

    def reset(self):
        """Reset the translator state.
        
        This should be called between different conversation runs
        to ensure clean state.
        """
        self._active_tool_calls.clear()
        self._streaming_message_id = None
        self._is_streaming = False
        self._current_stream_text = ""
        self._last_streamed_text = None
        self._last_streamed_run_id = None
        self.long_running_tool_ids.clear()
        logger.debug("Reset EventTranslator state (including streaming state)")
        