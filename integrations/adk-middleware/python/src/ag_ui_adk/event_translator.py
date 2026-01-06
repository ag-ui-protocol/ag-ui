# src/event_translator.py

"""Event translator for converting ADK events to AG-UI protocol events."""

import dataclasses
from collections.abc import Iterable, Mapping
from typing import AsyncGenerator, Optional, Dict, Any, List
import uuid

from google.genai import types

from ag_ui.core import (
    BaseEvent, EventType,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent,
    ToolCallResultEvent, StateSnapshotEvent, StateDeltaEvent,
    CustomEvent, Message, UserMessage, AssistantMessage, ToolMessage,
    ToolCall, FunctionCall
)
import json
from google.adk.events import Event as ADKEvent

from .config import PredictStateMapping, normalize_predict_state

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

    def __init__(
        self,
        predict_state: Optional[Iterable[PredictStateMapping]] = None,
    ):
        """Initialize the event translator.

        Args:
            predict_state: Optional configuration for predictive state updates.
                When provided, the translator will emit PredictState CustomEvents
                for matching tool calls, enabling the UI to show state changes
                in real-time as tool arguments are streamed.
        """
        # Track tool call IDs for consistency
        self._active_tool_calls: Dict[str, str] = {}  # Tool call ID -> Tool call ID (for consistency)
        # Track streaming message state
        self._streaming_message_id: Optional[str] = None  # Current streaming message ID
        self._is_streaming: bool = False  # Whether we're currently streaming a message
        self._current_stream_text: str = ""  # Accumulates text for the active stream
        self._last_streamed_text: Optional[str] = None  # Snapshot of most recently streamed text
        self._last_streamed_run_id: Optional[str] = None  # Run identifier for the last streamed text
        self.long_running_tool_ids: List[str] = []  # Track the long running tool IDs

        # Predictive state configuration
        self._predict_state_mappings = normalize_predict_state(predict_state)
        self._predict_state_by_tool: Dict[str, List[PredictStateMapping]] = {}
        for mapping in self._predict_state_mappings:
            if mapping.tool not in self._predict_state_by_tool:
                self._predict_state_by_tool[mapping.tool] = []
            self._predict_state_by_tool[mapping.tool].append(mapping)
        self._emitted_predict_state_for_tools: set[str] = set()  # Track which tools have had PredictState emitted
        self._emitted_confirm_for_tools: set[str] = set()  # Track which tools have had confirm_changes emitted

        # Track tool call IDs that are associated with predictive state tools
        # We suppress TOOL_CALL_RESULT events for these since the frontend handles
        # state updates via the predictive state mechanism
        self._predictive_state_tool_call_ids: set[str] = set()

        # Deferred confirm_changes events - these must be emitted LAST, right before RUN_FINISHED
        # to ensure the frontend shows the confirmation dialog with buttons enabled
        self._deferred_confirm_events: List[BaseEvent] = []

    def get_and_clear_deferred_confirm_events(self) -> List[BaseEvent]:
        """Get and clear any deferred confirm_changes events.

        These events must be emitted right before RUN_FINISHED to ensure
        the frontend's confirmation dialog works correctly.

        Returns:
            List of deferred events (may be empty)
        """
        events = self._deferred_confirm_events
        self._deferred_confirm_events = []
        return events

    def has_deferred_confirm_events(self) -> bool:
        """Check if there are any deferred confirm_changes events.

        Returns:
            True if there are deferred events waiting to be emitted
        """
        return len(self._deferred_confirm_events) > 0

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

        # Handle is_final_response BEFORE the empty text early return.
        # An empty final response is a valid stream-closing signal that must close
        # any active stream, even if there's no new text content.
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
            # Check for duplicates from a *previous* stream in this *same run*.
            # We use two checks:
            # 1. Exact match - handles normal delta streaming where accumulated
            #    text equals the final consolidated message
            # 2. Suffix match - handles LLMs that send accumulated text in each
            #    chunk (not deltas), where _last_streamed_text will be concatenated
            #    chunks ending with the final text (GitHub #400)
            is_duplicate = False
            if self._last_streamed_run_id == run_id and self._last_streamed_text is not None:
                if combined_text == self._last_streamed_text:
                    is_duplicate = True
                elif self._last_streamed_text.endswith(combined_text):
                    is_duplicate = True

            if is_duplicate:
                logger.info(
                    "⏭️ Skipping final response event (duplicate content detected from finished stream)"
                )
                # Clean up state as this is still the terminal signal for text.
                self._current_stream_text = ""
                self._last_streamed_text = None
                self._last_streamed_run_id = None
                return

            if not combined_text:
                logger.info("⏭️ Final response contained no text; nothing to emit")
                self._current_stream_text = ""
                self._last_streamed_text = None
                self._last_streamed_run_id = None
                return

            # Fall through to the normal emission path to send the consolidated
            # START/CONTENT/END trio for non-streaming final responses.

        # Early return for empty text (non-final responses only).
        # Final responses with empty text are handled above to close active streams.
        if not combined_text:
            return

        # Use proper ADK streaming detection (handle None values)
        is_partial = getattr(adk_event, 'partial', False)
        turn_complete = getattr(adk_event, 'turn_complete', False)

        # Handle None values: if a turn is complete or a final chunk arrives, end streaming
        has_finish_reason = bool(getattr(adk_event, 'finish_reason', None))
        should_send_end = (
            (turn_complete and not is_partial)
            or (is_final_response and not is_partial)
            or (has_finish_reason and self._is_streaming)
        )

        # Track if we were already streaming before this event (for consolidated message detection)
        was_already_streaming = self._is_streaming

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

        # Emit content with consolidated message detection (GitHub #742)
        # When streaming, ADK sends incremental deltas with partial=True, then a final
        # consolidated message with partial=False containing all the text. If we were
        # already streaming and receive a consolidated message (partial=False), we skip
        # it to avoid duplicating already-streamed content.
        # Note: We check was_already_streaming (not _is_streaming) to allow the first
        # event of a non-streaming response (partial=False) to emit content normally.
        if combined_text:
            # Skip consolidated messages during active streaming
            if was_already_streaming and not is_partial:
                logger.info(
                    "⏭️ Skipping consolidated text (partial=False during active stream)"
                )
            else:
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
            Tool call events (START, ARGS, END) and optionally PredictState CustomEvent
        """
        # Since we're not tracking streaming messages, use None for parent message
        parent_message_id = None

        for func_call in function_calls:
            tool_call_id = getattr(func_call, 'id', str(uuid.uuid4()))
            tool_name = func_call.name

            # Check if this tool call ID already exists
            if tool_call_id in self._active_tool_calls:
                logger.warning(f"⚠️  DUPLICATE TOOL CALL! Tool call ID {tool_call_id} (name: {tool_name}) already exists in active calls!")

            # Track the tool call
            self._active_tool_calls[tool_call_id] = tool_call_id

            # Check if this tool has predictive state configuration
            # Emit PredictState CustomEvent BEFORE the tool call events
            if tool_name in self._predict_state_by_tool:
                # Track this tool call ID so we can suppress its TOOL_CALL_RESULT event
                # The frontend handles state updates via the predictive state mechanism
                self._predictive_state_tool_call_ids.add(tool_call_id)

                if tool_name not in self._emitted_predict_state_for_tools:
                    mappings = self._predict_state_by_tool[tool_name]
                    predict_state_payload = [mapping.to_payload() for mapping in mappings]
                    logger.debug(f"Emitting PredictState CustomEvent for tool '{tool_name}': {predict_state_payload}")
                    yield CustomEvent(
                        type=EventType.CUSTOM,
                        name="PredictState",
                        value=predict_state_payload,
                    )
                    self._emitted_predict_state_for_tools.add(tool_name)

            # Emit TOOL_CALL_START
            yield ToolCallStartEvent(
                type=EventType.TOOL_CALL_START,
                tool_call_id=tool_call_id,
                tool_call_name=tool_name,
                parent_message_id=parent_message_id
            )

            # Emit TOOL_CALL_ARGS if we have arguments
            if hasattr(func_call, 'args') and func_call.args:
                # Convert args to string (JSON format)
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

            # Check if we should emit confirm_changes tool call after this tool
            # This follows the pattern used by LangGraph, CrewAI, and server-starter-all-features
            # where the backend uses a "local" tool (e.g., write_document_local) and
            # then emits confirm_changes to trigger the frontend confirmation UI
            #
            # IMPORTANT: We DEFER these events to be emitted right before RUN_FINISHED.
            # If we emit them immediately, subsequent events (TOOL_CALL_RESULT, TEXT_MESSAGE, etc.)
            # can cause the frontend to transition the confirm_changes status away from "executing",
            # which disables the confirmation dialog buttons.
            if tool_name in self._predict_state_by_tool and tool_name not in self._emitted_confirm_for_tools:
                mappings = self._predict_state_by_tool[tool_name]
                # Check if any mapping has emit_confirm_tool=True
                should_emit_confirm = any(m.emit_confirm_tool for m in mappings)
                if should_emit_confirm:
                    confirm_tool_call_id = str(uuid.uuid4())
                    logger.debug(f"Deferring confirm_changes tool call events after '{tool_name}' (will emit before RUN_FINISHED)")

                    # Store events for later emission (right before RUN_FINISHED)
                    self._deferred_confirm_events.append(ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=confirm_tool_call_id,
                        tool_call_name="confirm_changes",
                        parent_message_id=parent_message_id
                    ))

                    self._deferred_confirm_events.append(ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=confirm_tool_call_id,
                        delta="{}"
                    ))

                    self._deferred_confirm_events.append(ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=confirm_tool_call_id
                    ))

                    self._emitted_confirm_for_tools.add(tool_name)

    

    async def _translate_function_response(
        self,
        function_response: list[types.FunctionResponse],
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate function calls from ADK event to AG-UI tool call events.

        Args:
            adk_event: The ADK event containing function calls
            function_response: List of function response from the event

        Yields:
            Tool result events (only for tool_call_ids not in long_running_tool_ids
            and not associated with predictive state tools)
        """

        for func_response in function_response:

            tool_call_id = getattr(func_response, 'id', str(uuid.uuid4()))
            # Skip TOOL_CALL_RESULT for long-running tools (handled by frontend)
            if tool_call_id in self.long_running_tool_ids:
                logger.debug(f"Skipping ToolCallResultEvent for long-running tool: {tool_call_id}")
                continue

            # Skip TOOL_CALL_RESULT for predictive state tools
            # The frontend handles state updates via the predictive state mechanism,
            # and emitting a result event causes "No function call event found" errors
            if tool_call_id in self._predictive_state_tool_call_ids:
                logger.debug(f"Skipping ToolCallResultEvent for predictive state tool: {tool_call_id}")
                continue

            yield ToolCallResultEvent(
                message_id=str(uuid.uuid4()),
                type=EventType.TOOL_CALL_RESULT,
                tool_call_id=tool_call_id,
                content=_serialize_tool_response(func_response.response)
            )
  
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
        self._emitted_predict_state_for_tools.clear()
        self._emitted_confirm_for_tools.clear()
        self._predictive_state_tool_call_ids.clear()
        self._deferred_confirm_events.clear()
        logger.debug("Reset EventTranslator state (including streaming state)")


