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
    ToolCall, FunctionCall,
    ThinkingStartEvent, ThinkingEndEvent,
    ThinkingTextMessageStartEvent, ThinkingTextMessageContentEvent, ThinkingTextMessageEndEvent,
)
import json
from google.adk.events import Event as ADKEvent

from .config import PredictStateMapping, normalize_predict_state

import logging
logger = logging.getLogger(__name__)

# Backwards-compatible thought support detection
# The part.thought attribute may not exist in older versions of google-genai
_THOUGHT_SUPPORT_CHECKED = False
_HAS_THOUGHT_SUPPORT = False

def _check_thought_support() -> bool:
    """Check if the google-genai SDK supports the part.thought attribute.

    Returns:
        True if thought support is available, False otherwise.
    """
    global _THOUGHT_SUPPORT_CHECKED, _HAS_THOUGHT_SUPPORT
    if not _THOUGHT_SUPPORT_CHECKED:
        try:
            # Check if Part class has 'thought' in its model fields (Pydantic)
            # or as a regular attribute
            if hasattr(types.Part, 'model_fields'):
                _HAS_THOUGHT_SUPPORT = 'thought' in types.Part.model_fields
            else:
                # Fallback: check if thought is a known attribute
                _HAS_THOUGHT_SUPPORT = hasattr(types.Part, 'thought')

            if _HAS_THOUGHT_SUPPORT:
                logger.info("Thought support detected in google-genai SDK; thoughts will be emitted as THINKING events")
            else:
                logger.info("Thought support not available in google-genai SDK; thoughts will be treated as regular text")
        except Exception as e:
            logger.warning(f"Error checking thought support: {e}; assuming no support")
            _HAS_THOUGHT_SUPPORT = False
        _THOUGHT_SUPPORT_CHECKED = True
    return _HAS_THOUGHT_SUPPORT

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
        streaming_function_call_arguments: bool = False,
        client_emitted_tool_call_ids: Optional[set] = None,
        client_tool_names: Optional[set] = None,
        client_tool_schemas: Optional[Dict[str, set]] = None,
    ):
        """Initialize the event translator.

        Args:
            predict_state: Optional configuration for predictive state updates.
                When provided, the translator will emit PredictState CustomEvents
                for matching tool calls, enabling the UI to show state changes
                in real-time as tool arguments are streamed.
            streaming_function_call_arguments: When True, enables Mode A streaming
                where partial events with ``will_continue=True`` but no accumulated
                args are treated as the first chunk of a streaming function call
                (Gemini 3+ with ``stream_function_call_arguments=True``).
                When False (default), such events are skipped.
            client_emitted_tool_call_ids: Optional shared set of tool call IDs that
                ClientProxyTool has already emitted TOOL_CALL events for. When provided,
                the translator will skip emitting duplicate events for these IDs.
            client_tool_names: Optional set of tool names that are handled by
                ClientProxyTool. When provided, the translator will skip emitting
                TOOL_CALL events for these tool names, since the proxy tool will
                emit its own events during execution. This prevents duplicate
                emissions when ADK assigns different IDs across LRO and confirmed events.
            client_tool_schemas: Optional mapping of tool name → set of argument
                names.  Used to disambiguate which client tool is being called
                when streaming FC chunks arrive without a tool name.
        """
        self._streaming_fc_args_enabled = streaming_function_call_arguments
        # Shared set of tool call IDs already emitted by ClientProxyTool
        self._client_emitted_tool_call_ids = client_emitted_tool_call_ids if client_emitted_tool_call_ids is not None else set()
        # Set of tool names handled by ClientProxyTool — translator skips these entirely
        self._client_tool_names = client_tool_names if client_tool_names is not None else set()
        # Mapping tool_name → set of argument names for json_path disambiguation
        self._client_tool_schemas = client_tool_schemas if client_tool_schemas is not None else {}
        # Set of tool call IDs that this translator has already emitted events for.
        # Shared with ClientProxyTool so it can skip duplicate emissions.
        self.emitted_tool_call_ids: set[str] = set()
        # Track tool call IDs for consistency
        self._active_tool_calls: Dict[str, str] = {}  # Tool call ID -> Tool call ID (for consistency)
        # Track streaming message state
        self._streaming_message_id: Optional[str] = None  # Current streaming message ID
        self._is_streaming: bool = False  # Whether we're currently streaming a message
        self._current_stream_text: str = ""  # Accumulates text for the active stream
        self._last_streamed_text: Optional[str] = None  # Snapshot of most recently streamed text
        self._last_streamed_run_id: Optional[str] = None  # Run identifier for the last streamed text
        self.long_running_tool_ids: List[str] = []  # Track the long running tool IDs

        # Track thinking message streaming state (for thought parts)
        self._is_thinking: bool = False  # Whether we're currently in a thinking block
        self._is_streaming_thinking: bool = False  # Whether we're streaming thinking content
        self._current_thinking_text: str = ""  # Accumulates thinking text for the active stream

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

        # Track streaming function calls for incremental TOOL_CALL_ARGS emission
        # Maps tool_call_id -> dict with streaming state (started, accumulated_args, etc.)
        self._streaming_function_calls: Dict[str, Dict[str, Any]] = {}
        # Track function call IDs that have been fully streamed (to skip final complete event)
        self._completed_streaming_function_calls: set[str] = set()
        # The tool_call_id of the currently active streaming function call (used to
        # correlate chunks that lack an id, e.g. with stream_function_call_arguments)
        self._active_streaming_fc_id: Optional[str] = None
        # Track the LAST tool name that completed streaming (for filtering the
        # aggregated non-partial event that follows).  Cleared after use so that
        # a second invocation of the same tool is not suppressed.
        self._last_completed_streaming_fc_name: Optional[str] = None
        # The streaming tool_call_id that corresponds to _last_completed_streaming_fc_name.
        # Used to build the confirmed→streaming id mapping below.
        self._last_completed_streaming_fc_id: Optional[str] = None
        # Maps confirmed (non-partial) FC id → streaming FC id so that
        # ToolCallResultEvent uses the same id we emitted in TOOL_CALL_START/END.
        # With PROGRESSIVE_SSE_STREAMING, ADK assigns different ids to the partial
        # and confirmed events for the same function call.
        self._confirmed_to_streaming_id: Dict[str, str] = {}

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
            
            # Handle streaming function calls from partial events
            # With stream_function_call_arguments=True, Gemini 3+ sends function
            # call arguments as incremental chunks with partial_args.  The raw
            # streaming chunks look like:
            #   chunk 1: name="tool", will_continue=True, partial_args=None
            #   chunk 2: name=None,   will_continue=True, partial_args=[PartialArg(...)]
            #   chunk N: name=None,   will_continue=None, partial_args=None  (end)
            # Without stream_function_call_arguments, ADK's aggregator provides
            # accumulated args on each partial event.  Both paths are handled below.
            if hasattr(adk_event, 'get_function_calls') and is_partial:
                function_calls = adk_event.get_function_calls()
                if function_calls:
                    # Filter out long-running tool calls
                    try:
                        lro_ids = set(getattr(adk_event, 'long_running_tool_ids', []) or [])
                    except Exception:
                        lro_ids = set()

                    # When streaming FC args is enabled, allow client tools
                    # through so the translator can stream their args
                    # incrementally.  ClientProxyTool will skip duplicate
                    # emission via _translator_emitted_tool_call_ids.
                    filter_by_client_name = not self._streaming_fc_args_enabled

                    non_lro_calls = [
                        fc for fc in function_calls
                        if getattr(fc, 'id', None) not in lro_ids
                        and getattr(fc, 'id', None) not in self._client_emitted_tool_call_ids
                        and (not filter_by_client_name or getattr(fc, 'name', None) not in self._client_tool_names)
                    ]

                    for func_call in non_lro_calls:
                        has_partial_args = getattr(func_call, 'partial_args', None)
                        has_args = getattr(func_call, 'args', None) is not None
                        will_continue = getattr(func_call, 'will_continue', None)

                        # Mode A: stream_function_call_arguments (Gemini 3+)
                        # Only active when explicitly enabled via streaming_function_call_arguments=True
                        is_mode_a = self._streaming_fc_args_enabled and (
                            has_partial_args                                          # middle chunk with partial_args
                            or (func_call.name and will_continue and not has_args)    # first chunk (name + will_continue, no accumulated args)
                            or (not func_call.name and will_continue and not has_args
                                and not self._active_streaming_fc_id)                 # nameless first chunk (ADK doesn't propagate name to partials)
                            or (not func_call.name and self._active_streaming_fc_id)  # end/continuation chunk (no name, active streaming)
                        )

                        # Mode B: accumulated args delta (progressive SSE / ADK aggregator)
                        # Enters streaming path when:
                        # - has_args AND will_continue (streaming in progress)
                        # - has_args AND id already tracked (continuation chunk)
                        # - has_args AND func_call.name set (complete FC in partial event)
                        is_mode_b = (
                            has_args and (
                                will_continue
                                or (getattr(func_call, 'id', None) or '') in self._streaming_function_calls
                                or bool(func_call.name)  # complete FC delivered via partial event
                            )
                        )

                        is_streaming_fc = is_mode_a or is_mode_b

                        if is_streaming_fc:
                            async for event in self._translate_streaming_function_call(func_call):
                                yield event

            # Handle complete (non-partial) function calls
            # Skip function calls that were already fully streamed via partial events
            if hasattr(adk_event, 'get_function_calls') and not is_partial:
                function_calls = adk_event.get_function_calls()
                if function_calls:
                    # Filter out long-running tool calls; those are handled by translate_lro_function_calls
                    try:
                        lro_ids = set(getattr(adk_event, 'long_running_tool_ids', []) or [])
                    except Exception:
                        lro_ids = set()

                    # Filter out LRO calls and calls already handled via streaming.
                    # With stream_function_call_arguments the aggregated FC has id=None,
                    # so we also check by name against the last completed streaming tool name.
                    # Also exclude:
                    # - tool calls already emitted via translate_lro_function_calls
                    #   (self.long_running_tool_ids tracks IDs across events, while lro_ids
                    #   is per-event and may be empty on the confirmed/non-partial replay)
                    # - tool calls already emitted by ClientProxyTool
                    #   (with ResumabilityConfig, the proxy tool emits its own events and
                    #   ADK may replay the same call as a confirmed event with a different ID)
                    all_lro_ids = lro_ids | set(self.long_running_tool_ids)
                    non_lro_calls = [
                        fc for fc in function_calls
                        if getattr(fc, 'id', None) not in all_lro_ids
                        and getattr(fc, 'id', None) not in self._client_emitted_tool_call_ids
                        and getattr(fc, 'name', None) not in self._client_tool_names
                        and getattr(fc, 'id', None) not in self._completed_streaming_function_calls
                        and not (self._last_completed_streaming_fc_name is not None and getattr(fc, 'name', None) == self._last_completed_streaming_fc_name)
                    ]

                    # Record confirmed→streaming id mapping for filtered FCs, then clear.
                    # With PROGRESSIVE_SSE_STREAMING, the confirmed event carries a
                    # different id than the partial event we already emitted.  The
                    # function response will use the confirmed id, so we remap it in
                    # _translate_function_response to keep ids consistent.
                    if self._last_completed_streaming_fc_name is not None:
                        for fc in function_calls:
                            fc_id = getattr(fc, 'id', None)
                            fc_name = getattr(fc, 'name', None)
                            if (
                                fc_name == self._last_completed_streaming_fc_name
                                and fc_id is not None
                                and fc_id not in lro_ids
                                and fc_id not in self._completed_streaming_function_calls
                                and self._last_completed_streaming_fc_id is not None
                                and fc_id != self._last_completed_streaming_fc_id
                            ):
                                self._confirmed_to_streaming_id[fc_id] = self._last_completed_streaming_fc_id
                                logger.debug(
                                    f"Mapped confirmed FC id {fc_id} → streaming id "
                                    f"{self._last_completed_streaming_fc_id} for tool '{fc_name}'"
                                )
                                break
                        self._last_completed_streaming_fc_name = None
                        self._last_completed_streaming_fc_id = None

                    if non_lro_calls:
                        logger.debug(f"ADK function calls detected (non-LRO, non-streamed): {len(non_lro_calls)} of {len(function_calls)} total")
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

    async def translate_text_only(
        self,
        adk_event: ADKEvent,
        thread_id: str,
        run_id: str
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate only text content from ADK event, ignoring function calls.

        Used when an event contains both text and LRO function calls,
        to ensure text is emitted before the LRO tool call events.
        (GitHub #906)

        Args:
            adk_event: The ADK event containing text content
            thread_id: The AG-UI thread ID
            run_id: The AG-UI run ID

        Yields:
            Text message events (START, CONTENT, END)
        """
        if adk_event.content and hasattr(adk_event.content, 'parts') and adk_event.content.parts:
            async for event in self._translate_text_content(
                adk_event, thread_id, run_id
            ):
                yield event

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
        
        # Extract text from all parts, separating thought parts from regular text
        text_parts = []
        thought_parts = []
        has_thought_support = _check_thought_support()

        # The check for adk_event.content.parts happens in the main translate method
        for part in adk_event.content.parts:
            if not part.text:  # Note: part.text == "" is False
                continue

            # Check if this is a thought part (backwards-compatible)
            # Use `is True` to handle Mock objects in tests and ensure we only
            # treat parts as thoughts when thought is explicitly set to True
            is_thought = False
            if has_thought_support:
                thought_value = getattr(part, 'thought', None)
                is_thought = thought_value is True

            if is_thought:
                thought_parts.append(part.text)
            else:
                text_parts.append(part.text)

        # Handle thought parts first (emit THINKING events)
        if thought_parts:
            async for event in self._translate_thinking_content(thought_parts):
                yield event

        # If no text AND it's not a final response, we can safely skip.
        # Otherwise, we must continue to process the final_response signal.
        if not text_parts and not is_final_response:
            # If we only had thought parts and this is not final, close any active thinking
            # but don't return yet if we need to handle final response
            return

        combined_text = "".join(text_parts)

        # Handle is_final_response BEFORE the empty text early return.
        # An empty final response is a valid stream-closing signal that must close
        # any active stream, even if there's no new text content.
        if is_final_response:
            # This is the final, complete message event.

            # Close any active thinking stream first
            async for event in self._close_thinking_stream():
                yield event

            # Case 1: A text stream is actively running. We must close it.
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
            # Close any active thinking stream before starting regular text
            # (transition from thinking to response)
            async for event in self._close_thinking_stream():
                yield event

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

    async def _translate_thinking_content(
        self,
        thought_parts: List[str]
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate thought parts to AG-UI THINKING events.

        This method emits THINKING_START, THINKING_TEXT_MESSAGE_START/CONTENT/END,
        and tracks thinking state for proper stream management.

        Args:
            thought_parts: List of thought text strings to emit

        Yields:
            Thinking events (THINKING_START, THINKING_TEXT_MESSAGE_START/CONTENT/END)
        """
        if not thought_parts:
            return

        combined_thought = "".join(thought_parts)
        if not combined_thought:
            return

        # Start thinking block if not already in one
        if not self._is_thinking:
            self._is_thinking = True
            yield ThinkingStartEvent(
                type=EventType.THINKING_START,
                title="Model Thinking"
            )
            logger.debug("🧠 Started thinking block")

        # Start thinking text message if not already streaming
        if not self._is_streaming_thinking:
            self._is_streaming_thinking = True
            self._current_thinking_text = ""
            yield ThinkingTextMessageStartEvent(
                type=EventType.THINKING_TEXT_MESSAGE_START
            )
            logger.debug("🧠 Started thinking text message")

        # Emit thinking content
        self._current_thinking_text += combined_thought
        yield ThinkingTextMessageContentEvent(
            type=EventType.THINKING_TEXT_MESSAGE_CONTENT,
            delta=combined_thought
        )
        logger.debug(f"🧠 Emitted thinking content: {len(combined_thought)} chars")

    async def _close_thinking_stream(self) -> AsyncGenerator[BaseEvent, None]:
        """Close any active thinking stream.

        This should be called when transitioning from thinking to regular output,
        or when the response is finalized.

        Yields:
            THINKING_TEXT_MESSAGE_END and THINKING_END events if needed
        """
        if self._is_streaming_thinking:
            yield ThinkingTextMessageEndEvent(
                type=EventType.THINKING_TEXT_MESSAGE_END
            )
            self._is_streaming_thinking = False
            self._current_thinking_text = ""
            logger.debug("🧠 Closed thinking text message")

        if self._is_thinking:
            yield ThinkingEndEvent(
                type=EventType.THINKING_END
            )
            self._is_thinking = False
            logger.debug("🧠 Closed thinking block")

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
                    ) and part.function_call.id not in self._client_emitted_tool_call_ids \
                      and getattr(part.function_call, 'name', None) not in self._client_tool_names:
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

                        # Record so ClientProxyTool can skip duplicate emission
                        self.emitted_tool_call_ids.add(long_running_function_call.id)

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

            # Record so ClientProxyTool can skip duplicate emission
            self.emitted_tool_call_ids.add(tool_call_id)

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

    def _infer_tool_name_from_json_paths(self, json_paths: set[str]) -> Optional[str]:
        """Infer the client tool name from partial_args json_paths.

        Matches the json_path argument names (e.g. ``$.content`` → ``content``)
        against ``_client_tool_schemas`` to find the best match.

        Falls back to the single entry in ``_client_tool_names`` when there's
        only one client tool, regardless of schema availability.

        Returns:
            The inferred tool name, or None if ambiguous/unknown.
        """
        if len(self._client_tool_names) == 1:
            return next(iter(self._client_tool_names))

        if not self._client_tool_schemas or not json_paths:
            return None

        # Extract argument names from json_paths (e.g. "$.content" → "content")
        arg_names = {p.lstrip('$.') for p in json_paths if p.startswith('$.')}
        if not arg_names:
            return None

        # Find tools whose argument set contains all observed arg names
        candidates = [
            name for name, schema_args in self._client_tool_schemas.items()
            if arg_names <= schema_args  # subset check
        ]
        if len(candidates) == 1:
            return candidates[0]

        return None

    async def _emit_streaming_fc_start(
        self,
        tool_call_id: str,
        tool_name: str,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Emit TOOL_CALL_START and mark the streaming state as started.

        Also emits PredictState CustomEvent if configured for this tool.
        """
        streaming_state = self._streaming_function_calls.get(tool_call_id)
        if streaming_state and streaming_state.get('start_emitted'):
            return  # Already emitted

        if streaming_state:
            streaming_state['start_emitted'] = True
            streaming_state['tool_name'] = tool_name

        # Emit PredictState CustomEvent before tool call events
        if tool_name in self._predict_state_by_tool:
            self._predictive_state_tool_call_ids.add(tool_call_id)
            if tool_name not in self._emitted_predict_state_for_tools:
                mappings = self._predict_state_by_tool[tool_name]
                predict_state_payload = [mapping.to_payload() for mapping in mappings]
                yield CustomEvent(
                    type=EventType.CUSTOM,
                    name="PredictState",
                    value=predict_state_payload,
                )
                self._emitted_predict_state_for_tools.add(tool_name)

        async for event in self.force_close_streaming_message():
            yield event

        yield ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=tool_call_id,
            tool_call_name=tool_name,
            parent_message_id=None,
        )
        logger.debug(f"Emitted TOOL_CALL_START for streaming FC: {tool_name} (id: {tool_call_id})")

    async def _translate_streaming_function_call(
        self,
        func_call: types.FunctionCall,
    ) -> AsyncGenerator[BaseEvent, None]:
        """Translate a streaming function call to AG-UI tool call events.

        Handles two streaming modes:

        1. **stream_function_call_arguments** (Gemini 3+ via Vertex AI):
           Raw chunks carry ``partial_args`` with incremental string values.
           Chunk IDs are all None; we generate a stable ``tool_call_id`` on the
           first chunk and track it via ``_active_streaming_fc_id``.

        2. **Accumulated args** (default ADK progressive SSE):
           The aggregator provides accumulated ``args`` on each partial event.
           We compute the JSON delta between consecutive partials.

        Args:
            func_call: A function call from a partial ADK event.

        Yields:
            TOOL_CALL_START, TOOL_CALL_ARGS (incremental), TOOL_CALL_END
        """
        partial_args = getattr(func_call, 'partial_args', None)
        will_continue = getattr(func_call, 'will_continue', None)
        accumulated_args = getattr(func_call, 'args', None)

        # ----- Determine tool_call_id -----
        tool_name = func_call.name  # Only set on the first chunk

        # ADK's populate_client_function_call_id assigns a fresh adk-<uuid> to
        # every partial event's function calls (since each raw chunk from Gemini
        # has id=None).  For continuation chunks (no name) we must map back to
        # the stable tool_call_id we generated on the first chunk.
        if self._active_streaming_fc_id and not tool_name:
            tool_call_id = self._active_streaming_fc_id
        else:
            tool_call_id = getattr(func_call, 'id', None) or str(uuid.uuid4())

        # ----- First chunk: emit START -----
        if tool_call_id not in self._streaming_function_calls:
            if not tool_name and not self._streaming_fc_args_enabled:
                # Stray chunk without a name and no active streaming FC — skip
                return

            logger.debug(f"Starting streaming function call: {tool_name or '<pending>'} (id: {tool_call_id})")

            self._streaming_function_calls[tool_call_id] = {
                'tool_name': tool_name,  # May be None; resolved on first partial_args
                'previous_json': '',
                'start_emitted': False,  # Defer START until we have a name
            }
            self._active_streaming_fc_id = tool_call_id
            self._active_tool_calls[tool_call_id] = tool_call_id

            if tool_name:
                # Name known — emit START immediately
                async for event in self._emit_streaming_fc_start(tool_call_id, tool_name):
                    yield event

        streaming_state = self._streaming_function_calls[tool_call_id]

        # ----- Emit deferred START if name was pending -----
        # When the first chunk had no name (ADK stream_function_call_arguments),
        # START was deferred. Emit it now using json_path disambiguation or
        # single-tool inference before the first ARGS event.
        if not streaming_state.get('start_emitted') and (partial_args or accumulated_args is not None):
            # Collect json_paths from partial_args for disambiguation
            json_paths: set[str] = set()
            if partial_args:
                for pa in partial_args:
                    jp = getattr(pa, 'json_path', None)
                    if jp:
                        json_paths.add(jp)

            inferred_name = self._infer_tool_name_from_json_paths(json_paths)
            effective_name = inferred_name or ""
            async for event in self._emit_streaming_fc_start(tool_call_id, effective_name):
                yield event

        # ----- Emit TOOL_CALL_ARGS from partial_args (stream_function_call_arguments mode) -----
        if partial_args:
            for partial_arg in partial_args:
                string_value = getattr(partial_arg, 'string_value', None)
                if string_value is None:
                    continue
                json_path = getattr(partial_arg, 'json_path', None)

                # Build JSON delta from partial_arg.
                # First partial_arg for a json_path needs the JSON key prefix;
                # subsequent ones just append the string fragment.
                if json_path and not streaming_state.get(f'started_{json_path}'):
                    # Emit JSON opening: {"document": "<value_start>
                    key = json_path.lstrip('$.')
                    # JSON-encode the partial string value (handles escaping)
                    encoded = json.dumps(string_value)
                    # Remove the closing quote — more content may follow
                    delta = '{' + json.dumps(key) + ': ' + encoded[:-1]
                    streaming_state[f'started_{json_path}'] = True
                    streaming_state['_open_paths'] = streaming_state.get('_open_paths', [])
                    streaming_state['_open_paths'].append(json_path)
                elif string_value:
                    # Continuation: just the raw escaped content (no quotes)
                    # We need to JSON-escape the string fragment
                    encoded = json.dumps(string_value)
                    delta = encoded[1:-1]  # strip surrounding quotes
                else:
                    continue

                if delta:
                    yield ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool_call_id,
                        delta=delta
                    )

        # ----- Emit TOOL_CALL_ARGS from accumulated args (aggregator delta mode) -----
        elif accumulated_args is not None:
            try:
                current_json = json.dumps(accumulated_args)
            except (TypeError, ValueError):
                current_json = str(accumulated_args)

            previous_json = streaming_state['previous_json']
            if current_json and current_json != previous_json:
                if current_json.startswith(previous_json):
                    delta = current_json[len(previous_json):]
                else:
                    delta = current_json

                if delta:
                    yield ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool_call_id,
                        delta=delta
                    )
                streaming_state['previous_json'] = current_json

        # ----- End of stream -----
        if not will_continue:
            resolved_name = tool_name or streaming_state.get('tool_name')
            logger.debug(f"Completing streaming function call: {resolved_name} (id: {tool_call_id})")

            # If START was never emitted (no partial_args arrived at all),
            # emit it now so the event sequence is valid.
            if not streaming_state.get('start_emitted'):
                inferred = self._infer_tool_name_from_json_paths(set()) or ""
                async for event in self._emit_streaming_fc_start(tool_call_id, inferred):
                    yield event

            # Close any open JSON paths from partial_args streaming
            open_paths = streaming_state.get('_open_paths', [])
            if open_paths:
                # Close the JSON: closing quote + closing brace
                closing_delta = '"}'
                yield ToolCallArgsEvent(
                    type=EventType.TOOL_CALL_ARGS,
                    tool_call_id=tool_call_id,
                    delta=closing_delta
                )

            yield ToolCallEndEvent(
                type=EventType.TOOL_CALL_END,
                tool_call_id=tool_call_id
            )

            # Record so ClientProxyTool can skip duplicate emission
            self.emitted_tool_call_ids.add(tool_call_id)

            # Mark as completed to skip the final complete event
            self._completed_streaming_function_calls.add(tool_call_id)
            if resolved_name:
                self._last_completed_streaming_fc_name = resolved_name
                self._last_completed_streaming_fc_id = tool_call_id

            # Clean up streaming state
            del self._streaming_function_calls[tool_call_id]
            self._active_tool_calls.pop(tool_call_id, None)
            if self._active_streaming_fc_id == tool_call_id:
                self._active_streaming_fc_id = None

            # Check if we should emit confirm_changes tool call after this tool
            if resolved_name in self._predict_state_by_tool and resolved_name not in self._emitted_confirm_for_tools:
                mappings = self._predict_state_by_tool[resolved_name]
                should_emit_confirm = any(m.emit_confirm_tool for m in mappings)
                if should_emit_confirm:
                    confirm_tool_call_id = str(uuid.uuid4())
                    logger.debug(f"Deferring confirm_changes tool call events after streaming '{resolved_name}'")

                    self._deferred_confirm_events.append(ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=confirm_tool_call_id,
                        tool_call_name="confirm_changes",
                        parent_message_id=None
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

                    self._emitted_confirm_for_tools.add(resolved_name)

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

            # Remap confirmed id → streaming id so the ToolCallResultEvent uses
            # the same id we emitted in TOOL_CALL_START/END.  With
            # PROGRESSIVE_SSE_STREAMING, ADK assigns different ids to the partial
            # and confirmed events for the same function call.
            if tool_call_id in self._confirmed_to_streaming_id:
                original_id = tool_call_id
                tool_call_id = self._confirmed_to_streaming_id.pop(original_id)
                logger.debug(f"Remapped ToolCallResult id {original_id} → {tool_call_id}")

            # Skip TOOL_CALL_RESULT for long-running tools (handled by frontend)
            if tool_call_id in self.long_running_tool_ids:
                logger.debug(f"Skipping ToolCallResultEvent for long-running tool: {tool_call_id}")
                continue

            # Skip TOOL_CALL_RESULT for predictive state tools
            # The frontend handles state updates via the predictive state mechanism,
            # and emitting a result event causes "No function call event found" errors
            tool_resp_name = getattr(func_response, 'name', None)
            if tool_call_id in self._predictive_state_tool_call_ids or (
                tool_resp_name is not None and tool_resp_name == self._last_completed_streaming_fc_name
            ):
                logger.debug(f"Skipping ToolCallResultEvent for predictive state/streamed tool: {tool_call_id}")
                if tool_resp_name is not None and tool_resp_name == self._last_completed_streaming_fc_name:
                    self._last_completed_streaming_fc_name = None
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
        # Reset thinking state
        self._is_thinking = False
        self._is_streaming_thinking = False
        self._current_thinking_text = ""
        logger.debug("Reset EventTranslator state (including streaming and thinking state)")


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
        # Note: ADK agents set author to the agent's name (e.g., "my_agent"),
        # not "model". We treat any non-"user" author as an assistant message.
        else:
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
        