def _translate_function_calls_to_tool_calls(function_calls: List[Any]) -> List[ToolCall]:
    """Convert ADK function calls to AG-UI ToolCall format.

    Args:
        function_calls: List of ADK function call objects

    Returns:
        List of AG-UI ToolCall objects
    """
    tool_calls = []
    for fc in function_calls:
        tool_call = ToolCall(
            id=fc.id if hasattr(fc, 'id') and fc.id else str(uuid.uuid4()),
            type="function",
            function=FunctionCall(
                name=fc.name,
                arguments=json.dumps(fc.args) if hasattr(fc, 'args') and fc.args else "{}"
            )
        )
        tool_calls.append(tool_call)
    return tool_calls


def adk_events_to_messages(events: List[ADKEvent]) -> List[Message]:
    """Convert ADK session events to AG-UI Message list.

    This function extracts complete messages from ADK events, filtering out
    partial/streaming events and converting to the appropriate AG-UI message types.

    Args:
        events: List of ADK events from a session (session.events)

    Returns:
        List of AG-UI Message objects representing the conversation history
    """
    messages: List[Message] = []

    for event in events:
        # Skip events without content
        if not hasattr(event, 'content') or event.content is None:
            continue

        # Skip partial/streaming events - we only want complete messages
        if hasattr(event, 'partial') and event.partial:
            continue

        content = event.content

        # Skip events without parts
        if not hasattr(content, 'parts') or not content.parts:
            continue

        # Extract text content from parts
        text_content = ""
        for part in content.parts:
            if hasattr(part, 'text') and part.text:
                text_content += part.text

        # Get function calls and responses
        function_calls = event.get_function_calls() if hasattr(event, 'get_function_calls') else []
        function_responses = event.get_function_responses() if hasattr(event, 'get_function_responses') else []

        # Determine the author/role
        author = getattr(event, 'author', None)
        event_id = getattr(event, 'id', None) or str(uuid.uuid4())

        # Handle function responses as ToolMessages
        if function_responses:
            for fr in function_responses:
                tool_message = ToolMessage(
                    id=str(uuid.uuid4()),
                    role="tool",
                    content=_serialize_tool_response(fr.response) if hasattr(fr, 'response') else "",
                    tool_call_id=fr.id if hasattr(fr, 'id') and fr.id else str(uuid.uuid4())
                )
                messages.append(tool_message)
            continue

        # Skip events with no meaningful content
        if not text_content and not function_calls:
            continue

        # Handle user messages
        if author == "user":
            user_message = UserMessage(
                id=event_id,
                role="user",
                content=text_content
            )
            messages.append(user_message)

        # Handle assistant/model messages
        elif author == "model" or author is None:
            # Convert function calls to tool calls if present
            tool_calls = _translate_function_calls_to_tool_calls(function_calls) if function_calls else None

            assistant_message = AssistantMessage(
                id=event_id,
                role="assistant",
                content=text_content if text_content else None,
                tool_calls=tool_calls
            )
            messages.append(assistant_message)

    return messages
        